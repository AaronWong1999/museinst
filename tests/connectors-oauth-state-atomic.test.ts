


import assert from "node:assert/strict";
import { createOAuthState, consumeOAuthState, OAUTH_STATE_TTL_MS } from "../src/connectors/oauth-state.ts";
import { handleOAuthCallback } from "../src/connectors/oauth-flow.ts";
import { REGISTRY } from "../src/connectors/registry.ts";
import { d1Get, d1All, type TestD1 } from "./helpers/d1";
import { makeConnectorEnv, makeMockProvider, exec, type TestEnv } from "./helpers/connectors-testkit";

console.log("▶ Testing OAuth state atomic consumption (A21/P1-03)...");

const WS = "ws-1";
const USER = "user-1";
const session = { workspaceId: WS, userId: USER };

const backend = (env: TestEnv) => env.DB as unknown as TestD1;

async function stateRow(env: TestEnv, state: string) {
  return d1Get<{ consumed_at: number | null; claim_token: string | null; redirect_to: string | null }>(
    backend(env), "SELECT consumed_at, claim_token, redirect_to FROM oauth_states WHERE state=?", state,
  );
}


{
  const env = makeConnectorEnv();
  const { state } = await createOAuthState(env, WS, USER, "google");
  const results = await Promise.all(Array.from({ length: 20 }, () => consumeOAuthState(env, state)));
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 1, "20 次并发只能有一次消费成功");
  const errs = results.filter((r) => !r.ok).map((r) => (r as any).error);
  assert.equal(errs.length, 19);
  for (const e of errs) assert.equal(e, "state_consumed", "失败必须是可判定的 state_consumed，实际 " + e);
  const row = await stateRow(env, state);
  assert.ok(row?.consumed_at != null, "CAS 成功者必须写入 consumed_at");
  assert.ok(row?.claim_token, "CAS 成功者必须拥有 claim_token");
}


{
  const env = makeConnectorEnv();
  const provider = makeMockProvider();
  REGISTRY.google = () => provider;
  const { state } = await createOAuthState(env, WS, USER, "google", undefined);
  const [a, b] = await Promise.all([
    handleOAuthCallback(env, { state, code: "code-a" }, session, { maxAccounts: null, expectedProvider: "google" }),
    handleOAuthCallback(env, { state, code: "code-b" }, session, { maxAccounts: null, expectedProvider: "google" }),
  ]);
  const okCount = [a, b].filter((r) => r.ok).length;
  assert.equal(okCount, 1, "两个并发 callback 只能有一个成功");
  assert.equal(provider.exchangeCalls, 1, "只能有一次 code exchange");
  const losers = [a, b].filter((r) => !r.ok) as Array<{ error: string }>;
  assert.equal(losers[0].error, "state_consumed");
  const conns = await d1All<any>(backend(env), "SELECT account_label FROM connections WHERE workspace_id=? AND provider='google'", WS);
  assert.equal(conns.length, 1, "只能写入一条连接");
}


{
  const env = makeConnectorEnv();
  const provider = makeMockProvider();
  REGISTRY.google = () => provider;
  REGISTRY.github = () => makeMockProvider({ id: "github" });
  const { state } = await createOAuthState(env, WS, USER, "google");
  const r = await handleOAuthCallback(env, { state, code: "code" }, session, { maxAccounts: null, expectedProvider: "github" });
  assert.equal(r.ok, false);
  assert.equal((r as any).error, "provider_mismatch");
  assert.equal(provider.exchangeCalls, 0, "provider 不一致绝不能 exchange code");
  assert.equal(provider.identifyCalls, 0, "provider 不一致绝不能 identify");
  assert.equal((await d1All(backend(env), "SELECT 1 FROM connections")).length, 0, "不能写入 grant");
  assert.equal((await d1All(backend(env), "SELECT 1 FROM connector_slots")).length, 0, "不能占 slot");
}


{
  const env = makeConnectorEnv();
  const provider = makeMockProvider();
  REGISTRY.google = () => provider;
  const s1 = await createOAuthState(env, "other-ws", USER, "google");
  const r1 = await handleOAuthCallback(env, { state: s1.state, code: "c" }, session, { maxAccounts: null, expectedProvider: "google" });
  assert.equal((r1 as any).error, "workspace_mismatch");
  const s2 = await createOAuthState(env, WS, "other-user", "google");
  const r2 = await handleOAuthCallback(env, { state: s2.state, code: "c" }, session, { maxAccounts: null, expectedProvider: "google" });
  assert.equal((r2 as any).error, "user_mismatch");
  assert.equal(provider.exchangeCalls, 0, "绑定不匹配绝不能 exchange code");
}


{
  const env = makeConnectorEnv();
  assert.equal((await consumeOAuthState(env, "nope") as any).error, "invalid_state");

  const expired = await createOAuthState(env, WS, USER, "google");
  exec(env, "UPDATE oauth_states SET expires_at=? WHERE state=?", Date.now() - 1000, expired.state);
  assert.equal((await consumeOAuthState(env, expired.state) as any).error, "state_expired");


  const legacy = await createOAuthState(env, WS, USER, "google");
  exec(env, "UPDATE oauth_states SET expires_at=NULL WHERE state=?", legacy.state);
  assert.equal((await consumeOAuthState(env, legacy.state) as any).error, "state_incomplete");

  const blank = await createOAuthState(env, WS, USER, "google");
  exec(env, "UPDATE oauth_states SET workspace_id='' WHERE state=?", blank.state);
  assert.equal((await consumeOAuthState(env, blank.state) as any).error, "state_incomplete");
}


{
  const env = makeConnectorEnv();
  const { state } = await createOAuthState(env, WS, USER, "github", "/settings?x=1", "me@example.com");
  const r = await consumeOAuthState(env, state);
  assert.equal(r.ok, true);
  const row = (r as any).row;
  assert.equal(row.workspace_id, WS);
  assert.equal(row.user_id, USER);
  assert.equal(row.provider, "github");
  assert.equal(row.redirect_to, "/settings?x=1");
  assert.ok(row.expires_at > Date.now() && row.expires_at <= Date.now() + OAUTH_STATE_TTL_MS + 5000, "TTL 应为 10 分钟");
}


{
  const env = makeConnectorEnv();
  const { state } = await createOAuthState(env, WS, USER, "google");
  const r = await consumeOAuthState(env, state);
  assert.equal(r.ok, true);
  const row = await stateRow(env, state);
  assert.equal(row?.consumed_at != null, true);

  const again = await consumeOAuthState(env, state);
  assert.equal((again as any).error, "state_consumed");
}

console.log("✔ OAuth state atomic consumption passed!");
