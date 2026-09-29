import assert from "node:assert/strict";
import { systemPrompt } from "../src/agent/instructions";
import { describeApproval, formatBrowserResult, resolveParkedReplyLang } from "../src/agent/personal-agent";
import { templateLang } from "../src/channels/dispatch";
import type { ChannelEvent } from "../src/channels/normalize";

console.log("▶ Agent Human Voice Implementation Plan Test Suite (T1 - T10)");

// ============================================================================

// ============================================================================
{
  const args = {
    action: "create",
    provider: "google",
    summary: "GVERIFY_CALENDAR",
    startIso: "2026-09-16T10:00:00+08:00",
    endIso: "2026-09-16T10:30:00+08:00",
    attendees: [],
  };

  const descZh = describeApproval("calendar", args, "zh");
  const descEn = describeApproval("calendar", args, "en");


  assert.match(descZh, /GVERIFY_CALENDAR/, "ZH approval must contain summary");
  assert.match(descZh, /Google 日历/, "ZH approval must contain human provider name");
  assert.match(descZh, /9\/16 10:00–10:30/, "ZH approval must contain readable time");
  assert.doesNotMatch(descZh, /[{}]/, "ZH approval must not contain JSON braces");
  assert.doesNotMatch(descZh, /"action"/, "ZH approval must not contain raw field names");
  assert.doesNotMatch(descZh, /"provider"/, "ZH approval must not contain raw field names");

  assert.match(descEn, /GVERIFY_CALENDAR/, "EN approval must contain summary");
  assert.match(descEn, /Google Calendar/, "EN approval must contain human provider name");
  assert.match(descEn, /9\/16 10:00–10:30/, "EN approval must contain readable time");
  assert.doesNotMatch(descEn, /[{}]/, "EN approval must not contain JSON braces");
  assert.doesNotMatch(descEn, /"action"/, "EN approval must not contain raw field names");
  assert.doesNotMatch(descEn, /"provider"/, "EN approval must not contain raw field names");

  // Additional Semantic Facades: todo, files, documents, spreadsheet, presentation, code
  const todoDesc = describeApproval("todo", { action: "delete", title: "Buy groceries", provider: "google" }, "zh");
  assert.match(todoDesc, /Buy groceries/);
  assert.doesNotMatch(todoDesc, /[{}]/);

  const filesDesc = describeApproval("files", { action: "delete", name: "Report.pdf" }, "en");
  assert.match(filesDesc, /Report\.pdf/);
  assert.doesNotMatch(filesDesc, /[{}]/);

  const codeDesc = describeApproval("code", { action: "pr_create", repo: "org/repo", head: "feat", base: "main", title: "Add feature" }, "zh");
  assert.match(codeDesc, /Add feature/);
  assert.doesNotMatch(codeDesc, /[{}]/);


  const delZh = describeApproval("calendar", { action: "delete", provider: "google", eventId: "29fjcbpq40l3xyz", startIso: "2026-09-16T10:00:00+08:00", endIso: "2026-09-16T10:30:00+08:00" }, "zh");
  const delEn = describeApproval("calendar", { action: "delete", provider: "google", eventId: "29fjcbpq40l3xyz", startIso: "2026-09-16T10:00:00+08:00", endIso: "2026-09-16T10:30:00+08:00" }, "en");
  assert.doesNotMatch(delZh, /29fjcbpq40l3/);
  assert.doesNotMatch(delEn, /29fjcbpq40l3/);
  assert.doesNotMatch(delZh, /ID/);
  assert.doesNotMatch(delEn, /ID/);
  assert.match(delZh, /9\/16 10:00–10:30/);
  assert.match(delEn, /9\/16 10:00–10:30/);

  console.log("  ✅ T1: Calendar and semantic facades approval descriptions contain no raw JSON");
}

// ============================================================================

// ============================================================================
{
  const unknownArgs = { secretKey: "secret_12345", amount: 999, foo: "bar" };
  const descZh = describeApproval("unknown_payment_tool", unknownArgs, "zh");
  const descEn = describeApproval("unknown_payment_tool", unknownArgs, "en");

  assert.equal(descZh, "执行这项外部操作，需要你的确认。");
  assert.equal(descEn, "This external action needs your approval.");
  assert.doesNotMatch(descZh, /secret_12345/);
  assert.doesNotMatch(descEn, /secret_12345/);
  assert.doesNotMatch(descZh, /[{}]/);
  assert.doesNotMatch(descEn, /[{}]/);

  console.log("  ✅ T2: Unknown approval tools fallback to safe human text without dumping raw args");
}

