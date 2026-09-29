
//









import type { Env } from "../../env";
import { newId } from "../../util";
import { sha256hex } from "../../crypto";

export type OutboxStatus =
  | "queued"
  | "sending"
  | "accepted"
  /** Provider accepted, but local state commit failed: only retry commit, do not resend */
  | "accepted_pending_commit"
  | "retry_wait"
  | "permanent_failed"
  | "delivery_unknown";


const PLATFORM_CONTROLLED_HEADERS: ReadonlySet<string> = new Set([
  "message-id",
  "date",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
  "return-path",
  "received",
  "dkim-signature",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "feedback-id",
  "tls-required",
  "tls-report-domain",
  "tls-report-submitter",
  "cfbl-address",
  "cfbl-feedback-id",
]);

export interface EnqueueOpts {
  workspaceId: string;
  logicalKey: string;
  fromAddr: string;
  toAddr: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  headers?: Record<string, string>;
  replyTo?: string;

  messageId: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  rootTaskId?: string;
  transport?: string;

  autoSubmitted?: "auto-generated" | "auto-replied" | "auto-notified";
}

export function getOutboundMessageId(fromAddr: string): string {
  const domain = String(fromAddr ?? "").split("@")[1] ?? "museinst.com";
  return `<${newId("msg").replace(/^msg_/, "")}.${Date.now().toString(36)}@${domain}>`;
}

export async function bodySha256(text: string): Promise<string> {
  return sha256hex(text);
}








async function compensateAutoReplyQuotaOnEnqueueFailure(env: Env, opts: EnqueueOpts, nowMs: number): Promise<void> {
  if (!opts.logicalKey.startsWith("reply:")) return;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  try {
    await env.DB.prepare(
      `UPDATE email_counters SET count=count-1, updated_at=?
        WHERE workspace_id=? AND day=? AND scope='outbound_send' AND count>0`,
    )
      .bind(Date.now(), opts.workspaceId, day)
      .run();
  } catch (e) {

    console.error("[email] auto-reply quota compensation failed", opts.workspaceId, opts.logicalKey, String(e));
  }
}


