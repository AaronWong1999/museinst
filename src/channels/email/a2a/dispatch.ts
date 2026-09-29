
//








import type { Env } from "../../../env";
import { isExplicitlyEnabled } from "../../../util";
import { deriveSecurityContext, humanA2aScopeKey, type SecurityContext } from "../../../security/context";
import { resolveOwnerApprovalRoute } from "../../../security/approval-route";
import { getHostHooks } from "../../../hooks";
import { getContactFacts, touchContact } from "../identity";
import { serializeDisclosure, type ScheduleFacts } from "./disclosure";
import {
  ensureInboundConvo,
  markA2aMessageApplied,
  persistA2aMessage,
  reserveA2aSeq,
  shouldNotifyHalt,
  stepConvo,
  type ConvoRow,
} from "./statemachine";
import { hasA2aOutboundIntent, resumeA2aResponse, sendA2aResponse } from "./outbound";
import type { VerifiedA2A } from "./verify";

export interface A2aDispatchInput {
  route: { workspaceId: string; address: string };
  rowId: string;
  threadId: string;
  verified: VerifiedA2A;
  humanBody?: string;
}

export interface A2aDispatchResult {
  handled: boolean;
  reason: string;
  security?: SecurityContext;
  state?: string;
}

export interface A2aPolicy {
  autoCounter?: boolean;
  autoAccept?: boolean;
  windows?: Array<{ start: string; end: string; status: "free" | "busy" }>;
  timezone?: string;
  broadCity?: string;
  meetingPreference?: string;
}

interface InboundProtocolRecord {
  id: string;
  email_id: string | null;
  payload_json: string;
}

