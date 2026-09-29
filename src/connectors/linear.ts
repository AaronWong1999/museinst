



import type { Env } from "../env";
import { decryptField, encryptField } from "../crypto";
import { DEADLINE_BUDGETS_MS, fetchWithDeadline } from "../util/deadlines";

const API = "https://api.linear.app/graphql";

export async function linearStore(env: Env, workspaceId: string, apiKey: string): Promise<{ ok: true; label: string } | { error: string }> {
  const me = await gql(apiKey, `query { viewer { id name email } }`);
  if (me.errors || !me.data?.viewer?.email) return { error: "invalid_key" };
  const viewer = me.data.viewer as { name: string; email: string };
  await env.DB.prepare(
    `INSERT INTO connections (workspace_id, provider, account_label, encrypted_token, scopes)
     VALUES (?, 'linear', ?, ?, 'api_key')
     ON CONFLICT(workspace_id, provider, account_label) DO UPDATE SET encrypted_token=excluded.encrypted_token`,
  )
    .bind(workspaceId, viewer.email, await encryptField(env, "connection:linear", apiKey.trim()))
    .run();
  return { ok: true, label: viewer.email };
}

export async function getLinearKey(env: Env, workspaceId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT encrypted_token FROM connections WHERE workspace_id=? AND provider='linear' LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ encrypted_token: string }>();
  if (!row) return null;
  return decryptField(env, "connection:linear", row.encrypted_token);
}

async function gql(key: string, query: string, variables?: Record<string, unknown>): Promise<any> {

  const res = await fetchWithDeadline(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  }, { operation: "linear:gql", budgetMs: DEADLINE_BUDGETS_MS.imapCommand });
  return res.json();
}

export async function linearIssues(env: Env, workspaceId: string, opts: { filter?: string; includeDone?: boolean; max?: number } = {}): Promise<Array<{ id: string; identifier: string; title: string; state: string; url: string; due?: string }>> {
  const key = await getLinearKey(env, workspaceId);
  if (!key) throw new Error("linear_not_connected");
  const stateFilter = opts.includeDone ? "" : `completedAt: { null: true }, canceledAt: { null: true }`;
  const textFilter = opts.filter ? `, title: { containsIgnoreCase: "${opts.filter.replace(/"/g, "")}" }` : "";
  const q = `query { issues(first: ${Math.min(opts.max ?? 10, 25)}, orderBy: updatedAt, filter: { assignee: { isMe: { eq: true } }${textFilter}, ${stateFilter} }) { nodes { identifier title url dueDate state { name } } } }`;
  const j = await gql(key, q);
  if (j.errors) throw new Error(String(j.errors[0]?.message ?? "linear_error").slice(0, 200));
  return (j.data?.issues?.nodes ?? []).map((n: any) => ({
    id: n.identifier,
    identifier: n.identifier,
    title: n.title,
    state: n.state?.name ?? "",
    url: n.url,
    due: n.dueDate ?? undefined,
  }));
}

export async function linearCreateIssue(env: Env, workspaceId: string, input: { teamKey: string; title: string; description?: string }): Promise<{ ok: true; identifier: string; url: string } | { error: string }> {
  const key = await getLinearKey(env, workspaceId);
  if (!key) return { error: "linear_not_connected" };

  const t = await gql(key, `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id name } } }`, { key: input.teamKey });
  const team = t.data?.teams?.nodes?.[0];
  if (!team) return { error: `team_not_found:${input.teamKey}` };
  const m = await gql(
    key,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }`,
    { input: { teamId: team.id, title: input.title, description: input.description } },
  );
  const issue = m.data?.issueCreate?.issue;
  if (!m.data?.issueCreate?.success || !issue) return { error: String(m.errors?.[0]?.message ?? "create_failed").slice(0, 200) };
  return { ok: true, identifier: issue.identifier, url: issue.url };
}
