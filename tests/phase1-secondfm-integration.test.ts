import assert from "node:assert/strict";
import { allTools, toolDefs, findTool } from "../src/agent/tools.ts";
import { stripToolCallDSL, createDSLStreamCleaner } from "../src/channels/format-cleaner.ts";
import { WeChatTypingManager, withWeChatTyping } from "../src/channels/wechat-typing.ts";
import { normalizeSymbol } from "../src/agent/finance/quote-service.ts";
import { normalizeNewsTime } from "../src/agent/finance/news-service.ts";

async function runTests() {
  console.log("===============================================================");
  console.log("🧪 Running Phase 1 Second.fm Integration Test Suite");
  console.log("===============================================================\n");

  // ── 1. Tool Registry & Kill Switch Snapshot Tests (P0-3, P0-6) ──
  console.log("[1/5] Checking Tool Registry & Kill Switch...");
  // Trusted Introduction is deliberately NOT model-visible until a real signed protocol exists.
  const toolsEnabled = allTools();
  assert.equal(toolsEnabled.length, 77, "Default tool count should be 77 (legacy flat path; +mail_count, +files_create_text in Round 1 remediation)");
  const catalogEnabled = allTools({} as any);
  assert.equal(catalogEnabled.length, 118, "Catalog with env should be 118 (116 + mail_count + files_create_text)");
  assert.ok(!catalogEnabled.some((t) => t.name === "tool_search"), "tool_search is a discovery view, not an executable catalog entry");
  assert.ok(!catalogEnabled.some((t) => t.name === "trusted_people_introduce"), "Introduction must stay hidden until it has a real signed protocol");

  const toolsDisabled = allTools({ FINANCE_TOOLS_ENABLED: "0" } as any);
  assert.equal(toolsDisabled.length, 114, "With FINANCE_TOOLS_ENABLED=0, catalog must be exactly 114 (118 minus 4 finance)");

  const quoteTool = findTool("get_quote");
  assert.ok(quoteTool, "get_quote must be registered");
  assert.equal(quoteTool.name, "get_quote");

  const klineTool = findTool("get_kline");
  assert.ok(klineTool, "get_kline must be registered");

  const profileTool = findTool("get_stock_profile");
  assert.ok(profileTool, "get_stock_profile must be registered");

  const newsTool = findTool("get_news");
  assert.ok(newsTool, "get_news must be registered");

  const disabledFind = findTool("get_quote", { FINANCE_TOOLS_ENABLED: "0" } as any);
  assert.equal(disabledFind, undefined, "findTool must return undefined when feature flag is 0");
  console.log("   ✔ Tool registry and Kill Switch validated.\n");

  // ── 2. Fenced Code Block Preservation in DSL Cleaner (P0-4) ──
  console.log("[2/5] Checking DSL Cleaner & Fenced Code Block Preservation...");
  const rawLeak = "苹果收盘价。<｜DSML｜tool_calls><invoke name=\"get_quote\">{\"symbols\":[\"AAPL\"]}</invoke></｜DSML｜tool_calls>当前股价为 220 美元。";
  const cleanedLeak = stripToolCallDSL(rawLeak);
  assert.equal(cleanedLeak, "苹果收盘价。当前股价为 220 美元。");

  const fencedDoc = `以下是文档说明：
\`\`\`xml
<｜DSML｜tool_calls>
<invoke name="get_weather">
  <parameter name="city">Beijing</parameter>
</invoke>
</｜DSML｜tool_calls>
\`\`\`
请参考以上示例。`;
  const cleanedFenced = stripToolCallDSL(fencedDoc);
  assert.equal(cleanedFenced, fencedDoc, "Fenced code blocks must NOT be modified by stripToolCallDSL!");

  const inlineDoc = "我们推荐使用 `<invoke name=\"foo\">` 作为标记。";
  const cleanedInline = stripToolCallDSL(inlineDoc);
  assert.equal(cleanedInline, inlineDoc, "Inline code spans must NOT be modified!");

  const cleaner = createDSLStreamCleaner();
  const chunk1 = cleaner.push("Hello <｜DSML");
  const chunk2 = cleaner.push("｜tool_calls>internal</｜DSML｜tool_calls> world!");
  const flushed = cleaner.flush();
  assert.equal(chunk1 + chunk2 + flushed, "Hello  world!");
  console.log("   ✔ DSL cleaner code block protection & streaming window validated.\n");

  // ── 3. WeChat Typing Lifecycle & Cleanup Invariant (P0-2) ──
  console.log("[3/5] Checking WeChat Typing Lifecycle & Finally Cleanup...");
  const typingMgr = new WeChatTypingManager({ idleTimeoutMs: 50 });
  const sentActions: number[] = [];
  const mockSender = async (status: 1 | 2) => {
    sentActions.push(status);
  };

  await withWeChatTyping("botA", "userA", true, mockSender, async () => {
    assert.equal(typingMgr.isActive("botA", "userA"), true);
  }, typingMgr);
  assert.equal(typingMgr.isActive("botA", "userA"), false);
  assert.deepEqual(sentActions, [1, 2]);

  sentActions.length = 0;
  try {
    await withWeChatTyping("botA", "userA", true, mockSender, async () => {
      throw new Error("Simulated DO crash / timeout");
    }, typingMgr);
  } catch {}
  assert.equal(typingMgr.isActive("botA", "userA"), false, "Session MUST be stopped even after throwing exception");
  assert.equal(typingMgr.activeCount, 0, "activeCount must return to 0");
  assert.deepEqual(sentActions, [1, 2]);

  await typingMgr.start("botB", "userB");
  assert.equal(typingMgr.activeCount, 1);
  await new Promise((r) => setTimeout(r, 60));
  const expired = await typingMgr.sweepIdle();
  assert.equal(expired.length, 1);
  assert.equal(typingMgr.activeCount, 0, "Idle sessions past TTL must be swept cleanly");
  console.log("   ✔ WeChat typing lifecycle and guaranteed cleanup validated.\n");

  // ── 4. Symbol Resolution & Disambiguation (P0-5) ──
  console.log("[4/5] Checking Financial Symbol Normalization & Disambiguation...");
  const normSilver = normalizeSymbol("白银");
  assert.equal(normSilver.code, "SI=F");
  assert.equal(normSilver.assetClass, "commodity");

  const normGold = normalizeSymbol("黄金");
  assert.equal(normGold.code, "GC=F");
  assert.equal(normGold.assetClass, "commodity");

  const normBtc = normalizeSymbol("BTC");
  assert.equal(normBtc.code, "BTC-USD");
  assert.equal(normBtc.assetClass, "crypto");

  const normAshare = normalizeSymbol("600519");
  assert.equal(normAshare.code, "sh600519");
  assert.equal(normAshare.market, "cn");

  const normHk = normalizeSymbol("00700");
  assert.equal(normHk.code, "hk00700");
  assert.equal(normHk.market, "hk");
  console.log("   ✔ Symbol normalization and disambiguation validated.\n");

  // ── 5. Timezone Normalization (P0-5) ──
  console.log("[5/5] Checking News Timezone Normalization...");
  const rawTime = "2026-09-09 18:30:00";
  const normalized = normalizeNewsTime(rawTime, "Asia/Shanghai");
  assert.equal(normalized, "2026-09-09T18:30:00+08:00", "Must have explicit +08:00 timezone offset");

  const epochSec = 1788949800;
  const normalizedEpoch = normalizeNewsTime(epochSec);
  assert.ok(normalizedEpoch.endsWith("Z"), "Epoch should normalize to UTC ISO timestamp");
  console.log("   ✔ Timezone normalization validated.\n");

  console.log("===============================================================");
  console.log("🎉 All 5 Phase 1 Integration test suites PASSED!");
  console.log("===============================================================\n");
}

runTests().catch((e) => {
  console.error("Test failure:", e);
  process.exit(1);
});