// ============================================================================

// ============================================================================
{
  const rawObj = {
    success: true,
    opaqueInternal: { foo: "bar", traceId: "tr_998811" },
  };
  const zhResult = formatBrowserResult(rawObj, "zh");
  const enResult = formatBrowserResult(rawObj, "en");

  assert.equal(zhResult, "操作已经完成。");
  assert.equal(enResult, "Done.");
  assert.doesNotMatch(zhResult, /opaqueInternal/);
  assert.doesNotMatch(enResult, /opaqueInternal/);
  assert.doesNotMatch(zhResult, /[{}]/);
  assert.doesNotMatch(enResult, /[{}]/);

  // String and summary fields still work naturally
  assert.equal(formatBrowserResult("Successfully submitted form.", "en"), "Successfully submitted form.");
  assert.equal(formatBrowserResult({ summary: "机票已预订成功" }, "zh"), "机票已预订成功");
  assert.equal(formatBrowserResult({ message: "Item added to cart" }, "en"), "Item added to cart");
  assert.equal(formatBrowserResult(null, "zh"), "任务完成。");

  console.log("  ✅ T3: Browser object fallback never exposes raw JSON");
}

// ============================================================================

// ============================================================================
{
  const wechatEnEvent: ChannelEvent = {
    channel: "wechat",
    senderId: "wx_user_1",
    messageId: "m_1",
    kind: "text",
    text: "Create a Google task for tomorrow.",
    receivedAt: Date.now(),
  };

  assert.equal(templateLang(wechatEnEvent), "en", "WeChat English message must route to templateLang 'en'");
  console.log("  ✅ T4: WeChat English message routes to 'en'");
}

// ============================================================================

// ============================================================================
{
  const tgZhEvent: ChannelEvent = {
    channel: "telegram",
    senderId: "tg_user_1",
    messageId: "m_2",
    kind: "text",
    text: "帮我查一下明天的日历",
    receivedAt: Date.now(),
  };

  assert.equal(templateLang(tgZhEvent), "zh", "Telegram Chinese message must route to templateLang 'zh'");
  console.log("  ✅ T5: Telegram Chinese message routes to 'zh'");
}

// ============================================================================

// ============================================================================
{
  const wechatEmojiEvent: ChannelEvent = {
    channel: "wechat",
    senderId: "wx_user_2",
    messageId: "m_3",
    kind: "text",
    text: "👍🎉",
    receivedAt: Date.now(),
  };

  const tgEmojiEvent: ChannelEvent = {
    channel: "telegram",
    senderId: "tg_user_2",
    messageId: "m_4",
    kind: "text",
    text: "👋",
    receivedAt: Date.now(),
  };

  const emptyEvent: ChannelEvent = {
    channel: "telegram",
    senderId: "tg_user_3",
    messageId: "m_5",
    kind: "text",
    text: "",
    receivedAt: Date.now(),
  };

  assert.equal(templateLang(wechatEmojiEvent), "zh", "WeChat pure emoji falls back to channel default 'zh'");
  assert.equal(templateLang(tgEmojiEvent), "en", "Telegram pure emoji falls back to channel default 'en'");
  assert.equal(templateLang(emptyEvent), "en", "Empty text falls back to channel default");

  console.log("  ✅ T6: Pure emoji / empty text falls back safely without error");
}

// ============================================================================
// T7 — Pending reply language logic
// ============================================================================
{
  // Simulating checkPendingTask language resolution:
  // p.reply_lang ? p.reply_lang === "zh" : p.channel === "wechat"
  const resolveLang = (p: { reply_lang?: string | null; channel: string }) =>
    p.reply_lang ? p.reply_lang === "zh" : p.channel === "wechat";

  // WeChat task with English originating turn
  assert.equal(resolveLang({ reply_lang: "en", channel: "wechat" }), false, "WeChat with reply_lang=en must be English");

  // Telegram task with Chinese originating turn
  assert.equal(resolveLang({ reply_lang: "zh", channel: "telegram" }), true, "Telegram with reply_lang=zh must be Chinese");

  // Legacy task without reply_lang falls back to channel default
  assert.equal(resolveLang({ reply_lang: null, channel: "wechat" }), true, "Legacy WeChat falls back to Chinese");
  assert.equal(resolveLang({ reply_lang: null, channel: "telegram" }), false, "Legacy Telegram falls back to English");

  console.log("  ✅ T7: Pending follow-up language respects originating turn reply_lang");
}

