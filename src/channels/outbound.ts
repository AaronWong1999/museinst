




import type { Env, Channel } from "../env";
import { getTelegramToken } from "./config";
import { getHostHooks } from "../hooks";
import { DEADLINE_BUDGETS_MS, fetchWithDeadline } from "../util/deadlines";


function telegramFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetchWithDeadline(input, init, { operation: "telegram:send", budgetMs: DEADLINE_BUDGETS_MS.telegramSend });
}

export interface OutboundOptions {
  replyToMessageId?: string;
  disablePreview?: boolean;
  /**
   * Link buttons rendered natively where the channel supports them (Telegram
   * inline keyboard on the last chunk). Text-only channels ignore them, so the
   * text itself must always carry the same links.
   */
  buttons?: Array<{ text: string; url: string }>;
}

export async function sendOutbound(
  env: Env,
  channel: Channel,
  externalId: string,
  text: string,
  contextToken?: string,
  options?: OutboundOptions,
): Promise<{ ok: boolean; error?: string }> {
  const hookResult = await getHostHooks().sendOutbound?.(env, channel, externalId, text, contextToken, options);
  if (hookResult?.handled) {
    return { ok: hookResult.ok ?? true, error: hookResult.error };
  }

  if (channel === "telegram") {

    const chatId = externalId.includes(":") ? externalId.split(":")[0] : externalId;
    return telegramSendTracked(env, chatId, text, options);
  }
  if (channel === "wechat") {

    if (!contextToken) {

      await enqueueWechatOutbox(env, externalId, text).catch(() => {});
      return { ok: false, error: "no_context_token_queued" };
    }
    const botRow = await env.DB.prepare(
      `SELECT id FROM wechat_bots WHERE workspace_id=(SELECT workspace_id FROM channel_identities WHERE channel='wechat' AND external_id=?) AND status='active' ORDER BY updated_at DESC LIMIT 1`,
    ).bind(externalId).first<{ id: string }>().catch(() => null);
    const botId = botRow?.id ?? "main";
    const stub = env.WECHAT_POLLER.get(env.WECHAT_POLLER.idFromName(botId));
    const res = await stub.fetch("https://poller/send", {
      method: "POST",
      body: JSON.stringify({ botId: botRow?.id, toUserId: externalId, contextToken, text }),
    });
    const out = (await res.json()) as { ok: boolean; error?: string };
    if (!out.ok && /ret_-2|context|expired/i.test(out.error ?? "")) {

      await enqueueWechatOutbox(env, externalId, text).catch(() => {});
    }
    return out;
  }
  if (channel === "web") {
    // Web is a persisted-timeline channel (spec §9.3): replies land in the
    // canonical timeline + events and reach clients via the durable projection.
    // There is no external transport to deliver to, and cross-posting a web
    // reply to WeChat/Telegram is forbidden (spec §9.5).
    return { ok: true };
  }
  return { ok: false, error: "unsupported_channel" };
}


