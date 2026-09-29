// channels/email/trust-service.ts — Kernel Trusted People domain service.
// Manages trust_requests, trust_edges, pause policies, and signed trust-control flows.

import type { Env } from "../../env";
import { newId } from "../../util";
import { sendTrustControl } from "./trust-control/outbound";
import {
  dispatchVerifiedTrustControl,
  type DispatchTrustControlResult,
} from "./trust-control/dispatch";
import type { TrustControlEnvelope } from "./trust-control/schema";
import { canonicalize } from "./trust-control/canonical";
import { sha256HexString } from "./a2a/codec";
import { resolveLocalSigningKey, type LocalSigningKey } from "./a2a/outbound";
import { canonicalAddress } from "./identity";
import { currentMailboxAddress } from "./mailbox";

export interface TrustRequestRecord {
  id: string;
  workspaceId: string;
  protocolRequestId: string;
  direction: "in" | "out";
  peerAddress: string;
  peerIssuer?: string | null;
  displayName?: string | null;
  relation?: string | null;
  edgeId?: string | null;
  status: string;
  verificationSource?: string | null;
  transportEmailId?: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  resolvedAt?: number | null;
  lastError?: string | null;
}

export interface TrustEdgeRecord {
  id: string;
  workspaceId: string;
  peerAddress: string;
  peerIssuer?: string | null;
  displayName?: string | null;
  relation: string;
  status: string;
  invitedAt: number;
  confirmedAt?: number | null;
  revokedAt?: number | null;
}

export async function isTrustedPeoplePaused(env: Env, workspaceId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT value FROM settings WHERE workspace_id=? AND key='trusted_people_connections_paused'`,
  )
    .bind(workspaceId)
    .first<{ value: string }>();
  return row?.value === "1";
}

export async function setTrustedPeoplePaused(env: Env, workspaceId: string, paused: boolean): Promise<void> {
  const val = paused ? "1" : "0";
  await env.DB.prepare(
    `INSERT INTO settings (workspace_id, key, value) VALUES (?, 'trusted_people_connections_paused', ?)
     ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value`,
  )
    .bind(workspaceId, val)
    .run();
}

export async function getWorkspaceActiveMailbox(
  env: Env,
  workspaceId: string,
): Promise<{ address: string; domain: string } | null> {
  const row = await env.DB.prepare(
    `SELECT address, domain FROM agent_mailboxes WHERE workspace_id=? AND status='active'`,
  )
    .bind(workspaceId)
    .first<{ address: string; domain: string }>();
  return row ? { address: row.address, domain: row.domain } : null;
}

function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

function publishedLocalIssuerForPeer(env: Env, peerAddress: string, override?: LocalSigningKey): string {
  const resolved = override ? { ok: true as const, key: override } : resolveLocalSigningKey(env);
  if (!resolved.ok) return "";
  const issuer = resolved.key.issuer.trim().toLowerCase();
  const domain = addressDomain(peerAddress);
  if (!issuer || !domain) return "";

  const raw = env.A2A_SIGNING_PUBLIC_JWKS_JSON;
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { issuers?: Record<string, { mailDomains?: string[] }> };
    const entry = parsed.issuers?.[issuer];
    const domains = Array.isArray(entry?.mailDomains)
      ? entry!.mailDomains!.map((d) => String(d).trim().toLowerCase())
      : [];
    return domains.includes(domain) ? issuer : "";
  } catch {
    return "";
  }
}

async function cancelQueuedA2aForPeer(env: Env, workspaceId: string, peerAddress: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE email_outbox
        SET status='permanent_failed', last_error=?, lease_token=NULL, lease_until=NULL
      WHERE workspace_id=? AND status IN ('queued','retry_wait')
        AND id IN (
          SELECT outbox_id FROM a2a_outbound_intents
           WHERE workspace_id=? AND peer_address=? AND outbox_id IS NOT NULL
        )`,
  )
    .bind(reason, workspaceId, workspaceId, canonicalAddress(peerAddress))
    .run();
}

