


import type { Env } from "../env";
import { now } from "../util";
import { newCodeVerifier, codeChallengeS256 } from "./pkce";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export const DEFAULT_REDIRECT_TO = "/workspace";









export function normalizeRedirectTo(raw: string | null | undefined): string {
  if (raw == null) return DEFAULT_REDIRECT_TO;
  let v = String(raw).trim();
  if (!v) return DEFAULT_REDIRECT_TO;

  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(v);
    } catch {
      return DEFAULT_REDIRECT_TO;
    }
    if (next === v) break;
    v = next;
  }
  v = v.trim();

  if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(v)) return DEFAULT_REDIRECT_TO;
  if (/\s/.test(v)) return DEFAULT_REDIRECT_TO;
  if (/[\\"'<>`]/.test(v)) return DEFAULT_REDIRECT_TO;

  if (!v.startsWith("/") || v.startsWith("//")) return DEFAULT_REDIRECT_TO;
  if (v.length > 512) return DEFAULT_REDIRECT_TO;

  if (/^\/(\.\.?)(\/|$)/.test(v)) return DEFAULT_REDIRECT_TO;

  if (/^\/[^/?#]*:/.test(v)) return DEFAULT_REDIRECT_TO;
  return v;
}

export async function createOAuthState(env: Env, ws: string, userId: string, provider: string, redirectTo?: string, reauthLabel?: string): Promise<{ state: string; codeChallenge?: string; codeVerifier?: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  const state = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let codeVerifier: string | undefined; let codeChallenge: string | undefined;
  if (provider === "google") { codeVerifier = await newCodeVerifier(); codeChallenge = await codeChallengeS256(codeVerifier); }

  const safeRedirect = redirectTo == null || String(redirectTo).trim() === "" ? null : normalizeRedirectTo(redirectTo);
  await env.DB.prepare("INSERT INTO oauth_states(state, workspace_id, user_id, provider, code_verifier, redirect_to, reauth_label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(state, ws, userId, provider, codeVerifier ?? null, safeRedirect, reauthLabel ?? null, now() + OAUTH_STATE_TTL_MS, now()).run();
  return { state, codeChallenge, codeVerifier };
}

export interface OAuthStateRow { state: string; workspace_id: string; user_id: string | null; provider: string; code_verifier: string | null; redirect_to: string | null; reauth_label: string | null; expires_at: number | null; created_at: number; }

export type ConsumeOAuthStateResult =
  | { ok: true; row: OAuthStateRow }
  | { ok: false; error: "invalid_state" | "state_consumed" | "state_expired" | "state_incomplete" };

function claimToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}








export async function consumeOAuthState(env: Env, state: string): Promise<ConsumeOAuthStateResult> {
  if (!state) return { ok: false, error: "invalid_state" };
  const t = now();
  const claim = claimToken();
  const cas = await env.DB.prepare(
    "UPDATE oauth_states SET consumed_at=?, claim_token=? WHERE state=? AND consumed_at IS NULL AND expires_at IS NOT NULL AND expires_at>?",
  ).bind(t, claim, state, t).run();
  if (((cas.meta as any)?.changes ?? 0) !== 1) {

    const row = await env.DB.prepare("SELECT consumed_at, expires_at FROM oauth_states WHERE state=?").bind(state).first<{ consumed_at: number | null; expires_at: number | null }>();
    if (!row) return { ok: false, error: "invalid_state" };
    if (row.consumed_at != null) return { ok: false, error: "state_consumed" };
    if (row.expires_at == null) return { ok: false, error: "state_incomplete" };
    return { ok: false, error: "state_expired" };
  }

  const row = await env.DB.prepare(
    "SELECT state, workspace_id, user_id, provider, code_verifier, redirect_to, reauth_label, expires_at, created_at FROM oauth_states WHERE state=? AND claim_token=?",
  ).bind(state, claim).first<OAuthStateRow>();
  if (!row) return { ok: false, error: "invalid_state" };
  if (!row.workspace_id || !row.provider || row.expires_at == null) return { ok: false, error: "state_incomplete" };
  return { ok: true, row };
}