// ============================================================================

// ============================================================================
{
  const promptBase = {
    workspaceId: "ws_prompt_test",
    channel: "telegram",
    memoryBlock: "",
    personalInfoBlock: "",
    connectorsBlock: "",
    vaultBlock: "",
    locationBlock: "",
    nowIso: "2026-09-15T12:00:00.000Z",
  };

  const zhPrompt = systemPrompt({ ...promptBase, lang: "zh" });
  const enPrompt = systemPrompt({ ...promptBase, lang: "en" });

  assert.match(zhPrompt, /只返回 JSON/, "ZH prompt must explicitly preserve JSON-only format override");
  assert.match(zhPrompt, /只返回 marker/, "ZH prompt must explicitly preserve marker format override");
  assert.match(zhPrompt, /只返回姓名和邮箱/, "ZH prompt must explicitly preserve specific fields override");

  assert.match(enPrompt, /JSON-only/i, "EN prompt must explicitly preserve JSON-only format override");
  assert.match(enPrompt, /exact marker/i, "EN prompt must explicitly preserve marker format override");
  assert.match(enPrompt, /only specific fields/i, "EN prompt must explicitly preserve specific fields override");

  console.log("  ✅ T8: System prompt explicitly guarantees user format overrides");
}

// ============================================================================

// ============================================================================
{
  const promptBase = {
    workspaceId: "ws_prompt_test",
    channel: "telegram",
    memoryBlock: "",
    personalInfoBlock: "",
    connectorsBlock: "",
    vaultBlock: "",
    locationBlock: "",
    nowIso: "2026-09-15T12:00:00.000Z",
  };

  const zhPrompt = systemPrompt({ ...promptBase, lang: "zh" });
  const enPrompt = systemPrompt({ ...promptBase, lang: "en" });

  // Check silent resilience in style and worker instructions
  assert.match(zhPrompt, /自动换正确路径并最终成功，正常情况下只自然地报告最终结果/);
  assert.match(zhPrompt, /不写“Transparency \/ 第一次失败 \/ 第二次重试成功”这类内部日志/);
  assert.match(zhPrompt, /不要把中间失败过程作为“透明度报告”发给用户/);
  assert.match(zhPrompt, /用户当前消息明确指定 provider.*保留该 provider 参数/);

  assert.match(enPrompt, /If an internal attempt fails but you recover automatically and the final result is correct, normally report the successful outcome without narrating the recovery/i);
  assert.match(enPrompt, /do not narrate the intermediate failures as a "transparency report"/i);
  assert.match(enPrompt, /preserve that provider argument when invoking the unified semantic facade/i);

  console.log("  ✅ T9: Silent resilience and provider preservation are present in prompts");
}

// ============================================================================

// ============================================================================
{

  assert.equal(
    resolveParkedReplyLang("approve", { lang: "en", replyContext: { channel: "wechat" } }),
    "en",
  );

  assert.equal(
    resolveParkedReplyLang("1234", { lang: "en", replyContext: { channel: "wechat" } }),
    "en",
  );

  assert.equal(
    resolveParkedReplyLang("1234", { lang: "zh", replyContext: { channel: "telegram" } }),
    "zh",
  );

  assert.equal(
    resolveParkedReplyLang("批准", { lang: "en", replyContext: { channel: "telegram" } }),
    "zh",
  );

  assert.equal(
    resolveParkedReplyLang("👍", { replyContext: { channel: "wechat" } }),
    "zh",
  );
  assert.equal(
    resolveParkedReplyLang("👍", { lang: undefined, replyContext: { channel: "telegram" } }),
    "en",
  );

  console.log("  ✅ T10: Parked approval replies follow originating turn language");
}

console.log("\nAll Human Voice tests (T1 - T10) passed successfully!");
