// channels/email/a2a/outbound.ts — crash-safe A2A outbound pipeline.
//







import type { Env } from "../../../env";
import { newId } from "../../../util";
import { b64urlEncode, sha256HexString } from "./codec";
import { signEnvelope } from "./sign";
import { renderHumanBody } from "./render";
import type { ScheduleFacts } from "./disclosure";
import type { A2aEnvelope, A2aMessageType } from "./schema";
import { getHostHooks } from "../../../hooks";
import { convoMeta, hasOwnerApproval, nextState, recordOwnerApproval, reserveA2aSeq } from "./statemachine";
import { getOutboundMessageId } from "../outbox";

export interface LocalSigningKey {
  privateJwk: JsonWebKey;
  publicX: string;
  kid: string;
  issuer: string;
}

export function resolveLocalSigningKey(env: Env): { ok: true; key: LocalSigningKey } | { ok: false; error: string } {
  const raw = env.A2A_SIGNING_PRIVATE_JWK;
  if (!raw) return { ok: false, error: "signing_key_not_configured" };
  let jwk: JsonWebKey & { kid?: string; issuer?: string };
  try {
    jwk = JSON.parse(raw) as typeof jwk;
  } catch {
    return { ok: false, error: "signing_key_invalid_json" };
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || !jwk.d) return { ok: false, error: "signing_key_invalid" };
  const published = findPublishedKey(env, String(jwk.x));
  if (!published) return { ok: false, error: "signing_key_not_published" };
  const kid = String(jwk.kid ?? published.kid);
  if (kid !== published.kid) return { ok: false, error: "signing_key_kid_mismatch" };
  const issuer = String(jwk.issuer ?? published.issuer).toLowerCase();
  if (issuer !== published.issuer) return { ok: false, error: "signing_key_issuer_mismatch" };
  return { ok: true, key: { privateJwk: jwk, publicX: String(jwk.x), kid, issuer } };
}

function findPublishedKey(env: Env, x: string): { kid: string; issuer: string } | null {
  const raw = env.A2A_SIGNING_PUBLIC_JWKS_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { issuers?: Record<string, { keys?: Record<string, { x?: string }> }> };
    for (const [issuer, entry] of Object.entries(parsed.issuers ?? {})) {
      for (const [kid, k] of Object.entries(entry.keys ?? {})) {
        if (k?.x === x) return { kid, issuer: issuer.toLowerCase() };
      }
    }
  } catch {
    return null;
  }
  return null;
}


export async function nextOutboundSeq(
  env: Env,
  opts: { workspaceId: string; protocolConvoId: string; peerAddress: string; nowMs?: number },
): Promise<{ ok: true; seq: number } | { ok: false; error: string }> {
  const peer = opts.peerAddress.toLowerCase();
  const row = await env.DB.prepare(
    `SELECT MAX(seq) AS max_seq FROM (
       SELECT seq FROM a2a_messages WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=? AND direction='out'
       UNION ALL
       SELECT seq FROM a2a_seq_reservations WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=? AND direction='out'
       UNION ALL
       SELECT seq FROM a2a_outbound_intents WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=?
     )`,
  )
    .bind(
      opts.workspaceId, opts.protocolConvoId, peer,
      opts.workspaceId, opts.protocolConvoId, peer,
      opts.workspaceId, opts.protocolConvoId, peer,
    )
    .first<{ max_seq: number | null }>();
  let seq = Math.max(1, Number(row?.max_seq ?? 0) + 1);
  for (let i = 0; i < 8; i++) {
    const reserved = await reserveA2aSeq(env, {
      workspaceId: opts.workspaceId,
      protocolConvoId: opts.protocolConvoId,
      peerAddress: peer,
      direction: "out",
      seq,
      nowMs: opts.nowMs,
    });
    if (reserved.ok) return { ok: true, seq };
    if (reserved.error === "db_error") return { ok: false, error: "db_error" };
    seq += 1;
  }
  return { ok: false, error: "seq_alloc_failed" };
}

