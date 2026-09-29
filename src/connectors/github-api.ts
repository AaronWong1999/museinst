
//






//


import { ConnectorCallError, httpStatusToKind } from "./types";

export type FetchFn = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<Response>;

export const MAX_ISSUES = 50;
const MAX_ISSUE_PAGES = 4;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TREE_ENTRIES = 300;
const MAX_DIFF_BYTES = 128 * 1024;
const MAX_SEARCH_RESULTS = 30;
const MAX_API_READ_BYTES = 256 * 1024;

export interface GithubIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  url: string;
  isPr: boolean;
}

function assertOkStatus(res: Response, what: string): void {
  if (!res.ok) throw new ConnectorCallError(httpStatusToKind(res.status), `github_${what}_http_${res.status}`, res.status, `github_${what}_http_${res.status}`);
}

function normalizeLabel(l: unknown): string {
  return typeof l === "string" ? l : String((l as any)?.name ?? "");
}





export async function listIssuesExcludingPrs(
  fetchFn: FetchFn,
  repo: string,
  opts: { state?: "open" | "closed" | "all"; sort?: "created" | "updated" | "comments"; direction?: "asc" | "desc"; limit?: number },
): Promise<{ issues: GithubIssueSummary[]; truncated: boolean }> {
  const limit = Math.max(1, Math.min(MAX_ISSUES, Number(opts.limit ?? 10)));
  const state = opts.state ?? "open";
  const sort = opts.sort ?? "updated";
  const direction = opts.direction ?? "desc";
  const out: GithubIssueSummary[] = [];
  let page = 1;
  let truncated = false;
  while (out.length < limit && page <= MAX_ISSUE_PAGES) {
    const p = new URLSearchParams({ state, sort, direction, per_page: "100", page: String(page) });
    const res = await fetchFn(`/repos/${repo}/issues?${p}`);
    assertOkStatus(res, "issues_list");
    const items = (await res.json()) as any[];
    if (!Array.isArray(items)) break;
    if (items.length === 0) break;
    for (const item of items) {
      if (item && item.pull_request) continue;
      out.push({
        number: Number(item.number),
        title: String(item.title ?? ""),
        state: String(item.state ?? ""),
        author: String(item.user?.login ?? ""),
        createdAt: String(item.created_at ?? ""),
        updatedAt: String(item.updated_at ?? ""),
        labels: (item.labels ?? []).map(normalizeLabel),
        url: String(item.html_url ?? ""),
        isPr: false,
      });
      if (out.length >= limit) break;
    }
    if (items.length < 100) break;
    page++;
  }

  if (out.length < limit && page > MAX_ISSUE_PAGES) {

    truncated = true;
  }
  return { issues: out, truncated };
}

