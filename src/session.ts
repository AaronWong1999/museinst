import type { Env, SessionInfo } from "./env";
import { hmacSign, hmacVerify } from "./crypto";
import { now } from "./util";
import { getHostHooks } from "./hooks";

export const COOKIE_NAME = "oi";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const DEV_INSECURE_SECRET = "dev-insecure";
const MIN_SECRET_LEN = 16;

function validSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= MIN_SECRET_LEN && value !== DEV_INSECURE_SECRET;
}

/**
 * Production and self-hosted deployments always require an explicit session secret.
 * The insecure fallback is available only when a local developer opts in deliberately.
 */
function sessionSecret(env: Env): string {
  if (validSecret(env.OPENINST_SECRET)) return env.OPENINST_SECRET;
  if (env.ALLOW_INSECURE_DEV_SESSION === "1") {
    console.warn("[session] insecure development session secret is enabled explicitly");
    return DEV_INSECURE_SECRET;
  }
  throw new Error("OPENINST_SECRET_REQUIRED");
}

export async function createSession(env: Env, userId: string, workspaceId: string): Promise<{ id: string; cookie: string }> {
  const id = crypto.randomUUID().replace(/-/g, "");
  const t = now();
  const sig = await hmacSign(sessionSecret(env), id);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, workspaceId, t, t + SESSION_TTL_MS)
    .run();
  return { id, cookie: `${id}.${sig}` };
}

export async function readSession(env: Env, req: Request): Promise<SessionInfo | null> {
  const customAuth = getHostHooks().authenticateRequest;
  if (customAuth) {
    const session = await customAuth(env, req).catch(() => null);
    if (session) return session;
  }

  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9]+)\\.([A-Za-z0-9+/=]+)`));
  if (!match) return null;

  const [, id, sig] = match;
  if (!(await hmacVerify(sessionSecret(env), id, sig))) return null;

  const row = await env.DB.prepare(
    `SELECT user_id, workspace_id, expires_at FROM sessions WHERE id=?`,
  )
    .bind(id)
    .first<{ user_id: string; workspace_id: string; expires_at: number }>();
  if (!row || row.expires_at < now()) return null;
  return { userId: row.user_id, workspaceId: row.workspace_id };
}

export function sessionCookieHeader(cookie: string): string {
  return `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionHeader(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

const LOGIN_CLAIM_LEASE_MS = 60 * 1000;

export type ConsumeLoginResult =
  | { ok: true; cookie: string; workspaceId: string }
  | { ok: false; reason: "invalid" | "expired" };

/**
 * Claims a login nonce before creating the session. The nonce is finalized only after
 * session creation succeeds; a failed attempt releases only its own claim token.
 */
export async function consumeLoginNonceAndCreateSession(
  env: Env,
  nonce: string,
): Promise<ConsumeLoginResult> {
  const t = now();
  const expiredBefore = t - LOGIN_CLAIM_LEASE_MS;
  const claimToken = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE bind_nonces SET claim_state='pending', claim_token=?, claimed_at=?
      WHERE nonce=? AND purpose='login' AND used_at IS NULL AND expires_at>?
        AND (claim_state IS NULL OR (claim_state='pending' AND claimed_at<?))`,
  ).bind(claimToken, t, nonce, t, expiredBefore).run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    const row = await env.DB.prepare(
      `SELECT used_at, expires_at FROM bind_nonces WHERE nonce=? AND purpose='login'`,
    ).bind(nonce).first<{ used_at: number | null; expires_at: number }>();
    if (!row || row.used_at) return { ok: false, reason: "invalid" };
    if (row.expires_at < t) return { ok: false, reason: "expired" };
    return { ok: false, reason: "expired" };
  }

  const row = await env.DB.prepare(
    `SELECT workspace_id, user_id, claim_token FROM bind_nonces
      WHERE nonce=? AND claim_token=? AND claim_state='pending'`,
  ).bind(nonce, claimToken).first<{ workspace_id: string; user_id: string; claim_token: string }>();
  if (!row) {
    await env.DB.prepare(
      `UPDATE bind_nonces SET claim_state=NULL, claim_token=NULL, claimed_at=NULL
        WHERE nonce=? AND claim_state='pending' AND claim_token=?`,
    ).bind(nonce, claimToken).run();
    return { ok: false, reason: "invalid" };
  }

  try {
    const session = await createSession(env, row.user_id, row.workspace_id);
    const consumed = await env.DB.prepare(
      `UPDATE bind_nonces SET used_at=?, claim_state='consumed'
        WHERE nonce=? AND claim_token=? AND claim_state='pending' AND used_at IS NULL`,
    ).bind(now(), nonce, claimToken).run();
    if ((consumed.meta?.changes ?? 0) !== 1) {
      await env.DB.prepare(`DELETE FROM sessions WHERE id=?`).bind(session.id).run();
      throw new Error(`login_nonce_consume_failed:${nonce}`);
    }
    return { ok: true, cookie: session.cookie, workspaceId: row.workspace_id };
  } catch (error) {
    await env.DB.prepare(
      `UPDATE bind_nonces SET claim_state=NULL, claim_token=NULL, claimed_at=NULL
        WHERE nonce=? AND claim_state='pending' AND claim_token=?`,
    ).bind(nonce, claimToken).run();
    throw error;
  }
}
