


import assert from "node:assert/strict";
import { findTool } from "../src/agent/tools.ts";
import { d1Get, type TestD1 } from "./helpers/d1";
import { makeConnectorEnv, seedConnection, mockConnectorFetch, toolCtx, exec, type TestEnv } from "./helpers/connectors-testkit";

console.log("▶ Testing connector tool error layer (A22)...");

const WS = "ws-1";
const backend = (env: TestEnv) => env.DB as unknown as TestD1;
const auth = (c: { headers: Record<string, string> }) => c.headers.authorization ?? c.headers.Authorization ?? "";

async function needsReauth(env: TestEnv, provider: string, label: string): Promise<number> {
  const r = await d1Get<{ needs_reauth: number }>(
    backend(env), "SELECT needs_reauth FROM connections WHERE workspace_id=? AND provider=? AND account_label=?", WS, provider, label,
  );
  return r?.needs_reauth ?? -1;
}

async function callTool(env: TestEnv, name: string, args: Record<string, unknown>) {
  const t = findTool(name);
  assert.ok(t, "tool must exist: " + name);
  return await t!.run(toolCtx(env, WS), args);
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "a@example.com", { accessToken: "tok-a", accessExpiresAt: Date.now() + 3600_000 });
  await seedConnection(env, WS, "google", "b@example.com", { accessToken: "tok-b", accessExpiresAt: Date.now() + 3600_000 });
  const mock = mockConnectorFetch([{ match: "gmail.googleapis.com", reply: () => ({ status: 401, json: { error: { message: "Invalid Credentials" } } }) }]);
  try {
    const r = await callTool(env, "gmail_search", { query: "is:unread", account: "b@example.com" });
    assert.equal(r.ok, false, "401 必须是明确失败");
    assert.equal(r.data, undefined, "401 绝不能变成空列表成功");
    assert.match(String(r.error), /重新连接|授权/, "错误文案必须指明需要重新授权：" + r.error);
    assert.equal(await needsReauth(env, "google", "b@example.com"), 1, "被撤销的账号必须标记 needs_reauth");
    assert.equal(await needsReauth(env, "google", "a@example.com"), 0, "只有对应账号被标记");
    const audit = await d1Get<{ c: number }>(backend(env), "SELECT COUNT(*) AS c FROM connector_audit WHERE action='gmail_search_reauth_required'");
    assert.equal(audit?.c, 1, "失效必须留下审计");
  } finally { mock.restore(); }
}


