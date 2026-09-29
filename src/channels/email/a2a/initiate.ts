// channels/email/a2a/initiate.ts — Owner-initiated A2A scheduling coordination.
// Allocates crash-safe durable a2a_initiations, enforces active trust edges,
// creates isolated 1:1 conversations for each peer, and signs propose messages.

import type { Env } from "../../../env";
import { newId } from "../../../util";
import { serializeDisclosure, type ScheduleFacts } from "./disclosure";
import { sendA2aResponse, type LocalSigningKey } from "./outbound";
import { getHostHooks } from "../../../hooks";
import { isTrustedPeoplePaused, getWorkspaceActiveMailbox } from "../trust-service";
import { canonicalAddress } from "../identity";

export interface StartScheduleCoordinationOpts {
  workspaceId: string;
  peers: string[]; // 1..N; each peer gets an isolated 1:1 conversation
  facts: ScheduleFacts;
  timeWindow: { start: string; end: string };
  durationMinutes: number;
  preference?: string;
  rootTaskId?: string;
  idempotencyKey: string;
  nowMs?: number;
  signingKeyOverride?: LocalSigningKey;
}

export interface PeerCoordinationResult {
  peer: string;
  ok: boolean;
  convoId?: string;
  protocolConvoId?: string;
  outboxId?: string;
  state?: string;
  error?: string;
}

export interface StartScheduleCoordinationResult {
  ok: boolean;
  results: PeerCoordinationResult[];
  error?: string;
}

interface ExistingInitiation {
  id: string;
  protocol_convo_id: string;
  state: string;
  request_json: string;
}

interface PeerPreflight {
  peer: string;
  peerIssuer: string;
  logicalKey: string;
  requestJson: string;
  existingInit: ExistingInitiation | null;
}

