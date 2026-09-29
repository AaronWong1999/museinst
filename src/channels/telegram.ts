
//






import type { Env, InboundEnvelope } from "../env";
import type { ChannelEvent } from "./normalize";
import { getHostHooks } from "../hooks";
import {
  getTelegramToken,
  getTelegramWebhookSecret,
  getTelegramBotId,
  setTelegramBotId,
  setTelegramToken,
  setTelegramUsername,
  ensureTelegramWebhookSecret,
  telegramGetMe,
} from "./config";

export const TELEGRAM_TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; language_code?: string; is_bot?: boolean };
    chat: { id: number; type?: string };
    text?: string;

    location?: { latitude: number; longitude: number; horizontal_accuracy?: number; live_period?: number };

    voice?: { file_id: string; duration: number; mime_type?: string };

    photo?: unknown[];
    document?: { file_name?: string };
    video?: unknown;
    sticker?: unknown;
  };
}


export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}







export function parseUpdate(update: TgUpdate): ChannelEvent | null {
  const msg = update.message;
  if (!msg || !msg.from || msg.from.is_bot) return null;
  const chatType = msg.chat?.type ?? "private";
  const senderId = String(msg.from.id);
  const base = {
    channel: "telegram" as const,
    senderId,
    messageId: `${msg.chat.id}:${msg.message_id}`,
    receivedAt: Date.now(),
    ...(chatType === "private" ? {} : { groupChatId: String(msg.chat.id) }),
  };
  if (msg.location) {
    return {
      ...base,
      kind: "location",
      location: {
        lat: msg.location.latitude,
        lng: msg.location.longitude,
        accuracy: msg.location.horizontal_accuracy,
        live: typeof msg.location.live_period === "number",
      },
      text: undefined,
    };
  }
  if (msg.voice) {
    return { ...base, kind: "voice", voiceFileId: msg.voice.file_id, mediaNote: `voice_${msg.voice.duration ?? 0}s` };
  }

  if (msg.photo) return { ...base, kind: "image", mediaNote: "photo" };
  if (msg.document) return { ...base, kind: "file", mediaNote: msg.document.file_name ?? "document" };
  if (msg.video) return { ...base, kind: "video", mediaNote: "video" };
  if (msg.sticker) return { ...base, kind: "sticker", mediaNote: "sticker" };
  const text = msg.text ?? "";
  if (!text) return null;
  return { ...base, kind: "text", text };
}


export interface VoiceBudget {
  maxBytes: number;
  maxDurationSeconds: number;
  timeoutMs: number;

  durationSeconds?: number;

  usageRef?: string;
  costAttribution?: "owner" | "platform" | "none";
}

export const VOICE_DEFAULT_BUDGET: VoiceBudget = {
  maxBytes: 5 * 1024 * 1024,
  maxDurationSeconds: 300,
  timeoutMs: 30_000,
};


async function readBodyLimited(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}


function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}






export async function transcribeVoice(
  env: Env,
  fileId: string,
  budget: Partial<VoiceBudget> = {},
): Promise<string | null> {
  const limits: VoiceBudget = { ...VOICE_DEFAULT_BUDGET, ...budget };
  if (limits.durationSeconds != null && limits.durationSeconds > limits.maxDurationSeconds) {
    console.warn("[telegram] voice over duration budget; skip transcription");
    return null;
  }
  const token = await getTelegramToken(env);
  if (!token) return null;

  let text = "";
  try {
    const meta = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
    const mj = (await meta.json()) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
    const path = mj.result?.file_path;
    if (!meta.ok || !mj.ok || !path) return null;
    if (typeof mj.result?.file_size === "number" && mj.result.file_size > limits.maxBytes) {
      console.warn("[telegram] voice file over byte budget; skip download");
      return null;
    }
    const bin = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
    if (!bin.ok) return null;
    const buf = await readBodyLimited(bin, limits.maxBytes);
    if (!buf || buf.length === 0) return null;
    if (!env.AI || typeof env.AI.run !== "function") {
      console.error("[telegram] AI binding unavailable; cannot transcribe");
      return null;
    }
    const audio = bytesToBase64(buf);
    const out = (await env.AI.run(TELEGRAM_TRANSCRIPTION_MODEL, { audio, task: "transcribe" })) as { text?: string };
    text = (out?.text ?? "").trim();
    if (!text) return null;
  } catch (e) {
    console.error("[telegram] transcribeVoice failed", String(e));
    return null;
  }



  const afterMediaUsage = getHostHooks().afterMediaUsage;
  if (afterMediaUsage) {
    await afterMediaUsage(env, {
      channel: "telegram",
      kind: "voice",
      fileId,
      model: TELEGRAM_TRANSCRIPTION_MODEL,
      durationSeconds: limits.durationSeconds,
      usageRef: limits.usageRef,
      costAttribution: limits.costAttribution,
    });
  }
  return text;
}

export async function setWebhook(env: Env, base: string): Promise<{ ok: boolean; error?: string }> {
  const token = await getTelegramToken(env);
  const secret = await getTelegramWebhookSecret(env);
  if (!token || !secret) return { ok: false, error: "telegram_not_configured" };
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${base}/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    }),
  });
  const j = (await res.json()) as { ok: boolean; description?: string };
  return { ok: j.ok, error: j.description };
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