async function cancelQueuedTrustInvite(env: Env, workspaceId: string, protocolRequestId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE email_outbox
        SET status='permanent_failed', last_error='trust_request_cancelled', lease_token=NULL, lease_until=NULL
      WHERE workspace_id=? AND logical_key=? AND status IN ('queued','retry_wait')`,
  )
    .bind(workspaceId, `trust:invite:${protocolRequestId}`)
    .run();
}

export async function listTrustRequests(
  env: Env,
  workspaceId: string,
  filter?: { direction?: "in" | "out"; status?: string; limit?: number; offset?: number },
): Promise<TrustRequestRecord[]> {
  let query = `SELECT id, workspace_id, protocol_request_id, direction, peer_address, peer_issuer,
                      display_name, relation, edge_id, status, verification_source, transport_email_id,
                      created_at, updated_at, expires_at, resolved_at, last_error
               FROM trust_requests WHERE workspace_id=?`;
  const params: unknown[] = [workspaceId];
  if (filter?.direction) {
    query += ` AND direction=?`;
    params.push(filter.direction);
  }
  if (filter?.status) {
    query += ` AND status=?`;
    params.push(filter.status);
  }
  query += ` ORDER BY created_at DESC, id DESC`;
  if (typeof filter?.limit === "number") {
    query += ` LIMIT ?`;
    params.push(filter.limit);
    if (typeof filter?.offset === "number") {
      query += ` OFFSET ?`;
      params.push(filter.offset);
    }
  }

  const { results } = await env.DB.prepare(query).bind(...params).all<{
    id: string;
    workspace_id: string;
    protocol_request_id: string;
    direction: "in" | "out";
    peer_address: string;
    peer_issuer?: string | null;
    display_name?: string | null;
    relation?: string | null;
    edge_id?: string | null;
    status: string;
    verification_source?: string | null;
    transport_email_id?: string | null;
    created_at: number;
    updated_at: number;
    expires_at: number;
    resolved_at?: number | null;
    last_error?: string | null;
  }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    protocolRequestId: r.protocol_request_id,
    direction: r.direction,
    peerAddress: r.peer_address,
    peerIssuer: r.peer_issuer,
    displayName: r.display_name,
    relation: r.relation,
    edgeId: r.edge_id,
    status: r.status,
    verificationSource: r.verification_source,
    transportEmailId: r.transport_email_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    resolvedAt: r.resolved_at,
    lastError: r.last_error,
  }));
}

export async function countTrustRequests(
  env: Env,
  workspaceId: string,
  filter?: { direction?: "in" | "out"; status?: string },
): Promise<number> {
  let query = `SELECT COUNT(*) AS total FROM trust_requests WHERE workspace_id=?`;
  const params: unknown[] = [workspaceId];
  if (filter?.direction) {
    query += ` AND direction=?`;
    params.push(filter.direction);
  }
  if (filter?.status) {
    query += ` AND status=?`;
    params.push(filter.status);
  }
  const row = await env.DB.prepare(query).bind(...params).first<{ total: number }>();
  return row?.total ?? 0;
}

export async function getTrustRequest(
  env: Env,
  workspaceId: string,
  idOrProtocolId: string,
): Promise<TrustRequestRecord | null> {
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, protocol_request_id, direction, peer_address, peer_issuer,
            display_name, relation, edge_id, status, verification_source, transport_email_id,
            created_at, updated_at, expires_at, resolved_at, last_error
     FROM trust_requests
     WHERE workspace_id=? AND (id=? OR protocol_request_id=?)`,
  )
    .bind(workspaceId, idOrProtocolId, idOrProtocolId)
    .first<{
      id: string;
      workspace_id: string;
      protocol_request_id: string;
      direction: "in" | "out";
      peer_address: string;
      peer_issuer?: string | null;
      display_name?: string | null;
      relation?: string | null;
      edge_id?: string | null;
      status: string;
      verification_source?: string | null;
      transport_email_id?: string | null;
      created_at: number;
      updated_at: number;
      expires_at: number;
      resolved_at?: number | null;
      last_error?: string | null;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    protocolRequestId: row.protocol_request_id,
    direction: row.direction,
    peerAddress: row.peer_address,
    peerIssuer: row.peer_issuer,
    displayName: row.display_name,
    relation: row.relation,
    edgeId: row.edge_id,
    status: row.status,
    verificationSource: row.verification_source,
    transportEmailId: row.transport_email_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    lastError: row.last_error,
  };
}

