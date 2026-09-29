// config.ts — Platform origins and configuration for Lark & Feishu.
// V2 §5: Shared adapter with platform-specific origins and app credentials.

import type { Env } from "../../env";
import type { LarkFeishuPlatformConfig, LarkFeishuProvider } from "./types";

export const FEISHU_API_ORIGIN = "https://open.feishu.cn";
export const LARK_API_ORIGIN = "https://open.larksuite.com";

/**
 * Standard user scopes requested during OAuth flow.
 * Keep this list aligned with the real semantic adapters. In particular,
 * contact_search uses contact/v3/users/search and document_search uses
 * search/v2/doc_wiki/search, so their dedicated read scopes must be requested.
 *
 * Tasks:
 * Both Lark and Feishu Task adapters use Task v2 (/open-apis/task/v2/tasks).
 * Lark does not support the legacy monolithic `task:task` scope on newly created apps,
 * returning error 20027 if requested. Modern Task v2 uses granular scopes:
 * `task:task:read` and `task:task:write`.
 */
export const LARK_FEISHU_DEFAULT_SCOPES = [
  "contact:user.base:readonly",
  "contact:user.email:readonly",
  "contact:user:search",
  "calendar:calendar",
  "task:task:read",
  "task:task:write",
  "docx:document",
  "sheets:spreadsheet",
  "bitable:app",
  "drive:drive:readonly",
  "search:docs:read",
];

export function getPlatformDefaultScopes(provider: LarkFeishuProvider): string[] {
  return [...LARK_FEISHU_DEFAULT_SCOPES];
}

export function getPlatformConfig(env: Env, provider: LarkFeishuProvider): LarkFeishuPlatformConfig {
  if (provider === "feishu") {
    return {
      provider: "feishu",
      apiOrigin: FEISHU_API_ORIGIN,
      appId: String((env as any).FEISHU_APP_ID ?? "").trim(),
      appSecret: String((env as any).FEISHU_APP_SECRET ?? "").trim(),
    };
  }
  if (provider === "lark") {
    return {
      provider: "lark",
      apiOrigin: LARK_API_ORIGIN,
      appId: String((env as any).LARK_APP_ID ?? "").trim(),
      appSecret: String((env as any).LARK_APP_SECRET ?? "").trim(),
    };
  }
  throw new Error(`unknown_lark_feishu_provider: ${provider}`);
}

export function isLarkFeishuConfigured(env: Env, provider: LarkFeishuProvider): boolean {
  try {
    const cfg = getPlatformConfig(env, provider);
    return !!(cfg.appId && cfg.appSecret);
  } catch {
    return false;
  }
}
