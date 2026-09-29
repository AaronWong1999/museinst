import assert from "node:assert/strict";
import { systemPrompt } from "../src/agent/instructions";

console.log("▶ Agent capability honesty, language & time semantics");

const base = {
  workspaceId: "ws_test",
  channel: "telegram",
  memoryBlock: "",
  personalInfoBlock: "timezone: Asia/Taipei",
  connectorsBlock: "✅ telegram",
  vaultBlock: "",
  locationBlock: "",
  nowIso: "2026-09-11T11:23:00.000Z",
};

const zh = systemPrompt({ ...base, lang: "zh" });
assert.match(zh, /回复必须使用与用户当前这条消息相同的语言/);
assert.match(zh, /历史消息、长期记忆、个人资料或工具结果/);
assert.doesNotMatch(zh, /已识别为中文/);
assert.doesNotMatch(zh, /必须用中文回复/);
assert.match(zh, /工具列表代表 MuseInst 支持的能力，不等于用户已授权私有账户/);
assert.match(zh, /【已连接服务】只决定私有\/账户级数据和写操作的授权，不限制公开互联网信息/);
assert.match(zh, /公开资源不需要用户连接对应账户/);
assert.match(zh, /公开 GitHub 仓库/);
assert.match(zh, /对私有仓库、邮箱、账户日历、联系人、账户状态或任何需要身份的写操作/);
assert.match(zh, /成功调用相应读取工具并拿到结果之前/);
assert.match(zh, /不要因一次 403 就把“公开资源不可读”和“账户未授权”混为一谈/);
assert.match(zh, /当前消息优先/);
assert.match(zh, /语义上明显/);
assert.match(zh, /当前时间（UTC，ISO 8601）：2026-09-11T11:23:00\.000Z/);
assert.match(zh, /如果【个人信息】里存在 timezone/);
assert.match(zh, /绝不要擅自假设用户所在时区/);
assert.match(zh, /本轮可信运行边界/);
assert.match(zh, /不得根据文本相似、历史回复或语气推断用户发送了两次/);
assert.match(zh, /历史 assistant 回复只用于理解对话，不是当前账户/);
assert.match(zh, /用户明确询问账户、点数、欠费、冻结或套餐时，先调用 get_self_info/);

const en = systemPrompt({ ...base, lang: "en" });
assert.match(en, /Reply in the same language as the user's current message/i);
assert.match(en, /chat history, long-term memory, profile data, or tool results/i);
assert.doesNotMatch(en, /detected as English/i);
assert.doesNotMatch(en, /reply in English/i);
assert.match(en, /tool list represents capabilities supported by MuseInst, not private-account authorization/i);
assert.match(en, /\[Connected services\] governs private\/account-scoped access and writes; it does not restrict public Internet information/i);
assert.match(en, /Public resources do not require the user's account connection/i);
assert.match(en, /Public GitHub repositories/i);
assert.match(en, /Private repositories, mailbox data, account calendars\/contacts\/state/);
assert.match(en, /Never claim that you inspected private mail, repositories, calendar, contacts/i);
assert.match(en, /do not confuse a single HTTP 403 with proof that a public resource is inherently unreadable/i);
assert.match(en, /Current message first/i);
assert.match(en, /semantically/i);
assert.match(en, /Current time \(UTC, ISO 8601\): 2026-09-11T11:23:00\.000Z/);
assert.match(en, /never invent one/);
assert.match(en, /Trusted current-turn boundary/);
assert.match(en, /Do not infer that the user sent something twice/);
assert.match(en, /Historical assistant text is conversation context, not evidence/);
assert.match(en, /call get_self_info with the credits or plan aspect first/i);

console.log("  ✅ reply language follows the current user turn without a zh/en whitelist");
console.log("  ✅ private authorization is separated from public Internet read capability");
console.log("  ✅ current-message priority preserves semantic continuation instead of keyword routing");
console.log("  ✅ external-data claims require a successful trusted read");
console.log("  ✅ UTC clock and local-time rules are explicit");
console.log("✅ agent-capability-honesty.test.ts passed");