export async function listTrustEdges(
  env: Env,
  workspaceId: string,
  filter?: { status?: string; limit?: number; offset?: number },
): Promise<TrustEdgeRecord[]> {
  let query = `SELECT id, workspace_id, peer_address, peer_issuer, display_name, relation,
                      status, invited_at, confirmed_at, revoked_at
               FROM trust_edges WHERE workspace_id=?`;
  const params: unknown[] = [workspaceId];
  if (filter?.status) {
    query += ` AND status=?`;
    params.push(filter.status);
  }
  query += ` ORDER BY invited_at DESC, id DESC`;
  if (typeof filter?.limit === "number") {
    query += ` LIMIT ?`;
    params.push(filter.limit);
    if (typeof filter?.offset === "number") {
      query += ` OFFSET ?`;
      params.push(filter.offset);
    }
  }

  const { results } = await env.DB.prepare(query).bind(...params).all<{
    id: string;
    workspace_id: string;
    peer_address: string;
    peer_issuer?: string | null;
    display_name?: string | null;
    relation: string;
    status: string;
    invited_at: number;
    confirmed_at?: number | null;
    revoked_at?: number | null;
  }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    peerAddress: r.peer_address,
    peerIssuer: r.peer_issuer,
    displayName: r.display_name,
    relation: r.relation,
    status: r.status,
    invitedAt: r.invited_at,
    confirmedAt: r.confirmed_at,
    revokedAt: r.revoked_at,
  }));
}

export async function countTrustEdges(
  env: Env,
  workspaceId: string,
  filter?: { status?: string },
): Promise<number> {
  let query = `SELECT COUNT(*) AS total FROM trust_edges WHERE workspace_id=?`;
  const params: unknown[] = [workspaceId];
  if (filter?.status) {
    query += ` AND status=?`;
    params.push(filter.status);
  }
  const row = await env.DB.prepare(query).bind(...params).first<{ total: number }>();
  return row?.total ?? 0;
}