export async function loadA2aPolicy(env: Env, workspaceId: string): Promise<A2aPolicy> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE workspace_id=? AND key='a2a_policy_json'`)
    .bind(workspaceId)
    .first<{ value: string }>();
  if (!row?.value) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(row.value);
  } catch {
    return {};
  }
  const p = (raw ?? {}) as Record<string, unknown>;
  const out: A2aPolicy = {};
  if (typeof p.autoCounter === "boolean") out.autoCounter = p.autoCounter;
  if (typeof p.autoAccept === "boolean") out.autoAccept = p.autoAccept;
  if (typeof p.timezone === "string" && p.timezone.length <= 64) out.timezone = p.timezone;
  if (typeof p.broadCity === "string" && p.broadCity.length <= 64) out.broadCity = p.broadCity;
  if (typeof p.meetingPreference === "string" && p.meetingPreference.length <= 280) out.meetingPreference = p.meetingPreference;
  if (Array.isArray(p.windows)) {
    out.windows = (p.windows as Array<{ start?: unknown; end?: unknown; status?: unknown }>)
      .filter((w) => typeof w?.start === "string" && typeof w?.end === "string")
      .slice(0, 20)
      .map((w) => ({
        start: String(w.start),
        end: String(w.end),
        status: w.status === "busy" ? ("busy" as const) : ("free" as const),
      }));
  }
  return out;
}

function disclosureFacts(policy: A2aPolicy): ScheduleFacts {
  return serializeDisclosure({
    freeBusyWindows: policy.windows,
    timezone: policy.timezone,
    broadCity: policy.broadCity,
    meetingPreference: policy.meetingPreference,
  });
}

async function setIngestState(env: Env, rowId: string, state: string, error?: string): Promise<void> {
  await env.DB.prepare(`UPDATE email_messages SET ingest_state=?, ingest_last_error=? WHERE id=?`)
    .bind(state, error ? String(error).slice(0, 400) : null, rowId)
    .run();
}

async function findInboundProtocolRecord(env: Env, input: A2aDispatchInput): Promise<InboundProtocolRecord | null> {
  const v = input.verified;
  return await env.DB.prepare(
    `SELECT id, email_id, payload_json FROM a2a_messages
      WHERE workspace_id=? AND protocol_convo_id=? AND peer_address=? AND direction='in' AND seq=?`,
  )
    .bind(input.route.workspaceId, v.protocolConvoId, v.peerAddress.toLowerCase(), v.envelope.seq)
    .first<InboundProtocolRecord>();
}

function autoReplyType(input: A2aDispatchInput): "counter" | "accept" | null {
  const type = input.verified.envelope.type;
  return type === "propose" ? "counter" : type === "counter" ? "accept" : null;
}

function autoLogicalKey(input: A2aDispatchInput): string | null {
  const replyType = autoReplyType(input);
  return replyType ? `a2a:${input.verified.protocolConvoId}:${replyType}` : null;
}





async function resumeExistingAutoResponse(
  env: Env,
  input: A2aDispatchInput,
): Promise<{ ok: true; state?: string } | { ok: false; error: string }> {
  const logicalKey = autoLogicalKey(input);
  if (!logicalKey) return { ok: true };
  try {
    if (!(await hasA2aOutboundIntent(env, input.route.workspaceId, logicalKey))) return { ok: true };
    const reply = await resumeA2aResponse(env, input.route.workspaceId, logicalKey);
    if (!reply.ok) return { ok: false, error: reply.error ?? "resume_failed" };
    return { ok: true, state: reply.state };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


async function runAutoResponse(
  env: Env,
  input: A2aDispatchInput,
  policy: A2aPolicy,
  nowMs: number,
): Promise<{ ok: true; state?: string } | { ok: false; error: string }> {
  try {
    const reply = await respondIfNeeded(env, {
      workspaceId: input.route.workspaceId,
      address: input.route.address,
      verified: input.verified,
      policy,
      threadId: input.threadId,
      nowMs,
    });
    if (!reply) return { ok: true };
    if (!reply.ok) return { ok: false, error: reply.error ?? "respond_failed" };
    return { ok: true, state: reply.state };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function finishReplay(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  input: A2aDispatchInput,
  policy: A2aPolicy,
  nowMs: number,
  record: InboundProtocolRecord,
  security: SecurityContext,
): Promise<A2aDispatchResult> {
  const sameOriginalEmail = record.email_id === input.rowId;
  const recovered = sameOriginalEmail
    ? await runAutoResponse(env, input, policy, nowMs)
    : await resumeExistingAutoResponse(env, input);
  if (!recovered.ok) {
    await setIngestState(env, input.rowId, "failed_a2a_internal", `outbound_recovery:${recovered.error}`);
    return { handled: true, reason: "outbound_recovery_failed", security };
  }



  await setIngestState(
    env,
    input.rowId,
    sameOriginalEmail ? "processed_a2a" : "rejected_a2a_replay",
    sameOriginalEmail ? "replay_recovered" : "duplicate_seq",
  );
  ctx.waitUntil(touchContactBestEffort(env, input.route.workspaceId, input.verified.peerAddress));
  return { handled: true, reason: "replay", security, state: recovered.state };
}

export async function dispatchA2AEvent(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  input: A2aDispatchInput,
): Promise<A2aDispatchResult> {
  const verified = input.verified;
  const envelope = verified.envelope;
  const workspaceId = input.route.workspaceId;

  if (!isExplicitlyEnabled(env.A2A_ENABLED)) {
    await setIngestState(env, input.rowId, "stored_a2a_disabled", "a2a_disabled");
    return { handled: true, reason: "a2a_disabled_store_only" };
  }


  const { isTrustedPeoplePaused } = await import("../trust-service");
  if (await isTrustedPeoplePaused(env, workspaceId).catch(() => false)) {
    await setIngestState(env, input.rowId, "stored_a2a_paused", "connections_paused");
    return { handled: true, reason: "stored_a2a_paused" };
  }

  const claims = {
    source: "a2a" as const,
    workspaceId,
    scopeKey: humanA2aScopeKey(verified.protocolConvoId),
    emailMessageRowId: input.rowId,
    threadId: input.threadId,
    peerAddress: verified.peerAddress,
    a2aLocalMessageId: input.rowId,
  };
  const approvalRoute = await resolveOwnerApprovalRoute(env, workspaceId).catch(() => null);
  const contact = await getContactFacts(env, workspaceId, verified.peerAddress).catch(() => ({
    contactClass: "unknown" as const,
    addressVerifiedByOwner: false,
  }));
  const policy = await loadA2aPolicy(env, workspaceId).catch(() => ({} as A2aPolicy));
  const security = deriveSecurityContext({
    claims,
    identity: {
      peerAddress: verified.peerAddress,
      contactClass: contact.contactClass,
      addressVerifiedByOwner: contact.addressVerifiedByOwner,
      messageAuth: "a2a_signature",
    },
    approvalRoute,
    a2aState: envelope.type,
    a2aPayload: serializeDisclosure(envelope.payload ?? {}),
    protocolConvoId: verified.protocolConvoId,
  });

  let gate: { allow: boolean } | null = null;
  try {
    gate = (await getHostHooks().beforeExternalEvent?.(env, claims)) ?? null;
  } catch (e) {
    await setIngestState(env, input.rowId, "stored_a2a_gate_error", String(e));
    return { handled: true, reason: "a2a_gate_error", security };
  }
  if (gate && !gate.allow) {
    await setIngestState(env, input.rowId, "stored_gated");
    return { handled: true, reason: "gated", security };
  }

  const nowMs = Date.now();
  const ensured = await ensureInboundConvo(env, {
    workspaceId,
    protocolConvoId: verified.protocolConvoId,
    peerAddress: verified.peerAddress,
    peerIssuer: verified.issuer,
    envelope,
    threadId: input.threadId,
    nowMs,
  });
  if (!ensured.ok) {
    await setIngestState(env, input.rowId, "rejected_a2a_transition", ensured.error);
    return { handled: true, reason: ensured.error, security };
  }
  const convo: ConvoRow = ensured.convo;

  const reserved = await reserveA2aSeq(env, {
    workspaceId,
    protocolConvoId: verified.protocolConvoId,
    peerAddress: verified.peerAddress,
    direction: "in",
    seq: envelope.seq,
    nowMs,
  });
  if (!reserved.ok) {
    if (reserved.error !== "replay") {
      await setIngestState(env, input.rowId, "failed_a2a_internal", reserved.detail ?? reserved.error);
      return { handled: true, reason: "seq_reserve_db_error", security };
    }



    const existing = await findInboundProtocolRecord(env, input).catch(() => null);
    if (existing) return finishReplay(env, ctx, input, policy, nowMs, existing, security);
  }

  const stepped = await stepConvo(env, {
    workspaceId,
    protocolConvoId: verified.protocolConvoId,
    envelope,
    nowMs,
    seqReserved: true,
  });
  const stepReplay = !stepped.ok && (stepped.error === "replay" || stepped.error === "seq_replay");
  const stepHalted = !stepped.ok && !!stepped.halted && !stepReplay && shouldNotifyHalt(stepped.error ?? "");
  const stepRejected = !stepped.ok && !stepReplay && !stepHalted;

  if (!stepRejected) {
    const persisted = await persistA2aMessage(env, {
      workspaceId,
      localConvoId: convo.id,
      protocolConvoId: verified.protocolConvoId,
      peerAddress: verified.peerAddress,
      peerIssuer: verified.issuer,
      direction: "in",
      envelope,
      humanBody: input.humanBody ?? "",
      emailId: input.rowId,
      verified: true,
      nowMs,
    });
    if (!persisted.ok) {
      await setIngestState(env, input.rowId, "failed_a2a_internal", persisted.detail ?? persisted.error);
      return { handled: true, reason: "message_persist_db_error", security };
    }

    if (!persisted.created && !stepReplay) {
      const existing = await findInboundProtocolRecord(env, input);
      if (!existing) {
        await setIngestState(env, input.rowId, "failed_a2a_internal", "duplicate_message_unreadable");
        return { handled: true, reason: "message_persist_db_error", security };
      }
      return finishReplay(env, ctx, input, policy, nowMs, existing, security);
    }


    await markA2aMessageApplied(env, {
      messageRowId: persisted.messageRowId,
      revision: stepReplay ? convo.revision : (stepped.revision ?? 0),
      state: stepReplay ? convo.state : (stepped.state ?? ""),
      nowMs,
    });
  }

  if (stepRejected) {
    await setIngestState(env, input.rowId, "rejected_a2a_transition", stepped.error);
    return { handled: true, reason: stepped.error ?? "step_failed", security };
  }
  if (stepHalted) {
    await setIngestState(env, input.rowId, "processed_a2a", `halted:${stepped.error}`);
    ctx.waitUntil(touchContactBestEffort(env, workspaceId, verified.peerAddress));
    return { handled: true, reason: `halted_${stepped.error}`, security, state: "halted" };
  }


  const responded = await runAutoResponse(env, input, policy, nowMs);
  if (!responded.ok) {
    await setIngestState(env, input.rowId, "failed_a2a_internal", `respond_failed:${responded.error}`);
    return { handled: true, reason: "respond_failed", security, state: stepReplay ? convo.state : stepped.state };
  }

  await setIngestState(env, input.rowId, "processed_a2a", stepReplay ? "protocol_record_recovered" : undefined);
  ctx.waitUntil(touchContactBestEffort(env, workspaceId, verified.peerAddress));
  return {
    handled: true,
    reason: "processed_a2a",
    security,
    state: responded.state ?? (stepReplay ? convo.state : stepped.state),
  };
}

async function touchContactBestEffort(env: Env, workspaceId: string, peerAddress: string): Promise<void> {
  await touchContact(env, workspaceId, peerAddress).catch(() => undefined);
}

async function respondIfNeeded(
  env: Env,
  opts: {
    workspaceId: string;
    address: string;
    verified: VerifiedA2A;
    policy: A2aPolicy;
    threadId: string;
    nowMs: number;
  },
): Promise<{ ok: boolean; outboxId?: string; error?: string; state?: string } | null> {
  const type = opts.verified.envelope.type;
  const replyType: "counter" | "accept" | null = type === "propose" ? "counter" : type === "counter" ? "accept" : null;
  if (!replyType) return null;

  const logicalKey = `a2a:${opts.verified.protocolConvoId}:${replyType}`;


  if (await hasA2aOutboundIntent(env, opts.workspaceId, logicalKey)) {
    return resumeA2aResponse(env, opts.workspaceId, logicalKey);
  }

  const facts = disclosureFacts(opts.policy);
  if (replyType === "counter") {
    if (!opts.policy.autoCounter || (facts.freeBusyWindows?.length ?? 0) === 0) return null;
  } else if (!opts.policy.autoAccept) {
    return null;
  }

  return sendA2aResponse(env, {
    workspaceId: opts.workspaceId,
    fromAgent: opts.address,
    toAgent: opts.verified.peerAddress,
    type: replyType,
    convo: opts.verified.protocolConvoId,
    intent: "coordinate.schedule",
    payload: replyType === "counter" ? { freeBusyWindows: facts.freeBusyWindows, timezone: facts.timezone } : { accepted: true },
    facts,
    threadId: opts.threadId,
    logicalKey,
    nowMs: opts.nowMs,
  });
}

export { stepConvo, shouldNotifyHalt };
