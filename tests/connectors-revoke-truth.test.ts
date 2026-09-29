



import assert from "node:assert/strict";
import { disconnectProvider, handleOAuthCallback } from "../src/connectors/oauth-flow.ts";
import { getProvider } from "../src/connectors/registry.ts";
import { createOAuthState } from "../src/connectors/oauth-state.ts";
import { d1All, d1Get, type TestD1 } from "./helpers/d1";
import { makeConnectorEnv, seedConnection, mockConnectorFetch, type TestEnv } from "./helpers/connectors-testkit";

console.log("▶ Testing revoke truthfulness (A23)...");

const WS = "ws-1";
const session = { workspaceId: WS, userId: "u1" };
const backend = (env: TestEnv) => env.DB as unknown as TestD1;

async function audits(env: TestEnv) {
  return d1All<{ action: string; detail: string | null; account_label: string }>(
    backend(env), "SELECT action, detail, account_label FROM connector_audit WHERE workspace_id=? ORDER BY created_at ASC", WS,
  );
}
async function localCounts(env: TestEnv) {
  return {
    conns: (await d1Get<{ c: number }>(backend(env), "SELECT COUNT(*) AS c FROM connections WHERE workspace_id=?", WS))?.c ?? 0,
    slots: (await d1Get<{ c: number }>(backend(env), "SELECT COUNT(*) AS c FROM connector_slots WHERE workspace_id=?", WS))?.c ?? 0,
  };
}


{
  const gh = getProvider("github")!;
  assert.equal(gh.supportsRevoke, false, "GitHub 尚未实现远端 revoke");
  assert.equal(gh.revoke, undefined, "GitHub 不得保留把 GET /user 当 revoke 的假函数");
  assert.match(String(gh.manualRevokeUrl), /github\.com\/settings\/applications/, "必须给出手动撤销入口");
  const g = getProvider("google")!;
  assert.equal(g.supportsRevoke, true);
  assert.equal(typeof g.revoke, "function");
  const slack = getProvider("slack");
  assert.equal(slack, null, "已下线/未上线的 provider 不应出现在 registry");
  const feishu = getProvider("feishu")!;
  assert.equal(feishu.supportsRevoke, false);
  assert.equal(feishu.revoke, undefined);
  assert.match(String(feishu.manualRevokeUrl), /open\.feishu\.cn/);
  const lark = getProvider("lark")!;
  assert.equal(lark.supportsRevoke, false);
  assert.equal(lark.revoke, undefined);
  assert.match(String(lark.manualRevokeUrl), /open\.larksuite\.com/);
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "github", "octocat", { accessToken: "ghp-token", expiresAtOverride: null });
  const mock = mockConnectorFetch([{ match: "api.github.com", reply: () => ({ status: 200, json: { login: "octocat" } }) }]);
  try {
    const r: any = await disconnectProvider(env, WS, "github");
    assert.equal(r.ok, true);
    assert.equal(r.revoked, false, "未实现远端 revoke 必须返回 revoked=false");
    assert.equal(r.revoke, "unsupported");
    assert.equal(r.remoteRevokePending, true, "远端授权可能仍在，必须标记待处理");
    assert.match(String(r.manualRevokeUrl), /github\.com/);
    assert.equal(mock.callsTo("api.github.com").length, 0, "绝不能把 GET /user 当作 revoke");
    const lc = await localCounts(env);
    assert.equal(lc.conns, 0, "本地连接必须删除");
    assert.equal(lc.slots, 0, "slot 必须一起释放");
    const a = await audits(env);
    assert.ok(a.some((x) => x.action === "disconnect_ok" && /revoke_unsupported/.test(String(x.detail))), "审计必须写真实结果");
    assert.ok(a.some((x) => x.action === "remote_revoke_pending"), "必须留可恢复审计");
    assert.ok(!a.some((x) => /revoked$/.test(String(x.detail))), "不得声称已撤销");
  } finally { mock.restore(); }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "a@example.com", {
    accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: Date.now() + 3600_000,
  });
  const mock = mockConnectorFetch([{ match: "oauth2.googleapis.com/revoke", reply: () => ({ status: 200, json: {} }) }]);
  try {
    const r: any = await disconnectProvider(env, WS, "google", "a@example.com");
    assert.equal(r.revoked, true, "provider 确认成功才允许 revoked=true");
    assert.equal(r.revoke, "revoked");
    assert.equal(r.remoteRevokePending, false);
    assert.equal(r.manualRevokeUrl, undefined);
    assert.equal(mock.callsTo("oauth2.googleapis.com/revoke").length, 1);
    assert.match(mock.calls[0].body, /token=refresh-1/, "必须撤销 refresh token，否则远端授权仍然有效");
    assert.deepEqual(await localCounts(env), { conns: 0, slots: 0 });
    const a = await audits(env);
    assert.ok(a.some((x) => x.action === "disconnect_ok" && x.detail === "revoked"));
    assert.ok(!a.some((x) => x.action === "remote_revoke_pending"), "确认撤销后不应有待处理记录");
  } finally { mock.restore(); }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "a@example.com", { accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: Date.now() + 3600_000 });
  const mock = mockConnectorFetch([{ match: "oauth2.googleapis.com/revoke", reply: () => "network_error" }]);
  try {
    const r: any = await disconnectProvider(env, WS, "google");
    assert.equal(r.ok, true, "远端失败不妨碍用户主动本地断开");
    assert.equal(r.revoked, false, "网络异常绝不能记 revoked");
    assert.equal(r.revoke, "failed");
    assert.equal(r.remoteRevokePending, true);
    assert.ok(r.manualRevokeUrl, "必须给出手动撤销入口");
    assert.deepEqual(await localCounts(env), { conns: 0, slots: 0 });
    const a = await audits(env);
    const ok = a.find((x) => x.action === "disconnect_ok");
    assert.match(String(ok?.detail), /revoke_failed/, "审计必须是失败的准确结果");
    assert.ok(a.some((x) => x.action === "remote_revoke_pending"));
  } finally { mock.restore(); }
}


