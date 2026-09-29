

import assert from "node:assert/strict";
import { createOAuthState, normalizeRedirectTo, DEFAULT_REDIRECT_TO } from "../src/connectors/oauth-state.ts";
import { handleOAuthCallback } from "../src/connectors/oauth-flow.ts";
import { REGISTRY } from "../src/connectors/registry.ts";
import { d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import { makeConnectorEnv, makeMockProvider, type TestEnv } from "./helpers/connectors-testkit";

console.log("▶ Testing OAuth redirect_to normalization (P1-02)...");

const WS = "ws-1";
const session = { workspaceId: WS, userId: "u1" };
const backend = (env: TestEnv) => env.DB as unknown as TestD1;


const REJECTED = [
  "https://evil.com",
  "http://evil.com/x",
  "HTTP://evil.com",
  "//evil.com",
  "///evil.com",
  "/%2f%2fevil.com",
  "/%2F%2Fevil.com",
  "/%252f%252fevil.com",
  "\\evil.com",
  "\\\\evil.com",
  "/\\evil.com",
  "/%5cevil.com",
  "/%5Cevil.com",
  "%2f%2fevil.com",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "/javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "/workspace\r\nSet-Cookie: evil=1",
  "/workspace\nX-Injected: 1",
  "/workspace\u0000evil",
  "/work space",
  "/workspace\"x",
  "/workspace<x>",
  "/workspace`x",
  "..",
  "../evil.com",
  "/../evil.com",
  "/%2e%2e/evil.com",
  "/..",
];
for (const raw of REJECTED) {
  assert.equal(normalizeRedirectTo(raw), DEFAULT_REDIRECT_TO, "必须拒绝并回默认: " + JSON.stringify(raw));
}
assert.equal(normalizeRedirectTo(null), DEFAULT_REDIRECT_TO);
assert.equal(normalizeRedirectTo(undefined), DEFAULT_REDIRECT_TO);
assert.equal(normalizeRedirectTo(""), DEFAULT_REDIRECT_TO);
assert.equal(normalizeRedirectTo("   "), DEFAULT_REDIRECT_TO);


for (const ok of ["/workspace", "/workspace?connect=google_ok", "/settings?x=1", "/usage", "/a/b/c#frag", "/settings?next=%2Fworkspace"]) {
  const out = normalizeRedirectTo(ok);
  assert.ok(out.startsWith("/") && !out.startsWith("//"), "合法目标必须保持站内: " + ok);
  assert.equal(normalizeRedirectTo(out), out, "规范化必须幂等: " + ok);
}
assert.equal(normalizeRedirectTo("  /workspace?connect=google_ok  "), "/workspace?connect=google_ok", "首尾空白应被裁剪而不是拒绝");


{
  const env = makeConnectorEnv();
  const a = await createOAuthState(env, WS, "u1", "google", "https://evil.com");
  const ra = await d1Get<{ redirect_to: string }>(backend(env), "SELECT redirect_to FROM oauth_states WHERE state=?", a.state);
  assert.equal(ra?.redirect_to, DEFAULT_REDIRECT_TO, "外部 URL 不能原样入库");
  const b = await createOAuthState(env, WS, "u1", "google", "/settings?x=1");
  const rb = await d1Get<{ redirect_to: string }>(backend(env), "SELECT redirect_to FROM oauth_states WHERE state=?", b.state);
  assert.equal(rb?.redirect_to, "/settings?x=1");
  const c = await createOAuthState(env, WS, "u1", "google", undefined);
  const rc = await d1Get<{ redirect_to: string | null }>(backend(env), "SELECT redirect_to FROM oauth_states WHERE state=?", c.state);
  assert.equal(rc?.redirect_to, null, "未提供时存 NULL（callback 走默认提示）");
}


{
  const env = makeConnectorEnv();
  REGISTRY.google = () => makeMockProvider();
  const good = await createOAuthState(env, WS, "u1", "google", "/settings?x=1");
  const r1 = await handleOAuthCallback(env, { state: good.state, code: "c" }, session, { maxAccounts: null, expectedProvider: "google" });
  assert.equal(r1.ok, true);
  assert.equal((r1 as any).redirectTo, "/settings?x=1");
  assert.ok(!(r1 as any).redirectTo.startsWith("http"), "callback 绝不返回绝对 URL");


  const dirty = await createOAuthState(env, WS, "u1", "google");
  d1Exec(backend(env), "UPDATE oauth_states SET redirect_to='https://evil.com' WHERE state=?", dirty.state);
  const r2 = await handleOAuthCallback(env, { state: dirty.state, code: "c" }, session, { maxAccounts: null, expectedProvider: "google" });
  assert.equal(r2.ok, true);
  assert.equal((r2 as any).redirectTo, DEFAULT_REDIRECT_TO, "历史脏数据必须回安全默认");
  const composed = "https://app.example.com" + (r2 as any).redirectTo;
  assert.equal(new URL(composed).origin, "https://app.example.com", "拼 base 后必须同源");
}

console.log("✔ OAuth redirect_to normalization passed!");
