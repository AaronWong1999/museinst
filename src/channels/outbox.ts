









//



import type { Env } from "../env";
import { getTelegramToken } from "./config";
import { splitText } from "./outbound";
import { newId, now } from "../util";
import { getHostHooks, type OutboundSendRequest } from "../hooks";

export const TELEGRAM_CHUNK_MAX = 3900;
const CHUNK_GAP_MS = 1000;

export const SENDING_LEASE_MS = 3 * 60 * 1000;

export interface OutboxStaging {
  inboxId: string;
  channel: string;
  destinationId: string;
  replyToMessageId?: string;
}


export async function stageOutbox(env: Env, staging: OutboxStaging, replies: string[]): Promise<void> {
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  replies.forEach((reply, replyIndex) => {
    const chunks = splitText(reply, TELEGRAM_CHUNK_MAX);
    chunks.forEach((chunk, chunkIndex) => {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO channel_outbox
             (id, inbox_id, channel, destination_id, reply_to_message_id, reply_index, chunk_index, text, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).bind(
          newId("co"), staging.inboxId, staging.channel, staging.destinationId,
          staging.replyToMessageId ?? null, replyIndex, chunkIndex, chunk, t,
        ),
      );
    });
  });
  if (stmts.length > 0) await env.DB.batch(stmts);
}

type SendOutcome =
  | { kind: "sent"; telegramMessageId?: string }
  | { kind: "retryable"; retryAfterSeconds?: number; error: string }
  | { kind: "permanent"; error: string }
  | { kind: "uncertain"; error: string };

function leaseField(token: string, deadlineMs: number): string {
  return `claim:${token}:${deadlineMs}`;
}

function parseLeaseField(v: string | null | undefined): { token: string; deadline: number } | null {
  const m = /^claim:([0-9a-zA-Z-]{6,}):(\d{6,})$/.exec(String(v ?? ""));
  if (!m) return null;
  return { token: m[1], deadline: Number(m[2]) };
}

async function sendChunk(
  env: Env,
  chunk: { text: string; destination_id: string; reply_to_message_id: string | null; chunk_index: number },
): Promise<SendOutcome> {
  const token = await getTelegramToken(env);
  if (!token) return { kind: "uncertain", error: "telegram_not_configured" };

  const body: Record<string, unknown> = {
    chat_id: chunk.destination_id,
    text: chunk.text,

    link_preview_options: { is_disabled: true },
  };
  if (chunk.chunk_index === 0 && chunk.reply_to_message_id) {
    const n = Number(String(chunk.reply_to_message_id).split(":").pop() ?? "");
    if (Number.isFinite(n) && n > 0) body.reply_parameters = { message_id: n };
  }

  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {

    return { kind: "uncertain", error: String(e) };
  }

  interface TgSendResponse {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
    parameters?: { retry_after?: number };
  }
  let j: TgSendResponse | null = null;
  try {
    j = (await res.json()) as TgSendResponse;
  } catch {

    return { kind: "uncertain", error: `unparseable_response_http_${res.status}` };
  }

  if (res.ok && j?.ok) {
    return { kind: "sent", telegramMessageId: j.result?.message_id != null ? String(j.result.message_id) : undefined };
  }
  if (res.status === 429) {
    const retryAfter = j?.parameters?.retry_after;
    return { kind: "retryable", retryAfterSeconds: typeof retryAfter === "number" ? retryAfter : undefined, error: j?.description ?? "rate_limited" };
  }

  return { kind: "permanent", error: j?.description ?? `http_${res.status}` };
}

export interface DrainResult {
  outcome: "all_sent" | "has_retryable" | "has_permanent" | "has_uncertain";
  retryAfterSeconds?: number;

  inflight?: number;
}

interface OutboxChunkRow {
  id: string;
  chunk_index: number;
  text: string;
  destination_id: string;
  reply_to_message_id: string | null;
  status: string;
  last_error: string | null;
}


async function sweepStaleSending(env: Env, rows: OutboxChunkRow[], t: number): Promise<void> {
  for (const row of rows) {
    if (row.status !== "sending") continue;
    const lease = parseLeaseField(row.last_error);
    if (lease && lease.deadline > t) continue;
    const r = await env.DB.prepare(
      `UPDATE channel_outbox SET status='uncertain', uncertain_at=?, last_error=?
        WHERE id=? AND status='sending' AND last_error IS ?`,
    )
      .bind(t, `sending_lease_expired:${row.last_error ?? "unknown"}`, row.id, row.last_error)
      .run();
    if ((r.meta?.changes ?? 0) === 1) {
      row.status = "uncertain";
      console.warn("[outbox] stale sending → uncertain (no auto resend)", row.id);
    }
  }
}


async function hostAllowsSend(
  env: Env,
  row: OutboxChunkRow,
  workspaceId: string | undefined,
  inboxId: string,
  inboundAutoReply: boolean,
): Promise<{ allow: boolean; reason: string }> {


  if (!workspaceId && inboundAutoReply) return { allow: true, reason: "unbound_auto_reply" };

  const hook = getHostHooks().beforeOutboundSend;
  if (!hook) return { allow: true, reason: "no_host_gate" };
  const req: OutboundSendRequest = {
    channel: "telegram",
    workspaceId,
    destinationId: row.destination_id,
    source: "auto_reply",
    inboxId,
  };
  try {
    const d = await hook(env, req);
    if (d && d.allow === false) return { allow: false, reason: d.reason ?? "host_blocked" };
    return { allow: true, reason: "allowed" };
  } catch (e) {

    console.error("[outbox] beforeOutboundSend failed; owner channel keeps availability", String(e));
    return { allow: true, reason: "host_gate_error" };
  }
}

