// channels/email/trust-control/dispatch.ts — Dispatching verified incoming trust-control protocol messages.

import type { Env } from "../../../env";
import { newId } from "../../../util";
import type { VerifiedTrustControl } from "./verify";
import { resolveLocalSigningKey } from "../a2a/outbound";

export interface DispatchTrustControlOpts {
  workspaceId: string;
  verified: VerifiedTrustControl;
  transportEmailId?: string;
  verificationSource?: string;
  nowMs?: number;
}

export interface DispatchTrustControlResult {
  ok: boolean;
  status?: string;
  duplicate?: boolean;
  ignored?: boolean;
  reason?: string;
  error?: string;
}

export function isCrossIssuerTrustEnabled(env: Env): boolean {
  const flag = (env as { TRUSTED_PEOPLE_CROSS_ISSUER_ENABLED?: string | boolean }).TRUSTED_PEOPLE_CROSS_ISSUER_ENABLED;
  return flag === "1" || flag === "true" || flag === true;
}

export function isTrustedPeopleEnabled(env: Env): boolean {
  // Kernel/self-hosted keeps the open capability available when the flag is absent.
  // Deployments that want it off set TRUSTED_PEOPLE_ENABLED=0 explicitly.
  const flag = (env as { TRUSTED_PEOPLE_ENABLED?: string | boolean }).TRUSTED_PEOPLE_ENABLED;
  if (flag === undefined || flag === null || flag === "") return true;
  return flag === "1" || flag === "true" || flag === true;
}

export function getLocalIssuer(env: Env): string {
  const envIssuer = (env as { A2A_ISSUER?: string }).A2A_ISSUER;
  if (envIssuer) return envIssuer.trim().toLowerCase();
  const resolved = resolveLocalSigningKey(env);
  if (resolved.ok) return resolved.key.issuer.trim().toLowerCase();
  return "";
}

async function markSeen(
  env: Env,
  opts: { workspaceId: string; issuer: string; requestId: string; kind: string; envelopeSha256: string; nowMs: number },
): Promise<DispatchTrustControlResult | null> {
  // INSERT OR IGNORE closes the SELECT->INSERT race when local fast-path and real email arrive together.
  // meta.changes tells us whether this invocation owns the first insertion, without a racy pre-read.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO trust_control_seen (workspace_id, issuer, protocol_request_id, kind, envelope_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(opts.workspaceId, opts.issuer, opts.requestId, opts.kind, opts.envelopeSha256, opts.nowMs)
    .run();

  const seen = await env.DB.prepare(
    `SELECT envelope_sha256 FROM trust_control_seen WHERE workspace_id=? AND issuer=? AND protocol_request_id=? AND kind=?`,
  )
    .bind(opts.workspaceId, opts.issuer, opts.requestId, opts.kind)
    .first<{ envelope_sha256: string }>();

  if (!seen) return { ok: false, error: "trust_control_seen_write_failed" };
  if (seen.envelope_sha256 !== opts.envelopeSha256) {
    return { ok: false, error: "trust_control_conflict", duplicate: false };
  }

  if (Number(inserted?.meta?.changes ?? 0) === 0) {
    return { ok: true, duplicate: true, status: "seen_duplicate" };
  }
  return null;
}

async function readSeen(
  env: Env,
  opts: { workspaceId: string; issuer: string; requestId: string; kind: string; envelopeSha256: string; nowMs: number },
): Promise<DispatchTrustControlResult | null> {
  const seen = await env.DB.prepare(
    `SELECT envelope_sha256 FROM trust_control_seen WHERE workspace_id=? AND issuer=? AND protocol_request_id=? AND kind=?`,
  )
    .bind(opts.workspaceId, opts.issuer, opts.requestId, opts.kind)
    .first<{ envelope_sha256: string }>();
  if (!seen) return null;
  if (seen.envelope_sha256 !== opts.envelopeSha256) {
    return { ok: false, error: "trust_control_conflict", duplicate: false };
  }
  return { ok: true, duplicate: true, status: "seen_duplicate" };
}

