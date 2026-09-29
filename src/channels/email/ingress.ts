

//






import type { Env } from "../../env";
import { isExplicitlyEnabled, newId } from "../../util";
import { sha256hex } from "../../crypto";
import {
  deriveSecurityContext,
  emailScopeKey,
  type EmailIdentityFacts,
  type SecurityClaims,
  type SecurityContext,
} from "../../security/context";
import { peerHash, canonicalAddress, getContactFacts, touchContact } from "./identity";
import {
  parseEmail,
  cleanBodyText,
  snippetOf,
  htmlToText,
  sanitizeHtml,
  EMAIL_BODY_STORE_MAX_CHARS,
  type ParsedEmail,
} from "./parse";
import { classifyProtocol, screenOrdinary } from "./screen";
import type { VerifyOk } from "./a2a/verify";
import {
  extractCapabilityRef,
  verifyThreadCapability,
  completeAddressVerification,
  rotateThreadCapabilityReplyTo,
} from "./thread";
import { reserveEmailModelAdmission } from "./admission";
import { queueEmailDispatch } from "./dispatch-queue";
import {
  resolveMailbox,
  normalizeThread,
  getMailboxSettings,
  reserveEmailQuota,
  refundEmailQuota,
  emailQuotaDay,
  emailOutboundAllowed,
  putRawMime,
  type MailboxRoute,
} from "./mailbox";

export const APP_MAX_INBOUND_BYTES = 5 * 1024 * 1024;


export { readEmailMessage } from "./mailbox";


const INGEST_LEASE_MS = 5 * 60 * 1000;

export interface IngressResult {
  handled: boolean;
  reason: string;
  emailRowId?: string;
  threadId?: string;
  security?: SecurityContext;
  rootTaskId?: string;
}

