import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent } from "../src/agent/personal-agent";
import { findOperationalClaimViolations, stripUnsupportedOperationalClaims, hasRepeatedSyncDiagnostics, type OperationalClaimContext } from "../src/agent/operational-claim-guard";

const question = "那你现在能去 binance 给我找到我的钱么";
const diagnostics = [
  "刚才同步报错或者显示离线，同步报错",
  "刚才同步报错或者显示离线，同步报错",
  "刚才同步报错 or offline，同步报错",
  "刚才同步报错 or offline，同步报error",
  "「同步报错」几条可以忽略，都是同一事件的重复推送。",
  "目前我能看到的账户状态是:待审批提案已生成，正等你批准或拒绝。",
].join("\n\n");
const good = "需要确认你要查的是现货、质押还是 Earn。入口：https://www.binance.com";
const context: OperationalClaimContext = { currentUserText: question, channel: "web", source: "owner_chat", duplicateConfirmed: false, currentAccountEvidence: false, currentConnectorEvidence: false };
for (const text of diagnostics.split("\n\n")) assert.ok(findOperationalClaimViolations(text, context).length, text);
assert.equal(stripUnsupportedOperationalClaims(good + "\n\n" + diagnostics, context).text, good);
assert.equal(stripUnsupportedOperationalClaims("1. https://www.binance.com\n\n2. 余额 1.25", context).text, "1. https://www.binance.com\n\n2. 余额 1.25");
for (const text of ["如果同步报错，可以刷新页面。", "你提到同步报错，我还无法确认原因。", "I cannot confirm whether the session is offline.", "如果需要批准，我会先向你确认。", "解释 offline 这个术语。"])
  assert.equal(findOperationalClaimViolations(text, context).length, 0, text);
assert.equal(findOperationalClaimViolations("The session is offline. Duplicate notifications occurred.", context).length, 2);
assert.ok(findOperationalClaimViolations("没有丢数据，刚才同步报错。", context).length);
assert.equal(findOperationalClaimViolations("刚才同步报错", { ...context, currentAccountEvidence: true, currentConnectorEvidence: true }).length, 1);
assert.equal(findOperationalClaimViolations("正等你批准或拒绝", { ...context, currentApprovalEvidence: true }).length, 0);
assert.equal(findOperationalClaimViolations("刚才同步报错", { ...context, currentUserText: "请引用这句话：刚才同步报错" }).length, 0);
assert.ok(hasRepeatedSyncDiagnostics(diagnostics));
assert.equal(hasRepeatedSyncDiagnostics("如果同步报错，刷新。\n你提到同步报错。\n无法确认同步报错。"), false);

function setup(outputs: string[]) {
  const db = new DatabaseSync(":memory:");
  const ctx: any = { storage: { sql: { exec: (s: string, ...args: any[]) => db.prepare(s).all(...args) }, setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {}, setState: async () => {}, getState: async () => ({}), delete: async () => {}, list: async () => ({ rows: [] }) }, getWebSockets: () => [], acceptWebSocket: () => {}, getTags: () => [], setWebSocketAutoResponse: () => {}, getWebSocketAutoResponse: () => null, blockConcurrencyWhile: async (fn: any) => await fn(), id: { name: "sync-regression" } };
  const calls: any[] = [];
  const noRows = () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 }, success: true }) }) });
  const env: any = { DB: { prepare: noRows, batch: async () => [] }, PUBLIC_BASE_URL: "https://example.com", MODEL_PROVIDER: "workers-ai", MODEL_ROOT: "@cf/test/model", MODEL_WORKER: "@cf/test/model", AI: { run: async (_: any, body: any) => { calls.push(structuredClone(body)); return { response: outputs[Math.min(calls.length - 1, outputs.length - 1)] }; } } };
  const agent = new (PersonalAgent as any)(ctx, env); agent.onStart();
  return { agent, db, calls };
}
for (const repairSucceeds of [true, false]) {
  const { agent, db, calls } = setup([good + "\n\n" + diagnostics, repairSucceeds ? good : good + "\n\n" + diagnostics]);
  // Corrupted assistant prose stays in storage, but is not replayed into prompts.
  for (const [id, role, text] of [["old-user", "user", diagnostics], ["old-bad", "assistant", diagnostics], ["old-good", "assistant", "之前讨论过币安。"]]) {
    db.prepare("INSERT INTO messages (id,role,content_json,channel,scope_key,thread_id,created_at) VALUES (?,?,?,'web','owner:global','main',1)").run(id, role, JSON.stringify({ text }));
  }
  const history = agent.loadHistory("owner:global", null, undefined, "main");
  assert.ok(history.some((m: any) => m.role === "user" && m.content === diagnostics));
  assert.ok(!history.some((m: any) => m.role === "assistant" && m.content === diagnostics));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 3);
  const result = await agent.handleEvent({ channel: "web", senderId: "web-owner", messageId: `sync-${repairSucceeds}`, kind: "text", text: question, receivedAt: Date.now() }, "zh");
  assert.equal(calls.length, 2, "one repair, never an unbounded retry loop");
  assert.equal(result.replies.join("\n\n"), good);
  const saved = db.prepare("SELECT content_json FROM messages WHERE role='assistant' AND id NOT IN ('old-bad','old-good')").all();
  assert.ok(saved.length > 0);
  for (const row of saved) assert.ok(!String(row.content_json).includes("同步报错"));
}
console.log("✅ sync diagnostic hallucination: detection, precise exemptions, bounded repair, fallback, history isolation, durable replies");

for (const repairSucceeds of [true, false]) {
  const { agent, calls } = setup([diagnostics, repairSucceeds ? good : good + "\n\n" + diagnostics]);
  const resumed = await agent.continueLoop({ taskId: "resume-sync", messages: [{ role: "user", content: question }], replyContext: { channel: "web", senderId: "web-owner" }, waitingFor: "approval", createdAt: Date.now() }, "zh", { channel: "web", senderId: "web-owner", messageId: `resume-${repairSucceeds}`, kind: "text", text: "批准", receivedAt: Date.now() });
  assert.equal(calls.length, 2);
  assert.equal(resumed.join("\n\n"), good);
}
console.log("✅ resumed turns enforce the same bounded repair and fallback");
