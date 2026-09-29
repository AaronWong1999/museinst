



import type { Env } from "../env";
import { decryptField, encryptField } from "../crypto";
import { DEADLINE_BUDGETS_MS, fetchWithDeadline } from "../util/deadlines";

const API = "https://slack.com/api";


function slackFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetchWithDeadline(input, init, { operation: "slack", budgetMs: DEADLINE_BUDGETS_MS.imapCommand });
}

export const SLACK_SCOPES = "search:read chat:write channels:history groups:history im:history";

export async function slackStore(env: Env, workspaceId: string, token: string): Promise<{ ok: true; label: string } | { error: string }> {
  const t = token.trim();
  if (!/^xox[pbr]-/.test(t)) return { error: "token_must_be_xoxp" };
  const res = await slackFetch(`${API}/auth.test`, { headers: { authorization: `Bearer ${t}` } });
  const j = (await res.json()) as { ok: boolean; team?: string; user?: string; error?: string };
  if (!j.ok) return { error: `invalid_token:${j.error ?? "unknown"}` };
  const label = `${j.user}@${j.team}`;
  await env.DB.prepare(
    `INSERT INTO connections (workspace_id, provider, account_label, encrypted_token, scopes)
     VALUES (?, 'slack', ?, ?, ?)
     ON CONFLICT(workspace_id, provider, account_label) DO UPDATE SET encrypted_token=excluded.encrypted_token, scopes=excluded.scopes`,
  )
    .bind(workspaceId, label, await encryptField(env, "connection:slack", t), SLACK_SCOPES)
    .run();
  return { ok: true, label };
}

export async function getSlackToken(env: Env, workspaceId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT encrypted_token FROM connections WHERE workspace_id=? AND provider='slack' LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ encrypted_token: string }>();
  if (!row) return null;
  return decryptField(env, "connection:slack", row.encrypted_token);
}

export interface SlackHit {
  channel: string;
  user: string;
  ts: string;
  text: string;
  permalink: string;
}


export async function slackSearch(env: Env, workspaceId: string, query: string, max = 8): Promise<SlackHit[]> {
  const token = await getSlackToken(env, workspaceId);
  if (!token) throw new Error("slack_not_connected");
  const p = new URLSearchParams({ query, count: String(Math.min(max, 20)) });
  const res = await slackFetch(`${API}/search.messages?${p}`, { headers: { authorization: `Bearer ${token}` } });
  const j = (await res.json()) as any;
  if (!j.ok) throw new Error(String(j.error ?? "slack_error"));
  const msgs = j.messages?.matches ?? [];
  return msgs.map((m: any) => ({
    channel: m.channel?.name ?? m.channel?.id ?? "?",
    user: m.username ?? m.user ?? "?",
    ts: m.ts ?? "",
    text: (m.text ?? "").slice(0, 300),
    permalink: m.permalink ?? "",
  }));
}

export async function slackPost(env: Env, workspaceId: string, channel: string, text: string, threadTs?: string): Promise<{ ok: true; channel: string; ts: string } | { error: string }> {
  const token = await getSlackToken(env, workspaceId);
  if (!token) return { error: "slack_not_connected" };
  const res = await slackFetch(`${API}/chat.postMessage`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
  const j = (await res.json()) as any;
  if (!j.ok) return { error: String(j.error ?? "post_failed") };
  return { ok: true, channel: j.channel, ts: j.ts };
}
