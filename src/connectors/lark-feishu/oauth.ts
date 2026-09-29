// oauth.ts — OAuth 2.0 flow, token exchange, refresh, and identity for Lark & Feishu.
// V2 §8: Unified OAuth registry integration, stable identity, TokenBroker refresh.

import type { Env } from "../../env";
import { now } from "../../util";
import { ConnectorCallError, type OAuthTokens } from "../types";
import { getPlatformConfig, getPlatformDefaultScopes, LARK_FEISHU_DEFAULT_SCOPES } from "./config";
import { assertLarkFeishuOk } from "./errors";
import { getAppAccessToken, larkFeishuFetch } from "./client";
import type { LarkFeishuProvider } from "./types";

export function larkFeishuAuthorizeUrl(
  env: Env,
  provider: LarkFeishuProvider,
  redirectUri: string,
  state: string,
  opts?: { forceConsent?: boolean; scopes?: string[] },
): string {
  const cfg = getPlatformConfig(env, provider);
  const scopes = opts?.scopes && opts.scopes.length > 0 ? opts.scopes : getPlatformDefaultScopes(provider);
  const p = new URLSearchParams({
    app_id: cfg.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    scope: scopes.join(" "),
  });
  return `${cfg.apiOrigin}/open-apis/authen/v1/index?${p.toString()}`;
}

export async function larkFeishuExchangeCode(
  env: Env,
  provider: LarkFeishuProvider,
  code: string,
  redirectUri: string,
): Promise<OAuthTokens | { error: string }> {
  const cfg = getPlatformConfig(env, provider);
  const appTok = await getAppAccessToken(env, provider);

  const res = await larkFeishuFetch(`${cfg.apiOrigin}/open-apis/authen/v1/oidc/access_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${appTok}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  const j = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || (j.code !== undefined && j.code !== 0)) {
    const msg = j.msg || j.message || `http_${res.status}`;
    return { error: `${provider}_exchange_failed: ${msg}` };
  }

  const data = j.data ?? j;
  if (!data.access_token) {
    return { error: `${provider}_exchange_failed: missing_access_token` };
  }

  const t = now();
  const accessExpiresIn = Number(data.expires_in ?? 7140);
  const refreshExpiresIn = Number(data.refresh_expires_in ?? 2592000);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: t + accessExpiresIn * 1000,
    refreshExpiresAt: data.refresh_token ? t + refreshExpiresIn * 1000 : undefined,
    scope: String(data.scope ?? LARK_FEISHU_DEFAULT_SCOPES.join(" ")),
  };
}

export async function larkFeishuRefreshToken(
  env: Env,
  provider: LarkFeishuProvider,
  refreshToken: string,
): Promise<OAuthTokens> {
  const cfg = getPlatformConfig(env, provider);
  const appTok = await getAppAccessToken(env, provider);

  const res = await larkFeishuFetch(`${cfg.apiOrigin}/open-apis/authen/v1/oidc/refresh_access_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${appTok}`,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const j = (await res.json().catch(() => ({}))) as any;
  assertLarkFeishuOk(j, `${provider}_refresh`, res.status);

  const data = j.data ?? j;
  if (!data.access_token) {
    throw new ConnectorCallError("auth", `${provider}_refresh: missing_access_token`, res.status);
  }

  const t = now();
  const accessExpiresIn = Number(data.expires_in ?? 7140);
  const refreshExpiresIn = Number(data.refresh_expires_in ?? 2592000);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    accessExpiresAt: t + accessExpiresIn * 1000,
    refreshExpiresAt: t + refreshExpiresIn * 1000,
    scope: data.scope ? String(data.scope) : undefined,
  };
}

export async function larkFeishuIdentifyAccount(
  env: Env,
  provider: LarkFeishuProvider,
  accessToken: string,
): Promise<{ label: string; displayName: string }> {
  const cfg = getPlatformConfig(env, provider);

  const res = await larkFeishuFetch(`${cfg.apiOrigin}/open-apis/authen/v1/user_info`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  const j = (await res.json().catch(() => ({}))) as any;
  assertLarkFeishuOk(j, `${provider}_identify`, res.status);

  const data = j.data ?? j;
  const openId = String(data.open_id ?? "").trim();
  if (!openId) {
    throw new ConnectorCallError("provider_error", `${provider}_identify: empty_open_id`, res.status);
  }

  const name = String(data.name ?? data.en_name ?? "").trim();
  const email = String(data.email ?? data.enterprise_email ?? "").trim().toLowerCase();
  const displayName = name ? (email ? `${name} (${email})` : name) : (email || openId);

  return {
    label: openId,
    displayName,
  };
}
