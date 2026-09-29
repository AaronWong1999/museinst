// DEFECT-022-RC4 — completion-claim guard: browser action claims + web_fetch
// honesty.
//
// Clicked-action claims, and claims about what a browser page shows,
// must require a browser-sourced ledger record. A plain web_fetch record
// (provider "web") proves only that static HTML was fetched — it never proves
// a rendered page observation or any page interaction.
import assert from "node:assert/strict";
import { findExternalCompletionViolations, stripUnsupportedExternalClaims, recordFromToolResult, type ExternalLedger, type ExternalOutcomeRecord } from "../src/agent/external-completion-guard";

console.log("▶ DEFECT-022-RC4 claim guard: click/action + browser-page claims");

const browserObservation: ExternalOutcomeRecord = {
  tool: "browser_task",
  provider: "browser",
  operation: "browse",
  ok: true,
  observation: true,
  resourceType: "browser_page",
  fetchedAt: Date.now(),
};

const webFetchOk: ExternalOutcomeRecord = {
  tool: "web_fetch",
  provider: "web",
  operation: "read",
  ok: true,
  fetchedAt: Date.now(),
  externalUrl: "https://example.com/start",
  resourceType: "web_page",
};

const webSearchOk: ExternalOutcomeRecord = {
  tool: "web_search",
  provider: "web",
  operation: "read",
  ok: true,
  fetchedAt: Date.now(),
  resourceType: "web_search",
};

const ledger = (records: ExternalLedger) => ({ ledger: records });

console.log("  [1] clicked claims with only a web_fetch record → violation");
{
  const v = findExternalCompletionViolations("已点击 Start，看到了 Hello World!", ledger([webFetchOk]));
  assert.ok(v.length > 0, "点击声明不能被 web_fetch 支撑");
  assert.ok(v.some((x) => x.type === "external_browse"), `必须报 external_browse，实际 ${v.map((x) => x.type).join(",")}`);

  const v2 = findExternalCompletionViolations("我已经点击了「连接」按钮并提交了表单。", ledger([webFetchOk]));
  assert.ok(v2.length > 0, "点击+提交声明不能被 web_fetch 支撑");

  const v3 = findExternalCompletionViolations("I clicked the Start button and typed the name into the form.", ledger([webFetchOk]));
  assert.ok(v3.length > 0, "English clicked/typed claims must be blocked too");

  const v4 = findExternalCompletionViolations("我点击了页面上的按钮。", ledger([]));
  assert.ok(v4.length > 0, "空 ledger 下的点击声明必须被拦截");
  console.log("    ✅ 已点击/clicked/提交/typed blocked without browser record");
}

console.log("  [2] same click claim with a browser observation record → passes");
{
  assert.equal(findExternalCompletionViolations("已点击 Start，看到了 Hello World!", ledger([browserObservation])).length, 0);
  assert.equal(findExternalCompletionViolations("我已经点击了「连接」按钮并提交了表单。", ledger([browserObservation])).length, 0);
  assert.equal(findExternalCompletionViolations("I clicked the Start button.", ledger([browserObservation])).length, 0);
  console.log("    ✅ browser observation record satisfies action claims");
}

console.log("  [3] 打开/读到页面 claims satisfied by web_fetch alone → violation");
{
  const v = findExternalCompletionViolations("我打开了 example.com 并读到了标题。", ledger([webFetchOk]));
  assert.ok(v.length > 0, "『打开 example.com』是浏览器声明，web_fetch 不能支撑");
  assert.ok(v.some((x) => x.type === "external_browse") || v.some((x) => x.type === "external_read"));

  const v2 = findExternalCompletionViolations("我在网页上读到了价格是 99 元。", ledger([webFetchOk]));
  assert.ok(v2.length > 0, "『网页上读到』必须要求浏览器观察记录");

  const v3 = findExternalCompletionViolations("页面上看到的数字是 42。", ledger([webSearchOk]));
  assert.ok(v3.length > 0, "『页面上看到』不能被 web_search 支撑");

  const v4 = findExternalCompletionViolations("I visited example.com and saw the page content.", ledger([webFetchOk]));
  assert.ok(v4.length > 0, "visited + saw the page must require a browser record");
  console.log("    ✅ opened/visited/页面读到/看到 claims rejected for web-provider records");
}

console.log("  [4] browser page claims satisfied by browser observation → passes");
{
  assert.equal(findExternalCompletionViolations("我打开了 example.com 并读到了标题。", ledger([browserObservation])).length, 0);
  assert.equal(findExternalCompletionViolations("我在网页上读到了价格是 99 元。", ledger([browserObservation])).length, 0);
  assert.equal(findExternalCompletionViolations("页面上看到的数字是 42。", ledger([browserObservation])).length, 0);
  // web_fetch + browser observation together is also fine.
  assert.equal(findExternalCompletionViolations("已点击 Start，看到了 Hello World!", ledger([webFetchOk, browserObservation])).length, 0);
  console.log("    ✅ browser-sourced records satisfy page claims");
}

console.log("  [5] non-browser texts stay clean (no false positives)");
{
  const empty = ledger([]);
  assert.equal(findExternalCompletionViolations("我给你写一段总结。", empty).length, 0);
  assert.equal(findExternalCompletionViolations("请点击下面的链接完成连接。", empty).length, 0, "引导用户操作的祈使句不是完成声明");
  assert.equal(findExternalCompletionViolations("你可以在网页上查看详情。", empty).length, 0);
  assert.equal(findExternalCompletionViolations("我需要你在表单里输入用户名。", empty).length, 0);
  assert.equal(findExternalCompletionViolations("Let me write a summary for you.", empty).length, 0);
  assert.equal(findExternalCompletionViolations("Please type your name into the form once it opens.", empty).length, 0, "future/instructional phrasing is not a claim");
  // Web read claims (static page) with a web_fetch record stay legitimate.
  assert.equal(findExternalCompletionViolations("我读取了正文内容。", ledger([webFetchOk])).length, 0, "普通 web 读取声明仍然合法");
  assert.equal(findExternalCompletionViolations("搜索结果显示有三条相关资料。", ledger([webSearchOk])).length, 0);
  console.log("    ✅ guidance/imperatives and legitimate web reads untouched");
}

console.log("  [6] end-to-end via recordFromToolResult: web_fetch evidence → record cannot back click claim");
{
  const fakeResult = {
    ok: true,
    data: "page text",
    external: {
      ok: true,
      evidence: { provider: "web", fetchedAt: Date.now(), externalUrl: "https://example.com", resourceType: "web_page", metadata: {} },
      operation: "read",
    },
  } as const;
  const rec = recordFromToolResult("web_fetch", "read", fakeResult);
  assert.ok(rec);
  assert.equal(rec!.provider, "web");
  const v = findExternalCompletionViolations("已点击 Start，看到了 Hello World!", ledger([rec!]));
  assert.ok(v.length > 0, "真实 web_fetch 工具结果产生的记录绝不能支撑点击声明");
  const stripped = stripUnsupportedExternalClaims("已点击 Start，看到了 Hello World!", ledger([rec!]));
  assert.equal(stripped.text.includes("已点击"), false, "strip 必须移除点击声明");
  console.log("    ✅ recordFromToolResult(web_fetch) rejected + stripping works");
}

console.log("✅ claim-guard-click tests passed");
