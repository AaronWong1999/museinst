


import assert from "node:assert/strict";
import {
  constrainedApiRead,
  createIssue,
  listIssuesExcludingPrs,
  listPullRequests,
  readCommit,
  readIssue,
  readFile,
  readPullRequestDiff,
  readTree,
  searchCode,
  type FetchFn,
} from "../src/connectors/github-api";
import { ConnectorCallError } from "../src/connectors/types";

console.log("▶ github api adapters (Step 9 §6.7)");

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(headers ?? {}) } });
}


function fakeFetch(routes: Array<{ match: string | RegExp; replies: Array<(url: string, init?: RequestInit) => Response> }>): FetchFn & { calls: string[] } {
  const counters = new Map<number, number>();
  const calls: string[] = [];
  return Object.assign((async (path: string, init?: RequestInit) => {
    calls.push(path);
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const hit = typeof r.match === "string" ? path.includes(r.match) : r.match.test(path);
      if (!hit) continue;
      const idx = Math.min((counters.get(i) ?? 0), r.replies.length - 1);
      counters.set(i, (counters.get(i) ?? 0) + 1);
      return r.replies[idx](path, init);
    }
    throw new Error("unmatched fetch: " + path);
  }) as FetchFn, { calls });
}


{
  const prItem = (n: number) => ({ number: n, title: `PR ${n}`, state: "open", user: { login: "a" }, created_at: "2026-09-01", updated_at: "2026-09-02", labels: [], html_url: `https://github.com/x/y/pull/${n}`, pull_request: { url: "x" } });
  const issueItem = (n: number) => ({ number: n, title: `Issue ${n}`, state: "open", user: { login: "a" }, created_at: "2026-09-01", updated_at: "2026-09-05", labels: [{ name: "bug" }], html_url: `https://github.com/x/y/issues/${n}` });

  const fullPrPage = Array.from({ length: 100 }, (_, i) => prItem(1000 + i));
  const fetchFn = fakeFetch([
    { match: "/repos/o/r/issues?", replies: [
      () => jsonResponse(fullPrPage),
      () => jsonResponse([issueItem(1), prItem(104), issueItem(2)]),
      () => jsonResponse([]),
    ] },
  ]);
  const { issues, truncated } = await listIssuesExcludingPrs(fetchFn, "o/r", { limit: 3 });
  assert.deepEqual(issues.map((i) => i.number), [1, 2], "必须是真实 Issue，无 PR 混入；数据耗尽时不编造第三条");
  assert.ok(issues.every((i) => !i.isPr));
  assert.equal(truncated, false, "短页=数据自然耗尽，不算截断");
  assert.ok(fetchFn.calls.filter((c) => c.includes("page=2")).length === 1, "整页 PR 时必须翻页");
  console.log("  ✅ issue list filters PRs and keeps paginating");
}


{
  let seen = "";
  const fetchFn = fakeFetch([
    { match: "/issues?", replies: [(url) => { seen = url; return jsonResponse([]); }] },
  ]);
  await listIssuesExcludingPrs(fetchFn, "o/r", {});
  assert.ok(seen.includes("sort=updated") && seen.includes("direction=desc"), "默认必须 sort=updated desc: " + seen);
  console.log("  ✅ default sort is updated/desc");
}


{
  const cases: Array<{ status: number; expectKind: string }> = [
    { status: 401, expectKind: "auth" },
    { status: 403, expectKind: "permission" },
    { status: 429, expectKind: "rate_limit" },
    { status: 500, expectKind: "transient" },
    { status: 503, expectKind: "transient" },
  ];
  for (const c of cases) {
    const fetchFn = fakeFetch([{ match: "/repos/o/r/issues?", replies: [() => jsonResponse({ message: "nope" }, c.status)] }]);
    await assert.rejects(
      () => listIssuesExcludingPrs(fetchFn, "o/r", { limit: 5 }),
      (e: unknown) => e instanceof ConnectorCallError && e.kind === c.expectKind,
      `status ${c.status} 必须归类为 ${c.expectKind}`,
    );
  }
  console.log("  ✅ 401/403/429/5xx → typed failures (never empty success)");
}


{
  const b64 = (s: string) => btoa(s);
  const fetchFn = fakeFetch([
    { match: "/repos/o/r/contents/src/main.ts", replies: [() => jsonResponse({ path: "src/main.ts", sha: "abc", size: 20, encoding: "base64", content: b64("console.log(1)"), html_url: "https://github.com/o/r/blob/main/src/main.ts" })] },
    { match: "/repos/o/r/contents/logo.png", replies: [() => jsonResponse({ path: "logo.png", sha: "def", size: 1000, encoding: "base64", content: b64("ok\0binary") })] },
    { match: "/repos/o/r/contents/big.ts", replies: [() => jsonResponse({ path: "big.ts", sha: "ghi", size: 500 * 1024, encoding: "base64", content: b64("x".repeat(100)) })] },
  ]);
  const text = await readFile(fetchFn, "o/r", "src/main.ts", "main");
  assert.equal(text.encoding, "utf-8");
  assert.equal(text.text, "console.log(1)");
  assert.equal(text.truncated, false);
  assert.equal(text.url.includes("blob/main"), true);

  const bin = await readFile(fetchFn, "o/r", "logo.png");
  assert.equal(bin.encoding, "binary");
  assert.equal(bin.text, null, "二进制内容绝不能被当作文本吐出");

  const big = await readFile(fetchFn, "o/r", "big.ts");
  assert.equal(big.text, null);
  assert.equal(big.truncated, true, "超大小上限必须明确标记 truncated");
  console.log("  ✅ file read: utf-8 only, binary rejected, size cap flagged");
}


