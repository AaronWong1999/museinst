







import type { Env, InboundEnvelope } from "../env";
import { parseUpdate, transcribeVoice, type TgUpdate } from "./telegram";
import { dispatchChannelEvent } from "./dispatch";
import { getTelegramUsername } from "./config";
import { stageOutbox, drainTelegramOutbox, outboxStats, type DrainResult, type OutboxStaging } from "./outbox";
import { chatCopy, type Lang } from "../copy";
import { now } from "../util";
import { getHostHooks, type MediaAdmissionDecision } from "../hooks";
import { withDeadline } from "../util/deadlines";



const LEASE_MS = 15 * 60 * 1000;

const LEASE_HEARTBEAT_FRACTION = 0.5;


export const VOICE_MAX_BYTES = 5 * 1024 * 1024;
export const VOICE_MAX_DURATION_SECONDS = 300;
export const VOICE_TIMEOUT_MS = 30_000;

export type ConsumeOutcome = { kind: "ack" } | { kind: "retry"; delaySeconds?: number };

export { outboxStats };

function inboxDay(): string {
  return new Date().toISOString().slice(0, 10);
}


export async function bumpMetric(env: Env, channel: string, event: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO channel_metrics (day, channel, event, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, channel, event) DO UPDATE SET count = count + 1`,
    ).bind(inboxDay(), channel, event).run();
  } catch (e) {
    console.error("[inbox] metric write failed", event, String(e));
  }
}


export async function inboxStats(env: Env): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS c FROM channel_inbox GROUP BY status`,
  ).all<{ status: string; c: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.status] = r.c;
  return out;
}


async function finalizeInbox(env: Env, id: string, leaseToken: string, note: string | null): Promise<void> {
  const r = await env.DB.prepare(
    `UPDATE channel_inbox SET status='done', last_error=?, completed_at=?, payload_json=NULL, lease_token=NULL, lease_until=NULL
      WHERE id=? AND lease_token=?`,
  ).bind(note, now(), id, leaseToken).run();
  if ((r.meta?.changes ?? 0) !== 1) throw new Error(`inbox_finalize_failed:${id}`);
}


function langOf(update: TgUpdate | null, eventText: string | undefined): Lang {
  void update;
  if (/[\u4e00-\u9fff]/.test(eventText ?? "")) return "zh";
  return "en";
}

interface PersistedResult {
  replies?: string[];
  voiceText?: string;
  mediaAdmission?: { reason: string; userMessage?: string; costAttribution?: string; usageRef?: string };
}

function parsePersisted(resultJson: string | null): PersistedResult | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as PersistedResult;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}





async function admitVoice(
  env: Env,
  opts: { senderId: string; botId?: string; fileId: string; durationSeconds?: number; mimeType?: string },
): Promise<{ allow: boolean; reason: string; userMessage?: string; costAttribution?: string; usageRef?: string }> {
  const hook = getHostHooks().beforeMediaAdmission;
  if (!hook) return { allow: true, reason: "no_host_gate" };
  try {
    const d: MediaAdmissionDecision = await hook(env, {
      channel: "telegram",
      kind: "voice",
      senderId: opts.senderId,
      botId: opts.botId,
      fileId: opts.fileId,
      durationSeconds: opts.durationSeconds,
      mimeType: opts.mimeType,
      receivedAt: now(),
    });
    if (d && d.allow) return { allow: true, reason: "allowed", costAttribution: d.costAttribution, usageRef: d.usageRef };
    return { allow: false, reason: d?.reason ?? "denied", userMessage: d?.userMessage };
  } catch (e) {
    console.error("[inbox] beforeMediaAdmission failed; fail closed", String(e));
    return { allow: false, reason: "gate_error" };
  }
}


async function persistVoiceText(
  env: Env,
  id: string,
  leaseToken: string,
  voiceText: string,
  mediaAdmission: PersistedResult["mediaAdmission"],
  prev: PersistedResult | null,
): Promise<void> {
  const payload: PersistedResult = { ...(prev ?? {}), voiceText, mediaAdmission };
  const r = await env.DB.prepare(
    `UPDATE channel_inbox SET result_json=? WHERE id=? AND lease_token=?`,
  ).bind(JSON.stringify(payload), id, leaseToken).run();
  if ((r.meta?.changes ?? 0) !== 1) throw new Error(`inbox_voice_persist_failed:${id}`);
}