function validateWindow(opts: StartScheduleCoordinationOpts): string | null {
  const start = Date.parse(String(opts.timeWindow?.start ?? ""));
  const end = Date.parse(String(opts.timeWindow?.end ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "invalid_time_window";
  const duration = Number(opts.durationMinutes);
  if (!Number.isInteger(duration) || duration <= 0 || duration > 24 * 60) return "invalid_duration_minutes";
  if (duration * 60_000 > end - start) return "duration_exceeds_time_window";
  if (!String(opts.idempotencyKey ?? "").trim()) return "idempotency_key_required";
  return null;
}

function requestJsonForPeer(opts: StartScheduleCoordinationOpts, workspaceId: string, peer: string): string {
  return JSON.stringify({
    workspaceId,
    peer,
    timeWindow: opts.timeWindow,
    durationMinutes: opts.durationMinutes,
    preference: opts.preference,
    idempotencyKey: opts.idempotencyKey,
  });
}

async function preflightPeer(
  env: Env,
  workspaceId: string,
  peer: string,
  opts: StartScheduleCoordinationOpts,
): Promise<{ ok: true; value: PeerPreflight } | { ok: false; result: PeerCoordinationResult }> {
  const edge = await env.DB.prepare(
    `SELECT id, peer_issuer, status FROM trust_edges WHERE workspace_id=? AND peer_address=?`,
  )
    .bind(workspaceId, peer)
    .first<{ id: string; peer_issuer: string | null; status: string }>();

  if (!edge || edge.status !== "active") {
    return { ok: false, result: { peer, ok: false, error: "trust_edge_not_active" } };
  }

  let peerIssuer = (edge.peer_issuer ?? "").trim().toLowerCase();
  if (!peerIssuer) peerIssuer = peer.split("@")[1]?.toLowerCase() ?? "";
  if (!peerIssuer) {
    return { ok: false, result: { peer, ok: false, error: "peer_issuer_unknown" } };
  }

  const consent = await env.DB.prepare(
    `SELECT status FROM a2a_domain_consents WHERE workspace_id=? AND issuer=?`,
  )
    .bind(workspaceId, peerIssuer)
    .first<{ status: string }>();
  if (!consent || consent.status !== "allowed") {
    return { ok: false, result: { peer, ok: false, error: "domain_consent_not_allowed" } };
  }

  const logicalKey = `a2a:init:${opts.idempotencyKey.trim()}:${peer}`;
  const requestJson = requestJsonForPeer(opts, workspaceId, peer);
  const existingInit = await env.DB.prepare(
    `SELECT id, protocol_convo_id, state, request_json FROM a2a_initiations WHERE workspace_id=? AND logical_key=?`,
  )
    .bind(workspaceId, logicalKey)
    .first<ExistingInitiation>();
  if (existingInit && existingInit.request_json !== requestJson) {
    return { ok: false, result: { peer, ok: false, error: "idempotency_key_reused_with_different_request" } };
  }

  return {
    ok: true,
    value: { peer, peerIssuer, logicalKey, requestJson, existingInit: existingInit ?? null },
  };
}

export async function startScheduleCoordination(
  env: Env,
  opts: StartScheduleCoordinationOpts,
): Promise<StartScheduleCoordinationResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const workspaceId = opts.workspaceId;

  const inputError = validateWindow(opts);
  if (inputError) return { ok: false, results: [], error: inputError };

  // T1: Active Agent Mail prerequisite.
  const mailbox = await getWorkspaceActiveMailbox(env, workspaceId);
  if (!mailbox) return { ok: false, results: [], error: "agent_mail_required" };

  // Paused means no new schedule protocol actions.
  if (await isTrustedPeoplePaused(env, workspaceId)) {
    return { ok: false, results: [], error: "connections_paused" };
  }

  const rawPeers = Array.isArray(opts.peers) ? opts.peers : [];
  const normalizedPeers = [...new Set(rawPeers.map((p) => canonicalAddress(p)).filter(Boolean))];
  if (normalizedPeers.length === 0) return { ok: false, results: [], error: "no_peers_specified" };
  if (normalizedPeers.length > 25) return { ok: false, results: [], error: "too_many_peers" };

  // Validate every peer BEFORE charging any Hosted A2A budget. A bad/untrusted peer must not
  // consume a reservation, and a multi-peer request must not partially pass protocol preconditions.
  const preflights: PeerPreflight[] = [];
  const preflightFailures: PeerCoordinationResult[] = [];
  for (const peer of normalizedPeers) {
    const checked = await preflightPeer(env, workspaceId, peer, opts);
    if (checked.ok) preflights.push(checked.value);
    else preflightFailures.push(checked.result);
  }
  if (preflightFailures.length > 0) {
    const byPeer = new Map(preflightFailures.map((r) => [r.peer, r]));
    const results = normalizedPeers.map((peer) => byPeer.get(peer) ?? ({ peer, ok: false, error: "coordination_aborted_peer_precondition" }));
    return { ok: false, results, error: preflightFailures[0]?.error ?? "peer_precondition_failed" };
  }

  const hooks = getHostHooks();
  const beforeA2a = hooks.beforeA2aOutbound;
  const releaseA2a = hooks.releaseA2aOutbound;
  const newPreflights = preflights.filter((p) => !p.existingInit);

  // Hosted multi-peer admission is all-or-nothing. If a host installs a budget gate but cannot
  // exactly release earlier reservations, fail before touching quota rather than leaking quota.
  if (beforeA2a && newPreflights.length > 1 && !releaseA2a) {
    return {
      ok: false,
      results: normalizedPeers.map((peer) => ({ peer, ok: false, error: "a2a_release_hook_required" })),
      error: "a2a_release_hook_required",
    };
  }

  const reserved: PeerPreflight[] = [];
  if (beforeA2a) {
    for (const p of newPreflights) {
      let decision: { allow: boolean; reason?: string };
      try {
        decision = await beforeA2a(env, { workspaceId, peerAddress: p.peer, logicalKey: p.logicalKey });
      } catch {
        decision = { allow: false, reason: "a2a_budget_error" };
      }
      if (!decision.allow) {
        if (releaseA2a) {
          await Promise.allSettled(reserved.map((r) => releaseA2a(env, {
            workspaceId,
            peerAddress: r.peer,
            logicalKey: r.logicalKey,
          })));
        }
        const reason = decision.reason ?? "a2a_budget_denied";
        return {
          ok: false,
          results: normalizedPeers.map((peer) => ({ peer, ok: false, error: reason })),
          error: reason,
        };
      }
      reserved.push(p);
    }
  }

  const results: PeerCoordinationResult[] = [];
  for (const p of preflights) {
    const peerRes = await coordinateSinglePeer(env, {
      workspaceId,
      mailboxAddress: mailbox.address,
      preflight: p,
      opts,
      nowMs,
      budgetReserved: Boolean(beforeA2a && !p.existingInit),
    });
    results.push(peerRes);
  }

  const allOk = results.length > 0 && results.every((r) => r.ok);
  return { ok: allOk, results, error: allOk ? undefined : results.find((r) => !r.ok)?.error };
}

async function coordinateSinglePeer(
  env: Env,
  args: {
    workspaceId: string;
    mailboxAddress: string;
    preflight: PeerPreflight;
    opts: StartScheduleCoordinationOpts;
    nowMs: number;
    budgetReserved?: boolean;
  },
): Promise<PeerCoordinationResult> {
  const { workspaceId, mailboxAddress, preflight, opts, nowMs } = args;
  const { peer, peerIssuer, logicalKey, requestJson } = preflight;

  let initiationId: string;
  let protocolConvoId: string;

  if (preflight.existingInit) {
    initiationId = preflight.existingInit.id;
    protocolConvoId = preflight.existingInit.protocol_convo_id;
  } else {
    const proposedInitiationId = newId("ainit");
    const proposedProtocolConvoId = newId("cv");
    await env.DB.prepare(
      `INSERT INTO a2a_initiations (
         id, workspace_id, logical_key, protocol_convo_id, peer_address, intent,
         request_json, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'coordinate.schedule', ?, 'allocated', ?, ?)
       ON CONFLICT(workspace_id, logical_key) DO NOTHING`,
    )
      .bind(proposedInitiationId, workspaceId, logicalKey, proposedProtocolConvoId, peer, requestJson, nowMs, nowMs)
      .run();

    // Always re-read the durable winner. A concurrent idempotent caller may have won the INSERT.
    const durable = await env.DB.prepare(
      `SELECT id, protocol_convo_id, state, request_json FROM a2a_initiations WHERE workspace_id=? AND logical_key=?`,
    )
      .bind(workspaceId, logicalKey)
      .first<ExistingInitiation>();
    if (!durable) return { peer, ok: false, error: "initiation_allocation_failed" };
    if (durable.request_json !== requestJson) {
      return { peer, ok: false, error: "idempotency_key_reused_with_different_request" };
    }
    initiationId = durable.id;
    protocolConvoId = durable.protocol_convo_id;
  }

  let convoRow = await env.DB.prepare(
    `SELECT id, state FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`,
  )
    .bind(workspaceId, protocolConvoId)
    .first<{ id: string; state: string }>();

  if (!convoRow) {
    const proposedLocalConvoId = newId("acv");
    const expiresAt = nowMs + 14 * 86_400_000;
    const initialPayloadJson = JSON.stringify({
      __a2a: { peerIssuer, lastInboundSeq: null, lastSeq: 0, createdAt: nowMs },
    });
    await env.DB.prepare(
      `INSERT INTO a2a_convos (
         id, workspace_id, protocol_convo_id, role, peer_address, peer_issuer,
         intent, state, payload_json, revision, rounds, max_rounds, budget_micro,
         spent_micro, expires_at, thread_id, root_task_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'initiator', ?, ?, 'coordinate.schedule', 'new', ?, 0, 0, 12, 10000000, 0, ?, NULL, ?, ?, ?)
       ON CONFLICT(workspace_id, protocol_convo_id) DO NOTHING`,
    )
      .bind(
        proposedLocalConvoId,
        workspaceId,
        protocolConvoId,
        peer,
        peerIssuer,
        initialPayloadJson,
        expiresAt,
        opts.rootTaskId ?? null,
        nowMs,
        nowMs,
      )
      .run();
    convoRow = await env.DB.prepare(
      `SELECT id, state FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`,
    )
      .bind(workspaceId, protocolConvoId)
      .first<{ id: string; state: string }>();
    if (!convoRow) return { peer, ok: false, protocolConvoId, error: "convo_allocation_failed" };
  }
  const localConvoId = convoRow.id;

  // Narrow disclosure only. Event titles, attendees, Vault, mail and contact graph never enter payload.
  const payload = {
    timeWindow: opts.timeWindow,
    durationMinutes: opts.durationMinutes,
    preference: opts.preference ?? "any",
    ...serializeDisclosure((opts.facts ?? {}) as Record<string, unknown>),
  };

  const sendRes = await sendA2aResponse(env, {
    workspaceId,
    fromAgent: mailboxAddress,
    toAgent: peer,
    type: "propose",
    convo: protocolConvoId,
    intent: "coordinate.schedule",
    payload,
    facts: opts.facts,
    rootTaskId: opts.rootTaskId,
    logicalKey,
    nowMs,
    ttlMs: 7 * 86_400_000,
    budgetReserved: args.budgetReserved,
  });

  if (!sendRes.ok) {
    await env.DB.prepare(`UPDATE a2a_initiations SET last_error=?, updated_at=? WHERE id=?`)
      .bind(sendRes.error ?? "propose_send_failed", nowMs, initiationId)
      .run()
      .catch(() => undefined);
    return { peer, ok: false, convoId: localConvoId, protocolConvoId, error: sendRes.error };
  }

  await env.DB.prepare(`UPDATE a2a_initiations SET state='proposed', last_error=NULL, updated_at=? WHERE id=?`)
    .bind(nowMs, initiationId)
    .run()
    .catch(() => undefined);

  return {
    peer,
    ok: true,
    convoId: localConvoId,
    protocolConvoId,
    outboxId: sendRes.outboxId,
    state: sendRes.state,
  };
}