async function sha256HexBytes(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeMessageId(mid: string | null): string | null {
  if (!mid) return null;
  return mid.trim().toLowerCase();
}


export async function inboundFingerprint(opts: {
  messageId: string | null;
  envelopeFrom: string;
  recipient: string;
  rawSha256: string;
}): Promise<string> {
  const mid = normalizeMessageId(opts.messageId);
  if (mid) return `mid:${mid}`;
  return `raw:${await sha256hex(`${canonicalAddress(opts.envelopeFrom)}\u0000${canonicalAddress(opts.recipient)}\u0000${opts.rawSha256}`)}`;
}


function inboundMaxBytes(env: Env): number {
  const n = Number(env.EMAIL_INBOUND_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : APP_MAX_INBOUND_BYTES;
}


async function readRawLimited(
  raw: ReadableStream<Uint8Array> | ArrayBuffer,
  limit: number,
): Promise<{ ok: true; buf: ArrayBuffer } | { ok: false }> {
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength > limit ? { ok: false } : { ok: true, buf: raw };
  }
  const reader = (raw as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, buf: out.buffer as ArrayBuffer };
}


function isTerminalIngestState(state: string): boolean {
  return state === "processed" || state === "dropped" || state.startsWith("stored");
}

function isLeaseExpired(startedAt: number | null, nowMs: number): boolean {
  return startedAt == null || startedAt < nowMs - INGEST_LEASE_MS;
}

interface InboundReservation {
  rowId: string;
  threadId: string;

  claimed: boolean;

  state: string;
}

export async function handleInboundEmail(
  message: {
    from: string;
    to: string;
    raw: ReadableStream<Uint8Array> | ArrayBuffer;
    rawSize: number;
    headers: Headers;
    setReject(reason: string): void;
  },
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<IngressResult> {

  if (!isExplicitlyEnabled(env.AGENT_EMAIL_ENABLED)) {
    message.setReject("Service unavailable");
    return { handled: false, reason: "disabled" };
  }
  const maxBytes = inboundMaxBytes(env);
  if (message.rawSize > maxBytes) {
    message.setReject("Message too large");
    return { handled: false, reason: "too_large" };
  }

  const route = await resolveMailbox(env, String(message.to || ""));
  if (!route) {
    message.setReject("Unknown recipient");
    return { handled: false, reason: "unknown_recipient" };
  }

  const read = await readRawLimited(message.raw as ReadableStream<Uint8Array> | ArrayBuffer, maxBytes);
  if (!read.ok) {
    message.setReject("Message too large");
    return { handled: false, reason: "too_large" };
  }
  const raw = read.buf;
  const rawSha = await sha256HexBytes(raw);


  let parsed: ParsedEmail | null = null;
  let parseError: string | null = null;
  try {
    parsed = await parseEmail(raw, message.from);
  } catch (e) {
    parseError = String(e).slice(0, 200);
  }

  const fingerprint = await inboundFingerprint({
    messageId: parsed?.messageId ?? null,
    envelopeFrom: message.from,
    recipient: message.to,
    rawSha256: rawSha,
  });

  const body = buildStoredBody(parsed);

  const reservation = await reserveInbound(env, {
    route,
    fingerprint,
    rawSha,
    parsed,
    body,
    raw,
  });

  if (!reservation.claimed) {
    if (isTerminalIngestState(reservation.state)) {
      return {
        handled: true,
        reason: reservation.state === "processed" ? "duplicate" : `duplicate_${reservation.state}`,
        emailRowId: reservation.rowId,
        threadId: reservation.threadId,
      };
    }

    return { handled: true, reason: "in_progress", emailRowId: reservation.rowId, threadId: reservation.threadId };
  }

  if (parseError || !parsed) {
    await markIngest(env, reservation.rowId, "stored", { reason: `unparseable:${parseError ?? "unknown"}` });
    return { handled: true, reason: "stored_unparseable", emailRowId: reservation.rowId, threadId: reservation.threadId };
  }

  const classified = classifyProtocol(parsed.headers);


  if (classified.kind === "maybe_trust") {
    const { verifyTrustControl } = await import("./trust-control/verify");
    const trustVerified = await verifyTrustControl(env, {
      headers: parsed.headers,
      recipient: route.address,
      workspaceId: route.workspaceId,
    }).catch((e) => {
      console.error("[email] trust-control verify failed", String(e));
      return { ok: false as const, error: "verify_threw" };
    });

    if (trustVerified.ok) {
      await markIngest(env, reservation.rowId, "processing", { messageAuth: "trust_control_signature" });
      const { dispatchVerifiedTrustControl } = await import("./trust-control/dispatch");
      const dispatchRes = await dispatchVerifiedTrustControl(env, {
        workspaceId: route.workspaceId,
        verified: trustVerified,
        transportEmailId: reservation.rowId,
        verificationSource: "email_verified",
      });
      await markIngest(env, reservation.rowId, "stored", {
        messageAuth: "trust_control_signature",
        error: dispatchRes.ignored ? dispatchRes.reason : undefined,
      });
      return {
        handled: true,
        reason: dispatchRes.status ?? "trust_control_processed",
        emailRowId: reservation.rowId,
        threadId: reservation.threadId,
      };
    } else {

      await markIngest(env, reservation.rowId, "stored", {
        messageAuth: "none",
        error: "rejected_trust_control_invalid",
      });
      return {
        handled: true,
        reason: "rejected_trust_control_invalid",
        emailRowId: reservation.rowId,
        threadId: reservation.threadId,
      };
    }
  }




  let a2aVerified: VerifyOk | null = null;
  if (classified.kind === "maybe_a2a" && isExplicitlyEnabled(env.A2A_ENABLED)) {
    const { verifyA2aInbound } = await import("./a2a/verify");
    const verified = await verifyA2aInbound(env, {
      headers: parsed.headers,
      text: parsed.text,
      recipient: route.address,
      workspaceId: route.workspaceId,
    }).catch((e) => {
      console.error("[email] a2a verify failed; downgrade to ordinary", String(e));
      return { ok: false as const, error: "verify_threw" };
    });
    if (verified.ok) a2aVerified = verified;
  }

  try {
    if (a2aVerified?.ok) {
      await markIngest(env, reservation.rowId, "processing", { messageAuth: "a2a_signature" });
      const { dispatchA2AEvent } = await import("./a2a/dispatch");
      return await dispatchA2AEvent(env, ctx, {
        route,
        rowId: reservation.rowId,
        threadId: reservation.threadId,
        verified: a2aVerified,
        humanBody: parsed.text,
      });
    }


    const auth = await authenticateInbound(env, {
      route,
      recipient: message.to,
      envelopeFrom: message.from,

      threadId: reservation.threadId,
    });


    if (auth.addressVerified) {
      await markIngest(env, reservation.rowId, "stored", {
        messageAuth: "none",
        reason: `address_verified:${auth.addressVerified}`,
      });
      await touchContact(env, route.workspaceId, message.from).catch(() => {});
      return {
        handled: true,
        reason: "address_verified",
        emailRowId: reservation.rowId,
        threadId: reservation.threadId,
      };
    }

    const downgraded = classified.kind === "maybe_a2a";
    const contact = downgraded
      ? { contactClass: "unknown" as const, addressVerifiedByOwner: false }
      : await getContactFacts(env, route.workspaceId, message.from);
    const identity: EmailIdentityFacts = {
      peerAddress: canonicalAddress(message.from),
      contactClass: contact.contactClass,
      addressVerifiedByOwner: contact.addressVerifiedByOwner,
      messageAuth: auth.messageAuth,
      capabilityId: auth.capabilityId,
    };
    await markIngest(env, reservation.rowId, "processing", {
      messageAuth: identity.messageAuth,
      capabilityId: identity.capabilityId,
    });

    const policy = screenOrdinary({
      headers: parsed.headers,
      from: message.from,
      textLength: parsed.text.length || htmlTextLength(parsed),
      contactClass: contact.contactClass,
    });
    if (policy.action !== "process") {
      await markIngest(env, reservation.rowId, "stored", { reason: policy.reason });
      await touchContact(env, route.workspaceId, message.from).catch(() => {});
      return { handled: true, reason: policy.reason, emailRowId: reservation.rowId, threadId: reservation.threadId };
    }

    return await dispatchOrdinary(env, ctx, {
      route, rowId: reservation.rowId, threadId: reservation.threadId,
      parsed, fingerprint, rawSha, from: message.from, identity,
    });
  } catch (e) {

    await markIngest(env, reservation.rowId, "dispatch_failed", { error: String(e).slice(0, 300) }).catch((markErr) => {
      console.error("[email] mark dispatch_failed failed", reservation.rowId, String(markErr));
    });
    console.error("[email] email_ingress_failure", JSON.stringify({ rowId: reservation.rowId, workspaceId: route.workspaceId, error: String(e).slice(0, 300) }));
    await bumpEmailMetric(env, "ingress_failed");
    throw e;
  }
}


async function bumpEmailMetric(env: Env, event: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO channel_metrics (day, channel, event, count) VALUES (?, 'email', ?, 1)
       ON CONFLICT(day, channel, event) DO UPDATE SET count = count + 1`,
    ).bind(new Date().toISOString().slice(0, 10), event).run();
  } catch (e) {
    console.error("[email] metric write failed", event, String(e));
  }
}


function htmlTextLength(parsed: ParsedEmail): number {
  return parsed.html ? htmlToText(parsed.html, 64 * 1024).length : 0;
}

interface StoredBody {
  bodyText: string;
  bodyHtml: string | null;
  attachmentsJson: string | null;
  snippet: string;
}


function buildStoredBody(parsed: ParsedEmail | null): StoredBody {
  if (!parsed) return { bodyText: "", bodyHtml: null, attachmentsJson: null, snippet: "" };
  const plain = cleanBodyText(parsed.text, EMAIL_BODY_STORE_MAX_CHARS);
  const bodyText = plain.length > 0 ? plain : parsed.html ? htmlToText(parsed.html) : "";
  const bodyHtml = parsed.html ? sanitizeHtml(parsed.html) : null;
  const attachmentsJson = parsed.attachments.length > 0 ? JSON.stringify(parsed.attachments).slice(0, 20_000) : null;
  return { bodyText, bodyHtml, attachmentsJson, snippet: snippetOf(bodyText) };
}







async function reserveInbound(
  env: Env,
  opts: {
    route: MailboxRoute;
    fingerprint: string;
    rawSha: string;
    parsed: ParsedEmail | null;
    body: StoredBody;
    raw: ArrayBuffer;
  },
): Promise<InboundReservation> {
  const id = newId("em");
  const nowMs = Date.now();
  const peerAddr = opts.parsed?.from || "";
  const peerHex = await peerHash(peerAddr);
  const threadId = await normalizeThread(env, {
    workspaceId: opts.route.workspaceId,
    inReplyTo: opts.parsed?.inReplyTo ?? null,
    references: opts.parsed?.references ?? [],
  });
  const scopeKey = emailScopeKey(peerHex, threadId);
  const r = await env.DB.prepare(
    `INSERT INTO email_messages (id, workspace_id, direction, message_id, fingerprint, raw_sha256, thread_id, in_reply_to, from_addr, to_addr, subject, snippet, scope_key, message_auth, ingest_state, body_text, body_html, attachments_json, raw_r2_key, created_at)
     VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 'reserved', ?, ?, ?, NULL, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      id, opts.route.workspaceId, opts.parsed?.messageId ?? null, opts.fingerprint, opts.rawSha, threadId,
      opts.parsed?.inReplyTo ?? null, opts.parsed?.from ?? "", opts.parsed?.to ?? opts.route.address,
      (opts.parsed?.subject ?? "").slice(0, 200), opts.body.snippet, scopeKey,
      opts.body.bodyText, opts.body.bodyHtml, opts.body.attachmentsJson, nowMs,
    )
    .run();
  if ((r.meta?.changes ?? 0) === 1) {

    const rawR2Key = await putRawMime(env, opts.route.workspaceId, id, opts.raw);
    if (rawR2Key) {
      await env.DB.prepare(`UPDATE email_messages SET raw_r2_key=? WHERE id=? AND raw_r2_key IS NULL`)
        .bind(rawR2Key, id)
        .run()
        .catch((e) => {
          console.error("[email] raw_r2_key persist failed", id, String(e));
        });
    }
    const claimed = await claimIngestRow(env, id, nowMs);
    return { rowId: id, threadId, claimed, state: "processing" };
  }


  const existing = await env.DB.prepare(
    `SELECT id, thread_id, ingest_state, processing_started_at, raw_r2_key FROM email_messages
      WHERE workspace_id=? AND direction='in' AND fingerprint=?`,
  )
    .bind(opts.route.workspaceId, opts.fingerprint)
    .first<{ id: string; thread_id: string; ingest_state: string; processing_started_at: number | null; raw_r2_key: string | null }>();
  if (!existing) throw new Error(`email_reserve_conflict_unreadable:${opts.fingerprint.slice(0, 40)}`);
  const state = String(existing.ingest_state ?? "reserved");
  if (isTerminalIngestState(state)) {
    return { rowId: existing.id, threadId: existing.thread_id, claimed: false, state };
  }
  if (state === "processing" && !isLeaseExpired(existing.processing_started_at ?? null, nowMs)) {
    return { rowId: existing.id, threadId: existing.thread_id, claimed: false, state };
  }
  const rawR2Key = existing.raw_r2_key ? null : await putRawMime(env, opts.route.workspaceId, existing.id, opts.raw);
  const claimed = await claimIngestRow(env, existing.id, nowMs);
  if (claimed) {

    await env.DB.prepare(
      `UPDATE email_messages SET body_text=COALESCE(NULLIF(body_text,''), ?), body_html=COALESCE(body_html, ?),
         attachments_json=COALESCE(attachments_json, ?), snippet=COALESCE(NULLIF(snippet,''), ?),
         raw_r2_key=COALESCE(raw_r2_key, ?), raw_sha256=COALESCE(NULLIF(raw_sha256,''), ?)
       WHERE id=?`,
    )
      .bind(opts.body.bodyText, opts.body.bodyHtml, opts.body.attachmentsJson, opts.body.snippet, rawR2Key, opts.rawSha, existing.id)
      .run();
  }
  return { rowId: existing.id, threadId: existing.thread_id, claimed, state };
}


async function claimIngestRow(env: Env, rowId: string, nowMs: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE email_messages
        SET ingest_state='processing', processing_started_at=?, ingest_last_error=NULL
      WHERE id=? AND (
        ingest_state='reserved'
        OR ingest_state IN ('dispatch_failed','failed')
        OR (ingest_state='processing' AND (processing_started_at IS NULL OR processing_started_at < ?))
      )`,
  )
    .bind(nowMs, rowId, nowMs - INGEST_LEASE_MS)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

interface InboundAuthFacts {
  messageAuth: "none" | "thread_capability";
  capabilityId?: string;

  addressVerified?: string;

  rejectedReason?: string;
}










async function authenticateInbound(
  env: Env,
  opts: { route: MailboxRoute; recipient: string; envelopeFrom: string; threadId: string },
): Promise<InboundAuthFacts> {
  const ref = extractCapabilityRef(opts.recipient);
  if (!ref) return { messageAuth: "none" };

  if (ref.kind === "verify") {
    const done = await completeAddressVerification(env, {
      token: ref.token,
      workspaceId: opts.route.workspaceId,
      peerAddress: opts.envelopeFrom,
    });
    if (!done.ok) {
      console.warn(
        "[email] address verification rejected",
        JSON.stringify({ reason: done.error, workspaceId: opts.route.workspaceId }),
      );
      return { messageAuth: "none", rejectedReason: `address_verification_${done.error ?? "unknown"}` };
    }
    return { messageAuth: "none", addressVerified: done.address };
  }

  const v = await verifyThreadCapability(env, ref.token, {
    workspaceId: opts.route.workspaceId,
    peerAddress: opts.envelopeFrom,

    threadId: opts.threadId,
  });
  if (!v.ok || !v.payload) {
    console.warn(
      "[email] thread capability rejected",
      JSON.stringify({ reason: v.error ?? "unknown", workspaceId: opts.route.workspaceId, threadId: opts.threadId }),
    );
    return { messageAuth: "none", rejectedReason: `thread_capability_${v.error ?? "unknown"}` };
  }
  return { messageAuth: "thread_capability", capabilityId: v.payload.capId };
}


async function markIngest(
  env: Env,
  rowId: string,
  state: string,
  opts: { messageAuth?: string; capabilityId?: string; reason?: string; error?: string } = {},
): Promise<void> {
  const finished = isTerminalIngestState(state) || state === "dispatch_failed" ? Date.now() : null;
  await env.DB.prepare(
    `UPDATE email_messages
        SET ingest_state=?, message_auth=COALESCE(?, message_auth), capability_id=COALESCE(?, capability_id),
            ingest_last_error=COALESCE(?, ingest_last_error), processing_finished_at=COALESCE(?, processing_finished_at)
      WHERE id=?`,
  )
    .bind(state, opts.messageAuth ?? null, opts.capabilityId ?? null, opts.reason ?? opts.error ?? null, finished, rowId)
    .run();
}

async function dispatchOrdinary(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  opts: {
    route: MailboxRoute;
    rowId: string;
    threadId: string;
    parsed: ParsedEmail;
    fingerprint: string;
    rawSha: string;
    from: string;
    identity: EmailIdentityFacts;
  },
): Promise<IngressResult> {
  const workspaceId = opts.route.workspaceId;


  if (!isExplicitlyEnabled(env.AGENT_EMAIL_ENABLED)) {
    await markIngest(env, opts.rowId, "stored", { reason: "disabled" });
    return { handled: true, reason: "stored_disabled", emailRowId: opts.rowId, threadId: opts.threadId };
  }



  const stranger = opts.identity.messageAuth === "none";
  const mailbox = await getMailboxSettings(env, workspaceId);
  if (!mailbox) {
    await markIngest(env, opts.rowId, "stored", { reason: "mailbox_missing" });
    return { handled: true, reason: "stored_mailbox_missing", emailRowId: opts.rowId, threadId: opts.threadId };
  }
  if (stranger) {
    if (!mailbox.strangerAutoreply || !isExplicitlyEnabled(env.STRANGER_AUTOREPLY_GLOBAL)) {
      await markIngest(env, opts.rowId, "stored", { reason: "stranger_autoreply_off" });
      await touchContact(env, workspaceId, opts.from).catch(() => {});
      return { handled: true, reason: "stored_stranger_autoreply_off", emailRowId: opts.rowId, threadId: opts.threadId };
    }
  }

  const approvalRoute = await resolveOwnerApprovalRouteSafe(env, workspaceId);
  const peerHex = await peerHash(opts.from);
  const scopeKey = emailScopeKey(peerHex, opts.threadId);
  const publicFacts = await loadPublicFacts(env, workspaceId);
  const claims: SecurityClaims = {
    source: "email",
    workspaceId,
    scopeKey,
    emailMessageRowId: opts.rowId,
    threadId: opts.threadId,
    peerAddress: canonicalAddress(opts.from),
    capabilityId: opts.identity.capabilityId,
  };
  const security = deriveSecurityContext({ claims, identity: opts.identity, approvalRoute, publicFacts });


  const gate = await runExternalGate(env, claims);
  if (!gate.allow) {
    await markIngest(env, opts.rowId, gate.reason === "gate_error" ? "stored_gate_error" : "stored_gated", { reason: gate.reason });
    await touchContact(env, workspaceId, opts.from).catch(() => {});
    return { handled: true, reason: gate.reason === "gate_error" ? "stored_gate_error" : "gated", security, emailRowId: opts.rowId, threadId: opts.threadId };
  }


  const admission = await reserveEmailModelAdmission(env, {
    workspaceId,
    rowId: opts.rowId,
    peerHash: peerHex,
    totalCap: mailbox.dailyInCap,
    peerCap: Math.min(mailbox.dailyInCap, 50),
    nowMs: Date.now(),
  });
  if (!admission.allowed) {
    await markIngest(env, opts.rowId, "stored", { reason: admission.reason });
    await touchContact(env, workspaceId, opts.from).catch(() => {});
    return { handled: true, reason: "stored_quota_exceeded", security, emailRowId: opts.rowId, threadId: opts.threadId };
  }


  const nowMs = Date.now();
  await env.DB.prepare(
    `UPDATE email_messages
     SET ingest_state='dispatch_queued',
         external_admission_state='admitted',
         external_admission_reason='ok',
         external_admitted_at=?
     WHERE id=?`,
  )
    .bind(nowMs, opts.rowId)
    .run();

  await queueEmailDispatch(env, { rowId: opts.rowId, workspaceId });
  return { handled: true, reason: "dispatched", emailRowId: opts.rowId, threadId: opts.threadId, security };
}


async function runExternalGate(env: Env, claims: SecurityClaims): Promise<{ allow: boolean; reason: string }> {
  const hook = (await import("../../hooks")).getHostHooks().beforeExternalEvent;
  if (!hook) return { allow: true, reason: "no_host_gate" };
  try {
    const d = await hook(env, claims);
    if (d && d.allow) return { allow: true, reason: "allowed" };
    return { allow: false, reason: "host_denied" };
  } catch (e) {
    console.error("[email] beforeExternalEvent failed; fail closed", String(e));
    return { allow: false, reason: "gate_error" };
  }
}

export async function resolveOwnerApprovalRouteSafe(env: Env, workspaceId: string): Promise<{ channel: "wechat" | "telegram" | "web"; externalId?: string; contextToken?: string } | null> {
  try {
    const { resolveOwnerApprovalRoute } = await import("../../security/approval-route");
    return await resolveOwnerApprovalRoute(env, workspaceId);
  } catch (e) {
    console.error("[email] approval route lookup failed", String(e));
    return null;
  }
}

export async function loadPublicFacts(env: Env, workspaceId: string): Promise<Record<string, string>> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE workspace_id=? AND key='public_facts'`)
    .bind(workspaceId)
    .first<{ value: string }>()
    .catch((e) => {
      console.error("[email] public facts load failed", String(e));
      return null;
    });
  if (!row?.value) return {};
  try {
    const v = JSON.parse(row.value) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v ?? {})) {
      if (typeof val === "string" && val.length <= 200) out[String(k).slice(0, 60)] = val;
    }
    return out;
  } catch {
    return {};
  }
}





