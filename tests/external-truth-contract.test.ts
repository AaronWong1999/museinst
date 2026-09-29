


import assert from "node:assert/strict";
import {
  externalCodeFromConnectorReason,
  externalFailure,
  notConnected,
  serializeEvidenceForLog,
} from "../src/external/result";
import {
  externalCorrectionInstruction,
  findExternalCompletionViolations,
  providerForToolName,
  recordFromToolResult,
  stripUnsupportedExternalClaims,
  type ExternalLedger,
} from "../src/agent/external-completion-guard";
import { connectorFailureToExternal } from "../src/connectors/token-mark";
import { findTool } from "../src/agent/tools.ts";
import { makeConnectorEnv, mockConnectorFetch, seedConnection, toolCtx, type TestEnv } from "./helpers/connectors-testkit";

console.log("▶ external truth contract (Step 9 §5)");


{
  assert.equal(externalCodeFromConnectorReason("not_connected").code, "not_connected");
  assert.equal(externalCodeFromConnectorReason("reauth_required").code, "reauth_required");
  assert.equal(externalCodeFromConnectorReason("permission_denied").code, "permission_missing", "403 必须=permission_missing，绝不升级成 reauth");
  assert.equal(externalCodeFromConnectorReason("rate_limited").code, "rate_limited");
  assert.equal(externalCodeFromConnectorReason("result_unknown").code, "unknown_delivery_state", "写结果未知必须有独立错误码");
  assert.equal(externalCodeFromConnectorReason("transient_error").code, "provider_unavailable");
  assert.equal(externalCodeFromConnectorReason("internal_error").code, "provider_unavailable");
  assert.equal(externalCodeFromConnectorReason("not_found").code, "resource_not_found");

  const f = connectorFailureToExternal("github", { ok: false, reason: "permission_denied" });
  assert.equal(f.code, "permission_missing");
  assert.equal(f.retryable, false);
  assert.match(f.message, /权限不足|403/);

  const nc = notConnected("github", "/workspace/connect?provider=github");
  assert.equal(nc.error.code, "not_connected");
  assert.equal(nc.error.resumable, true, "not_connected 必须标记为可恢复（等待连接）");
  assert.equal(nc.error.connectUrl, "/workspace/connect?provider=github");

  const unknown = externalFailure("mailbox", "unknown_delivery_state", "投递状态未知", { retryable: false });
  assert.equal(unknown.error.code, "unknown_delivery_state");
  assert.equal(unknown.error.retryable, false, "投递状态未知绝不自动重试");
  console.log("  ✅ error code normalization (401/403/429/5xx/unknown → distinct codes)");
}


{
  const evidence = {
    provider: "google",
    account: "user@example.com",
    externalId: "msg_123",
    externalUrl: "https://mail.google.com/x",
    resourceType: "message",
    fetchedAt: Date.now(),
    verifiedAt: Date.now(),
  } as const;
  const serialized = JSON.stringify(serializeEvidenceForLog(evidence as any));
  for (const banned of ["ya29.", "ghp_", "1//", "password", "authorization", "private_key", "refresh_token"]) {
    assert.equal(serialized.includes(banned), false, `证据序列化不得包含 ${banned}`);
  }
  console.log("  ✅ evidence serialization never contains credential material");
}


{
  const rec = recordFromToolResult("gmail_send", "external_send", {
    ok: true,
    data: { messageId: "m1" },
    external: { ok: true, evidence: { provider: "google", account: "a@x.com", externalId: "m1", resourceType: "message", fetchedAt: 1 }, operation: "send" },
  });
  assert.ok(rec);
  assert.equal(rec!.provider, "google");
  assert.equal(rec!.operation, "send");
  assert.equal(rec!.ok, true);
  assert.equal(rec!.externalId, "m1");


  const failRec = recordFromToolResult("github_repos", "read", { ok: false, error: "（github 拒绝访问：权限不足（403）...）" });
  assert.ok(failRec);
  assert.equal(failRec!.provider, "github");
  assert.equal(failRec!.ok, false);


  assert.equal(recordFromToolResult("memory_save", "local", { ok: true, data: "ok" }), null);
  console.log("  ✅ ledger record construction from tool results");
}


const ledger = (records: ExternalLedger) => ({ ledger: records });

