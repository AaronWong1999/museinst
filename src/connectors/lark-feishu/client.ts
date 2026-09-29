// client.ts — Unified API client for Lark & Feishu connector family.
// Manages app_access_token acquisition/caching, user API calls, deadlines, and TokenBroker integration.

import type { Env } from "../../env";
import { DEADLINE_BUDGETS_MS, fetchWithDeadline } from "../../util/deadlines";
import { now } from "../../util";
import { ConnectorCallError, type ConnectorCallKind } from "../types";
import { withConnectorCall, type ConnectorCallResult } from "../token-mark";
import { getPlatformConfig } from "./config";
import { assertLarkFeishuOk } from "./errors";
import type { LarkFeishuProvider } from "./types";

interface CachedAppToken {
  token: string;
  expiresAt: number;
}

const appTokenCache = new Map<string, CachedAppToken>();

export function larkFeishuFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetchWithDeadline(input, init, {
    operation: "lark_feishu",
    budgetMs: DEADLINE_BUDGETS_MS.modelRequest,
  });
}

/**
 * Get internal app_access_token for app authentication (used during code exchange & token refresh).
 */
export async function getAppAccessToken(env: Env, provider: LarkFeishuProvider): Promise<string> {
  const cfg = getPlatformConfig(env, provider);
  if (!cfg.appId || !cfg.appSecret) {
    throw new ConnectorCallError("provider_error", `${provider}_not_configured`, 500);
  }

  const cacheKey = `${provider}:${cfg.appId}`;
  const cached = appTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - 300_000 > now()) {
    return cached.token;
  }

  const res = await larkFeishuFetch(`${cfg.apiOrigin}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });

  const j = (await res.json().catch(() => ({}))) as any;
  assertLarkFeishuOk(j, `${provider}_app_token`, res.status);

  const token = String(j.app_access_token || j.tenant_access_token || "");
  if (!token) {
    throw new ConnectorCallError("auth", `${provider}_app_token_missing`, res.status);
  }

  const expireSeconds = Number(j.expire ?? 7200);
  appTokenCache.set(cacheKey, {
    token,
    expiresAt: now() + expireSeconds * 1000,
  });

  return token;
}

/**
 * Make an authenticated API request with a user_access_token.
 */
export async function larkFeishuUserRequest<T = any>(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const cfg = getPlatformConfig(env, provider);
  const url = path.startsWith("http") ? path : `${cfg.apiOrigin}/open-apis${path.startsWith("/") ? path : `/${path}`}`;

  const res = await larkFeishuFetch(url, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${userToken}`,
      ...(init?.headers ?? {}),
    },
  });

  const j = (await res.json().catch(() => ({}))) as any;
  assertLarkFeishuOk(j, `${provider}_api`, res.status);

  return (j.data !== undefined ? j.data : j) as T;
}

/**
 * Executes a semantic operation using TokenBroker with transparent token refresh and re-auth handling.
 */
export async function withLarkFeishuCall<T>(
  env: Env,
  opts: {
    workspaceId: string;
    provider: LarkFeishuProvider;
    accountLabel?: string;
    taskId?: string;
  },
  effect: "read" | "write" | "destructive" | "external_send",
  operation: string,
  fn: (token: string, accountLabel: string) => Promise<T>,
): Promise<ConnectorCallResult<T>> {
  return withConnectorCall(
    env,
    {
      workspaceId: opts.workspaceId,
      provider: opts.provider,
      accountLabel: opts.accountLabel,
      taskId: opts.taskId,
    },
    effect,
    operation,
    fn,
  );
}