export interface SendA2aResponseOpts {
  workspaceId: string;
  fromAgent: string;
  toAgent: string;
  type: A2aMessageType;
  convo: string;
  intent: "coordinate.schedule";
  payload: Record<string, unknown>;
  facts?: ScheduleFacts;
  lang?: "zh" | "en";
  note?: string;
  threadId?: string | null;
  rootTaskId?: string | null;
  logicalKey: string;
  inReplyTo?: string | null;
  references?: string[];
  subject?: string;
  nowMs?: number;
  ttlMs?: number;

  budgetReserved?: boolean;
}

export interface SendA2aResponseResult {
  ok: boolean;
  outboxId?: string;
  seq?: number;
  envelope?: A2aEnvelope;
  state?: string;
  error?: string;
}

interface StoredRequest {
  fromAgent: string;
  toAgent: string;
  type: A2aMessageType;
  convo: string;
  intent: "coordinate.schedule";
  payload: Record<string, unknown>;
  facts: ScheduleFacts;
  lang: "zh" | "en" | null;
  note: string | null;
  threadId: string | null;
  rootTaskId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  ttlMs: number;
}

interface OutboundIntentRow {
  workspace_id: string;
  logical_key: string;
  request_hash: string;
  request_json: string;
  protocol_convo_id: string;
  local_convo_id: string;
  peer_address: string;
  from_agent: string;
  peer_issuer: string;
  message_type: string;
  source_state: string;
  source_revision: number;
  desired_state: string;
  seq: number;
  envelope_json: string | null;
  signature: string | null;
  human_body: string | null;
  outbox_id: string | null;
  message_id: string | null;
  state: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function requestFromOpts(opts: SendA2aResponseOpts): StoredRequest {
  return {
    fromAgent: opts.fromAgent.toLowerCase(),
    toAgent: opts.toAgent.toLowerCase(),
    type: opts.type,
    convo: opts.convo,
    intent: opts.intent,
    payload: opts.payload ?? {},
    facts: opts.facts ?? {},
    lang: opts.lang ?? null,
    note: opts.note ?? null,
    threadId: opts.threadId ?? null,
    rootTaskId: opts.rootTaskId ?? null,
    inReplyTo: opts.inReplyTo ?? null,
    references: opts.references ?? [],
    subject: opts.subject ?? null,
    ttlMs: opts.ttlMs ?? 7 * 86_400_000,
  };
}

function requestJson(req: StoredRequest): string {
  return JSON.stringify(stableValue(req));
}

async function requestHash(json: string): Promise<string> {
  return sha256HexString(json);
}

function parseStoredRequest(row: OutboundIntentRow): StoredRequest | null {
  try {
    const v = JSON.parse(row.request_json) as StoredRequest;
    if (!v || typeof v !== "object") return null;
    if (typeof v.fromAgent !== "string" || typeof v.toAgent !== "string" || typeof v.convo !== "string") return null;
    if (v.intent !== "coordinate.schedule" || typeof v.type !== "string") return null;
    if (!v.payload || typeof v.payload !== "object" || Array.isArray(v.payload)) return null;
    if (!Array.isArray(v.references)) v.references = [];
    if (!Number.isFinite(Number(v.ttlMs)) || Number(v.ttlMs) <= 0) v.ttlMs = 7 * 86_400_000;
    return v;
  } catch {
    return null;
  }
}

async function loadIntent(env: Env, workspaceId: string, logicalKey: string): Promise<OutboundIntentRow | null> {
  return await env.DB.prepare(`SELECT * FROM a2a_outbound_intents WHERE workspace_id=? AND logical_key=?`)
    .bind(workspaceId, logicalKey)
    .first<OutboundIntentRow>();
}


export async function hasA2aOutboundIntent(env: Env, workspaceId: string, logicalKey: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS x FROM a2a_outbound_intents WHERE workspace_id=? AND logical_key=?`)
    .bind(workspaceId, logicalKey)
    .first<{ x: number }>());
}

function parseStoredEnvelope(row: OutboundIntentRow): A2aEnvelope | null {
  if (!row.envelope_json) return null;
  try {
    return JSON.parse(row.envelope_json) as A2aEnvelope;
  } catch {
    return null;
  }
}

function validateExistingIntent(row: OutboundIntentRow, req: StoredRequest, reqHash: string): string | null {
  if (row.request_hash !== reqHash) return "logical_key_reused_with_different_payload";
  if (row.protocol_convo_id !== req.convo) return "logical_key_convo_mismatch";
  if (row.peer_address !== req.toAgent) return "logical_key_peer_mismatch";
  if (row.from_agent !== req.fromAgent) return "logical_key_sender_mismatch";
  if (row.message_type !== req.type) return "logical_key_type_mismatch";
  return null;
}

async function ensureAllocatedIntent(
  env: Env,
  opts: SendA2aResponseOpts,
  key: LocalSigningKey,
  req: StoredRequest,
  reqJson: string,
  reqHash: string,
): Promise<{ ok: true; row: OutboundIntentRow } | { ok: false; error: string }> {
  const existing = await loadIntent(env, opts.workspaceId, opts.logicalKey);
  if (existing) {
    const invalid = validateExistingIntent(existing, req, reqHash);
    if (invalid) return { ok: false, error: invalid };
    if (existing.state === "stale") return { ok: false, error: existing.last_error ?? "stale_intent" };
    return { ok: true, row: existing };
  }

  const legacy = await env.DB.prepare(`SELECT id FROM email_outbox WHERE workspace_id=? AND logical_key=?`)
    .bind(opts.workspaceId, opts.logicalKey)
    .first<{ id: string }>();
  if (legacy) return { ok: false, error: "legacy_outbox_without_durable_intent" };

  const convo = await env.DB.prepare(
    `SELECT id, state, revision, payload_json, peer_address FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`,
  )
    .bind(opts.workspaceId, req.convo)
    .first<{ id: string; state: string; revision: number; payload_json: string; peer_address: string }>();
  if (!convo) return { ok: false, error: "unknown_convo" };
  if (String(convo.peer_address).toLowerCase() !== req.toAgent) return { ok: false, error: "convo_peer_mismatch" };
  if (req.type === "confirm" && !hasOwnerApproval(convo.payload_json)) return { ok: false, error: "owner_approval_required" };
  const desired = nextState(convo.state, req.type);
  if (!desired) return { ok: false, error: `illegal_transition_${convo.state}_${req.type}` };

  const createdAt = opts.nowMs ?? Date.now();
  const peer = req.toAgent;
  for (let attempt = 0; attempt < 12; attempt++) {
    const max = await env.DB.prepare(
      `SELECT MAX(seq) AS max_seq FROM (
         SELECT seq FROM a2a_messages WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=? AND direction='out'
         UNION ALL
         SELECT seq FROM a2a_seq_reservations WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=? AND direction='out'
         UNION ALL
         SELECT seq FROM a2a_outbound_intents WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=?
       )`,
    )
      .bind(
        opts.workspaceId, req.convo, peer,
        opts.workspaceId, req.convo, peer,
        opts.workspaceId, req.convo, peer,
      )
      .first<{ max_seq: number | null }>();
    const seq = Math.max(1, Number(max?.max_seq ?? 0) + 1);
    try {
      await env.DB.prepare(
        `INSERT INTO a2a_outbound_intents
          (workspace_id, logical_key, request_hash, request_json, protocol_convo_id, local_convo_id, peer_address, from_agent,
           peer_issuer, message_type, source_state, source_revision, desired_state, seq, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'allocated', ?, ?)
         ON CONFLICT(workspace_id, logical_key) DO NOTHING`,
      )
        .bind(
          opts.workspaceId, opts.logicalKey, reqHash, reqJson, req.convo, convo.id, peer, req.fromAgent,
          key.issuer, req.type, convo.state, convo.revision, desired, seq, createdAt, createdAt,
        )
        .run();
    } catch (e) {
      const raced = await loadIntent(env, opts.workspaceId, opts.logicalKey);
      if (!raced) {
        if (attempt < 11) continue;
        return { ok: false, error: `intent_seq_allocate_failed:${String(e).slice(0, 120)}` };
      }
    }
    const row = await loadIntent(env, opts.workspaceId, opts.logicalKey);
    if (!row) continue;
    const invalid = validateExistingIntent(row, req, reqHash);
    if (invalid) return { ok: false, error: invalid };
    return { ok: true, row };
  }
  return { ok: false, error: "intent_seq_allocate_failed" };
}

async function ensurePreparedIntent(
  env: Env,
  row: OutboundIntentRow,
  signing?: LocalSigningKey,
): Promise<{ ok: true; row: OutboundIntentRow; envelope: A2aEnvelope } | { ok: false; error: string }> {
  if (row.state === "state_committed") {
    const envelope = parseStoredEnvelope(row);
    if (!envelope) return { ok: false, error: "committed_intent_missing_envelope" };
    return { ok: true, row, envelope };
  }
  if (row.state === "stale") return { ok: false, error: row.last_error ?? "stale_intent" };

  const req = parseStoredRequest(row);
  if (!req) return { ok: false, error: "intent_request_corrupt" };

  if (!row.envelope_json || !row.signature || !row.human_body || !row.outbox_id || !row.message_id) {
    if (!signing) return { ok: false, error: "signing_key_required_to_prepare_intent" };
    const baseTime = Number(row.created_at);
    const humanBody = req.note ?? renderHumanBody({
      type: req.type,
      intent: req.intent,
      facts: req.facts ?? {},
      convo: req.convo,
      seq: row.seq,
      lang: req.lang ?? undefined,
    });
    const envelope: A2aEnvelope = {
      v: 1,
      issuer: signing.issuer,
      kid: signing.kid,
      fromAgent: req.fromAgent,
      toAgent: req.toAgent,
      type: req.type,
      convo: req.convo,
      seq: row.seq,
      intent: req.intent,
      iat: Math.floor(baseTime / 1000),
      exp: Math.floor((baseTime + req.ttlMs) / 1000),
      nonce: `${row.seq}_${baseTime.toString(36)}`,
      payload: req.payload,
      humanBodySha256: await sha256HexString(humanBody),
    };
    const sig = await signEnvelope(signing.privateJwk, envelope);
    const outboxId = row.outbox_id ?? newId("eob");
    const messageId = row.message_id ?? getOutboundMessageId(req.fromAgent);
    await env.DB.prepare(
      `UPDATE a2a_outbound_intents SET
         envelope_json=COALESCE(envelope_json, ?), signature=COALESCE(signature, ?), human_body=COALESCE(human_body, ?),
         outbox_id=COALESCE(outbox_id, ?), message_id=COALESCE(message_id, ?),
         state=CASE WHEN state='allocated' THEN 'prepared' ELSE state END, updated_at=?
       WHERE workspace_id=? AND logical_key=? AND request_hash=? AND state IN ('allocated','prepared')`,
    )
      .bind(
        JSON.stringify(envelope), sig, humanBody, outboxId, messageId, Date.now(),
        row.workspace_id, row.logical_key, row.request_hash,
      )
      .run();
  }

  const prepared = await loadIntent(env, row.workspace_id, row.logical_key);
  if (!prepared || !prepared.envelope_json || !prepared.signature || !prepared.human_body || !prepared.outbox_id || !prepared.message_id) {
    return { ok: false, error: "intent_prepare_failed" };
  }
  const envelope = parseStoredEnvelope(prepared);
  if (!envelope) return { ok: false, error: "intent_envelope_corrupt" };
  return { ok: true, row: prepared, envelope };
}

async function commitPreparedIntent(
  env: Env,
  row: OutboundIntentRow,
  envelope: A2aEnvelope,
): Promise<SendA2aResponseResult> {
  if (row.state === "state_committed") {
    return { ok: true, outboxId: row.outbox_id ?? undefined, seq: row.seq, envelope, state: row.desired_state };
  }
  if (!row.signature || !row.human_body || !row.outbox_id || !row.message_id) return { ok: false, error: "intent_not_prepared" };
  const req = parseStoredRequest(row);
  if (!req) return { ok: false, error: "intent_request_corrupt" };

  const desiredRevision = Number(row.source_revision) + 1;
  const t = Date.now();
  const headers: Record<string, string> = {
    "X-OpenInst-A2A-Envelope": b64urlEncode(new TextEncoder().encode(row.envelope_json!)),
    "X-OpenInst-A2A-Sig": row.signature,
    "X-OpenInst-A2A-Kid": envelope.kid,
    "X-OpenInst-A2A-Issuer": envelope.issuer,
    "Auto-Submitted": "auto-generated",
  };
  const subject = req.subject ?? `[MuseInst A2A] ${req.type} ${req.convo}`;
  const refsJson = req.references.length > 0 ? JSON.stringify(req.references) : null;
  const protocolRowId = newId("amsg");
  const confirmGuard = row.message_type === "confirm"
    ? ` AND CAST(json_extract(payload_json, '$.__a2a.ownerApprovalAt') AS INTEGER) > 0`
    : "";

  const convoUpdate = env.DB.prepare(
    `UPDATE a2a_convos SET
       state=?, rounds=rounds+1, revision=revision+1, updated_at=?,
       payload_json=json_set(payload_json, '$.__a2a.lastOutboundSeq', ?, '$.__a2a.lastSeq', ?)
     WHERE id=? AND workspace_id=? AND protocol_convo_id=? AND state=? AND revision=?${confirmGuard}`,
  ).bind(
    row.desired_state, t, row.seq, row.seq,
    row.local_convo_id, row.workspace_id, row.protocol_convo_id, row.source_state, row.source_revision,
  );

  const committedStateExists =
    `EXISTS(SELECT 1 FROM a2a_convos WHERE id=? AND workspace_id=? AND protocol_convo_id=? AND state=? AND revision=?)`;

  const outboxInsert = env.DB.prepare(
    `INSERT INTO email_outbox
       (id, workspace_id, logical_key, from_addr, to_addr, subject, text_body, html_body, body_sha256, headers_json,
        reply_to, message_id, in_reply_to, references_json, thread_id, root_task_id, transport, status, attempts,
        next_attempt_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 'send_email', 'queued', 0, ?, ?
     WHERE ${committedStateExists}`,
  ).bind(
    row.outbox_id, row.workspace_id, row.logical_key, row.from_agent, row.peer_address, subject,
    row.human_body, envelope.humanBodySha256, JSON.stringify(headers), row.message_id,
    req.inReplyTo, refsJson, req.threadId, req.rootTaskId, t, t,
    row.local_convo_id, row.workspace_id, row.protocol_convo_id, row.desired_state, desiredRevision,
  );

  const messageInsert = env.DB.prepare(
    `INSERT INTO a2a_messages
       (id, workspace_id, local_convo_id, protocol_convo_id, peer_address, direction, type, seq, envelope_json,
        payload_json, human_body, human_body_sha256, sig_kid, verified, email_id, issuer, created_at)
     SELECT ?, ?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?
     WHERE ${committedStateExists}`,
  ).bind(
    protocolRowId, row.workspace_id, row.local_convo_id, row.protocol_convo_id, row.peer_address,
    row.message_type, row.seq, row.envelope_json, JSON.stringify(envelope.payload ?? {}), row.human_body,
    envelope.humanBodySha256, envelope.kid, envelope.issuer, t,
    row.local_convo_id, row.workspace_id, row.protocol_convo_id, row.desired_state, desiredRevision,
  );

  const intentCommit = env.DB.prepare(
    `UPDATE a2a_outbound_intents SET state='state_committed', last_error=NULL, updated_at=?
      WHERE workspace_id=? AND logical_key=? AND state='prepared'
        AND EXISTS(SELECT 1 FROM email_outbox WHERE id=? AND workspace_id=? AND logical_key=?)
        AND EXISTS(SELECT 1 FROM a2a_messages WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=? AND direction='out' AND seq=?)
        AND ${committedStateExists}`,
  ).bind(
    t, row.workspace_id, row.logical_key,
    row.outbox_id, row.workspace_id, row.logical_key,
    row.workspace_id, row.protocol_convo_id, row.peer_address, row.seq,
    row.local_convo_id, row.workspace_id, row.protocol_convo_id, row.desired_state, desiredRevision,
  );

  const assertCommit = env.DB.prepare(
    `INSERT INTO a2a_outbound_commit_asserts (workspace_id, logical_key, ok, checked_at)
     VALUES (
       ?, ?,
       CASE WHEN
         EXISTS(SELECT 1 FROM a2a_convos WHERE id=? AND state=? AND revision=?)
         AND EXISTS(SELECT 1 FROM email_outbox WHERE id=? AND workspace_id=? AND logical_key=?)
         AND EXISTS(SELECT 1 FROM a2a_messages WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=? AND direction='out' AND seq=?)
         AND EXISTS(SELECT 1 FROM a2a_outbound_intents WHERE workspace_id=? AND logical_key=? AND state='state_committed')
       THEN 1 ELSE 0 END,
       ?
     )
     ON CONFLICT(workspace_id, logical_key) DO UPDATE SET ok=excluded.ok, checked_at=excluded.checked_at`,
  ).bind(
    row.workspace_id, row.logical_key,
    row.local_convo_id, row.desired_state, desiredRevision,
    row.outbox_id, row.workspace_id, row.logical_key,
    row.workspace_id, row.protocol_convo_id, row.peer_address, row.seq,
    row.workspace_id, row.logical_key,
    t,
  );

  try {
    await env.DB.batch([convoUpdate, outboxInsert, messageInsert, intentCommit, assertCommit]);
  } catch (e) {
    const current = await env.DB.prepare(`SELECT state, revision FROM a2a_convos WHERE id=?`)
      .bind(row.local_convo_id)
      .first<{ state: string; revision: number }>()
      .catch(() => null);
    const after = await loadIntent(env, row.workspace_id, row.logical_key).catch(() => null);
    if (after?.state === "state_committed") {
      const stored = parseStoredEnvelope(after);
      return { ok: true, outboxId: after.outbox_id ?? undefined, seq: after.seq, envelope: stored ?? envelope, state: after.desired_state };
    }
    const stateMoved = !!current && (current.state !== row.source_state || Number(current.revision) !== Number(row.source_revision));
    const reason = stateMoved
      ? `outbound_state_conflict:${current?.state ?? "missing"}:${current?.revision ?? -1}`
      : `outbound_commit_failed:${String(e).slice(0, 160)}`;
    await env.DB.prepare(
      `UPDATE a2a_outbound_intents SET state=CASE WHEN ? THEN 'stale' ELSE state END, last_error=?, updated_at=?
       WHERE workspace_id=? AND logical_key=? AND state!='state_committed'`,
    )
      .bind(stateMoved ? 1 : 0, reason, Date.now(), row.workspace_id, row.logical_key)
      .run()
      .catch(() => {});
    return { ok: false, error: reason };
  }

  const committed = await loadIntent(env, row.workspace_id, row.logical_key);
  if (!committed || committed.state !== "state_committed") return { ok: false, error: "outbound_commit_incomplete" };
  const stored = parseStoredEnvelope(committed);
  return {
    ok: true,
    outboxId: committed.outbox_id ?? undefined,
    seq: committed.seq,
    envelope: stored ?? envelope,
    state: committed.desired_state,
  };
}

export async function sendA2aResponse(env: Env, opts: SendA2aResponseOpts): Promise<SendA2aResponseResult> {
  const signing = resolveLocalSigningKey(env);
  if (!signing.ok) return { ok: false, error: signing.error };
  const req = requestFromOpts(opts);
  const json = requestJson(req);
  const hash = await requestHash(json);
  const existing = await loadIntent(env, opts.workspaceId, opts.logicalKey);


  if (!existing && !opts.budgetReserved) {
    const before = getHostHooks().beforeA2aOutbound;
    if (before) {
      let decision: { allow: boolean; reason?: string };
      try {
        decision = await before(env, {
          workspaceId: opts.workspaceId,
          peerAddress: req.toAgent,
          logicalKey: opts.logicalKey,
        });
      } catch {
        decision = { allow: false, reason: "a2a_budget_error" };
      }
      if (!decision.allow) {
        return { ok: false, error: decision.reason ?? "a2a_budget_denied" };
      }
    }
  }
  const allocated = await ensureAllocatedIntent(env, opts, signing.key, req, json, hash);
  if (!allocated.ok) return allocated;
  const invalid = validateExistingIntent(allocated.row, req, hash);
  if (invalid) return { ok: false, error: invalid };
  const prepared = await ensurePreparedIntent(env, allocated.row, signing.key);
  if (!prepared.ok) return prepared;
  return commitPreparedIntent(env, prepared.row, prepared.envelope);
}





export async function resumeA2aResponse(
  env: Env,
  workspaceId: string,
  logicalKey: string,
): Promise<SendA2aResponseResult> {
  const row = await loadIntent(env, workspaceId, logicalKey);
  if (!row) return { ok: false, error: "outbound_intent_not_found" };
  if (row.state === "stale") return { ok: false, error: row.last_error ?? "stale_intent" };
  if (row.state === "state_committed") {
    const envelope = parseStoredEnvelope(row);
    if (!envelope) return { ok: false, error: "committed_intent_missing_envelope" };
    return { ok: true, outboxId: row.outbox_id ?? undefined, seq: row.seq, envelope, state: row.desired_state };
  }

  let signing: LocalSigningKey | undefined;
  if (row.state === "allocated" || !row.envelope_json || !row.signature) {
    const resolved = resolveLocalSigningKey(env);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    signing = resolved.key;
  }
  const prepared = await ensurePreparedIntent(env, row, signing);
  if (!prepared.ok) return prepared;
  return commitPreparedIntent(env, prepared.row, prepared.envelope);
}




export async function approveAndSendConfirm(
  env: Env,
  opts: {
    workspaceId: string;
    protocolConvoId: string;
    fromAgent: string;
    threadId?: string | null;
    rootTaskId?: string | null;
    by?: string;
    nowMs?: number;
  },
): Promise<{ ok: boolean; state?: string; outboxId?: string; error?: string }> {
  const logicalKey = `a2a:${opts.protocolConvoId}:confirm`;
  const prior = await loadIntent(env, opts.workspaceId, logicalKey);
  if (prior) {
    const resumed = await resumeA2aResponse(env, opts.workspaceId, logicalKey);
    return resumed.ok
      ? { ok: true, state: resumed.state ?? "confirmed", outboxId: resumed.outboxId }
      : { ok: false, state: prior.source_state, error: resumed.error };
  }

  let convo = await env.DB.prepare(
    `SELECT id, state, peer_address, payload_json FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`,
  )
    .bind(opts.workspaceId, opts.protocolConvoId)
    .first<{ id: string; state: string; peer_address: string; payload_json: string }>();
  if (!convo) return { ok: false, error: "unknown_convo" };
  if (convo.state === "confirmed") return { ok: false, state: "confirmed", error: "confirmed_without_durable_confirm_intent" };
  if (convo.state !== "pending_owner_ok") return { ok: false, state: convo.state, error: `illegal_transition_${convo.state}_confirm` };

  if (!hasOwnerApproval(convo.payload_json)) {
    const approval = await recordOwnerApproval(env, {
      workspaceId: opts.workspaceId,
      protocolConvoId: opts.protocolConvoId,
      approve: true,
      by: opts.by,
      nowMs: opts.nowMs,
    });
    if (!approval.ok) return { ok: false, error: approval.error, state: convo.state };
    convo = (await env.DB.prepare(
      `SELECT id, state, peer_address, payload_json FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`,
    )
      .bind(opts.workspaceId, opts.protocolConvoId)
      .first<{ id: string; state: string; peer_address: string; payload_json: string }>()) ?? convo;
  }

  const approvedAt = convoMeta(convo.payload_json).ownerApprovalAt;
  if (typeof approvedAt !== "number" || approvedAt <= 0) return { ok: false, error: "owner_approval_not_durable", state: convo.state };

  const sent = await sendA2aResponse(env, {
    workspaceId: opts.workspaceId,
    fromAgent: opts.fromAgent,
    toAgent: convo.peer_address,
    type: "confirm",
    convo: opts.protocolConvoId,
    intent: "coordinate.schedule",
    payload: { confirmedAt: approvedAt },
    facts: {},
    threadId: opts.threadId ?? null,
    rootTaskId: opts.rootTaskId ?? null,
    logicalKey,
    nowMs: opts.nowMs,
  });
  if (!sent.ok) return { ok: false, error: sent.error, state: convo.state };
  return { ok: true, state: sent.state ?? "confirmed", outboxId: sent.outboxId };
}