async function replyAndDrain(
  env: Env,
  id: string,
  leaseToken: string,
  staging: OutboxStaging,
  replies: string[],
  note: string,
): Promise<ConsumeOutcome> {
  if (replies.length > 0) await stageOutbox(env, staging, replies);
  const setSending = await env.DB.prepare(
    `UPDATE channel_inbox SET status='sending' WHERE id=? AND lease_token=?`,
  ).bind(id, leaseToken).run();
  if ((setSending.meta?.changes ?? 0) !== 1) throw new Error(`inbox_lease_lost:${id}`);

  const drain: DrainResult = await drainTelegramOutbox(env, id);
  if (drain.outcome === "has_retryable") {
    await bumpMetric(env, "telegram", "rate_limited");

    await env.DB.prepare(
      `UPDATE channel_inbox SET status='sending', last_error=?, lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?`,
    ).bind(`retryable_send:${drain.retryAfterSeconds ?? "?"}s`, id, leaseToken).run();
    return { kind: "retry", delaySeconds: Math.max(1, drain.retryAfterSeconds ?? 10) };
  }
  if (drain.outcome === "all_sent") {
    await bumpMetric(env, "telegram", "sent");
  } else {
    await bumpMetric(env, "telegram", drain.outcome === "has_permanent" ? "permanent_failed" : "uncertain");
  }
  await finalizeInbox(env, id, leaseToken, drain.outcome === "all_sent" ? note : `${note}:${drain.outcome}`);
  return { kind: "ack" };
}