{

  const led: ExternalLedger = [{ tool: "github_issues_list", provider: "github", operation: "read", ok: false, errorCode: "permission_missing" }];
  const v = findExternalCompletionViolations("已经读取了你仓库最近 5 个 Issue，标题如下……", ledger(led));
  assert.ok(v.length > 0, "403 后的读取声明必须被拦截");
  assert.equal(v[0].type, "external_read");


  const led2: ExternalLedger = [{ tool: "github_issues_list", provider: "github", operation: "read", ok: false, errorCode: "not_connected" }];
  const v2 = findExternalCompletionViolations("我已读取到仓库数据，最近 issue 如下", ledger(led2));
  assert.ok(v2.length > 0, "not_connected 后的读取声明必须被拦截");


  const v3 = findExternalCompletionViolations("GitHub 还没有连接，我现在无法读取你的 Issue。请在控制台连接 GitHub 后对我说'继续'，我会接着办这件事。", ledger(led2));
  assert.equal(v3.length, 0, "如实说明未连接不是完成声明");
  console.log("  ✅ GitHub 403 / not_connected → read claims rejected; honest wording passes");
}

{

  const led: ExternalLedger = [{ tool: "mail_send", provider: "mailbox", operation: "send", ok: false, errorCode: "unknown_delivery_state" }];
  const v = findExternalCompletionViolations("邮件已发送给对方。", ledger(led));
  assert.ok(v.length > 0, "unknown_delivery_state 后的发送声明必须被拦截");

  const stripped = stripUnsupportedExternalClaims("邮件已发送给对方。\n需要我稍后再核对一次投递状态吗？", ledger(led));
  assert.equal(stripped.text.includes("邮件已发送给对方"), false);
  assert.equal(stripped.text.includes("核对一次投递状态"), true, "未违规句子必须保留");
  console.log("  ✅ unknown_delivery_state can never back a send claim; stripping keeps honest text");
}

{

  const led: ExternalLedger = [{ tool: "calendar_create", provider: "google", operation: "create", ok: false, errorCode: "verification_failed" }];
  const v = findExternalCompletionViolations("日程已创建好了。", ledger(led));
  assert.ok(v.length > 0, "读回不匹配后的创建声明必须被拦截");


  const led2: ExternalLedger = [{ tool: "google_calendar_create_event", provider: "google", operation: "create", ok: true, externalId: "ev1", resourceType: "event" }];
  const v2 = findExternalCompletionViolations("日程已创建好了。", ledger(led2));
  assert.ok(v2.length > 0, "event 创建声明必须要求读回验证");


  const led3: ExternalLedger = [{ tool: "google_calendar_create_event", provider: "google", operation: "create", ok: true, externalId: "ev1", resourceType: "event", verifiedAt: Date.now() }];
  assert.equal(findExternalCompletionViolations("日程已创建好了。", ledger(led3)).length, 0);
  console.log("  ✅ calendar create claims require provider read-back verification");
}

{

  const led: ExternalLedger = [{ tool: "browser_task", provider: "browser", operation: "browse", ok: true, observation: false }];
  const v = findExternalCompletionViolations("我在浏览器里查到了当前价格是 99 元。", ledger(led));
  assert.ok(v.length > 0, "浏览器未观察到目标值时的断言必须被拦截");
  const led2: ExternalLedger = [{ tool: "browser_task", provider: "browser", operation: "browse", ok: true, observation: true }];
  assert.equal(findExternalCompletionViolations("我在浏览器里查到了当前价格是 99 元。", ledger(led2)).length, 0);
  console.log("  ✅ browser claims require actual observation evidence");
}

{

  const okLed: ExternalLedger = [{ tool: "gmail_send", provider: "google", operation: "send", ok: true, externalId: "msg_1", resourceType: "message" }];
  assert.equal(findExternalCompletionViolations("邮件已经发送给 bob@example.com。", ledger(okLed)).length, 0);
  const badLed: ExternalLedger = [{ tool: "gmail_send", provider: "google", operation: "send", ok: true }];
  assert.ok(findExternalCompletionViolations("邮件已经发送给 bob@example.com。", ledger(badLed)).length > 0, "没有 provider 消息 ID 的发送不能支撑成功声明");
  console.log("  ✅ send claims require provider message ID");
}

{

  const empty: ExternalLedger = [];
  assert.equal(findExternalCompletionViolations("要我现在发送这封邮件吗？", ledger(empty)).length, 0);
  assert.equal(findExternalCompletionViolations("等你批准后我就会发送。", ledger(empty)).length, 0);
  assert.equal(findExternalCompletionViolations("I will send the email once you approve.", ledger(empty)).length, 0);
  assert.equal(findExternalCompletionViolations("目前还没有发送。", ledger(empty)).length, 0);
  console.log("  ✅ questions/future/negated phrasing are not completion claims");
}

{

  const v = findExternalCompletionViolations("已经发送了。", ledger([]));
  assert.ok(v.length > 0);
  const zh = externalCorrectionInstruction("zh", v);
  const en = externalCorrectionInstruction("en", v);
  assert.match(zh, /内部校正/);
  assert.match(en, /Internal correction/);
  assert.match(zh, /unknown_delivery_state/, "校正指令必须显式禁止把 unknown 说成成功");
  console.log("  ✅ correction instructions generated for both languages");
}