async function callTelegramMethod(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as TelegramApiResponse;
    if (!res.ok || !j.ok) return { ok: false, error: j.description ?? `http_${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}





async function configureTelegramBotProfile(token: string): Promise<{ ok: boolean; error?: string }> {
  const profiles = [
    {
      languageCode: undefined,
      name: "MuseInst",
      description: "MuseInst is your personal agent. Tell it what you need and it gets it done: it searches, browses, books, sends email and remembers what you prefer. Press Start, then connect your account at museinst.com.",
      shortDescription: "Your personal agent · museinst.com",
      commands: [
        { command: "start", description: "Start or connect MuseInst" },
        { command: "help", description: "What MuseInst can do" },
        { command: "bind", description: "Connect your account" },
      ],
    },
    {
      languageCode: "zh",
      name: "MuseInst 个人助理",
      description: "MuseInst 是你的个人 Agent。告诉它你要做什么，它会去搜索、打开网页、预订、发邮件，并记住你的偏好。点「开始」，然后在 museinst.com 绑定你的账号。",
      shortDescription: "你的个人 Agent · museinst.com",
      commands: [
        { command: "start", description: "开始或连接 MuseInst" },
        { command: "help", description: "看看 MuseInst 能做什么" },
        { command: "bind", description: "绑定你的账号" },
      ],
    },
  ];

  for (const profile of profiles) {
    const localized = profile.languageCode ? { language_code: profile.languageCode } : {};
    for (const [method, body] of [
      ["setMyName", { name: profile.name, ...localized }],
      ["setMyDescription", { description: profile.description, ...localized }],
      ["setMyShortDescription", { short_description: profile.shortDescription, ...localized }],
      ["setMyCommands", { commands: profile.commands, ...localized }],
    ] as const) {
      const result = await callTelegramMethod(token, method, body);
      if (!result.ok) return { ok: false, error: `${method}:${result.error ?? "failed"}` };
    }
  }
  return { ok: true };
}


export async function getWebhookInfo(env: Env): Promise<{ ok: boolean; info?: { url: string; pending_update_count: number; last_error_message?: string; last_error_date?: number }; error?: string }> {
  const token = await getTelegramToken(env);
  if (!token) return { ok: false, error: "telegram_not_configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const j = (await res.json()) as { ok?: boolean; result?: { url: string; pending_update_count: number; last_error_message?: string; last_error_date?: number }; description?: string };
    if (!res.ok || !j.ok || !j.result) return { ok: false, error: j.description ?? `http_${res.status}` };
    return { ok: true, info: j.result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}










export async function handleTelegramWebhook(env: Env, request: Request): Promise<Response> {
  const secret = await getTelegramWebhookSecret(env);
  const supplied = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !timingSafeEqual(secret, supplied)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const update = (await request.json().catch(() => null)) as TgUpdate | null;
  if (!update || typeof update.update_id !== "number") {
    return Response.json({ ok: true });
  }

  const botId = await getTelegramBotId(env);
  if (!botId) return Response.json({ ok: false, error: "telegram_not_initialized" }, { status: 503 });

  const envelope: InboundEnvelope = {
    v: 1,
    channel: "telegram",
    botId,
    externalKey: String(update.update_id),
    payload: update,
    receivedAt: Date.now(),
  };
  try {
    await env.INBOUND_QUEUE.send(envelope);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("[telegram] enqueue failed", String(e));
    return Response.json({ ok: false, error: "enqueue_failed" }, { status: 503 });
  }
}






export async function setupTelegramBot(
  env: Env,
  token: string,
  options?: {
    baseUrl?: string;

    expectedUsername?: string;

    dropPendingUpdates?: boolean;

    persistToken?: boolean;
  },
): Promise<{ ok: boolean; id?: string; username?: string; webhook?: string; error?: string; errorDetail?: string }> {
  const me = await telegramGetMe(token);
  if (!me.ok || !me.id) return { ok: false, error: "invalid_token", errorDetail: me.error };
  const expected = options?.expectedUsername?.toLowerCase();
  if (expected && String(me.username ?? "").toLowerCase() !== expected) {
    return { ok: false, error: "wrong_hosted_bot", username: me.username, id: me.id };
  }
  const profile = await configureTelegramBotProfile(token);
  if (!profile.ok) return { ok: false, error: "profile_setup_failed", errorDetail: profile.error };
  if (options?.persistToken !== false) await setTelegramToken(env, token);
  await setTelegramBotId(env, me.id);
  if (me.username) await setTelegramUsername(env, me.username);
  await ensureTelegramWebhookSecret(env);
  const base = options?.baseUrl ?? env.PUBLIC_BASE_URL;
  const webhook = `${base}/telegram/webhook`;
  const secret = await getTelegramWebhookSecret(env);
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhook,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: options?.dropPendingUpdates === true,
    }),
  });
  const j = (await res.json()) as { ok: boolean; description?: string };
  if (!res.ok || !j.ok) return { ok: false, error: j.description ?? `http_${res.status}` };
  return { ok: true, id: me.id, username: me.username, webhook };
}