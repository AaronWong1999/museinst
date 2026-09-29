
import assert from "node:assert/strict";
import { findTool } from "../src/agent/tools";
import { recordFromToolResult, findExternalCompletionViolations } from "../src/agent/external-completion-guard";
import { makeConnectorEnv, mockConnectorFetch, toolCtx, type TestEnv } from "./helpers/connectors-testkit";

console.log("▶ web evidence (Step 9 §8.1)");


{
  const env: TestEnv = makeConnectorEnv();
  const mock = mockConnectorFetch([
    { match: "duckduckgo", reply: () => ({ status: 200, raw: new Response('<html><body><a class="result__a" href="uddg=https%3A%2F%2Fexample.com%2Fprice">Example Price</a></body></html>', { status: 200, headers: { "content-type": "text/html" } }) }) },
  ]);
  try {
    const t = findTool("web_search")!;
    const r = await t.run(toolCtx(env, "ws-1"), { query: "example price", max: 3 });

    if (r.ok && Array.isArray(r.data)) {
      assert.equal(r.external?.ok, true);
      if (r.external?.ok) {
        assert.equal(r.external.evidence.provider, "web");
        assert.equal(r.external.evidence.resourceType, "web_search");
        for (const item of r.data as any[]) {
          assert.ok(item.url, "每条结果必须有 URL");
          assert.ok(item.searchedAt, "每条结果必须有 searchedAt");
        }
      }
    } else if (!r.ok) {

      assert.equal(r.external && !r.external.ok ? r.external.error.code : "", "provider_unavailable");
    }
  } finally { mock.restore(); }
  console.log("  ✅ web_search: real-URL results with evidence, blocked → explicit failure");
}


{
  const env: TestEnv = makeConnectorEnv();
  const mock = mockConnectorFetch([
    { match: "example.com/missing", reply: () => ({ status: 404, raw: new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }) }) },
  ]);
  try {
    const t = findTool("web_fetch")!;
    const r = await t.run(toolCtx(env, "ws-1"), { url: "https://example.com/missing" });
    assert.equal(r.ok, false, "404 必须失败");
    if (!r.external?.ok) assert.equal(r.external?.error.code, "resource_not_found");
    const rec = recordFromToolResult("web_fetch", "read", r);
    assert.equal(rec?.ok, false);
    assert.equal(rec?.errorCode, "resource_not_found");

    const v = findExternalCompletionViolations("我已经读取了该页面的全部内容，价格是 99 元。", { ledger: [rec!] });
    assert.ok(v.length > 0, "失败后的读取声明必须被拦");
  } finally { mock.restore(); }
  console.log("  ✅ web_fetch 404 → explicit failure; guard blocks read claims after failure");
}

console.log("✅ web evidence tests passed");