{
  const cases: Array<{ status: number; tool: string; args: Record<string, unknown>; endpoint: string; expect: RegExp }> = [
    { status: 403, tool: "contacts_search", args: { query: "x" }, endpoint: "people.googleapis.com", expect: /权限不足|403/ },
    { status: 429, tool: "calendar_list", args: { timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-01-02T00:00:00Z" }, endpoint: "www.googleapis.com", expect: /限流|429/ },
    { status: 500, tool: "tasks_list", args: {}, endpoint: "tasks.googleapis.com", expect: /暂时|可重试|500/ },
  ];
  for (const c of cases) {
    const env = makeConnectorEnv();
    await seedConnection(env, WS, "google", "a@example.com", { accessToken: "tok-a", accessExpiresAt: Date.now() + 3600_000 });
    const mock = mockConnectorFetch([{ match: c.endpoint, reply: () => ({ status: c.status, json: { error: { message: "denied" } } }) }]);
    try {
      const r = await callTool(env, c.tool, c.args);
      assert.equal(r.ok, false, `${c.tool} status ${c.status} 必须明确失败`);
      assert.equal(r.data, undefined, `${c.tool} status ${c.status} 不能变成空成功`);
      assert.match(String(r.error), c.expect, `${c.tool} 错误分类必须准确：` + r.error);
      assert.equal(await needsReauth(env, "google", "a@example.com"), 0, `status ${c.status} 绝不能标记 token 失效`);
    } finally { mock.restore(); }
  }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "a@example.com", { accessToken: "tok-a", accessExpiresAt: Date.now() + 3600_000 });
  const mock = mockConnectorFetch([{ match: "gmail.googleapis.com", reply: () => ({ status: 200, json: { resultSizeEstimate: 0 } }) }]);
  try {
    const r = await callTool(env, "gmail_search", { query: "nothing" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, []);
  } finally { mock.restore(); }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "a@example.com", { accessToken: "tok-a", accessExpiresAt: Date.now() + 3600_000 });
  const mock = mockConnectorFetch([
    { match: "gmail.googleapis.com/gmail/v1/users/me/profile", reply: () => ({ status: 200, json: { emailAddress: "a@example.com" } }) },
    { match: "gmail.googleapis.com/gmail/v1/users/me/messages/send", reply: () => "network_error" },
  ]);
  try {
    const r = await callTool(env, "gmail_send", { to: "x@example.com", subject: "s", body: "b" });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /结果未知|不要自动重试|绝不自动重发/, "写操作结果未知必须明确：" + r.error);
    assert.equal(mock.callsTo("messages/send").length, 1, "结果未知的写操作绝不能重试");
  } finally { mock.restore(); }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "a@example.com", {
    accessToken: "stale-token", refreshToken: "refresh-a", accessExpiresAt: Date.now() - 60_000,
  });
  (env as any).TOKEN_BROKER = {
    idFromName: (n: string) => n,
    get: () => ({ fetch: async () => { throw new Error("broker_down"); } }),
  };
  const mock = mockConnectorFetch([{ match: "oauth2.googleapis.com/token", reply: () => ({ status: 200, json: { access_token: "should-not-be-used" } }) }]);
  try {
    const r = await callTool(env, "gmail_search", { query: "x" });
    assert.equal(r.ok, false, "broker 故障必须是明确失败");
    assert.match(String(r.error), /内部故障|可重试/, "必须是可重试的内部故障：" + r.error);
    assert.equal(mock.callsTo("oauth2.googleapis.com/token").length, 0, "broker 故障绝不能绕过串行机制直接 refresh");
    assert.equal(await d1Get<{ c: number }>(backend(env), "SELECT COUNT(*) AS c FROM connector_audit WHERE action='gmail_search_transient_error'").then((x) => x?.c), 0);
  } finally { mock.restore(); }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "a@example.com", { accessToken: "stale", refreshToken: "r", accessExpiresAt: Date.now() - 60_000 });
  (env as any).TOKEN_BROKER = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }) };
  const mock = mockConnectorFetch([{ match: "google", reply: () => ({ status: 200, json: {} }) }]);
  try {
    const r = await callTool(env, "tasks_list", {});
    assert.equal(r.ok, false);
    assert.match(String(r.error), /内部故障|可重试/);
    assert.equal(mock.callsTo("oauth2.googleapis.com/token").length, 0);
  } finally { mock.restore(); }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "a@example.com", { accessToken: "stale", refreshToken: "r", accessExpiresAt: Date.now() - 60_000 });
  (env as any).TOKEN_BROKER = {
    idFromName: (n: string) => n,
    get: () => ({ fetch: async () => Response.json({ ok: true, token: "fresh-from-broker", accountLabel: "a@example.com" }) }),
  };
  const mock = mockConnectorFetch([{ match: "gmail.googleapis.com", reply: () => ({ status: 200, json: { messages: [] } }) }]);
  try {
    const r = await callTool(env, "gmail_search", { query: "x" });
    assert.equal(r.ok, true);
    assert.equal(auth(mock.calls[0]), "Bearer fresh-from-broker", "必须使用 broker 串行刷新出的 token");
  } finally { mock.restore(); }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "a@example.com", { accessToken: "tok-a", accessExpiresAt: Date.now() + 3600_000, createdAt: 1000 });
  await seedConnection(env, WS, "google", "b@example.com", { accessToken: "tok-b", accessExpiresAt: Date.now() + 3600_000, createdAt: 2000 });
  const mock = mockConnectorFetch([{ match: "gmail.googleapis.com", reply: () => ({ status: 200, json: { messages: [] } }) }]);
  try {
    await callTool(env, "gmail_search", { query: "x", account: "B@Example.com" });
    assert.equal(auth(mock.calls.at(-1)!), "Bearer tok-b", "指定账号必须精确使用（label 大小写归一化）");
    await callTool(env, "gmail_search", { query: "x" });
    assert.equal(auth(mock.calls.at(-1)!), "Bearer tok-a", "不指定时必须用最早连接的默认账号");
    const bad = await callTool(env, "gmail_search", { query: "x", account: "not-connected@example.com" });
    assert.equal(bad.ok, false, "不存在的账号必须明确失败，不能静默回退到别的账号");
  } finally { mock.restore(); }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "github", "octocat", { accessToken: "ghp-token", expiresAtOverride: null });
  const ok = mockConnectorFetch([{ match: "api.github.com/user/repos", reply: () => ({ status: 200, json: [{ full_name: "o/r", description: "", updated_at: "2026-01-01" }] }) }]);
  try {
    const r = await callTool(env, "github_repos", { max: 5 });
    assert.equal(r.ok, true, "无过期时间 token 必须能正常使用：" + r.error);
    assert.equal(auth(ok.calls[0]), "Bearer ghp-token");
    assert.equal((r.data as any[]).length, 1);
  } finally { ok.restore(); }

  const bad = mockConnectorFetch([{ match: "api.github.com", reply: () => ({ status: 401, json: { message: "Bad credentials" } }) }]);
  try {
    const r = await callTool(env, "github_repos", {});
    assert.equal(r.ok, false);
    assert.equal(r.data, undefined, "GitHub 401 不能变成空仓库列表");
    assert.equal(await needsReauth(env, "github", "octocat"), 1, "GitHub 401 必须标记 needs_reauth");
  } finally { bad.restore(); }

  const perm = mockConnectorFetch([{ match: "api.github.com", reply: () => ({ status: 403, json: { message: "Forbidden" } }) }]);
  try {
    exec(env, "UPDATE connections SET needs_reauth=0 WHERE workspace_id=? AND provider='github'", WS);
    const r = await callTool(env, "github_search_issues", { query: "is:open" });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /权限不足|403/);
    assert.equal(await needsReauth(env, "github", "octocat"), 0, "403 不等于 token 失效");
  } finally { perm.restore(); }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "github", "octocat", { accessToken: "ghp-token", expiresAtOverride: null });
  const mock = mockConnectorFetch([{ match: "api.github.com/repos/o/r/issues/1/comments", reply: () => "network_error" }]);
  try {
    const r = await callTool(env, "github_comment", { repo: "o/r", number: 1, body: "hi" });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /结果未知|不要自动重试/);
    assert.equal(mock.callsTo("/comments").length, 1);
  } finally { mock.restore(); }
}

console.log("✔ Connector tool error layer passed!");