{
  for (const status of [400, 500]) {
    const env = makeConnectorEnv();
    await seedConnection(env, WS, "google", "a@example.com", { accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: Date.now() + 3600_000 });
    const mock = mockConnectorFetch([{ match: "oauth2.googleapis.com/revoke", reply: () => ({ status, json: { error: "invalid_token" } }) }]);
    try {
      const r: any = await disconnectProvider(env, WS, "google");
      assert.equal(r.revoked, false, `HTTP ${status} 不能记 revoked`);
      assert.equal(r.revoke, "failed");
      assert.equal(r.remoteRevokePending, true);
    } finally { mock.restore(); }
  }
}


{
  const env = makeConnectorEnv();
  await seedConnection(env, WS, "github", "existing", { accessToken: "old-token", expiresAtOverride: null });
  const mock = mockConnectorFetch([
    { match: "github.com/login/oauth/access_token", reply: () => ({ status: 200, json: { access_token: "new-orphan-token" } }) },
    { match: "api.github.com/user", reply: () => ({ status: 200, json: { login: "someone-else" } }) },
  ]);
  try {
    const { state } = await createOAuthState(env, WS, "u1", "github");
    const r: any = await handleOAuthCallback(env, { state, code: "c" }, session, { maxAccounts: null, expectedProvider: "github" });
    assert.equal(r.error, "already_connected");
    const a = await audits(env);
    assert.ok(a.some((x) => x.action === "orphan_grant_unrevoked"), "不支持远端撤销必须如实记录 unrevoked");
    assert.ok(!a.some((x) => x.action === "orphan_grant_revoked"), "绝不能假记 orphan_grant_revoked");
  } finally { mock.restore(); }
}