export interface GithubIssueDetail {
  number: number;
  title: string;
  state: string;
  author: string;
  body: string;
  labels: string[];
  assignees: string[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  comments?: Array<{ author: string; body: string; createdAt: string; url: string }>;
}

export async function readIssue(fetchFn: FetchFn, repo: string, number: number, opts?: { includeComments?: boolean; commentsLimit?: number }): Promise<GithubIssueDetail> {
  const res = await fetchFn(`/repos/${repo}/issues/${number}`);
  assertOkStatus(res, "issue_read");
  const j = (await res.json()) as any;
  const detail: GithubIssueDetail = {
    number: Number(j.number),
    title: String(j.title ?? ""),
    state: String(j.state ?? ""),
    author: String(j.user?.login ?? ""),
    body: String(j.body ?? "").slice(0, 20_000),
    labels: (j.labels ?? []).map(normalizeLabel),
    assignees: (j.assignees ?? []).map((a: any) => String(a.login ?? "")),
    commentCount: Number(j.comments ?? 0),
    createdAt: String(j.created_at ?? ""),
    updatedAt: String(j.updated_at ?? ""),
    url: String(j.html_url ?? ""),
  };
  if (opts?.includeComments) {
    const limit = Math.max(1, Math.min(20, Number(opts.commentsLimit ?? 10)));
    const cres = await fetchFn(`/repos/${repo}/issues/${number}/comments?per_page=${limit}`);
    assertOkStatus(cres, "issue_comments");
    const items = (await cres.json()) as any[];
    detail.comments = (Array.isArray(items) ? items : []).slice(0, limit).map((c) => ({
      author: String(c.user?.login ?? ""),
      body: String(c.body ?? "").slice(0, 4000),
      createdAt: String(c.created_at ?? ""),
      url: String(c.html_url ?? ""),
    }));
  }
  return detail;
}

export interface GithubRepoMeta {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string;
  updatedAt: string;
  url: string;
  stars: number;
  language: string | null;
}

export async function readRepo(fetchFn: FetchFn, repo: string): Promise<GithubRepoMeta> {
  const res = await fetchFn(`/repos/${repo}`);
  assertOkStatus(res, "repo_read");
  const j = (await res.json()) as any;
  return {
    fullName: String(j.full_name ?? repo),
    private: !!j.private,
    defaultBranch: String(j.default_branch ?? "main"),
    description: String(j.description ?? ""),
    updatedAt: String(j.updated_at ?? ""),
    url: String(j.html_url ?? `https://github.com/${repo}`),
    stars: Number(j.stargazers_count ?? 0),
    language: j.language ? String(j.language) : null,
  };
}

export interface GithubRepoCard {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string;
  updatedAt: string;
  url: string;
}


export async function listInstallationRepos(fetchFn: FetchFn, max = 30): Promise<{ repos: GithubRepoCard[]; total: number }> {
  const per = Math.max(1, Math.min(100, max));
  const res = await fetchFn(`/installation/repositories?per_page=${per}`);
  assertOkStatus(res, "installation_repos");
  const j = (await res.json()) as any;
  const repos = (j.repositories ?? []).slice(0, per).map((r: any) => ({
    fullName: String(r.full_name ?? ""),
    private: !!r.private,
    defaultBranch: String(r.default_branch ?? ""),
    description: String(r.description ?? ""),
    updatedAt: String(r.updated_at ?? ""),
    url: String(r.html_url ?? ""),
  }));
  return { repos, total: Number(j.total_count ?? repos.length) };
}

export interface GithubTreeEntry {
  path: string;
  type: string;
  size: number | null;
  sha: string;
}


export async function readTree(fetchFn: FetchFn, repo: string, opts: { ref?: string; path?: string; maxEntries?: number }): Promise<{ entries: GithubTreeEntry[]; ref: string; truncated: boolean }> {
  const maxEntries = Math.max(1, Math.min(MAX_TREE_ENTRIES, Number(opts.maxEntries ?? 100)));
  let ref = opts.ref?.trim();
  if (!ref) ref = (await readRepo(fetchFn, repo)).defaultBranch;
  const res = await fetchFn(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  assertOkStatus(res, "tree");
  const j = (await res.json()) as any;
  let entries: any[] = Array.isArray(j.tree) ? j.tree : [];
  const truncatedRemote = !!j.truncated;
  if (opts.path) {
    const prefix = opts.path.replace(/\/+$/, "") + "/";
    entries = entries.filter((e) => String(e.path ?? "").startsWith(prefix) || String(e.path ?? "") === opts.path);
  }
  const capped = entries.slice(0, maxEntries).map((e) => ({
    path: String(e.path ?? ""),
    type: String(e.type ?? "blob"),
    size: typeof e.size === "number" ? e.size : null,
    sha: String(e.sha ?? ""),
  }));
  return {
    entries: capped,
    ref,
    truncated: truncatedRemote || entries.length > maxEntries,
  };
}

export interface GithubFileRead {
  path: string;
  ref: string;
  sha: string;
  size: number;
  encoding: "utf-8" | "binary";
  text: string | null;
  truncated: boolean;
  url: string;
}


export async function readFile(fetchFn: FetchFn, repo: string, path: string, ref?: string): Promise<GithubFileRead> {
  const p = new URLSearchParams();
  if (ref) p.set("ref", ref);
  const qs = p.toString();
  const res = await fetchFn(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${qs ? `?${qs}` : ""}`);
  assertOkStatus(res, "file_read");
  const j = (await res.json()) as any;
  if (Array.isArray(j)) throw new ConnectorCallError("provider_error", "github_path_is_directory", undefined, "github_path_is_directory");
  const size = Number(j.size ?? 0);
  const sha = String(j.sha ?? "");
  const htmlUrl = String(j.html_url ?? "");
  const resolvedRef = ref || String((j as any)?.ref ?? "default");
  if (j.encoding !== "base64" || typeof j.content !== "string") {

    return { path: String(j.path ?? path), ref: resolvedRef, sha, size, encoding: "binary", text: null, truncated: false, url: htmlUrl };
  }
  if (size > MAX_FILE_BYTES) {
    return { path: String(j.path ?? path), ref: resolvedRef, sha, size, encoding: "binary", text: null, truncated: true, url: htmlUrl };
  }
  const bin = atob(j.content.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  let hasNull = false;
  for (let i = 0; i < Math.min(bytes.length, 8000); i++) if (bytes[i] === 0) { hasNull = true; break; }
  let text: string | null;
  try {
    text = hasNull ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = null;
  }
  if (text == null) {
    return { path: String(j.path ?? path), ref: resolvedRef, sha, size, encoding: "binary", text: null, truncated: false, url: htmlUrl };
  }
  const truncated = text.length >= MAX_FILE_BYTES;
  return { path: String(j.path ?? path), ref: resolvedRef, sha, size, encoding: "utf-8", text: truncated ? text.slice(0, MAX_FILE_BYTES) : text, truncated, url: htmlUrl };
}

export interface GithubCodeHit {
  path: string;
  repo: string;
  snippet: string;
  url: string;
}

export async function searchCode(fetchFn: FetchFn, query: string, opts?: { repo?: string; limit?: number }): Promise<{ hits: GithubCodeHit[]; total: number }> {
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(opts?.limit ?? 15)));
  const q = opts?.repo ? `${query}+repo:${opts.repo}` : query;
  const res = await fetchFn(`/search/code?q=${encodeURIComponent(q)}&per_page=${limit}`, {
    headers: { accept: "application/vnd.github.text-match+json" },
  });
  assertOkStatus(res, "code_search");
  const j = (await res.json()) as any;
  const hits = ((j.items ?? []) as any[]).slice(0, limit).map((item) => {
    const frag = (item.text_matches ?? [])[0];
    return {
      path: String(item.path ?? ""),
      repo: String(item.repository?.full_name ?? ""),
      snippet: String(frag?.fragment ?? "").slice(0, 800),
      url: String(item.html_url ?? ""),
    };
  });
  return { hits, total: Number(j.total_count ?? hits.length) };
}

export interface GithubPrSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  draft: boolean;
  base: string;
  head: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export async function listPullRequests(fetchFn: FetchFn, repo: string, opts?: { state?: "open" | "closed" | "all"; sort?: "created" | "updated" | "popularity"; direction?: "asc" | "desc"; limit?: number }): Promise<GithubPrSummary[]> {
  const limit = Math.max(1, Math.min(50, Number(opts?.limit ?? 10)));
  const p = new URLSearchParams({ state: opts?.state ?? "open", sort: opts?.sort ?? "updated", direction: opts?.direction ?? "desc", per_page: String(limit) });
  const res = await fetchFn(`/repos/${repo}/pulls?${p}`);
  assertOkStatus(res, "pr_list");
  const items = (await res.json()) as any[];
  return (Array.isArray(items) ? items : []).slice(0, limit).map((j) => ({
    number: Number(j.number),
    title: String(j.title ?? ""),
    state: String(j.state ?? ""),
    author: String(j.user?.login ?? ""),
    draft: !!j.draft,
    base: String(j.base?.ref ?? ""),
    head: String(j.head?.ref ?? ""),
    createdAt: String(j.created_at ?? ""),
    updatedAt: String(j.updated_at ?? ""),
    url: String(j.html_url ?? ""),
  }));
}

export async function readPullRequest(fetchFn: FetchFn, repo: string, number: number): Promise<GithubPrSummary & { body: string; mergeableState: string | null; additions: number | null; deletions: number | null; commitCount: number | null; changedFiles: number | null }> {
  const res = await fetchFn(`/repos/${repo}/pulls/${number}`);
  assertOkStatus(res, "pr_read");
  const j = (await res.json()) as any;
  return {
    number: Number(j.number),
    title: String(j.title ?? ""),
    state: String(j.state ?? ""),
    author: String(j.user?.login ?? ""),
    draft: !!j.draft,
    base: String(j.base?.ref ?? ""),
    head: String(j.head?.ref ?? ""),
    createdAt: String(j.created_at ?? ""),
    updatedAt: String(j.updated_at ?? ""),
    url: String(j.html_url ?? ""),
    body: String(j.body ?? "").slice(0, 20_000),
    mergeableState: j.mergeable_state ? String(j.mergeable_state) : null,
    additions: typeof j.additions === "number" ? j.additions : null,
    deletions: typeof j.deletions === "number" ? j.deletions : null,
    commitCount: typeof j.commits === "number" ? j.commits : null,
    changedFiles: typeof j.changed_files === "number" ? j.changed_files : null,
  };
}

export interface GithubDiff {
  diff: string;
  bytes: number;
  truncated: boolean;
}

export async function readPullRequestDiff(fetchFn: FetchFn, repo: string, number: number): Promise<GithubDiff> {
  const res = await fetchFn(`/repos/${repo}/pulls/${number}`, { headers: { accept: "application/vnd.github.diff" } });
  assertOkStatus(res, "pr_diff");
  const raw = await res.text();
  const truncated = raw.length > MAX_DIFF_BYTES;
  const diff = truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw;
  return { diff, bytes: raw.length, truncated };
}

export async function createIssue(fetchFn: FetchFn, repo: string, title: string, body: string): Promise<{ number: number; url: string; id: number }> {
  const res = await fetchFn(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body }) });
  assertOkStatus(res, "issue_create");
  const j = (await res.json()) as any;
  return { number: Number(j.number), url: String(j.html_url ?? ""), id: Number(j.id ?? 0) };
}

export async function createIssueComment(fetchFn: FetchFn, repo: string, number: number, body: string): Promise<{ id: number; url: string }> {
  const res = await fetchFn(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  assertOkStatus(res, "comment_create");
  const j = (await res.json()) as any;
  return { id: Number(j.id ?? 0), url: String(j.html_url ?? "") };
}


export async function createPullRequest(fetchFn: FetchFn, repo: string, opts: { title: string; head: string; base: string; body?: string }): Promise<{ number: number; url: string }> {
  const res = await fetchFn(`/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: opts.title, head: opts.head, base: opts.base, body: opts.body ?? "" }) });
  assertOkStatus(res, "pr_create");
  const j = (await res.json()) as any;
  return { number: Number(j.number), url: String(j.html_url ?? "") };
}




