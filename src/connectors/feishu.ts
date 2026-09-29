// feishu.ts — Backward-compatibility shim for legacy feishu imports.
// V2 §5: Shared adapter implementation moved to src/connectors/lark-feishu/.

import type { Env } from "../env";
import {
  isLarkFeishuConfigured,
  larkFeishuAuthorizeUrl,
  larkFeishuExchangeCode,
  larkFeishuIdentifyAccount,
  larkFeishuCalendarList as lfCalendarList,
  larkFeishuCalendarCreate as lfCalendarCreate,
  withLarkFeishuCall,
} from "./lark-feishu";

export function feishuConfigured(env: Env): boolean {
  return isLarkFeishuConfigured(env, "feishu");
}

export function larkConfigured(env: Env): boolean {
  return isLarkFeishuConfigured(env, "lark");
}

export function feishuAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  return larkFeishuAuthorizeUrl(env, "feishu", redirectUri, state);
}

export async function feishuExchangeCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number } | { error: string }> {
  const r = await larkFeishuExchangeCode(env, "feishu", code, redirectUri);
  if ("error" in r) return r;
  return {
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: r.accessExpiresAt ?? (Date.now() + 7140 * 1000),
  };
}

export async function feishuUserInfo(env: Env, workspaceId: string): Promise<{ name?: string; email?: string }> {
  try {
    const res = await withLarkFeishuCall(env, { workspaceId, provider: "feishu" }, "read", "feishu_user_info", async (token) => {
      return larkFeishuIdentifyAccount(env, "feishu", token);
    });
    if (res.ok) {
      return { name: res.data.displayName };
    }
    return {};
  } catch {
    return {};
  }
}

export interface FeishuMail {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export async function feishuMailList(
  _env: Env,
  _workspaceId: string,
  _opts: { query?: string; max?: number } = {},
): Promise<FeishuMail[]> {
  return [];
}

export async function feishuMailGet(
  _env: Env,
  _workspaceId: string,
  _id: string,
): Promise<{ subject: string; from: string; body: string } | null> {
  return null;
}

export interface FeishuCalEvent {
  id: string;
  summary: string;
  start?: string;
  end?: string;
}

export async function feishuCalendarList(
  env: Env,
  workspaceId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<FeishuCalEvent[]> {
  const res = await withLarkFeishuCall(env, { workspaceId, provider: "feishu" }, "read", "feishu_calendar_list", async (token) => {
    return lfCalendarList(env, "feishu", token, timeMinIso, timeMaxIso);
  });
  if (!res.ok) throw new Error(res.reason);
  return (res.data as any[]).map((e: any) => ({
    id: e.id,
    summary: e.summary,
    start: e.startIso,
    end: e.endIso,
  }));
}

export async function feishuCalendarCreate(
  env: Env,
  workspaceId: string,
  ev: { summary: string; startIso: string; endIso: string; description?: string },
): Promise<{ id: string } | { error: string }> {
  const res = await withLarkFeishuCall(env, { workspaceId, provider: "feishu" }, "write", "calendar_create", async (token) => {
    return lfCalendarCreate(env, "feishu", token, ev);
  });
  if (!res.ok) return { error: res.reason };
  return { id: (res.data as any).id };
}

export async function feishuStoreConnection(
  env: Env,
  workspaceId: string,
  tok: { accessToken: string; refreshToken?: string; accessExpiresAt?: number; refreshExpiresAt?: number; openId?: string; name?: string; scope?: string },
): Promise<void> {
  const { upsertConnectedAccount } = await import("./token-store");
  const label = tok.openId || "feishu_user";
  await upsertConnectedAccount(env, workspaceId, "feishu", label, {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    accessExpiresAt: tok.accessExpiresAt,
    refreshExpiresAt: tok.refreshExpiresAt,
    scope: tok.scope,
  }, tok.name || label);
}
