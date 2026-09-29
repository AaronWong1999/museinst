


//







import type { Env } from "../../../env";
import { newId } from "../../../util";
import type { A2aEnvelope, A2aMessageType } from "./schema";
import { serializeDisclosure } from "./disclosure";

export type A2aState =
  | "new"
  | "proposed"
  | "negotiating"
  | "pending_owner_ok"
  | "confirmed"
  | "declined"
  | "cancelled"
  | "expired"
  | "halted";

export const INITIAL_STATE: A2aState = "new";
export const TERMINAL_STATES: ReadonlySet<string> = new Set(["confirmed", "declined", "cancelled", "expired", "halted"]);

export const DEFAULT_MAX_ROUNDS = 12;
export const DEFAULT_BUDGET_MICRO = 10_000_000;

export const MAX_CONVO_TTL_MS = 14 * 86_400_000;

const TRANSITIONS: Record<string, Record<string, string>> = {
  new: { propose: "proposed" },
  proposed: { propose: "negotiating", counter: "negotiating", accept: "pending_owner_ok", decline: "declined", cancel: "cancelled" },
  negotiating: { propose: "negotiating", counter: "negotiating", accept: "pending_owner_ok", decline: "declined", cancel: "cancelled" },
  pending_owner_ok: { confirm: "confirmed", decline: "declined", cancel: "cancelled" },
  confirmed: {},
  declined: {},
  cancelled: {},
  expired: {},
  halted: {},
};

export function nextState(current: string, type: A2aMessageType): string | null {
  const row = TRANSITIONS[current];
  if (!row) return null;
  return row[type] ?? null;
}