const API_READ_ALLOWLIST =
  /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pulls|commits|branches|tags|milestones|releases|labels|contributors|languages|actions\/runs|actions\/workflows|check-runs|statuses)(\/[A-Za-z0-9_.\-\/]*)?(\?.*)?$/;
const FORBIDDEN_READ = /admin|secrets|variables|keys|tokens|collaborators|invitations|members|people|teams|users\b/i;

export async function constrainedApiRead(fetchFn: FetchFn, path: string): Promise<{ status: number; bodyText: string; truncated: boolean }> {
  const clean = path.trim();
  if (!clean.startsWith("/repos/")) throw new ConnectorCallError("provider_error", "github_api_read_only_repos", undefined, "github_api_read_invalid_path");
  if (!API_READ_ALLOWLIST.test(clean)) throw new ConnectorCallError("provider_error", "github_api_read_endpoint_not_allowed", undefined, "github_api_read_not_allowed");
  if (FORBIDDEN_READ.test(clean)) throw new ConnectorCallError("provider_error", "github_api_read_forbidden_endpoint", undefined, "github_api_read_forbidden_endpoint");
  if (/per_page=(\d+)/.exec(clean) && Number(/per_page=(\d+)/.exec(clean)![1]) > 100) throw new ConnectorCallError("provider_error", "github_api_read_per_page_cap", undefined, "github_api_read_per_page_cap");
  const res = await fetchFn(clean);
  assertOkStatus(res, "api_read");
  const raw = await res.text();
  const truncated = raw.length > MAX_API_READ_BYTES;
  return { status: res.status, bodyText: truncated ? raw.slice(0, MAX_API_READ_BYTES) : raw, truncated };
}