export async function enqueueOutbox(env: Env, opts: EnqueueOpts): Promise<{ id: string; created: boolean }> {
  const id = newId("eob");
  const nowMs = Date.now();
  const sha = await bodySha256(opts.textBody);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.autoSubmitted) headers["Auto-Submitted"] = opts.autoSubmitted;
  let r: Awaited<ReturnType<ReturnType<ReturnType<Env["DB"]["prepare"]>["bind"]>["run"]>>;
  try {
    r = await env.DB.prepare(
      `INSERT INTO email_outbox (id, workspace_id, logical_key, from_addr, to_addr, subject, text_body, html_body, body_sha256, headers_json, reply_to, message_id, in_reply_to, references_json, thread_id, root_task_id, transport, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
      .bind(
        id, opts.workspaceId, opts.logicalKey, opts.fromAddr, opts.toAddr, opts.subject.slice(0, 300),
        opts.textBody, opts.htmlBody ?? null, sha, JSON.stringify(headers),
        opts.replyTo ?? null, opts.messageId, opts.inReplyTo ?? null,
        opts.references ? JSON.stringify(opts.references) : null,
        opts.threadId ?? null, opts.rootTaskId ?? null, opts.transport ?? "send_email", nowMs, nowMs,
      )
      .run();
  } catch (e) {
    await compensateAutoReplyQuotaOnEnqueueFailure(env, opts, nowMs);
    throw e;
  }
  if ((r.meta?.changes ?? 0) === 1) return { id, created: true };
  const existing = await env.DB.prepare(`SELECT id FROM email_outbox WHERE workspace_id=? AND logical_key=?`)
    .bind(opts.workspaceId, opts.logicalKey)
    .first<{ id: string }>();
  return { id: existing?.id ?? id, created: false };
}

export interface SendEmailBinding {
  send(msg: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string;

    headers?: Record<string, string>;
    inReplyTo?: string;
    references?: string[];
  }): Promise<{ messageId: string }>;
}

export interface OutboxRow {
  id: string;
  workspace_id: string;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  text_body: string;
  html_body: string | null;
  headers_json: string;
  reply_to: string | null;
  message_id: string;
  in_reply_to: string | null;
  references_json: string | null;
  thread_id?: string | null;
  root_task_id: string | null;
  provider_message_id?: string | null;
  status: string;
  attempts: number;
  lease_token?: string | null;
}



export type SendErrorClass = "not_accepted_retryable" | "permanent" | "unknown";


const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "RATE_LIMIT_EXCEEDED",
  "RATE_LIMITED",
  "rate_limit_exceeded",
  "rate_limited",
  "TOO_MANY_REQUESTS",
  "too_many_requests",
]);

const PERMANENT_CODES: ReadonlySet<string> = new Set([
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
  "E_SENDER_NOT_VERIFIED",
  "E_DOMAIN_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_INVALID_REQUEST",
  "invalid_recipient",
  "recipient_blocked",
  "sender_not_verified",
  "invalid_request",
]);

function fieldOf(err: unknown, key: string): unknown {
  if (!err || typeof err !== "object") return undefined;
  const direct = (err as Record<string, unknown>)[key];
  if (direct !== undefined && direct !== null) return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") return (cause as Record<string, unknown>)[key];
  return undefined;
}

function statusOf(err: unknown): number | null {
  for (const k of ["status", "statusCode", "httpStatus"]) {
    const v = fieldOf(err, k);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function errorCodeOf(err: unknown): string {
  for (const k of ["code", "errorCode", "error_code"]) {
    const v = fieldOf(err, k);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const cause = fieldOf(err, "name");
  if (typeof cause === "string" && cause === "TimeoutError") return "TIMEOUT";
  return "";
}





export function classifySendError(err: unknown): SendErrorClass {
  const code = errorCodeOf(err);
  if (code && RETRYABLE_CODES.has(code)) return "not_accepted_retryable";
  if (code && PERMANENT_CODES.has(code)) return "permanent";
  const status = statusOf(err);
  if (status === 429) return "not_accepted_retryable";
  if (status !== null && status >= 400 && status < 500 && status !== 408) return "permanent";
  return "unknown";
}


export function isRetryableSendError(err: unknown): boolean {
  return classifySendError(err) === "not_accepted_retryable";
}

export function isHardSendError(err: unknown): boolean {
  return classifySendError(err) === "permanent";
}


export function buildProviderHeaders(row: Pick<OutboxRow, "headers_json" | "in_reply_to" | "references_json">): Record<string, string> {
  let stored: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.headers_json ?? "{}") as Record<string, string>;
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {
    stored = {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored)) {
    if (typeof v !== "string" || !v) continue;
    const lk = k.toLowerCase();
    if (PLATFORM_CONTROLLED_HEADERS.has(lk)) continue;
    out[k] = v;
  }
  if (row.in_reply_to) out["In-Reply-To"] = row.in_reply_to;
  let refs: string[] = [];
  try {
    const parsed = JSON.parse(row.references_json ?? "[]") as unknown;
    if (Array.isArray(parsed)) refs = parsed.filter((r): r is string => typeof r === "string" && r.length > 0);
  } catch {
    refs = [];
  }
  if (refs.length > 0) out["References"] = refs.join(" ");
  return out;
}

interface CommitResult {
  ok: boolean;
  error?: string;
}


async function commitAcceptedState(env: Env, rowId: string, leaseToken: string, providerMessageId: string | null): Promise<CommitResult> {
  try {
    const r = await env.DB.prepare(
      `UPDATE email_outbox SET status='accepted', provider_message_id=?, accepted_at=?, sent_marked_at=?, lease_token=NULL, lease_until=NULL, last_error=NULL
       WHERE id=? AND lease_token=?`,
    )
      .bind(providerMessageId, Date.now(), Date.now(), rowId, leaseToken)
      .run();
    if ((r.meta?.changes ?? 0) === 1) return { ok: true };
    return { ok: false, error: "lease_lost" };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

export async function sendOutboxRow(
  env: Env,
  sender: SendEmailBinding,
  row: OutboxRow,
  opts: { leaseMs?: number; maxAttempts?: number } = {},
): Promise<OutboxStatus> {
  const leaseMs = opts.leaseMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? 5;
  const nowMs = Date.now();
  const leaseToken = newId("lease");
  const claimed = await env.DB.prepare(
    `UPDATE email_outbox SET status='sending', attempts=attempts+1, lease_token=?, lease_until=?, last_error=NULL
     WHERE id=? AND status IN ('queued','retry_wait')`,
  )
    .bind(leaseToken, nowMs + leaseMs, row.id)
    .run();
  if ((claimed.meta?.changes ?? 0) !== 1) return row.status as OutboxStatus;
  const current = await env.DB.prepare(`SELECT * FROM email_outbox WHERE id=?`).bind(row.id).first<OutboxRow>();
  if (!current || current.lease_token !== leaseToken) return "delivery_unknown";
  if (current.attempts > maxAttempts) {
    await env.DB.prepare(`UPDATE email_outbox SET status='permanent_failed', last_error='max_attempts', lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?`)
      .bind(row.id, leaseToken)
      .run();
    return "permanent_failed";
  }

  const headers = buildProviderHeaders(current);
  const refs = headers["References"] ? headers["References"].split(" ").filter(Boolean) : [];

  let providerMessageId: string | null = null;
  try {
    const res = await sender.send({
      from: current.from_addr,
      to: current.to_addr,
      subject: current.subject ?? "",
      text: current.text_body,
      html: current.html_body ?? undefined,
      replyTo: current.reply_to ?? undefined,
      headers,
      inReplyTo: current.in_reply_to ?? undefined,
      references: refs.length > 0 ? refs : undefined,
    });
    providerMessageId = res?.messageId ?? null;
  } catch (e) {
    const cls = classifySendError(e);
    const detail = `${cls}:${errorCodeOf(e) || "no_code"}:${String(e).slice(0, 200)}`;
    if (cls === "not_accepted_retryable") {
      if (current.attempts < maxAttempts) {
        const backoff = Math.min(30 * 60_000, 5_000 * 2 ** Math.max(0, current.attempts - 1));
        await env.DB.prepare(
          `UPDATE email_outbox SET status='retry_wait', next_attempt_at=?, last_error=?, lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?`,
        )
          .bind(Date.now() + backoff, detail, row.id, leaseToken)
          .run();
        return "retry_wait";
      }
      await env.DB.prepare(
        `UPDATE email_outbox SET status='permanent_failed', last_error=?, lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?`,
      )
        .bind(`${detail}:max_attempts`, row.id, leaseToken)
        .run();
      return "permanent_failed";
    }
    if (cls === "permanent") {
      await env.DB.prepare(
        `UPDATE email_outbox SET status='permanent_failed', last_error=?, lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?`,
      )
        .bind(detail, row.id, leaseToken)
        .run();
      return "permanent_failed";
    }
    await env.DB.prepare(
      `UPDATE email_outbox SET status='delivery_unknown', last_error=?, lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?`,
    )
      .bind(`unknown:${detail}`, row.id, leaseToken)
      .run();
    return "delivery_unknown";
  }

  const committed = await commitAcceptedState(env, row.id, leaseToken, providerMessageId);
  if (committed.ok) return "accepted";
  const marker = `accepted_commit_failed:${committed.error ?? "unknown"}`;
  try {
    await env.DB.prepare(
      `UPDATE email_outbox SET status='accepted_pending_commit', provider_message_id=?, last_error=? WHERE id=? AND lease_token=?`,
    )
      .bind(providerMessageId, marker, row.id, leaseToken)
      .run();
  } catch {

  }
  return "accepted_pending_commit";
}


export async function retryAcceptedCommit(env: Env, limit = 20): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, provider_message_id FROM email_outbox WHERE status='accepted_pending_commit' LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; provider_message_id: string | null }>();
  let done = 0;
  for (const r of results ?? []) {
    const u = await env.DB.prepare(
      `UPDATE email_outbox SET status='accepted', accepted_at=?, sent_marked_at=?, last_error=NULL WHERE id=? AND status='accepted_pending_commit'`,
    )
      .bind(Date.now(), Date.now(), r.id)
      .run();
    done += u.meta?.changes ?? 0;
  }
  return done;
}


export async function sweepStuckSending(env: Env, nowMs = Date.now()): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE email_outbox SET status='delivery_unknown', last_error='unknown:lease_expired_result_unknown', lease_token=NULL, lease_until=NULL
     WHERE status='sending' AND lease_until IS NOT NULL AND lease_until < ?`,
  )
    .bind(nowMs)
    .run();
  return r.meta?.changes ?? 0;
}


