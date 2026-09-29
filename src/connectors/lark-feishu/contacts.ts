// contacts.ts — Semantic Contacts adapter for Lark & Feishu.
// V2 §10.4: contact_search and contact_get for member and recipient lookup.

import type { Env } from "../../env";
import { ConnectorCallError } from "../types";
import { larkFeishuUserRequest } from "./client";
import type { LarkFeishuContact, LarkFeishuProvider } from "./types";

function pickLocalizedName(provider: LarkFeishuProvider, names: unknown, fallback: string): string {
  if (!names || typeof names !== "object") return fallback;
  const map = names as Record<string, unknown>;
  const preferred = provider === "lark" ? ["en_us", "zh_cn"] : ["zh_cn", "en_us"];
  for (const key of preferred) {
    const value = String(map[key] ?? "").trim();
    if (value) return value;
  }
  for (const value of Object.values(map)) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return fallback;
}

/**
 * Search users through the current Contact v3 search endpoint.
 * This endpoint is POST + user identity and requires contact:user:search.
 * It intentionally does not fall back to the legacy /search/v1/user API:
 * a permission/API mismatch must be surfaced instead of looking like zero hits.
 */
export async function larkFeishuContactSearch(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  query: string,
  max = 10,
): Promise<LarkFeishuContact[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const pageSize = Math.max(1, Math.min(Math.trunc(max || 10), 30));
  const p = new URLSearchParams({ page_size: String(pageSize) });

  const res = await larkFeishuUserRequest(env, provider, userToken, `/contact/v3/users/search?${p}`, {
    method: "POST",
    body: JSON.stringify({ query: trimmed }),
  });

  const items = Array.isArray((res as any)?.items) ? (res as any).items : [];
  return items.slice(0, pageSize).map((item: any) => {
    const id = String(item?.id ?? item?.open_id ?? "").trim();
    const meta = item?.meta_data && typeof item.meta_data === "object" ? item.meta_data : {};
    const email = String(meta.enterprise_mail_address ?? meta.mail_address ?? "").trim();
    const displayInfo = String(item?.display_info ?? "");
    const displayLines = displayInfo.split("\n").map((s: string) => s.replace(/<\/?h>/g, "").trim()).filter(Boolean);
    return {
      id,
      name: pickLocalizedName(provider, meta.i18n_names, displayLines[0] || id),
      email: email || undefined,
      department: displayLines.length > 1 ? displayLines[1] : undefined,
    } satisfies LarkFeishuContact;
  }).filter((u: LarkFeishuContact) => !!u.id);
}

export async function larkFeishuContactGet(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  userId: string,
): Promise<LarkFeishuContact | null> {
  try {
    const res = await larkFeishuUserRequest(env, provider, userToken, `/contact/v3/users/${encodeURIComponent(userId)}?user_id_type=open_id`);
    const u = (res as any)?.user ?? res;
    if (!u) return null;
    return {
      id: String(u.open_id || u.user_id || userId),
      name: String(u.name || ""),
      email: u.email ? String(u.email) : undefined,
      phone: u.mobile ? String(u.mobile) : undefined,
      avatarUrl: u.avatar?.avatar_72 || u.avatar?.avatar_origin,
    };
  } catch (e) {
    if (e instanceof ConnectorCallError && e.kind === "not_found") return null;
    throw e;
  }
}
