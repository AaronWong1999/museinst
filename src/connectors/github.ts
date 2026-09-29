




import type { Env } from "../env";
import { getAccessToken } from "./token-mark";
import { upsertConnectedAccount } from "./token-store";
import { ConnectorCallError, httpStatusToKind } from "./types";
import { DEADLINE_BUDGETS_MS, fetchWithDeadline } from "../util/deadlines";

export function githubConfigured(env: Env): boolean {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

export function githubAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID!,
    redirect_uri: redirectUri,
    scope: "repo read:user",
    state,
  });
  return `https://github.com/login/oauth/authorize?${p}`;
}

export async function githubExchangeCode(
  env: Env,
  code: string,
): Promise<{ accessToken: string } | { error: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const j = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !j.access_token) return { error: String(j.error_description ?? j.error ?? `http_${res.status}`) };
  return { accessToken: j.access_token };
}

export async function githubStoreConnection(env: Env, workspaceId: string, accessToken: string, login: string): Promise<void> {
  if (!login) throw new Error("github_login_required");

  await upsertConnectedAccount(env, workspaceId, "github", login, { accessToken, scope: "repo,read:user" }, login);
}


export async function githubAccessToken(env: Env, workspaceId: string, accountLabel?: string): Promise<string> {
  const r = await getAccessToken(env, workspaceId, "github", accountLabel);
  if (!r.ok) throw new ConnectorCallError(r.reason === "reauth_required" ? "auth" : "transient", "github_token: " + r.reason, undefined, "github_" + r.reason);
  return r.token;
}



export async function githubApi(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetchWithDeadline(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "openinst",
      ...(init?.headers ?? {}),
    },
  }, { operation: `github:${path.split("?")[0]}`, budgetMs: DEADLINE_BUDGETS_MS.modelRequest });
  if (!res.ok) throw new ConnectorCallError(httpStatusToKind(res.status), `github_http_${res.status}`, res.status, `github_http_${res.status}`);
  return res.json();
}


export async function githubMe(env: Env, workspaceId: string): Promise<{ login: string } | null> {
  try {
    const token = await githubAccessToken(env, workspaceId);
    return await githubApi(token, "/user");
  } catch {
    return null;
  }
}

export async function githubListRepos(token: string, max = 10): Promise<Array<{ full_name: string; description: string; updated_at: string }>> {
  const repos = await githubApi(token, `/user/repos?sort=updated&per_page=${max}`);
  return (repos as any[]).map((r) => ({ full_name: r.full_name, description: r.description ?? "", updated_at: r.updated_at }));
}

export async function githubSearchIssues(token: string, q: string, max = 10): Promise<Array<{ repo: string; number: number; title: string; state: string; url: string }>> {
  const j = await githubApi(token, `/search/issues?q=${encodeURIComponent(q)}&per_page=${max}`);
  return (j.items ?? []).map((i: any) => ({
    repo: i.repository_url.split("/").slice(-2).join("/"),
    number: i.number,
    title: i.title,
    state: i.state,
    url: i.html_url,
  }));
}

export async function githubCreateIssue(token: string, repo: string, title: string, body: string): Promise<{ number: number; url: string }> {
  const j = await githubApi(token, `/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body }) });
  return { number: j.number, url: j.html_url };
}

export async function githubCommentIssue(token: string, repo: string, number: number, body: string): Promise<{ url: string }> {
  const j = await githubApi(token, `/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  return { url: j.html_url };
}