export async function dueOutbox(env: Env, limit = 20, nowMs = Date.now()): Promise<OutboxRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM email_outbox WHERE status IN ('queued','retry_wait') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?`,
  )
    .bind(nowMs, limit)
    .all<OutboxRow>();
  return results ?? [];
}




export async function findThreadByProviderMessageId(env: Env, workspaceId: string, providerMessageId: string | null): Promise<string | null> {
  const mid = String(providerMessageId ?? "").trim().toLowerCase();
  if (!mid) return null;
  const row = await env.DB.prepare(`SELECT thread_id FROM email_outbox WHERE workspace_id=? AND LOWER(provider_message_id)=? LIMIT 1`)
    .bind(workspaceId, mid)
    .first<{ thread_id: string | null }>();
  return row?.thread_id ?? null;
}


export async function listUncertainOutbox(
  env: Env,
  workspaceId: string,
  limit = 50,
): Promise<Array<{ id: string; status: string; last_error: string | null; to_addr: string; logical_key: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT id, status, last_error, to_addr, logical_key FROM email_outbox
     WHERE workspace_id=? AND status IN ('delivery_unknown','accepted_pending_commit') ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(workspaceId, limit)
    .all<{ id: string; status: string; last_error: string | null; to_addr: string; logical_key: string }>();
  return results ?? [];
}