export async function inviteTrustPerson(
  env: Env,
  opts: {
    workspaceId: string;
    peerAddress: string;
    /** Verified target issuer. Required for cross-issuer use; same-issuer published mail domains may omit it. */
    peerIssuer?: string;
    displayName?: string;
    relation?: string;
    ttlMs?: number;
    nowMs?: number;
    signingKeyOverride?: LocalSigningKey;
    idempotencyKey?: string;
  },
): Promise<{
  ok: boolean;
  requestId?: string;
  protocolRequestId?: string;
  edgeId?: string;
  outboxId?: string;
  envelope?: TrustControlEnvelope;
  error?: string;
}> {
  const nowMs = opts.nowMs ?? Date.now();
  const mailbox = await getWorkspaceActiveMailbox(env, opts.workspaceId);
  if (!mailbox) return { ok: false, error: "agent_mail_required" };
  if (await isTrustedPeoplePaused(env, opts.workspaceId)) return { ok: false, error: "connections_paused" };

  const peer = currentMailboxAddress(env, canonicalAddress(opts.peerAddress));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(peer)) return { ok: false, error: "invalid_peer_address" };
  if (peer === mailbox.address.toLowerCase()) return { ok: false, error: "cannot_invite_self" };

  const localPeer = await env.DB.prepare(`SELECT workspace_id FROM agent_mailboxes WHERE address=? AND status='active'`)
    .bind(peer).first<{ workspace_id: string }>();
  let peerIssuer = String(opts.peerIssuer ?? "").trim().toLowerCase();
  if (!peerIssuer && !localPeer) {
    // A non-local same-issuer target may be inferred only from this instance's explicitly published
    // mailDomains. Cross-issuer callers must provide a discovery-verified peerIssuer.
    peerIssuer = publishedLocalIssuerForPeer(env, peer, opts.signingKeyOverride);
  }
  if (!peerIssuer && !localPeer) return { ok: false, error: "peer_issuer_required" };
  // For an exact mailbox in this DB we deliberately leave peerIssuer NULL unless the caller supplied
  // it. The signed trust.accept will cryptographically bind and persist the real peer issuer. This
  // avoids incorrectly assuming the inviter's signing issuer is also the recipient's issuer in
  // multi-issuer/self-hosted deployments.

  const edge = await env.DB.prepare(
    `SELECT id, status FROM trust_edges WHERE workspace_id=? AND peer_address=?`,
  ).bind(opts.workspaceId, peer).first<{ id: string; status: string }>();
  if (edge?.status === "blocked") return { ok: false, error: "peer_blocked" };
  if (edge?.status === "active") return { ok: false, error: "already_trusted" };

  const existingPending = await env.DB.prepare(
    `SELECT id, protocol_request_id, edge_id, peer_issuer, expires_at FROM trust_requests
     WHERE workspace_id=? AND peer_address=? AND direction='out' AND status='pending'`,
  )
    .bind(opts.workspaceId, peer)
    .first<{ id: string; protocol_request_id: string; edge_id: string | null; peer_issuer: string | null; expires_at: number }>();

  if (existingPending && existingPending.expires_at > nowMs) {
    if (peerIssuer && existingPending.peer_issuer && existingPending.peer_issuer.toLowerCase() !== peerIssuer) {
      return { ok: false, error: "peer_issuer_conflict" };
    }
    const replay = await sendTrustControl(env, {
      workspaceId: opts.workspaceId,
      kind: "trust.invite",
      fromAgent: mailbox.address,
      toAgent: peer,
      requestId: existingPending.protocol_request_id,
      displayName: opts.displayName,
      relation: opts.relation ?? "trusted",
      nowMs,
      signingKeyOverride: opts.signingKeyOverride,
    });
    if (!replay.ok) return { ok: false, error: replay.error };
    return {
      ok: true,
      requestId: existingPending.id,
      protocolRequestId: existingPending.protocol_request_id,
      edgeId: existingPending.edge_id ?? edge?.id,
      outboxId: replay.outboxId,
      envelope: replay.envelope,
    };
  }

  const ttlMs = opts.ttlMs ?? 7 * 86_400_000;
  const expiresAt = nowMs + ttlMs;
  const protocolRequestId = opts.idempotencyKey?.trim() ? `req_${opts.idempotencyKey.trim()}` : newId("tcr");
  const trqId = newId("trq");
  const edgeId = edge?.id ?? newId("te");
  const relation = opts.relation ?? "trusted";

  await env.DB.prepare(
    `INSERT INTO trust_edges (
       id, workspace_id, peer_address, peer_issuer, display_name, relation, status,
       disclosure_json, auto_accept, invited_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '{}', 0, ?)
     ON CONFLICT(workspace_id, peer_address) DO UPDATE SET
       peer_issuer = COALESCE(excluded.peer_issuer, trust_edges.peer_issuer),
       status = CASE WHEN trust_edges.status = 'blocked' THEN 'blocked' ELSE 'pending' END,
       display_name = COALESCE(excluded.display_name, trust_edges.display_name),
       invited_at = excluded.invited_at
     WHERE trust_edges.status != 'blocked'`,
  ).bind(edgeId, opts.workspaceId, peer, peerIssuer || null, opts.displayName ?? null, relation, nowMs).run();

  await env.DB.prepare(
    `INSERT INTO trust_requests (
       id, workspace_id, protocol_request_id, direction, peer_address, peer_issuer, display_name,
       relation, edge_id, status, created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(workspace_id, protocol_request_id, direction) DO UPDATE SET
       updated_at=excluded.updated_at, expires_at=excluded.expires_at
     WHERE trust_requests.status='pending'`,
  ).bind(trqId, opts.workspaceId, protocolRequestId, peer, peerIssuer || null, opts.displayName ?? null, relation, edgeId, nowMs, nowMs, expiresAt).run();

  const sendRes = await sendTrustControl(env, {
    workspaceId: opts.workspaceId,
    kind: "trust.invite",
    fromAgent: mailbox.address,
    toAgent: peer,
    requestId: protocolRequestId,
    displayName: opts.displayName,
    relation,
    ttlMs,
    nowMs,
    signingKeyOverride: opts.signingKeyOverride,
  });
  if (!sendRes.ok) {
    await env.DB.prepare(`UPDATE trust_requests SET last_error=?, updated_at=? WHERE workspace_id=? AND protocol_request_id=? AND direction='out'`)
      .bind(sendRes.error ?? "invite_enqueue_failed", nowMs, opts.workspaceId, protocolRequestId).run().catch(() => undefined);
    return { ok: false, error: sendRes.error };
  }

  return { ok: true, requestId: trqId, protocolRequestId, edgeId, outboxId: sendRes.outboxId, envelope: sendRes.envelope };
}