{

  const env = makeConnectorEnv();
  await seedConnection(env, WS, "google", "existing@example.com", { accessToken: "old", refreshToken: "old-r", accessExpiresAt: Date.now() + 3600_000 });
  const ok = mockConnectorFetch([
    { match: "oauth2.googleapis.com/token", reply: () => ({ status: 200, json: { access_token: "orphan-access", refresh_token: "orphan-refresh", expires_in: 3600 } }) },
    { match: "openidconnect.googleapis.com/v1/userinfo", reply: () => ({ status: 200, json: { email: "new@example.com", name: "New User" } }) },
    { match: "oauth2.googleapis.com/revoke", reply: () => ({ status: 200, json: {} }) },
  ]);
  try {
    const { state } = await createOAuthState(env, WS, "u1", "google");
    const r: any = await handleOAuthCallback(env, { state, code: "c" }, session, { maxAccounts: 1, expectedProvider: "google" });
    assert.equal(r.error, "quota_exceeded");
    assert.equal(ok.callsTo("oauth2.googleapis.com/revoke").length, 1, "孤儿 grant 必须尝试真实撤销");
    assert.match(ok.callsTo("oauth2.googleapis.com/revoke")[0].body, /orphan-refresh/);
    const a = await audits(env);
    assert.ok(a.some((x) => x.action === "orphan_grant_revoked"), "确认撤销后才写 orphan_grant_revoked");
    assert.equal(await d1Get<{ c: number }>(backend(env), "SELECT COUNT(*) AS c FROM connections WHERE account_label='new@example.com'").then((x) => x?.c), 0);
  } finally { ok.restore(); }


  const env2 = makeConnectorEnv();
  await seedConnection(env2, WS, "google", "existing@example.com", { accessToken: "old", refreshToken: "old-r", accessExpiresAt: Date.now() + 3600_000 });
  const bad = mockConnectorFetch([
    { match: "oauth2.googleapis.com/token", reply: () => ({ status: 200, json: { access_token: "orphan-access", refresh_token: "orphan-refresh", expires_in: 3600 } }) },
    { match: "openidconnect.googleapis.com/v1/userinfo", reply: () => ({ status: 200, json: { email: "new@example.com", name: "New User" } }) },
    { match: "oauth2.googleapis.com/revoke", reply: () => "network_error" },
  ]);
  try {
    const { state } = await createOAuthState(env2, WS, "u1", "google");
    const r: any = await handleOAuthCallback(env2, { state, code: "c" }, session, { maxAccounts: 1, expectedProvider: "google" });
    assert.equal(r.error, "quota_exceeded");
    const a = await audits(env2);
    assert.ok(a.some((x) => x.action === "orphan_grant_revoke_failed"), "撤销失败必须记录失败，而不是成功");
    assert.ok(!a.some((x) => x.action === "orphan_grant_revoked"), "失败绝不能假记成功");
  } finally { bad.restore(); }
}


{
  const env = makeConnectorEnv();
  const mock = mockConnectorFetch([
    { match: "oauth2.googleapis.com/token", reply: () => ({ status: 200, json: { access_token: "a", refresh_token: "r", expires_in: 3600 } }) },
    { match: "openidconnect.googleapis.com/v1/userinfo", reply: () => ({ status: 200, json: { email: "wrong@example.com", name: "Wrong User" } }) },
    { match: "oauth2.googleapis.com/revoke", reply: () => "network_error" },
  ]);
  try {
    const { state } = await createOAuthState(env, WS, "u1", "google", undefined, "expected@example.com");
    const r: any = await handleOAuthCallback(env, { state, code: "c" }, session, { maxAccounts: null, expectedProvider: "google" });
    assert.equal(r.error, "reauth_identity_mismatch");
    const a = await audits(env);
    const row = a.find((x) => x.action === "reauth_identity_mismatch");
    assert.match(String(row?.detail), /revoke=failed/, "撤销失败必须体现在审计里");
    assert.ok(!/revoke=revoked/.test(String(row?.detail)), "不能谎报撤销成功");
  } finally { mock.restore(); }
}

console.log("✔ Revoke truthfulness passed!");
