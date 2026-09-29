import type { Env } from "../env";
import { decryptField, encryptField } from "../crypto";

function flagEnabled(value: string | undefined, defaultEnabled = true): boolean {
  if (value === undefined || value === "") return defaultEnabled;
  return value === "1" || value.toLowerCase() === "true";
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE workspace_id='__global' AND key=?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (workspace_id, key, value) VALUES ('__global', ?, ?)
     ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value`,
  )
    .bind(key, value)
    .run();
}

export async function getTelegramToken(env: Env): Promise<string | null> {
  if (!flagEnabled(env.TELEGRAM_ENABLED, false)) return null;
  if (env.TELEGRAM_BOT_TOKEN) return env.TELEGRAM_BOT_TOKEN;
  const enc = await getSetting(env, "telegram_bot_token_enc");
  if (!enc) return null;
  try {
    return await decryptField(env, "telegram:token", enc);
  } catch {
    return null;
  }
}

export async function setTelegramToken(env: Env, token: string): Promise<void> {
  await setSetting(env, "telegram_bot_token_enc", await encryptField(env, "telegram:token", token));
}

export async function getTelegramWebhookSecret(env: Env): Promise<string | null> {
  if (!flagEnabled(env.TELEGRAM_ENABLED, false)) return null;
  if (env.TELEGRAM_WEBHOOK_SECRET) return env.TELEGRAM_WEBHOOK_SECRET;
  const enc = await getSetting(env, "telegram_webhook_secret_enc");
  if (!enc) return null;
  try {
    return await decryptField(env, "telegram:webhook_secret", enc);
  } catch {
    return null;
  }
}

export async function ensureTelegramWebhookSecret(env: Env): Promise<string> {
  const existing = await getTelegramWebhookSecret(env);
  if (existing) return existing;
  const secret = crypto.randomUUID().replace(/-/g, "");
  await setSetting(env, "telegram_webhook_secret_enc", await encryptField(env, "telegram:webhook_secret", secret));
  return secret;
}

export async function getTelegramUsername(env: Env): Promise<string | null> {
  return getSetting(env, "telegram_bot_username");
}
export async function setTelegramUsername(env: Env, username: string): Promise<void> {
  await setSetting(env, "telegram_bot_username", username);
}

export async function getTelegramBotId(env: Env): Promise<string | null> {
  return getSetting(env, "telegram_bot_id");
}
export async function setTelegramBotId(env: Env, id: string): Promise<void> {
  await setSetting(env, "telegram_bot_id", id);
}

export async function telegramGetMe(token: string): Promise<{ ok: boolean; id?: string; username?: string; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = (await res.json()) as { ok?: boolean; result?: { id?: number; username?: string }; description?: string };
    if (!res.ok || !j.ok || !j.result?.id) return { ok: false, error: j.description ?? `http_${res.status}` };
    return { ok: true, id: String(j.result.id), username: j.result.username };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function telegramConfigured(env: Env): Promise<boolean> {
  return !!(await getTelegramToken(env));
}

export async function wechatConfigured(env: Env): Promise<boolean> {
  if (!flagEnabled(env.WECHAT_ENABLED, true)) return false;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM wechat_bots WHERE status='active'`).first<{ c: number }>();
  return (row?.c ?? 0) > 0;
}

export function isAdmin(req: Request, env: Env): boolean {
  return !!env.ADMIN_KEY && req.headers.get("x-admin-key") === env.ADMIN_KEY;
}