async function finishSeen(
  env: Env,
  opts: { workspaceId: string; issuer: string; requestId: string; kind: string; envelopeSha256: string; nowMs: number },
  result: DispatchTrustControlResult,
): Promise<DispatchTrustControlResult> {
  // The replay barrier is committed only AFTER the idempotent state effect succeeds.
  // A crash/DB failure before this point leaves no false "seen" marker, so provider retry
  // can finish the operation. Concurrent same-envelope workers are safe because every state
  // mutation below is conflict/CAS guarded; a conflicting signed envelope is still rejected.
  const seen = await markSeen(env, opts);
  if (seen && !seen.ok) return seen;
  return result;
}

function sameAddress(a: string | null | undefined, b: string): boolean {
  return String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

function sameIssuer(a: string | null | undefined, b: string): boolean {
  return String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

export async function dispatchVerifiedTrustControl(
  env: Env,
  opts: DispatchTrustControlOpts,
): Promise<DispatchTrustControlResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const { workspaceId, verified } = opts;
  const { envelope, issuer, peerAddress, envelopeSha256 } = verified;
  const requestId = envelope.requestId;
  const kind = envelope.kind;
  const peer = peerAddress.trim().toLowerCase();
  const peerIssuer = issuer.trim().toLowerCase();

  if (!isTrustedPeopleEnabled(env)) {
    return { ok: true, ignored: true, reason: "trusted_people_disabled" };
  }

  const edge = await env.DB.prepare(
    `SELECT id, status, peer_issuer FROM trust_edges WHERE workspace_id=? AND peer_address=?`,
  )
    .bind(workspaceId, peer)
    .first<{ id: string; status: string; peer_issuer: string | null }>();

  const optout = await env.DB.prepare(
    `SELECT 1 FROM a2a_optouts WHERE workspace_id=? AND peer_address=?`,
  )
    .bind(workspaceId, peer)
    .first();

  const isBlocked = edge?.status === "blocked" || Boolean(optout);
  if (isBlocked && kind !== "trust.revoke") {
    // Block must outrank old retries and delayed accepts/declines as well as new invites.
    return { ok: true, ignored: true, reason: "peer_blocked" };
  }

  if (kind === "trust.invite") {
    const localIssuer = getLocalIssuer(env);
    const isSameIssuer = Boolean(localIssuer) && peerIssuer === localIssuer;
    if (!isSameIssuer && !isCrossIssuerTrustEnabled(env)) {
      // Do not consume the replay key while a live product gate is closed: a later operator enable
      // plus provider redelivery must still be able to materialize the pending request.
      return { ok: true, ignored: true, reason: "cross_issuer_trust_disabled" };
    }
  }

  // Non-invite controls are only meaningful when cryptographic identity matches the relationship/request
  // they claim to mutate. requestId by itself is never an authorization capability.
  let outgoing:
    | { id: string; status: string; edge_id: string | null; peer_address: string; peer_issuer: string | null }
    | null = null;

  if (kind === "trust.accept" || kind === "trust.decline") {
    outgoing = await env.DB.prepare(
      `SELECT id, status, edge_id, peer_address, peer_issuer FROM trust_requests
       WHERE workspace_id=? AND protocol_request_id=? AND direction='out'`,
    )
      .bind(workspaceId, requestId)
      .first<{ id: string; status: string; edge_id: string | null; peer_address: string; peer_issuer: string | null }>();

    if (!outgoing) return { ok: false, error: "no_matching_outgoing_request" };
    if (!sameAddress(outgoing.peer_address, peer)) {
      return { ok: false, error: "control_peer_mismatch" };
    }

    if (outgoing.peer_issuer) {
      if (!sameIssuer(outgoing.peer_issuer, peerIssuer)) {
        return { ok: false, error: "control_peer_mismatch" };
      }
    } else {
      // Legacy/same-instance outgoing requests may intentionally leave peer_issuer NULL until a
      // cryptographically verified response arrives. Bind exactly once from that verified identity.
      await env.DB.prepare(
        `UPDATE trust_requests SET peer_issuer=?, updated_at=? WHERE id=? AND peer_issuer IS NULL`,
      )
        .bind(peerIssuer, nowMs, outgoing.id)
        .run();
      const bound = await env.DB.prepare(`SELECT peer_issuer FROM trust_requests WHERE id=?`)
        .bind(outgoing.id)
        .first<{ peer_issuer: string | null }>();
      if (!sameIssuer(bound?.peer_issuer, peerIssuer)) {
        return { ok: false, error: "control_peer_mismatch" };
      }
      outgoing.peer_issuer = peerIssuer;
    }
  }

  if (kind === "trust.revoke") {
    const matchingRequest = await env.DB.prepare(
      `SELECT id FROM trust_requests
       WHERE workspace_id=? AND protocol_request_id=? AND peer_address=?
         AND (peer_issuer=? OR peer_issuer IS NULL)
       LIMIT 1`,
    )
      .bind(workspaceId, requestId, peer, peerIssuer)
      .first<{ id: string }>();
    const edgeMatchesIssuer = Boolean(edge) && (!edge?.peer_issuer || sameIssuer(edge.peer_issuer, peerIssuer));
    if (!matchingRequest && !edgeMatchesIssuer) {
      return { ok: false, error: "no_matching_relationship" };
    }
  }

  const seenOpts = {
    workspaceId,
    issuer: peerIssuer,
    requestId,
    kind,
    envelopeSha256,
    nowMs,
  };
  // Only a COMPLETED control message may short-circuit as duplicate. The marker is written
  // after its state effect below, never before, so crashes cannot poison redelivery forever.
  const priorSeen = await readSeen(env, seenOpts);
  if (priorSeen) return priorSeen;

  switch (kind) {
    case "trust.invite": {
      if (edge?.status === "active") return await finishSeen(env, seenOpts, { ok: true, status: "already_active" });

      const existing = await env.DB.prepare(
        `SELECT id, status, peer_address, peer_issuer FROM trust_requests
         WHERE workspace_id=? AND protocol_request_id=? AND direction='in'`,
      )
        .bind(workspaceId, requestId)
        .first<{ id: string; status: string; peer_address: string; peer_issuer: string | null }>();
      if (existing) {
        if (!sameAddress(existing.peer_address, peer) || !sameIssuer(existing.peer_issuer, peerIssuer)) {
          return { ok: false, error: "control_peer_mismatch" };
        }
        return await finishSeen(env, seenOpts, { ok: true, status: existing.status, duplicate: true });
      }

      const reqId = newId("trq");
      const expiresAt = envelope.exp * 1000;
      const relation = envelope.relation ?? "trusted";
      const displayName = envelope.displayName ?? null;
      const source = opts.verificationSource ?? "email_verified";
      const transportId = opts.transportEmailId ?? null;

      await env.DB.prepare(
        `INSERT INTO trust_requests (
           id, workspace_id, protocol_request_id, direction, peer_address, peer_issuer,
           display_name, relation, status, verification_source, transport_email_id,
           created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, 'in', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, protocol_request_id, direction) DO NOTHING`,
      )
        .bind(reqId, workspaceId, requestId, peer, peerIssuer, displayName, relation, source, transportId, nowMs, nowMs, expiresAt)
        .run();

      const stored = await env.DB.prepare(
        `SELECT status, peer_address, peer_issuer FROM trust_requests
         WHERE workspace_id=? AND protocol_request_id=? AND direction='in'`,
      )
        .bind(workspaceId, requestId)
        .first<{ status: string; peer_address: string; peer_issuer: string | null }>();
      if (!stored || !sameAddress(stored.peer_address, peer) || !sameIssuer(stored.peer_issuer, peerIssuer)) {
        return { ok: false, error: "trust_request_materialize_failed" };
      }
      return await finishSeen(env, seenOpts, { ok: true, status: stored.status });
    }

    case "trust.accept": {
      if (!outgoing) return { ok: false, error: "no_matching_outgoing_request" };
      if (outgoing.status !== "pending") {
        return await finishSeen(env, seenOpts, { ok: true, status: outgoing.status, duplicate: true });
      }
      if (edge?.status === "blocked" || optout) return { ok: true, ignored: true, reason: "peer_blocked" };

      const edgeId = edge?.id ?? outgoing.edge_id ?? newId("te");
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO trust_edges (
             id, workspace_id, peer_address, peer_issuer, display_name, relation,
             status, disclosure_json, auto_accept, invited_at, confirmed_at
           ) VALUES (?, ?, ?, ?, ?, 'trusted', 'active', '{}', 0, ?, ?)
           ON CONFLICT(workspace_id, peer_address) DO UPDATE SET
             peer_issuer = excluded.peer_issuer,
             display_name = COALESCE(excluded.display_name, trust_edges.display_name),
             status = 'active',
             confirmed_at = excluded.confirmed_at
           WHERE trust_edges.status != 'blocked'`,
        ).bind(edgeId, workspaceId, peer, peerIssuer, envelope.displayName ?? null, nowMs, nowMs),
        env.DB.prepare(
          `INSERT INTO a2a_domain_consents (workspace_id, issuer, status, confirmed_by, confirmed_at)
           VALUES (?, ?, 'allowed', 'trust_accept', ?)
           ON CONFLICT(workspace_id, issuer) DO UPDATE SET status='allowed', confirmed_by='trust_accept', confirmed_at=excluded.confirmed_at`,
        ).bind(workspaceId, peerIssuer, nowMs),
        env.DB.prepare(
          `UPDATE trust_requests SET status='accepted', resolved_at=?, updated_at=?
           WHERE id=? AND status='pending' AND peer_address=? AND peer_issuer=?`,
        ).bind(nowMs, nowMs, outgoing.id, peer, peerIssuer),
      ]);

      const [edgeCheck, requestCheck] = await Promise.all([
        env.DB.prepare(`SELECT status, peer_issuer FROM trust_edges WHERE workspace_id=? AND peer_address=?`)
          .bind(workspaceId, peer).first<{ status: string; peer_issuer: string | null }>(),
        env.DB.prepare(`SELECT status FROM trust_requests WHERE id=?`).bind(outgoing.id).first<{ status: string }>(),
      ]);
      if (edgeCheck?.status !== "active" || !sameIssuer(edgeCheck.peer_issuer, peerIssuer) || requestCheck?.status !== "accepted") {
        return { ok: false, error: "trust_accept_commit_failed" };
      }
      return await finishSeen(env, seenOpts, { ok: true, status: "accepted" });
    }

    case "trust.decline": {
      if (!outgoing) return { ok: false, error: "no_matching_outgoing_request" };
      if (outgoing.status !== "pending") return await finishSeen(env, seenOpts, { ok: true, status: outgoing.status, duplicate: true });

      await env.DB.prepare(
        `UPDATE trust_requests SET status='declined', resolved_at=?, updated_at=?
         WHERE id=? AND status='pending' AND peer_address=? AND peer_issuer=?`,
      )
        .bind(nowMs, nowMs, outgoing.id, peer, peerIssuer)
        .run();

      if (edge?.status === "pending") {
        await env.DB.prepare(`UPDATE trust_edges SET status='declined', revoked_at=? WHERE id=? AND status='pending'`)
          .bind(nowMs, edge.id)
          .run();
      }
      return await finishSeen(env, seenOpts, { ok: true, status: "declined" });
    }

    case "trust.revoke": {
      // A remote revoke can never erase our local block fact.
      if (edge && edge.status === "active") {
        await env.DB.prepare(`UPDATE trust_edges SET status='revoked', revoked_at=? WHERE id=? AND status='active'`)
          .bind(nowMs, edge.id)
          .run();
      }

      await env.DB.batch([
        env.DB.prepare(
          `UPDATE trust_requests SET status='revoked', resolved_at=?, updated_at=?
           WHERE workspace_id=? AND peer_address=? AND status='pending'`,
        ).bind(nowMs, nowMs, workspaceId, peer),
        env.DB.prepare(
          `UPDATE a2a_convos SET state='halted', updated_at=?
           WHERE workspace_id=? AND peer_address=? AND state NOT IN ('confirmed','declined','cancelled','halted')`,
        ).bind(nowMs, workspaceId, peer),
      ]);

      return await finishSeen(env, seenOpts, { ok: true, status: edge?.status === "blocked" ? "blocked" : "revoked" });
    }
  }
}