export async function listCommits(fetchFn: FetchFn, repo: string, opts?: { ref?: string; path?: string; limit?: number }): Promise<Array<{ sha: string; author: string; message: string; date: string; url: string }>> {
  const limit = Math.max(1, Math.min(30, Number(opts?.limit ?? 10)));
  const p = new URLSearchParams({ per_page: String(limit) });
  if (opts?.ref) p.set("sha", opts.ref);
  if (opts?.path) p.set("path", opts.path);
  const res = await fetchFn(`/repos/${repo}/commits?${p}`);
  assertOkStatus(res, "commits");
  const items = (await res.json()) as any[];
  return (Array.isArray(items) ? items : []).slice(0, limit).map((j) => ({
    sha: String(j.sha ?? ""),
    author: String(j.author?.login ?? j.commit?.author?.name ?? ""),
    message: String(j.commit?.message ?? "").split("\n")[0].slice(0, 200),
    date: String(j.commit?.author?.date ?? ""),
    url: String(j.html_url ?? ""),
  }));
}

export async function readCommit(fetchFn: FetchFn, repo: string, sha: string): Promise<{ sha: string; author: string; message: string; date: string; files: Array<{ filename: string; status: string; additions: number; deletions: number }>; additions: number; deletions: number; url: string }> {
  const res = await fetchFn(`/repos/${repo}/commits/${encodeURIComponent(sha)}`);
  assertOkStatus(res, "commit_read");
  const j = (await res.json()) as any;
  return {
    sha: String(j.sha ?? sha),
    author: String(j.author?.login ?? j.commit?.author?.name ?? ""),
    message: String(j.commit?.message ?? "").slice(0, 4000),
    date: String(j.commit?.author?.date ?? ""),
    files: (j.files ?? []).slice(0, 50).map((f: any) => ({ filename: String(f.filename ?? ""), status: String(f.status ?? ""), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })),
    additions: Number(j.stats?.additions ?? 0),
    deletions: Number(j.stats?.deletions ?? 0),
    url: String(j.html_url ?? ""),
  };
}