{
  const many = Array.from({ length: 400 }, (_, i) => ({ path: `src/file${i}.ts`, type: "blob", sha: `s${i}` }));
  const fetchFn = fakeFetch([
    { match: /^\/repos\/o\/r$/, replies: [() => jsonResponse({ default_branch: "main" })] },
    { match: "/git/trees/main", replies: [() => jsonResponse({ tree: many, truncated: false })] },
  ]);
  const t = await readTree(fetchFn, "o/r", { maxEntries: 300 });
  assert.equal(t.entries.length, 300, "树条目必须有界");
  assert.equal(t.truncated, true);
  assert.equal(t.ref, "main");
  console.log("  ✅ tree browsing is bounded");
}


{
  const fetchFn = fakeFetch([
    { match: "/search/code?", replies: [() => jsonResponse({ total_count: 2, items: [
      { path: "src/a.ts", repository: { full_name: "o/r" }, text_matches: [{ fragment: "function hello() {}" }], html_url: "https://github.com/o/r/blob/main/src/a.ts" },
      { path: "src/b.ts", repository: { full_name: "o/r" }, html_url: "https://github.com/o/r/blob/main/src/b.ts" },
    ] })] },
  ]);
  const { hits, total } = await searchCode(fetchFn, "hello", { repo: "o/r" });
  assert.equal(total, 2);
  assert.equal(hits[0].path, "src/a.ts");
  assert.equal(hits[0].repo, "o/r");
  assert.equal(hits[0].snippet, "function hello() {}");
  assert.ok(hits[0].url.startsWith("https://github.com/o/r/blob/"));
  console.log("  ✅ code search result normalization");
}


{
  const huge = "a".repeat(200 * 1024);
  const fetchFn = fakeFetch([
    { match: "/repos/o/r/pulls/7", replies: [() => new Response(huge, { status: 200, headers: { "content-type": "text/plain" } })] },
  ]);
  const d = await readPullRequestDiff(fetchFn, "o/r", 7);
  assert.equal(d.truncated, true);
  assert.ok(d.diff.length <= 128 * 1024);
  assert.equal(d.bytes, huge.length, "bytes 报告原始大小");
  console.log("  ✅ PR diff bounded with truncation metadata");
}


{
  const okFn = fakeFetch([{ match: "/repos/o/r/commits", replies: [() => jsonResponse([{ sha: "x" }])] }]);
  const ok = await constrainedApiRead(okFn, "/repos/o/r/commits?per_page=5");
  assert.equal(ok.truncated, false);
  assert.ok(ok.bodyText.includes("x"));

  await assert.rejects(() => constrainedApiRead(okFn, "/repos/o/r/secrets"), /endpoint_not_allowed|forbidden_endpoint/);
  await assert.rejects(() => constrainedApiRead(okFn, "/user/repos"), /only_repos/);
  await assert.rejects(() => constrainedApiRead(okFn, "/repos/o/r/collaborators"), /endpoint_not_allowed|forbidden_endpoint/);
  await assert.rejects(() => constrainedApiRead(okFn, "/repos/o/r/commits?per_page=500"), /per_page_cap/);
  console.log("  ✅ escape hatch allowlist/forbidden/caps enforced");
}


{
  const fetchFn = fakeFetch([
    { match: "/repos/o/r/issues", replies: [(url, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") return jsonResponse({ number: 42, id: 9001, html_url: "https://github.com/o/r/issues/42" });
      return jsonResponse([]);
    }] },
  ]);
  const created = await createIssue(fetchFn, "o/r", "t", "b");
  assert.equal(created.number, 42);
  assert.equal(created.url, "https://github.com/o/r/issues/42");
  const prs = await listPullRequests(fakeFetch([{ match: "/pulls?", replies: [() => jsonResponse([{ number: 1, title: "T", state: "open", user: { login: "a" }, draft: false, base: { ref: "main" }, head: { ref: "feat" }, created_at: "", updated_at: "", html_url: "u" }])] }]), "o/r");
  assert.equal(prs[0].base, "main");
  assert.equal(prs[0].head, "feat");
  console.log("  ✅ write adapters return provider-native ids/urls");
}


{
  const fetchFn = fakeFetch([
    { match: "/repos/o/r/issues/9/comments", replies: [() => jsonResponse([{ user: { login: "bob" }, body: "hi", created_at: "2026-09-03", html_url: "c1" }])] },
    { match: "/repos/o/r/issues/9", replies: [() => jsonResponse({ number: 9, title: "T", state: "open", user: { login: "a" }, body: "body", labels: [], assignees: [{ login: "z" }], comments: 1, created_at: "", updated_at: "", html_url: "u" })] },
  ]);
  const d = await readIssue(fetchFn, "o/r", 9, { includeComments: true, commentsLimit: 5 });
  assert.equal(d.commentCount, 1);
  assert.equal(d.comments?.length, 1);
  assert.equal(d.comments?.[0].author, "bob");
  console.log("  ✅ issue read with bounded comments");
}


{
  const fetchFn = fakeFetch([
    { match: "/repos/o/r/commits/abc", replies: [() => jsonResponse({ sha: "abc", author: { login: "a" }, commit: { message: "fix: x", author: { date: "2026-09-01" } }, files: [{ filename: "a.ts", status: "modified", additions: 3, deletions: 1 }], stats: { additions: 3, deletions: 1 }, html_url: "u" })] },
  ]);
  const c = await readCommit(fetchFn, "o/r", "abc");
  assert.equal(c.additions, 3);
  assert.equal(c.files[0].filename, "a.ts");
  console.log("  ✅ commit read normalization");
}

console.log("✅ github api adapter tests passed");
