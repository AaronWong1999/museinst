// agent-incident-reproduction.test.ts — reproduce the production stale-history incident.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent } from "../src/agent/personal-agent";
import { setHostHooks, resetHostHooks } from "../src/hooks";

console.log("▶ PersonalAgent incident reproduction: stale duplicate/billing reply");

const db = new DatabaseSync(":memory:");
const captured: any[] = [];
const ctx: any = {
  storage: {
    sql: { exec: (s: string, ...args: unknown[]) => db.prepare(s).all(...(args as never[])) },
    setAlarm: async () => {},
    getAlarm: async () => null,
    deleteAlarm: async () => {},
    setState: async () => {},
    getState: async () => ({}),
    delete: async () => {},
    list: async () => ({ rows: [] }),
  },
  getWebSockets: () => [],
  acceptWebSocket: () => {},
  getTags: () => [],
  setWebSocketAutoResponse: () => {},
  getWebSocketAutoResponse: () => null,
  blockConcurrencyWhile: async (fn: () => Promise<unknown>) => await fn(),
  id: { name: "ws-incident-test" },
};
const noRows = () => ({
  bind: (..._args: unknown[]) => ({
    first: async () => null,
    all: async () => ({ results: [] as unknown[] }),
    run: async () => ({ meta: { changes: 0 }, success: true }),
  }),
});
const env: any = {
  DB: { prepare: noRows, batch: async () => [] },
  PUBLIC_BASE_URL: "https://example.com",
  MODEL_PROVIDER: "workers-ai",
  MODEL_ROOT: "@cf/test/model",
  MODEL_WORKER: "@cf/test/model",
  AI: {
    run: async (_model: string, body: any) => {
      captured.push(body);
      const response = captured.length === 1
        ? "已记住。你连发了两条相同消息，我合并处理只存了一次。你当前账号存在欠费（欠额 3.53 点）或处于账单冻结状态。"
        : "已记住测试暗号：蓝色企鹅 731。";
      return { response };
    },
  },
};

const agent = new (PersonalAgent as any)(ctx, env);
agent.onStart();
agent.sql`INSERT INTO messages (id, role, content_json, channel, scope_key, created_at)
  VALUES ('incident-duplicate', 'assistant', '{"text":"你连发了两条相同请求，我合并成一个提醒。"}', 'wechat', 'owner:global', 1)`;
agent.sql`INSERT INTO messages (id, role, content_json, channel, scope_key, created_at)
  VALUES ('incident-billing', 'assistant', '{"text":"你当前账号存在欠费（欠额 3.53 点）或处于账单冻结状态。"}', 'wechat', 'owner:global', 2)`;

try {
  const result = await agent.handleEvent(
    { channel: "wechat", senderId: "wx-user", messageId: "wx-incident-1", kind: "text", text: "记住我的测试暗号：蓝色企鹅 731", receivedAt: Date.now() } as any,
    "zh",
  );

  assert.equal(captured.length, 2, "unsupported first draft must be regenerated once");
  const firstPayloadUsers = captured[0].messages.filter((message: any) => message.role === "user");
  assert.equal(firstPayloadUsers.filter((message: any) => message.content === "记住我的测试暗号：蓝色企鹅 731").length, 1);
  assert.deepEqual(result.replies, ["已记住测试暗号：蓝色企鹅 731。"]);

  const assistantRows = agent.sql<{ content_json: string }>`SELECT content_json FROM messages WHERE role='assistant' ORDER BY created_at`;
  assert.equal(assistantRows.length, 3, "two old rows plus one final row; rejected draft is not persisted");
  const last = JSON.parse(assistantRows[assistantRows.length - 1].content_json);
  assert.equal(last.text, "已记住测试暗号：蓝色企鹅 731。");
  assert.equal(last.provenance, "model");
  const idem = agent.sql<{ replies_json: string }>`SELECT replies_json FROM idempotency WHERE key='owner_chat:owner:global:wx-incident-1'`[0];
  assert.ok(!idem.replies_json.includes("你连发了两条"));
  assert.ok(!idem.replies_json.includes("欠费"));
  console.log("  ✅ stale history cannot reproduce the false duplicate/billing reply; rejected draft is not durable");
} finally {
  resetHostHooks();
}

console.log("✅ agent-incident-reproduction.test.ts passed");