export async function listActionRuns(fetchFn: FetchFn, repo: string, opts?: { branch?: string; limit?: number }): Promise<Array<{ id: number; name: string; status: string; conclusion: string | null; branch: string; event: string; createdAt: string; url: string }>> {
  const limit = Math.max(1, Math.min(30, Number(opts?.limit ?? 10)));
  const p = new URLSearchParams({ per_page: String(limit) });
  if (opts?.branch) p.set("branch", opts.branch);
  const res = await fetchFn(`/repos/${repo}/actions/runs?${p}`);
  assertOkStatus(res, "actions_runs");
  const j = (await res.json()) as any;
  return ((j.workflow_runs ?? []) as any[]).slice(0, limit).map((r) => ({
    id: Number(r.id),
    name: String(r.name ?? ""),
    status: String(r.status ?? ""),
    conclusion: r.conclusion == null ? null : String(r.conclusion),
    branch: String(r.head_branch ?? ""),
    event: String(r.event ?? ""),
    createdAt: String(r.created_at ?? ""),
    url: String(r.html_url ?? ""),
  }));
}

export async function readActionRun(fetchFn: FetchFn, repo: string, runId: number): Promise<{ id: number; name: string; status: string; conclusion: string | null; branch: string; event: string; createdAt: string; updatedAt: string; url: string; jobs?: Array<{ name: string; status: string; conclusion: string | null }> }> {
  const res = await fetchFn(`/repos/${repo}/actions/runs/${runId}`);
  assertOkStatus(res, "action_run_read");
  const j = (await res.json()) as any;
  let jobs: Array<{ name: string; status: string; conclusion: string | null }> | undefined;
  try {
    const jres = await fetchFn(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=20`);
    assertOkStatus(jres, "action_run_jobs");
    const jj = (await jres.json()) as any;
    jobs = (jj.jobs ?? []).slice(0, 20).map((x: any) => ({ name: String(x.name ?? ""), status: String(x.status ?? ""), conclusion: x.conclusion == null ? null : String(x.conclusion) }));
  } catch { jobs = undefined; }
  return {
    id: Number(j.id),
    name: String(j.name ?? ""),
    status: String(j.status ?? ""),
    conclusion: j.conclusion == null ? null : String(j.conclusion),
    branch: String(j.head_branch ?? ""),
    event: String(j.event ?? ""),
    createdAt: String(j.created_at ?? ""),
    updatedAt: String(j.updated_at ?? ""),
    url: String(j.html_url ?? ""),
    jobs,
  };
}