async function workspaceOfDestination(env: Env, channel: string, destinationId: string): Promise<string | undefined> {

  const row = await env.DB.prepare(`SELECT workspace_id FROM channel_identities WHERE channel=? AND external_id=? LIMIT 1`)
    .bind(channel, destinationId)
    .first<{ workspace_id: string }>();
  return row?.workspace_id;
}


async function isInboundAutoReply(env: Env, inboxId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id FROM channel_inbox WHERE id=? LIMIT 1`)
    .bind(inboxId)
    .first<{ id: string }>();
  return !!row;
}


async function persistOwned(env: Env, sql: string, args: unknown[], rowId: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await env.DB.prepare(sql).bind(...args).run();
      return (r.meta?.changes ?? 0) === 1;
    } catch (e) {
      if (i === 2) throw e;
      console.error("[outbox] persist retry", rowId, String(e));
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
  return false;
}


export async function drainTelegramOutbox(env: Env, inboxId: string): Promise<DrainResult> {
  const { results } = await env.DB.prepare(
    `SELECT id, chunk_index, text, destination_id, reply_to_message_id, status, last_error
       FROM channel_outbox WHERE inbox_id=? ORDER BY reply_index, chunk_index`,
  ).bind(inboxId).all<OutboxChunkRow>();

  const rows = results ?? [];
  const t0 = now();
  await sweepStaleSending(env, rows, t0);

  const result: DrainResult = { outcome: "all_sent" };
  const seenUncertain = rows.some((r) => r.status === "uncertain");
  if (seenUncertain) result.outcome = "has_uncertain";
  const wsCache = new Map<string, string | undefined>();
  const inboundAutoReply = await isInboundAutoReply(env, inboxId);

  for (const row of rows) {
    if (row.status === "sent" || row.status === "uncertain") continue;
    if (row.status === "permanent_failed") {
      if (result.outcome === "all_sent") result.outcome = "has_permanent";
      continue;
    }
    if (row.status === "sending") {


      result.inflight = (result.inflight ?? 0) + 1;
      result.outcome = "has_retryable";
      result.retryAfterSeconds = 5;
      break;
    }


    const leaseToken = crypto.randomUUID();
    const t = now();
    const claim = await env.DB.prepare(
      `UPDATE channel_outbox SET status='sending', attempts=attempts+1, last_error=?
        WHERE id=? AND status IN ('pending','retryable')`,
    )
      .bind(leaseField(leaseToken, t + SENDING_LEASE_MS), row.id)
      .run();
    if ((claim.meta?.changes ?? 0) !== 1) {

      result.inflight = (result.inflight ?? 0) + 1;
      result.outcome = "has_retryable";
      result.retryAfterSeconds = 5;
      break;
    }
    const owned = { status: "sending", last_error: leaseField(leaseToken, t + SENDING_LEASE_MS) };

    if (!wsCache.has(row.destination_id)) {
      wsCache.set(row.destination_id, await workspaceOfDestination(env, "telegram", row.destination_id));
    }
    const gate = await hostAllowsSend(env, row, wsCache.get(row.destination_id), inboxId, inboundAutoReply);
    if (!gate.allow) {

      await persistOwned(env, `UPDATE channel_outbox SET status='permanent_failed', last_error=? WHERE id=? AND status=? AND last_error=?`,
        [`outbound_blocked:${gate.reason}`, row.id, owned.status, owned.last_error], row.id);
      if (result.outcome === "all_sent") result.outcome = "has_permanent";
      row.status = "permanent_failed";
      continue;
    }

    const outcome = await sendChunk(env, row);
    if (outcome.kind === "sent") {
      let ok = false;
      try {
        ok = await persistOwned(
          env,
          `UPDATE channel_outbox SET status='sent', telegram_message_id=?, sent_at=?, uncertain_at=NULL, last_error=NULL
            WHERE id=? AND status=? AND last_error=?`,
          [outcome.telegramMessageId ?? null, now(), row.id, owned.status, owned.last_error],
          row.id,
        );
      } catch (e) {
        console.error("[outbox] sent persist failed after retries", row.id, String(e));
      }
      if (!ok) {

        throw new Error(`outbox_sent_persist_failed:${row.id}`);
      }
      row.status = "sent";
    } else if (outcome.kind === "retryable") {
      await persistOwned(
        env,
        `UPDATE channel_outbox SET status='retryable', last_error=? WHERE id=? AND status=? AND last_error=?`,
        [`429: ${outcome.error}`.slice(0, 300), row.id, owned.status, owned.last_error],
        row.id,
      );
      result.outcome = "has_retryable";
      result.retryAfterSeconds = outcome.retryAfterSeconds;
      break;
    } else if (outcome.kind === "permanent") {
      await persistOwned(
        env,
        `UPDATE channel_outbox SET status='permanent_failed', last_error=? WHERE id=? AND status=? AND last_error=?`,
        [outcome.error.slice(0, 300), row.id, owned.status, owned.last_error],
        row.id,
      );
      if (result.outcome === "all_sent") result.outcome = "has_permanent";
      row.status = "permanent_failed";
    } else {
      await persistOwned(
        env,
        `UPDATE channel_outbox SET status='uncertain', uncertain_at=?, last_error=? WHERE id=? AND status=? AND last_error=?`,
        [now(), outcome.error.slice(0, 300), row.id, owned.status, owned.last_error],
        row.id,
      );
      result.outcome = result.outcome === "all_sent" ? "has_uncertain" : result.outcome;
      row.status = "uncertain";
    }

    await new Promise((r) => setTimeout(r, CHUNK_GAP_MS));
  }
  return result;
}


export async function outboxStats(env: Env): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS c FROM channel_outbox GROUP BY status`,
  ).all<{ status: string; c: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.status] = r.c;
  return out;
}