export async function consumeInboundEnvelope(env: Env, envelope: InboundEnvelope): Promise<ConsumeOutcome> {
  if (!envelope || envelope.v !== 1 || envelope.channel !== "telegram" || !envelope.botId || !envelope.externalKey) {
    return { kind: "ack" };
  }

  const t = now();


  const id = `ci_${envelope.botId}_${envelope.externalKey}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO channel_inbox (id, channel, bot_id, external_key, payload_json, status, received_at)
     VALUES (?, 'telegram', ?, ?, ?, 'queued', ?)`,
  ).bind(id, envelope.botId, envelope.externalKey, JSON.stringify(envelope.payload), envelope.receivedAt || t).run();
  await bumpMetric(env, "telegram", "received");

  const row = await env.DB.prepare(
    `SELECT id, status, payload_json, result_json, attempts FROM channel_inbox WHERE id=?`,
  ).bind(id).first<{ id: string; status: string; payload_json: string | null; result_json: string | null; attempts: number }>();
  if (!row) throw new Error(`inbox_row_missing:${id}`);
  if (row.status === "done") return { kind: "ack" };



  const leaseToken = crypto.randomUUID();
  const leased = await env.DB.prepare(
    `UPDATE channel_inbox SET status='processing', lease_token=?, lease_until=?, attempts=attempts+1
      WHERE id=? AND status <> 'done' AND (lease_until IS NULL OR lease_until < ?)`,
  ).bind(leaseToken, t + LEASE_MS, id, t).run();
  if ((leased.meta?.changes ?? 0) !== 1) {
    return { kind: "retry", delaySeconds: 15 };
  }


  const fresh = await env.DB.prepare(
    `SELECT payload_json, result_json FROM channel_inbox WHERE id=?`,
  ).bind(id).first<{ payload_json: string | null; result_json: string | null }>();
  if (!fresh) throw new Error(`inbox_row_missing_after_lease:${id}`);
  let persisted = parsePersisted(fresh.result_json);

  const update = (JSON.parse(fresh.payload_json ?? "null") as TgUpdate | null);
  const event = update ? parseUpdate(update) : null;
  const lang = langOf(update, event?.text);
  const copy = chatCopy[lang];

  if (!event) {
    await finalizeInbox(env, id, leaseToken, "no_dispatchable_event");
    return { kind: "ack" };
  }


  if (event.groupChatId) {
    await bumpMetric(env, "telegram", "group_rejected");
    const username = await getTelegramUsername(env);
    return await replyAndDrain(
      env, id, leaseToken,
      { inboxId: id, channel: "telegram", destinationId: event.groupChatId, replyToMessageId: event.messageId },
      [copy.groupDmOnly(username ?? undefined)],
      "group_dm_only",
    );
  }


  if (event.kind === "image" || event.kind === "file" || event.kind === "video" || event.kind === "sticker") {
    await bumpMetric(env, "telegram", "unsupported_media");
    return await replyAndDrain(
      env, id, leaseToken,
      { inboxId: id, channel: "telegram", destinationId: event.senderId, replyToMessageId: event.messageId },
      [copy.unsupportedMedia],
      `unsupported_media:${event.kind}`,
    );
  }


  let processable = event;
  if (event.kind === "voice" && event.voiceFileId) {
    let voiceText = persisted?.voiceText ?? null;
    let mediaAdmission = persisted?.mediaAdmission ?? null;
    if (!voiceText) {
      const voice = update?.message?.voice;
      const durationSeconds = typeof voice?.duration === "number" ? voice.duration : undefined;
      if (durationSeconds != null && durationSeconds > VOICE_MAX_DURATION_SECONDS) {
        await bumpMetric(env, "telegram", "voice_too_long");
        return await replyAndDrain(
          env, id, leaseToken,
          { inboxId: id, channel: "telegram", destinationId: event.senderId, replyToMessageId: event.messageId },
          [copy.voiceFailed],
          "voice_over_duration_budget",
        );
      }
      const admission = await admitVoice(env, {
        senderId: event.senderId,
        botId: envelope.botId,
        fileId: event.voiceFileId,
        durationSeconds,
        mimeType: voice?.mime_type,
      });
      if (!admission.allow) {
        await bumpMetric(env, "telegram", "voice_gated");
        return await replyAndDrain(
          env, id, leaseToken,
          { inboxId: id, channel: "telegram", destinationId: event.senderId, replyToMessageId: event.messageId },
          [admission.userMessage || copy.voiceFailed],
          `voice_gated:${admission.reason}`,
        );
      }
      const text = await transcribeVoice(env, event.voiceFileId, {
        maxBytes: VOICE_MAX_BYTES,
        maxDurationSeconds: VOICE_MAX_DURATION_SECONDS,
        timeoutMs: VOICE_TIMEOUT_MS,
        durationSeconds,
        usageRef: admission.usageRef,
        costAttribution: admission.costAttribution as "owner" | "platform" | "none" | undefined,
      });
      if (!text) {
        await bumpMetric(env, "telegram", "voice_failed");
        return await replyAndDrain(
          env, id, leaseToken,
          { inboxId: id, channel: "telegram", destinationId: event.senderId, replyToMessageId: event.messageId },
          [copy.voiceFailed],
          "voice_transcribe_failed",
        );
      }
      voiceText = text;
      mediaAdmission = { reason: admission.reason, costAttribution: admission.costAttribution, usageRef: admission.usageRef };

      await persistVoiceText(env, id, leaseToken, voiceText, mediaAdmission, persisted);
      persisted = { ...(persisted ?? {}), voiceText, mediaAdmission };
    }
    processable = { ...event, kind: "text", text: voiceText, voiceFileId: undefined };
  }




  async function heartbeatLease(stage: string): Promise<void> {
    const r = await env.DB.prepare(
      `UPDATE channel_inbox SET lease_until=? WHERE id=? AND lease_token=?`,
    ).bind(now() + LEASE_MS, id, leaseToken).run();
    if ((r.meta?.changes ?? 0) !== 1) throw new Error(`inbox_ownership_lost:${id}:${stage}`);
  }
  let replies: string[];
  let nextPersisted = persisted;
  if (persisted?.replies) {
    replies = persisted.replies;
  } else {
    const collected: string[] = [];
    await heartbeatLease("pre_dispatch");


    const INBOX_DISPATCH_BUDGET_MS = 14 * 60_000;
    const result = await withDeadline(
      dispatchChannelEvent(env, processable, async (texts) => {
        collected.push(...texts);
      }),
      {
        operation: "inbox:dispatch",
        budgetMs: INBOX_DISPATCH_BUDGET_MS,
        onLateResult: () => {},
      },
    );
    if (result !== "handled") {

      throw new Error(`dispatch_failed:${id}`);
    }

    await heartbeatLease("post_dispatch");
    void LEASE_HEARTBEAT_FRACTION;
    replies = collected;
    nextPersisted = { ...(persisted ?? {}), replies };
    const saved = await env.DB.prepare(
      `UPDATE channel_inbox SET result_json=?, status='result_ready', processed_at=? WHERE id=? AND lease_token=?`,
    ).bind(JSON.stringify(nextPersisted), now(), id, leaseToken).run();
    if ((saved.meta?.changes ?? 0) !== 1) throw new Error(`inbox_result_persist_failed:${id}`);
  }


  return await replyAndDrain(
    env, id, leaseToken,
    { inboxId: id, channel: "telegram", destinationId: event.senderId, replyToMessageId: event.messageId },
    replies,
    "ok",
  );
}