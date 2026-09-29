
import type { Env } from "../env";
import { decryptField, encryptField } from "../crypto";
import { newId, now } from "../util";
import { normalizeAccountLabel } from "./account-label";
import { tokenBrokerId } from "./token-broker";
import { ConnectorCallError, type AccessTokenResult, type OAuthTokens } from "./types";

export const ACCESS_SKEW_MS = 60_000;

export interface ConnectionRow {
  account_label: string;
  encrypted_token: string;
  refresh_token_enc: string | null;
  expires_at: number | null;
  refresh_expires_at: number | null;
  needs_reauth: number;
  refresh_generation: number;
  scopes: string | null;
}


export async function resolveLabel(env: Env, ws: string, provider: string, requested?: string): Promise<string | null> {
  if (requested !== undefined && requested !== "") return normalizeAccountLabel(provider, requested);
  const row = await env.DB.prepare(
    "SELECT account_label FROM connections WHERE workspace_id=? AND provider=? ORDER BY COALESCE(created_at,0) ASC, account_label ASC LIMIT 1",
  ).bind(ws, provider).first<{ account_label: string }>();
  return row?.account_label ?? null;
}





export async function listAccounts(env: Env, ws: string, provider: string): Promise<Array<{ account_label: string; display_name: string | null; needs_reauth: number; created_at: number | null; scopes: string | null }>> {
  const r = await env.DB.prepare(
    "SELECT account_label, display_name, needs_reauth, created_at, scopes FROM connections WHERE workspace_id=? AND provider=? ORDER BY COALESCE(created_at,0) ASC, account_label ASC",
  ).bind(ws, provider).all<{ account_label: string; display_name: string | null; needs_reauth: number; created_at: number | null; scopes: string | null }>();
  return r.results ?? [];
}


export async function upsertConnectedAccount(env: Env, ws: string, provider: string, labelRaw: string, tokens: OAuthTokens, displayName: string): Promise<void> {
  const label = normalizeAccountLabel(provider, labelRaw);
  if (!label) throw new Error("account_label_required");
  const t = now();
  const encAccess = await encryptField(env, "connection:" + provider, tokens.accessToken);
  const encRefresh = tokens.refreshToken ? await encryptField(env, "connection:" + provider, tokens.refreshToken) : null;
  await env.DB.prepare(
    "INSERT INTO connections(workspace_id, provider, account_label, encrypted_token, refresh_token_enc, expires_at, refresh_expires_at, scopes, display_name, created_at, updated_at, authorized_at, needs_reauth, last_ok_at, last_error, refresh_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 0) ON CONFLICT(workspace_id, provider, account_label) DO UPDATE SET encrypted_token=excluded.encrypted_token, refresh_token_enc=CASE WHEN excluded.refresh_token_enc IS NOT NULL THEN excluded.refresh_token_enc ELSE connections.refresh_token_enc END, expires_at=excluded.expires_at, refresh_expires_at=COALESCE(excluded.refresh_expires_at, connections.refresh_expires_at), scopes=COALESCE(excluded.scopes, connections.scopes), display_name=excluded.display_name, updated_at=excluded.updated_at, authorized_at=excluded.authorized_at, needs_reauth=0, last_ok_at=excluded.last_ok_at, last_error=NULL, refresh_generation=connections.refresh_generation+1",
  ).bind(ws, provider, label, encAccess, encRefresh, tokens.accessExpiresAt ?? null, tokens.refreshExpiresAt ?? null, tokens.scope ?? null, displayName || label, t, t, t, t).run();
}

export async function readConnectionRow(env: Env, ws: string, provider: string, label: string): Promise<ConnectionRow | null> {
  return env.DB.prepare(
    "SELECT account_label, encrypted_token, refresh_token_enc, expires_at, refresh_expires_at, needs_reauth, refresh_generation, scopes FROM connections WHERE workspace_id=? AND provider=? AND account_label=?",
  ).bind(ws, provider, label).first<ConnectionRow>();
}