{
  const env: TestEnv = makeConnectorEnv();
  await seedConnection(env, "ws-1", "google", "a@example.com", { accessToken: "tok-a", accessExpiresAt: Date.now() + 3600_000 });
  const draft = findTool("gmail_draft")!;
  const mock = mockConnectorFetch([
    { match: "gmail.googleapis.com/gmail/v1/users/me/drafts", reply: (url, init) => {
      if (String(init?.method ?? "GET").toUpperCase() === "POST") return { status: 200, json: { id: "draft_1", message: { id: "msg_9" } } };
      return { status: 200, json: { id: "draft_1", message: { id: "msg_9", labelIds: ["DRAFT"], payload: { headers: [
        { name: "To", value: "bob@example.com" }, { name: "Subject", value: "Step9 draft" },
      ] } } } };
    } },
  ]);
  try {
    const r = await draft.run(toolCtx(env, "ws-1"), { to: "bob@example.com", subject: "Step9 draft", body: "hello" });
    assert.equal(r.ok, true, "读回一致时草稿创建成功");
    assert.equal((r.data as any).draftId, "draft_1");
    assert.equal(r.external?.ok, true);
    if (r.external?.ok) {
      assert.equal(r.external.evidence.externalId, "draft_1");
      assert.equal(r.external.evidence.resourceType, "draft");
      assert.ok(typeof r.external.evidence.verifiedAt === "number", "draft 证据必须带 verifiedAt（读回验证）");
      assert.equal(r.external.operation, "create");
    }
    assert.equal(mock.calls.filter((c) => c.url.includes("/drafts/draft_1")).length, 1, "必须发生一次读回 GET");
  } finally { mock.restore(); }
}

{

  const env: TestEnv = makeConnectorEnv();
  await seedConnection(env, "ws-1", "google", "a@example.com", { accessToken: "tok-a", accessExpiresAt: Date.now() + 3600_000 });
  const draft = findTool("gmail_draft")!;
  const mock = mockConnectorFetch([
    { match: "gmail.googleapis.com/gmail/v1/users/me/drafts", reply: (url, init) => {
      if (String(init?.method ?? "GET").toUpperCase() === "POST") return { status: 200, json: { id: "draft_1" } };
      return { status: 200, json: { id: "draft_1", message: { labelIds: ["DRAFT"], payload: { headers: [
        { name: "To", value: "bob@example.com" }, { name: "Subject", value: "TOTALLY DIFFERENT" },
      ] } } } };
    } },
  ]);
  try {
    const r = await draft.run(toolCtx(env, "ws-1"), { to: "bob@example.com", subject: "Step9 draft", body: "hello" });
    assert.equal(r.ok, false, "读回不匹配必须是失败");
    assert.match(String(r.error), /读回验证失败|verification/);
    assert.equal(r.external?.ok, false);
    if (!r.external?.ok) assert.equal(r.external?.error.code, "verification_failed");
    const rec = recordFromToolResult("gmail_draft", "write", r);
    assert.equal(rec?.ok, false);
    assert.equal(rec?.errorCode, "verification_failed");
  } finally { mock.restore(); }
}


{
  const env: TestEnv = makeConnectorEnv();
  await seedConnection(env, "ws-1", "github", "octocat", { accessToken: "gh-tok", expiresAtOverride: null });
  const repos = findTool("github_repos")!;
  const mock = mockConnectorFetch([{ match: "api.github.com", reply: () => ({ status: 403, json: { message: "Forbidden" } }) }]);
  try {
    const r = await repos.run(toolCtx(env, "ws-1"), {});
    assert.equal(r.ok, false, "403 必须失败");
    assert.equal(r.data, undefined, "403 绝不能变成空列表成功");
    assert.equal(r.external?.ok, false);
    if (!r.external?.ok) {
      assert.equal(r.external?.error.code, "permission_missing");
      assert.equal(r.external?.error.provider, "github");
    }
    const rec = recordFromToolResult("github_repos", "read", r);
    assert.equal(rec?.ok, false);
    assert.equal(rec?.errorCode, "permission_missing");
    assert.equal(findExternalCompletionViolations("已经读取了你的仓库列表。", ledger([rec!])).length > 0, true);
  } finally { mock.restore(); }
}


{
  assert.equal(providerForToolName("github_issues_list"), "github");
  assert.equal(providerForToolName("gmail_draft"), "google");
  assert.equal(providerForToolName("mail_send"), "mailbox");
  assert.equal(providerForToolName("web_search"), "web");
  assert.equal(providerForToolName("browser_task"), "browser");
  assert.equal(providerForToolName("memory_save"), "local");
  console.log("  ✅ tool-name → provider classification");
}

console.log("✅ external truth contract tests passed");