export async function materializeVerifiedLocalTrustInvite(
  env: Env,
  opts: { recipientWorkspaceId: string; envelope: TrustControlEnvelope; verificationSource?: string; nowMs?: number },
): Promise<DispatchTrustControlResult> {
  const { recipientWorkspaceId, envelope } = opts;
  const envelopeSha256 = await sha256HexString(canonicalize(envelope));
  return await dispatchVerifiedTrustControl(env, {
    workspaceId: recipientWorkspaceId,
    verified: {
      ok: true,
      envelope,
      issuer: envelope.issuer,
      kid: envelope.kid,
      peerAddress: envelope.fromAgent,
      recipient: envelope.toAgent,
      keySource: "local_same_issuer",
      issuerMailDomains: [],
      envelopeSha256,
      verifiedAt: opts.nowMs ?? Date.now(),
    },
    verificationSource: opts.verificationSource ?? "local_same_issuer",
    nowMs: opts.nowMs,
  });
}

export async function acceptTrustRequest(
  env: Env,
  opts: { workspaceId: string; requestId: string; nowMs?: number; signingKeyOverride?: LocalSigningKey },
): Promise<{ ok: boolean; edgeId?: string; envelope?: TrustControlEnvelope; error?: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const mailbox = await getWorkspaceActiveMailbox(env, opts.workspaceId);
  if (!mailbox) return { ok: false, error: "agent_mail_required" };
  if (await isTrustedPeoplePaused(env, opts.workspaceId)) return { ok: false, error: "connections_paused" };

  const req = await getTrustRequest(env, opts.workspaceId, opts.requestId);
  if (!req || req.direction !== "in") return { ok: false, error: "request_not_found_or_not_pending" };
  if (req.status === "accepted") {
    const replay = await sendTrustControl(env, {
      workspaceId: opts.workspaceId,
      kind: "trust.accept",
      fromAgent: mailbox.address,
      toAgent: req.peerAddress,
      requestId: req.protocolRequestId,
      displayName: req.displayName ?? undefined,
      relation: req.relation ?? undefined,
      nowMs,
      signingKeyOverride: opts.signingKeyOverride,
    });
    if (!replay.ok) return { ok: false, error: replay.error };
    const active = await env.DB.prepare(`SELECT id, status FROM trust_edges WHERE workspace_id=? AND peer_address=?`)
      .bind(opts.workspaceId, canonicalAddress(req.peerAddress)).first<{ id: string; status: string }>();
    return active?.status === "active"
      ? { ok: true, edgeId: active.id, envelope: replay.envelope }
      : { ok: false, error: "trust_accept_incomplete" };
  }
  if (req.status !== "pending") return { ok: false, error: "request_not_found_or_not_pending" };

  if (req.expiresAt <= nowMs) {
    await env.DB.prepare(`UPDATE trust_requests SET status='expired', updated_at=? WHERE id=? AND status='pending'`)
      .bind(nowMs, req.id).run();
    return { ok: false, error: "request_expired" };
  }

  const peer = currentMailboxAddress(env, canonicalAddress(req.peerAddress));
  const currentEdge = await env.DB.prepare(`SELECT id, status FROM trust_edges WHERE workspace_id=? AND peer_address=?`)
    .bind(opts.workspaceId, peer).first<{ id: string; status: string }>();
  const optout = await env.DB.prepare(`SELECT 1 FROM a2a_optouts WHERE workspace_id=? AND peer_address=?`)
    .bind(opts.workspaceId, peer).first();
  if (currentEdge?.status === "blocked" || optout) return { ok: false, error: "peer_blocked" };
  if (!req.peerIssuer) return { ok: false, error: "peer_issuer_missing" };

  const acceptRes = await sendTrustControl(env, {
    workspaceId: opts.workspaceId,
    kind: "trust.accept",
    fromAgent: mailbox.address,
    toAgent: peer,
    requestId: req.protocolRequestId,
    displayName: req.displayName ?? undefined,
    relation: req.relation ?? undefined,
    nowMs,
    signingKeyOverride: opts.signingKeyOverride,
  });
  if (!acceptRes.ok || !acceptRes.envelope) return { ok: false, error: acceptRes.error ?? "trust_accept_enqueue_failed" };

  const edgeId = currentEdge?.id ?? newId("te");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO trust_edges (
         id, workspace_id, peer_address, peer_issuer, display_name, relation,
         status, disclosure_json, auto_accept, invited_at, confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', '{}', 0, ?, ?)
       ON CONFLICT(workspace_id, peer_address) DO UPDATE SET
         peer_issuer=excluded.peer_issuer,
         display_name=COALESCE(excluded.display_name, trust_edges.display_name),
         relation=excluded.relation,
         status='active', confirmed_at=excluded.confirmed_at
       WHERE trust_edges.status!='blocked'`,
    ).bind(edgeId, opts.workspaceId, peer, req.peerIssuer, req.displayName ?? null, req.relation ?? "trusted", nowMs, nowMs),
    env.DB.prepare(
      `INSERT INTO a2a_domain_consents (workspace_id, issuer, status, confirmed_by, confirmed_at)
       VALUES (?, ?, 'allowed', 'owner_accept', ?)
       ON CONFLICT(workspace_id, issuer) DO UPDATE SET status='allowed', confirmed_by='owner_accept', confirmed_at=excluded.confirmed_at`,
    ).bind(opts.workspaceId, req.peerIssuer, nowMs),
    env.DB.prepare(
      `UPDATE trust_requests SET status='accepted', resolved_at=?, updated_at=?, last_error=NULL
       WHERE id=? AND status='pending'`,
    ).bind(nowMs, nowMs, req.id),
  ]);

  const [edgeCheck, requestCheck] = await Promise.all([
    env.DB.prepare(`SELECT id, status, peer_issuer FROM trust_edges WHERE workspace_id=? AND peer_address=?`)
      .bind(opts.workspaceId, peer).first<{ id: string; status: string; peer_issuer: string | null }>(),
    env.DB.prepare(`SELECT status FROM trust_requests WHERE id=?`).bind(req.id).first<{ status: string }>(),
  ]);
  if (edgeCheck?.status !== "active" || edgeCheck.peer_issuer?.toLowerCase() !== req.peerIssuer.toLowerCase() || requestCheck?.status !== "accepted") {
    return { ok: false, error: "trust_accept_commit_failed" };
  }
  return { ok: true, edgeId: edgeCheck.id, envelope: acceptRes.envelope };
}

export async function declineTrustRequest(
  env: Env,
  opts: { workspaceId: string; requestId: string; nowMs?: number; signingKeyOverride?: LocalSigningKey },
): Promise<{ ok: boolean; error?: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const mailbox = await getWorkspaceActiveMailbox(env, opts.workspaceId);
  const req = await getTrustRequest(env, opts.workspaceId, opts.requestId);
  if (!req || req.direction !== "in" || req.status !== "pending") return { ok: false, error: "request_not_found_or_not_pending" };

  if (mailbox) {
    const sent = await sendTrustControl(env, {
      workspaceId: opts.workspaceId,
      kind: "trust.decline",
      fromAgent: mailbox.address,
      toAgent: req.peerAddress,
      requestId: req.protocolRequestId,
      nowMs,
      signingKeyOverride: opts.signingKeyOverride,
    });
    if (!sent.ok) return { ok: false, error: sent.error ?? "trust_decline_enqueue_failed" };
  }

  await env.DB.prepare(`UPDATE trust_requests SET status='declined', resolved_at=?, updated_at=? WHERE id=? AND status='pending'`)
    .bind(nowMs, nowMs, req.id).run();
  return { ok: true };
}

export async function cancelTrustRequest(
  env: Env,
  opts: { workspaceId: string; requestId: string; nowMs?: number; signingKeyOverride?: LocalSigningKey },
): Promise<{ ok: boolean; error?: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const mailbox = await getWorkspaceActiveMailbox(env, opts.workspaceId);
  const req = await getTrustRequest(env, opts.workspaceId, opts.requestId);
  if (!req || req.direction !== "out" || req.status !== "pending") return { ok: false, error: "request_not_found_or_not_pending" };

  await cancelQueuedTrustInvite(env, opts.workspaceId, req.protocolRequestId);
  await env.DB.batch([
    env.DB.prepare(`UPDATE trust_requests SET status='cancelled', resolved_at=?, updated_at=? WHERE id=? AND status='pending'`)
      .bind(nowMs, nowMs, req.id),
    env.DB.prepare(
      `UPDATE trust_edges SET status='revoked', revoked_at=? WHERE workspace_id=? AND peer_address=? AND status='pending'`,
    ).bind(nowMs, opts.workspaceId, canonicalAddress(req.peerAddress)),
  ]);

  if (mailbox) {
    await sendTrustControl(env, {
      workspaceId: opts.workspaceId,
      kind: "trust.revoke",
      fromAgent: mailbox.address,
      toAgent: req.peerAddress,
      requestId: req.protocolRequestId,
      nowMs,
      signingKeyOverride: opts.signingKeyOverride,
    }).catch(() => undefined);
  }
  return { ok: true };
}

export async function removeTrustPerson(
  env: Env,
  opts: { workspaceId: string; edgeIdOrPeerAddress: string; nowMs?: number; signingKeyOverride?: LocalSigningKey },
): Promise<{ ok: boolean; error?: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const mailbox = await getWorkspaceActiveMailbox(env, opts.workspaceId);
  const target = opts.edgeIdOrPeerAddress.trim().toLowerCase();
  const edge = await env.DB.prepare(
    `SELECT id, peer_address, status FROM trust_edges WHERE workspace_id=? AND (id=? OR peer_address=?)`,
  ).bind(opts.workspaceId, target, target).first<{ id: string; peer_address: string; status: string }>();
  if (!edge) return { ok: false, error: "edge_not_found" };

  await env.DB.batch([
    env.DB.prepare(`UPDATE trust_edges SET status='revoked', revoked_at=? WHERE id=? AND status!='blocked'`).bind(nowMs, edge.id),
    env.DB.prepare(
      `UPDATE a2a_convos SET state='halted', updated_at=?
       WHERE workspace_id=? AND peer_address=? AND state NOT IN ('confirmed','declined','cancelled','halted')`,
    ).bind(nowMs, opts.workspaceId, edge.peer_address),
  ]);
  await cancelQueuedA2aForPeer(env, opts.workspaceId, edge.peer_address, "trust_revoked");

  if (mailbox) {
    await sendTrustControl(env, {
      workspaceId: opts.workspaceId,
      kind: "trust.revoke",
      fromAgent: mailbox.address,
      toAgent: edge.peer_address,
      requestId: newId("tcr"),
      nowMs,
      signingKeyOverride: opts.signingKeyOverride,
    }).catch(() => undefined);
  }
  return { ok: true };
}

export async function blockTrustPeer(
  env: Env,
  opts: { workspaceId: string; edgeIdOrPeerAddress: string; nowMs?: number; signingKeyOverride?: LocalSigningKey },
): Promise<{ ok: boolean; error?: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const mailbox = await getWorkspaceActiveMailbox(env, opts.workspaceId);
  const target = opts.edgeIdOrPeerAddress.trim().toLowerCase();
  const edge = await env.DB.prepare(
    `SELECT id, peer_address, status FROM trust_edges WHERE workspace_id=? AND (id=? OR peer_address=?)`,
  ).bind(opts.workspaceId, target, target).first<{ id: string; peer_address: string; status: string }>();

  const peerAddress = edge?.peer_address ?? (target.includes("@") ? canonicalAddress(target) : "");
  if (!peerAddress) return { ok: false, error: "invalid_peer_address" };

  const edgeStmt = edge
    ? env.DB.prepare(`UPDATE trust_edges SET status='blocked', revoked_at=? WHERE id=?`).bind(nowMs, edge.id)
    : env.DB.prepare(
        `INSERT INTO trust_edges (id, workspace_id, peer_address, relation, status, disclosure_json, auto_accept, invited_at, revoked_at)
         VALUES (?, ?, ?, 'blocked', 'blocked', '{}', 0, ?, ?)`,
      ).bind(newId("te"), opts.workspaceId, peerAddress, nowMs, nowMs);

  await env.DB.batch([
    edgeStmt,
    env.DB.prepare(
      `INSERT INTO a2a_optouts (workspace_id, peer_address, created_at) VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, peer_address) DO NOTHING`,
    ).bind(opts.workspaceId, peerAddress, nowMs),
    env.DB.prepare(
      `UPDATE a2a_convos SET state='halted', updated_at=?
       WHERE workspace_id=? AND peer_address=? AND state NOT IN ('confirmed','declined','cancelled','halted')`,
    ).bind(nowMs, opts.workspaceId, peerAddress),
    env.DB.prepare(
      `UPDATE trust_requests SET status='revoked', resolved_at=?, updated_at=?
       WHERE workspace_id=? AND peer_address=? AND status='pending'`,
    ).bind(nowMs, nowMs, opts.workspaceId, peerAddress),
  ]);
  await cancelQueuedA2aForPeer(env, opts.workspaceId, peerAddress, "trust_blocked");

  if (mailbox) {
    await sendTrustControl(env, {
      workspaceId: opts.workspaceId,
      kind: "trust.revoke",
      fromAgent: mailbox.address,
      toAgent: peerAddress,
      requestId: newId("tcr"),
      nowMs,
      signingKeyOverride: opts.signingKeyOverride,
    }).catch(() => undefined);
  }
  return { ok: true };
}

export async function unblockTrustPeer(
  env: Env,
  opts: { workspaceId: string; edgeIdOrPeerAddress: string; nowMs?: number },
): Promise<{ ok: boolean; error?: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const target = opts.edgeIdOrPeerAddress.trim().toLowerCase();
  const edge = await env.DB.prepare(
    `SELECT id, peer_address, status FROM trust_edges WHERE workspace_id=? AND (id=? OR peer_address=?)`,
  ).bind(opts.workspaceId, target, target).first<{ id: string; peer_address: string; status: string }>();
  const peerAddress = edge?.peer_address ?? (target.includes("@") ? canonicalAddress(target) : "");

  if (edge) {
    await env.DB.prepare(`UPDATE trust_edges SET status='revoked', revoked_at=? WHERE id=? AND status='blocked'`)
      .bind(nowMs, edge.id).run();
  }
  if (peerAddress) {
    await env.DB.prepare(`DELETE FROM a2a_optouts WHERE workspace_id=? AND peer_address=?`)
      .bind(opts.workspaceId, peerAddress).run();
  }
  return { ok: true };
}