export interface ConvoRow {
  id: string;
  workspace_id: string;
  protocol_convo_id: string;
  role: string;
  peer_address: string;
  peer_issuer: string | null;
  intent: string;
  state: string;
  payload_json: string;
  revision: number;
  rounds: number;
  max_rounds: number;
  budget_micro: number;
  spent_micro: number;
  expires_at: number;
  thread_id: string | null;
  root_task_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface StepResult {
  ok: boolean;
  state?: string;
  revision?: number;
  convoId?: string;
  error?: string;
  halted?: boolean;
}


const META_KEY = "__a2a";

interface ConvoMeta {
  peerIssuer?: string;
  lastInboundSeq?: number | null;
  ownerApprovalAt?: number | null;
  ownerApprovedBy?: string | null;
  lastSeq?: number | null;
  receivedType?: string;
  [k: string]: unknown;
}

export function convoMeta(payloadJson: string): ConvoMeta {
  try {
    const parsed = JSON.parse(payloadJson || "{}") as Record<string, unknown>;
    const meta = parsed?.[META_KEY];
    return meta && typeof meta === "object" ? (meta as ConvoMeta) : {};
  } catch {
    return {};
  }
}

export function hasOwnerApproval(payloadJson: string): boolean {
  const at = convoMeta(payloadJson).ownerApprovalAt;
  return typeof at === "number" && at > 0;
}


async function patchConvoMeta(env: Env, convoId: string, patch: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(
    `UPDATE a2a_convos SET payload_json=json_set(payload_json, '$.${META_KEY}', json_patch(COALESCE(json_extract(payload_json, '$.${META_KEY}'), '{}'), ?)) WHERE id=?`,
  )
    .bind(JSON.stringify(patch), convoId)
    .run();
}



export type SeqReservationResult =
  | { ok: true; mode: "reserved" | "resumed" }
  | { ok: false; error: "replay" | "db_error"; detail?: string };

export interface A2aMessageKey {
  workspaceId: string;
  protocolConvoId: string;
  peerAddress: string;
  direction: "in" | "out";
  seq: number;
}

export async function findA2aMessage(env: Env, key: A2aMessageKey): Promise<{ id: string; payload_json: string } | null> {
  return await env.DB.prepare(
    `SELECT id, payload_json FROM a2a_messages WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=? AND direction=? AND seq=?`,
  )
    .bind(key.workspaceId, key.protocolConvoId, key.peerAddress.toLowerCase(), key.direction, key.seq)
    .first<{ id: string; payload_json: string }>();
}








export async function reserveA2aSeq(env: Env, key: A2aMessageKey & { nowMs?: number }): Promise<SeqReservationResult> {
  const peer = key.peerAddress.toLowerCase();
  let inserted = 0;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO a2a_seq_reservations (workspace_id, protocol_convo_id, peer_address, direction, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, protocol_convo_id, peer_address, direction, seq) DO NOTHING`,
    )
      .bind(key.workspaceId, key.protocolConvoId, peer, key.direction, key.seq, key.nowMs ?? Date.now())
      .run();
    inserted = r.meta?.changes ?? 0;
  } catch (e) {
    return { ok: false, error: "db_error", detail: String(e).slice(0, 200) };
  }
  if (inserted === 1) return { ok: true, mode: "reserved" };
  try {
    const existing = await findA2aMessage(env, { ...key, peerAddress: peer });
    if (existing) return { ok: false, error: "replay" };
  } catch (e) {
    return { ok: false, error: "db_error", detail: String(e).slice(0, 200) };
  }
  return { ok: true, mode: "resumed" };
}



export interface PersistA2aMessageInput {
  workspaceId: string;
  localConvoId: string;
  protocolConvoId: string;
  peerAddress: string;
  peerIssuer: string;
  direction: "in" | "out";
  envelope: A2aEnvelope;
  humanBody: string;
  emailId?: string | null;
  verified: boolean;
  nowMs?: number;

  extraPayload?: Record<string, unknown>;
}

export async function persistA2aMessage(
  env: Env,
  input: PersistA2aMessageInput,
): Promise<{ ok: true; messageRowId: string; created: boolean } | { ok: false; error: "replay" | "db_error"; detail?: string }> {
  const id = newId("amsg");
  const peer = input.peerAddress.toLowerCase();
  const payload: Record<string, unknown> = { ...(input.envelope.payload ?? {}), ...(input.extraPayload ?? {}) };
  try {
    const r = await env.DB.prepare(
      `INSERT INTO a2a_messages (id, workspace_id, local_convo_id, protocol_convo_id, peer_address, direction, type, seq,
         envelope_json, payload_json, human_body, human_body_sha256, sig_kid, verified, email_id, issuer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
      .bind(
        id,
        input.workspaceId,
        input.localConvoId,
        input.protocolConvoId,
        peer,
        input.direction,
        input.envelope.type,
        input.envelope.seq,
        JSON.stringify(input.envelope),
        JSON.stringify(payload),
        input.humanBody.slice(0, 20_000),
        input.envelope.humanBodySha256,
        input.envelope.kid,
        input.verified ? 1 : 0,
        input.emailId ?? null,
        input.peerIssuer.toLowerCase(),
        input.nowMs ?? Date.now(),
      )
      .run();
    if ((r.meta?.changes ?? 0) === 1) return { ok: true, messageRowId: id, created: true };
    const existing = await findA2aMessage(env, {
      workspaceId: input.workspaceId,
      protocolConvoId: input.protocolConvoId,
      peerAddress: peer,
      direction: input.direction,
      seq: input.envelope.seq,
    });
    if (existing) return { ok: true, messageRowId: existing.id, created: false };
    return { ok: false, error: "db_error", detail: "insert_conflict_without_row" };
  } catch (e) {
    return { ok: false, error: "db_error", detail: String(e).slice(0, 200) };
  }
}


export async function markA2aMessageApplied(
  env: Env,
  opts: { messageRowId: string; revision: number; state: string; nowMs?: number },
): Promise<void> {
  const patch = { __applied: { revision: opts.revision, state: opts.state, at: opts.nowMs ?? Date.now() } };
  await env.DB.prepare(
    `UPDATE a2a_messages SET payload_json=json_patch(payload_json, ?) WHERE id=?`,
  )
    .bind(JSON.stringify(patch), opts.messageRowId)
    .run();
}



export interface EnsureConvoInput {
  workspaceId: string;
  protocolConvoId: string;
  peerAddress: string;
  peerIssuer: string;
  envelope: A2aEnvelope;
  threadId?: string | null;
  rootTaskId?: string | null;
  maxRounds?: number;
  budgetMicro?: number;
  nowMs?: number;
}






export async function ensureInboundConvo(
  env: Env,
  input: EnsureConvoInput,
): Promise<{ ok: true; convo: ConvoRow; created: boolean } | { ok: false; error: string }> {
  const nowMs = input.nowMs ?? Date.now();
  const peer = input.peerAddress.toLowerCase();
  const issuer = input.peerIssuer.toLowerCase();
  const existing = await env.DB.prepare(`SELECT * FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`)
    .bind(input.workspaceId, input.protocolConvoId)
    .first<ConvoRow>();
  if (!existing && input.envelope.type !== "propose") {

    return { ok: false, error: "unknown_convo" };
  }
  if (existing) {
    if (String(existing.peer_address).toLowerCase() !== peer) return { ok: false, error: "convo_peer_mismatch" };
    const existingIssuer = String(existing.peer_issuer ?? "").toLowerCase();
    if (existingIssuer && existingIssuer !== issuer) return { ok: false, error: "convo_issuer_mismatch" };
    if (!existingIssuer) await patchConvoMeta(env, existing.id, { peerIssuer: issuer });
    return { ok: true, convo: existing, created: false };
  }
  const ttlExpiry = Math.min(input.envelope.exp * 1000, nowMs + MAX_CONVO_TTL_MS);
  const expiresAt = Math.max(ttlExpiry, nowMs + 60_000);
  const payload = {
    ...serializeDisclosure(input.envelope.payload ?? {}),
    [META_KEY]: { peerIssuer: issuer, lastInboundSeq: null, receivedType: input.envelope.type, createdAt: nowMs },
  };
  const id = newId("acv");
  const r = await env.DB.prepare(
    `INSERT INTO a2a_convos (id, workspace_id, protocol_convo_id, role, peer_address, peer_issuer, intent, state, payload_json,
       revision, rounds, max_rounds, budget_micro, spent_micro, expires_at, thread_id, root_task_id, created_at, updated_at)
     VALUES (?, ?, ?, 'recipient', ?, ?, ?, 'new', ?, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, protocol_convo_id) DO NOTHING`,
  )
    .bind(
      id,
      input.workspaceId,
      input.protocolConvoId,
      peer,
      issuer,
      input.envelope.intent,
      JSON.stringify(payload),
      input.maxRounds ?? DEFAULT_MAX_ROUNDS,
      input.budgetMicro ?? DEFAULT_BUDGET_MICRO,
      expiresAt,
      input.threadId ?? null,
      input.rootTaskId ?? null,
      nowMs,
      nowMs,
    )
    .run();
  const convo =
    (r.meta?.changes ?? 0) === 1
      ? await env.DB.prepare(`SELECT * FROM a2a_convos WHERE id=?`).bind(id).first<ConvoRow>()
      : await env.DB.prepare(`SELECT * FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`)
          .bind(input.workspaceId, input.protocolConvoId)
          .first<ConvoRow>();
  if (!convo) return { ok: false, error: "convo_create_failed" };
  if (String(convo.peer_address).toLowerCase() !== peer) return { ok: false, error: "convo_peer_mismatch" };
  return { ok: true, convo, created: (r.meta?.changes ?? 0) === 1 };
}



export interface StepConvoOpts {
  workspaceId: string;
  protocolConvoId: string;
  envelope: A2aEnvelope;
  nowMs?: number;