export type AutoReplyEnqueueResult =
  | { kind: "queued"; outboxId: string; created: boolean }
  | { kind: "suppressed"; reason: string }
  | { kind: "none" };





export async function enqueueReply(
  env: Env,
  opts: {
    route: MailboxRoute;
    rowId: string;
    threadId: string;
    texts: string[];
    rootTaskId?: string;

    capabilityPeer?: string;
  },
): Promise<AutoReplyEnqueueResult> {
  if (!opts.texts || opts.texts.length === 0) return { kind: "none" };
  const allowed = await emailOutboundAllowed(env, opts.route.workspaceId);
  if (!allowed.allow) {
    console.warn("[email] auto-reply suppressed", opts.rowId, allowed.reason);
    return { kind: "suppressed", reason: allowed.reason };
  }
  const row = await env.DB.prepare(`SELECT from_addr, subject FROM email_messages WHERE id=?`)
    .bind(opts.rowId)
    .first<{ from_addr: string; subject: string | null }>();
  const to = row?.from_addr ?? "";
  if (!to) return { kind: "none" };
  const { enqueueOutbox, getOutboundMessageId } = await import("./outbox");
  const day = emailQuotaDay();
  const mailbox = await getMailboxSettings(env, opts.route.workspaceId);
  const quota = await reserveEmailQuota(env, opts.route.workspaceId, day, "outbound_send", mailbox?.dailyOutCap ?? 0);
  if (!quota.allowed) {
    console.warn("[email] auto-reply over daily_out_cap", opts.route.workspaceId, opts.rowId);
    return { kind: "suppressed", reason: "daily_out_cap" };
  }
  const body = opts.texts.join("\n\n").slice(0, 8000);
  const subject = (row?.subject ? `Re: ${row.subject}` : "Re: your message").slice(0, 200);
  const logicalKey = `reply:${opts.rowId}:0`;




  let replyTo: string | undefined;
  if (opts.capabilityPeer) {
    const existing = await env.DB.prepare(`SELECT reply_to FROM email_outbox WHERE workspace_id=? AND logical_key=?`)
      .bind(opts.route.workspaceId, logicalKey)
      .first<{ reply_to: string | null }>();
    if (existing?.reply_to) {
      replyTo = existing.reply_to;
    } else {
      const rotated = await rotateThreadCapabilityReplyTo(env, {
        workspaceId: opts.route.workspaceId,
        threadId: opts.threadId,
        peerAddress: opts.capabilityPeer,
        localPart: opts.route.localPart,
        domain: opts.route.domain,
      });
      if (rotated.ok) {
        replyTo = rotated.replyTo;
      } else {

        console.error(
          "[email] capability Reply-To rotation failed",
          JSON.stringify({ rowId: opts.rowId, threadId: opts.threadId, error: rotated.error }),
        );
      }
    }
  }

  const res = await enqueueOutbox(env, {
    workspaceId: opts.route.workspaceId,
    logicalKey,
    fromAddr: opts.route.address,
    toAddr: to,
    subject,
    textBody: body,
    threadId: opts.threadId,
    rootTaskId: opts.rootTaskId,
    messageId: getOutboundMessageId(opts.route.address),
    replyTo,
    autoSubmitted: "auto-replied",
  });
  if (!res.created) {

    await refundEmailQuota(env, opts.route.workspaceId, day, "outbound_send").catch((e) => {
      console.error("[email] quota refund failed", String(e));
    });
  }
  return { kind: "queued", outboxId: res.id, created: res.created };
}
