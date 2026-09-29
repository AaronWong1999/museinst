// token-refresh.ts part1 — provider refresh + CAS
import type { Env } from "../env";
import { decryptField, encryptField } from "../crypto";
import { now } from "../util";
import { normalizeAccountLabel } from "./account-label";
import { ConnectorCallError, redactSecretText, type AccessTokenResult, type OAuthTokens } from "./types";
import { ACCESS_SKEW_MS, readConnectionRow } from "./token-store";
import { markNeedsReauth } from "./token-mark";

export async function providerRefresh(env: Env, provider: string, refreshToken: string): Promise<OAuthTokens> {
  const t = now();
  if (provider === "google") {
    const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID ?? "", client_secret: env.GOOGLE_CLIENT_SECRET ?? "", refresh_token: refreshToken, grant_type: "refresh_token" }) });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || !j.access_token) { const code = String(j.error ?? ("http_" + res.status)); throw new ConnectorCallError(code === "invalid_grant" ? "auth" : "transient", "google_refresh: " + redactSecretText(code), res.status, code); }
    return { accessToken: j.access_token, refreshToken: j.refresh_token, accessExpiresAt: t + Number(j.expires_in ?? 3600) * 1000, scope: j.scope ? String(j.scope) : undefined };
  }
  if (provider === "github") {
    const res = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_id: (env as any).GITHUB_CLIENT_ID ?? "", client_secret: (env as any).GITHUB_CLIENT_SECRET ?? "", refresh_token: refreshToken, grant_type: "refresh_token" }) });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || !j.access_token) { const code = String(j.error ?? ("http_" + res.status)); throw new ConnectorCallError(code === "invalid_grant" ? "auth" : "transient", "github_refresh: " + redactSecretText(code), res.status, code); }
    return { accessToken: j.access_token, refreshToken: j.refresh_token, accessExpiresAt: t + Number(j.expires_in ?? 3600) * 1000, refreshExpiresAt: j.refresh_token_expires_in ? t + Number(j.refresh_token_expires_in) * 1000 : undefined };
  }
  if (provider === "feishu" || provider === "lark") {
    const { larkFeishuRefreshToken } = await import("./lark-feishu");
    return larkFeishuRefreshToken(env, provider, refreshToken);
  }
  throw new ConnectorCallError("provider_error", provider + "_refresh_not_supported", undefined, provider + "_refresh_not_supported");
}

export async function refreshAndStore(env: Env, ws: string, provider: string, accountLabel: string): Promise<AccessTokenResult> {
  const label = normalizeAccountLabel(provider, accountLabel);
  const row = await readConnectionRow(env, ws, provider, label);
  if (!row) return { ok: false, reason: "not_connected" };
  if (row.needs_reauth === 1) return { ok: false, reason: "reauth_required", accountLabel: label };
  if (row.refresh_expires_at != null && row.refresh_expires_at <= now()) { await markNeedsReauth(env, ws, provider, label, "refresh_grant_expired"); return { ok: false, reason: "reauth_required", accountLabel: label }; }
  if (!row.refresh_token_enc) return { ok: false, reason: "reauth_required", accountLabel: label };
  const refreshPlain = await decryptField(env, "connection:" + provider, row.refresh_token_enc);
  if (!refreshPlain) return { ok: false, reason: "reauth_required", accountLabel: label };
  let fresh: OAuthTokens;
  try { fresh = await providerRefresh(env, provider, refreshPlain); } catch (e) {
    if (e instanceof ConnectorCallError && e.kind === "auth") { await markNeedsReauth(env, ws, provider, label, e.message); return { ok: false, reason: "reauth_required", accountLabel: label }; }
    return { ok: false, reason: "refresh_failed", accountLabel: label };
  }
  const encAccess = await encryptField(env, "connection:" + provider, fresh.accessToken);
  const encRefresh = fresh.refreshToken ? await encryptField(env, "connection:" + provider, fresh.refreshToken) : row.refresh_token_enc;
  const t = now();
  const cas = await env.DB.prepare("UPDATE connections SET encrypted_token=?, refresh_token_enc=?, expires_at=?, refresh_expires_at=COALESCE(?, refresh_expires_at), scopes=COALESCE(?, scopes), updated_at=?, last_ok_at=?, last_error=NULL, refresh_generation=refresh_generation+1 WHERE workspace_id=? AND provider=? AND account_label=? AND refresh_generation=?").bind(encAccess, encRefresh, fresh.accessExpiresAt ?? null, fresh.refreshExpiresAt ?? null, fresh.scope ?? null, t, t, ws, provider, label, row.refresh_generation).run();
  if (((cas.meta as any)?.changes ?? 0) !== 1) {
    const latest = await readConnectionRow(env, ws, provider, label);
    if (latest && latest.needs_reauth !== 1) {
      const tok = await decryptField(env, "connection:" + provider, latest.encrypted_token);
      if (tok && latest.expires_at != null && latest.expires_at - ACCESS_SKEW_MS > now()) return { ok: true, token: tok, accountLabel: label };
    }
    return { ok: false, reason: "refresh_failed", accountLabel: label };
  }
  return { ok: true, token: fresh.accessToken, accountLabel: label };
}