  seqReserved?: boolean;
  maxCasRetries?: number;
}






export async function stepConvo(env: Env, opts: StepConvoOpts): Promise<StepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const seq = opts.envelope.seq;
  if (!opts.seqReserved) {
    const reserved = await reserveA2aSeq(env, {
      workspaceId: opts.workspaceId,
      protocolConvoId: opts.protocolConvoId,
      peerAddress: opts.envelope.fromAgent,
      direction: "in",
      seq,
      nowMs,
    });
    if (!reserved.ok) return { ok: false, error: reserved.error === "replay" ? "seq_replay" : reserved.error };
  }

  const maxRetries = opts.maxCasRetries ?? 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const convo = await env.DB.prepare(`SELECT * FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`)
      .bind(opts.workspaceId, opts.protocolConvoId)
      .first<ConvoRow>();
    if (!convo) return { ok: false, error: "unknown_convo" };
    const meta = convoMeta(convo.payload_json);
    if (meta.lastInboundSeq === seq) return { ok: false, error: "replay" };
    if (TERMINAL_STATES.has(convo.state)) return { ok: false, error: `terminal_${convo.state}` };
    if (convo.expires_at < nowMs) {
      const halted = await haltConvo(env, convo, "expired", nowMs);
      if (!halted) continue;
      return { ok: false, error: "expired", halted: true };
    }
    if (convo.rounds >= convo.max_rounds) {
      const halted = await haltConvo(env, convo, "halted", nowMs);
      if (!halted) continue;
      return { ok: false, error: "max_rounds", halted: true };
    }
    if (convo.spent_micro >= convo.budget_micro) {
      const halted = await haltConvo(env, convo, "halted", nowMs);
      if (!halted) continue;
      return { ok: false, error: "budget_exceeded", halted: true };
    }
    if (opts.envelope.type === "confirm" && !hasOwnerApproval(convo.payload_json)) {

      return { ok: false, error: "owner_approval_required" };
    }
    const target = nextState(convo.state, opts.envelope.type);
    if (!target) return { ok: false, error: `illegal_transition_${convo.state}_${opts.envelope.type}` };