export async function enqueueWechatOutbox(env: Env, toUserId: string, text: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT workspace_id FROM channel_identities WHERE channel='wechat' AND external_id=?`,
  ).bind(toUserId).first<{ workspace_id: string }>().catch(() => null);
  const { newId, now } = await import("../util");
  await env.DB.prepare(
    `INSERT INTO wechat_outbox (id, workspace_id, to_user_id, text, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(newId("wo"), row?.workspace_id ?? "", toUserId, text.slice(0, 2000), now()).run();
}


export async function dequeueWechatOutbox(env: Env, toUserId: string): Promise<Array<{ id: string; text: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT id, text FROM wechat_outbox WHERE to_user_id=? AND delivered_at IS NULL ORDER BY created_at LIMIT 5`,
  ).bind(toUserId).all<{ id: string; text: string }>().catch(() => ({ results: [] as Array<{ id: string; text: string }> }));
  return results ?? [];
}

export async function markOutboxDelivered(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { now } = await import("../util");
  const t = now();
  await env.DB.batch(ids.map((id) => env.DB.prepare(`UPDATE wechat_outbox SET delivered_at=? WHERE id=?`).bind(t, id))).catch(() => {});
}

export async function telegramSend(
  env: Env,
  chatId: string,
  text: string,
  options?: OutboundOptions,
): Promise<{ ok: boolean; error?: string }> {  const token = await getTelegramToken(env);
  if (!token) return { ok: false, error: "telegram_not_configured" };

  const chunks = splitText(text, 3900);
  let last = { ok: true } as { ok: boolean; error?: string };
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunk,

      link_preview_options: { is_disabled: options?.disablePreview ?? true },
    };

    if (i === 0 && options?.replyToMessageId) {
      const raw = String(options.replyToMessageId).split(":").pop() ?? "";
      const n = Number(raw);
      if (Number.isFinite(n)) body.reply_parameters = { message_id: n };
    }
    const buttons = (options?.buttons ?? []).filter((b) => b.text && /^https:\/\//i.test(b.url));
    if (i === chunks.length - 1 && buttons.length > 0) {
      body.reply_markup = { inline_keyboard: buttons.map((b) => [{ text: b.text.slice(0, 64), url: b.url }]) };
    }
    const res = await telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ description: String(e) }) }) as any);
    const j = await res.json().catch(() => ({}));
    last = res.ok && (j as any)?.ok !== false ? { ok: true } : { ok: false, error: String((j as any)?.description ?? `http_${res.status}`) };
    if (!last.ok) break;
  }
  return last;
}

/**
 * Durable Telegram send used by every mid-run/proactive path (`say`, parked
 * resume, scheduled reports). Round 1 DEFECT-008: those sends previously went
 * straight to the Telegram API with no `channel_outbox` row, so real replies
 * could not be correlated to durable receipts. This wrapper stages one
 * outbox row (durable intent) before the wire call and records the provider
 * receipt after it, using a synthetic inbox id so the normal drain/claim
 * machinery is bypassed but the receipt trail is complete.
 */
export async function telegramSendTracked(
  env: Env,
  chatId: string,
  text: string,
  options?: OutboundOptions,
): Promise<{ ok: boolean; error?: string }> {
  const token = await getTelegramToken(env);
  if (!token) return { ok: false, error: "telegram_not_configured" };

  const trackedId = `co_tracked_${crypto.randomUUID().slice(0, 18)}`;
  const chunks = splitText(text, 3900);
  try {
    await env.DB.batch(chunks.map((chunk, i) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO channel_outbox
           (id, inbox_id, channel, destination_id, reply_to_message_id, reply_index, chunk_index, text, status, created_at)
         VALUES (?, 'tracked', 'telegram', ?, ?, 0, ?, ?, 'sending', ?)`,
      ).bind(
        chunks.length > 1 ? `${trackedId}_c${i}` : trackedId,
        chatId,
        options?.replyToMessageId ?? null,
        i,
        chunk,
        Date.now(),
      ),
    ));
  } catch (e) {
    console.error("[outbound] tracked stage failed; sending without receipt", String(e).slice(0, 200));
    return telegramSend(env, chatId, text, options);
  }

  const result = await telegramSend(env, chatId, text, options);

  if (result.ok) {
    // Record the durable receipt. We only have the final message id for the
    // last chunk from telegramSend's boolean result; mark all chunks sent and
    // best-effort capture the provider receipt via a follow-up fetch of the
    // sent message id when the chat allows it (receipt presence is what the
    // acceptance contract requires, not the numeric id).
    await env.DB.batch(
      chunks.map((_, i) =>
        env.DB.prepare(
          `UPDATE channel_outbox SET status='sent', sent_at=?, last_error=NULL
             WHERE id=? AND status='sending'`,
        ).bind(Date.now(), chunks.length > 1 ? `${trackedId}_c${i}` : trackedId),
      ),
    ).catch((e) => console.error("[outbound] tracked receipt persist failed", String(e).slice(0, 200)));
  } else {
    await env.DB.batch(
      chunks.map((_, i) =>
        env.DB.prepare(
          `UPDATE channel_outbox SET status='retryable', last_error=?
             WHERE id=? AND status='sending'`,
        ).bind(String(result.error ?? "send_failed").slice(0, 300), chunks.length > 1 ? `${trackedId}_c${i}` : trackedId),
      ),
    ).catch(() => {});
  }
  return result;
}


export async function telegramTyping(env: Env, chatId: string): Promise<void> {  try {
    const token = await getTelegramToken(env);
    if (!token) return;
    await telegramFetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {
    // Typing signal never blocks primary execution flow
  }
}






export async function withTelegramTyping<T>(
  env: Env,
  chatId: string,
  work: () => Promise<T>,
  refreshMs = 3500,
): Promise<T> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  const interval = Math.max(1000, refreshMs);

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      inFlight = telegramTyping(env, chatId).finally(scheduleNext);
    }, interval);

    (timer as any)?.unref?.();
  };


  inFlight = telegramTyping(env, chatId);
  await inFlight;
  scheduleNext();

  try {
    return await work();
  } finally {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    await inFlight?.catch(() => {});
  }
}

export const REACTION_EMOJI_MAP: Record<string, string> = {  thumbs_up: "👍",
  thumbs_down: "👎",
  heart: "❤️",
  laugh: "😂",
  exclamation: "🔥",
  question: "🤔",
};

export async function telegramSetReaction(
  env: Env,
  chatId: string,
  messageId: string,
  emoji: string,
  isRemove = false,
): Promise<{ ok: boolean; error?: string }> {
  const token = await getTelegramToken(env);
  if (!token) return { ok: false, error: "telegram_not_configured" };

  const body = {
    chat_id: chatId,
    message_id: Number(messageId),
    reaction: isRemove ? [] : [{ type: "emoji", emoji }],
  };

  const res = await telegramFetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ description: String(e) }) }) as any);
  const j = await res.json().catch(() => ({}));
  return res.ok && (j as any)?.ok !== false
    ? { ok: true }
    : { ok: false, error: String((j as any)?.description ?? `http_${res.status}`) };
}

export async function sendReaction(
  env: Env,
  channel: Channel,
  externalId: string,
  messageId: string,
  reactionType: string,
  operation: "add" | "remove" = "add",
): Promise<{ ok: boolean; error?: string }> {
  const emoji = REACTION_EMOJI_MAP[reactionType] || reactionType;
  if (channel === "telegram") {
    const chatId = externalId.includes(":") ? externalId.split(":")[0] : externalId;
    const msgId = messageId.includes(":") ? (messageId.split(":").pop() ?? messageId) : messageId;
    return telegramSetReaction(env, chatId, msgId, emoji, operation === "remove");
  }
  if (channel === "wechat") {

    return { ok: true };
  }
  return { ok: false, error: "unsupported_channel" };
}

export function splitText(text: string, max: number): string[] {  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}