    const r = await env.DB.prepare(
      `UPDATE a2a_convos SET state=?, rounds=rounds+1, revision=revision+1, updated_at=?,
         payload_json=json_set(payload_json, '$.${META_KEY}.lastInboundSeq', ?, '$.${META_KEY}.lastSeq', ?)
       WHERE id=? AND revision=? AND state=?`,
    )
      .bind(target, nowMs, seq, seq, convo.id, convo.revision, convo.state)
      .run();
    if ((r.meta?.changes ?? 0) === 1) {
      return { ok: true, state: target, revision: convo.revision + 1, convoId: convo.id };
    }

  }
  return { ok: false, error: "cas_conflict_retry" };
}

async function haltConvo(env: Env, convo: ConvoRow, state: string, nowMs: number): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE a2a_convos SET state=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?`)
    .bind(state, nowMs, convo.id, convo.revision)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}







export async function recordOwnerApproval(
  env: Env,
  opts: { workspaceId: string; protocolConvoId: string; approve: boolean; by?: string; nowMs?: number },
): Promise<{ ok: true; state: string } | { ok: false; error: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const convo = await env.DB.prepare(`SELECT * FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`)
    .bind(opts.workspaceId, opts.protocolConvoId)
    .first<ConvoRow>();
  if (!convo) return { ok: false, error: "unknown_convo" };
  if (TERMINAL_STATES.has(convo.state)) return { ok: false, error: `terminal_${convo.state}` };
  if (opts.approve) {
    await patchConvoMeta(env, convo.id, { ownerApprovalAt: nowMs, ownerApprovedBy: opts.by ?? "owner" });
    return { ok: true, state: convo.state };
  }
  const r = await env.DB.prepare(`UPDATE a2a_convos SET state='declined', revision=revision+1, updated_at=? WHERE id=? AND revision=?`)
    .bind(nowMs, convo.id, convo.revision)
    .run();
  if ((r.meta?.changes ?? 0) !== 1) return { ok: false, error: "cas_conflict_retry" };
  return { ok: true, state: "declined" };
}


export async function markConvoConfirmedByOwner(
  env: Env,
  opts: { workspaceId: string; protocolConvoId: string; nowMs?: number },
): Promise<{ ok: true; state: string } | { ok: false; error: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const convo = await env.DB.prepare(`SELECT * FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`)
    .bind(opts.workspaceId, opts.protocolConvoId)
    .first<ConvoRow>();
  if (!convo) return { ok: false, error: "unknown_convo" };
  if (convo.state === "confirmed") return { ok: true, state: "confirmed" };
  if (convo.state !== "pending_owner_ok") return { ok: false, error: `illegal_transition_${convo.state}_confirm` };
  if (!hasOwnerApproval(convo.payload_json)) return { ok: false, error: "owner_approval_required" };
  const r = await env.DB.prepare(
    `UPDATE a2a_convos SET state='confirmed', rounds=rounds+1, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND state='pending_owner_ok'`,
  )
    .bind(nowMs, convo.id, convo.revision)
    .run();
  if ((r.meta?.changes ?? 0) !== 1) return { ok: false, error: "cas_conflict_retry" };
  return { ok: true, state: "confirmed" };
}


export async function chargeA2aConvo(
  env: Env,
  opts: { workspaceId: string; protocolConvoId: string; micro: number; nowMs?: number },
): Promise<{ ok: boolean; spentMicro?: number; error?: string }> {
  if (!Number.isFinite(opts.micro) || opts.micro < 0) return { ok: false, error: "bad_micro" };
  const nowMs = opts.nowMs ?? Date.now();
  const r = await env.DB.prepare(
    `UPDATE a2a_convos SET spent_micro=spent_micro+?, revision=revision+1, updated_at=? WHERE workspace_id=? AND protocol_convo_id=?`,
  )
    .bind(Math.round(opts.micro), nowMs, opts.workspaceId, opts.protocolConvoId)
    .run();
  if ((r.meta?.changes ?? 0) !== 1) return { ok: false, error: "unknown_convo" };
  const row = await env.DB.prepare(`SELECT spent_micro FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`)
    .bind(opts.workspaceId, opts.protocolConvoId)
    .first<{ spent_micro: number }>();
  return { ok: true, spentMicro: row?.spent_micro ?? 0 };
}


export async function listPendingOwnerApprovals(env: Env, workspaceId: string, limit = 20): Promise<ConvoRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM a2a_convos WHERE workspace_id=? AND state='pending_owner_ok' ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(workspaceId, limit)
    .all<ConvoRow>();
  return results ?? [];
}


export async function listHaltedConvos(env: Env, workspaceId: string, limit = 20): Promise<ConvoRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM a2a_convos WHERE workspace_id=? AND state IN ('halted','expired') ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(workspaceId, limit)
    .all<ConvoRow>();
  return results ?? [];
}


export function shouldNotifyHalt(error: string): boolean {
  return error === "max_rounds" || error === "budget_exceeded" || error === "expired";
}
