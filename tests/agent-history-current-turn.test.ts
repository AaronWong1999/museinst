// agent-history-current-turn.test.ts — current user turn appears exactly once.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent, userHistoryMessageId } from "../src/agent/personal-agent";
import { OWNER_GLOBAL_SCOPE } from "../src/security/context";

console.log("▶ PersonalAgent current-turn history boundary");

function makeAgent(db: DatabaseSync): any {
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
    id: { name: "ws-history-test" },
  };
  const agent = new (PersonalAgent as any)(ctx, { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } });
  agent.onStart();
  return agent;
}

const db = new DatabaseSync(":memory:");
const agent = makeAgent(db);
const scope = OWNER_GLOBAL_SCOPE;
const idemKey = "owner_chat:owner:global:wx-trace-1";
const currentId = await userHistoryMessageId(idemKey);

agent.sql`INSERT INTO messages (id, role, content_json, channel, scope_key, created_at)
  VALUES ('old-user', 'user', '{"text":"旧消息"}', 'wechat', ${scope}, 1)`;
agent.sql`INSERT INTO messages (id, role, content_json, channel, scope_key, created_at)
  VALUES ('old-assistant', 'assistant', '{"text":"旧回复"}', 'wechat', ${scope}, 2)`;
agent.sql`INSERT OR IGNORE INTO messages (id, role, content_json, channel, scope_key, created_at)
  VALUES (${currentId}, 'user', '{"text":"蓝色企鹅 731","provenance":"user","promptVisibility":"normal"}', 'wechat', ${scope}, 3)`;
agent.sql`INSERT OR IGNORE INTO messages (id, role, content_json, channel, scope_key, created_at)
  VALUES (${currentId}, 'user', '{"text":"不应覆盖首稿"}', 'wechat', ${scope}, 4)`;
agent.sql`INSERT INTO messages (id, role, content_json, channel, scope_key, created_at)
  VALUES ('old-gate', 'assistant', '{"text":"旧欠费提示","provenance":"host_policy","promptVisibility":"ephemeral"}', 'wechat', ${scope}, 5)`;

const history = agent.loadHistory(scope, null, currentId) as Array<{ role: string; content: string }>;
assert.deepEqual(history.map((message) => message.content), ["旧消息", "旧回复"]);

const assembled = [
  { role: "system", content: "system" },
  ...history,
  { role: "user", content: "蓝色企鹅 731" },
];
assert.equal(assembled.filter((message) => message.content === "蓝色企鹅 731").length, 1);
assert.equal(agent.sql<{ c: number }>`SELECT COUNT(*) AS c FROM messages WHERE id=${currentId}`[0].c, 1);
assert.equal(JSON.parse(agent.sql<{ content_json: string }>`SELECT content_json FROM messages WHERE id=${currentId}`[0].content_json).text, "蓝色企鹅 731");
console.log("  ✅ current user row is excluded by ID, then appended once; INSERT OR IGNORE preserves first body");

const sameRetry = await userHistoryMessageId(idemKey);
const sameBareIdOtherScope = await userHistoryMessageId("email:email:peer:wx-trace-1");
const sameBareIdOtherSource = await userHistoryMessageId("a2a:human-a2a:conversation:wx-trace-1");
assert.equal(sameRetry, currentId);
assert.notEqual(sameBareIdOtherScope, currentId);
assert.notEqual(sameBareIdOtherSource, currentId);
console.log("  ✅ same namespaced event is stable; source/scope isolate identical bare message IDs");

const legacy = agent.loadHistory(scope, null, "not-current") as Array<{ content: string }>;
assert.ok(legacy.some((message) => message.content === "旧消息"), "legacy {text} rows remain readable");
assert.ok(!legacy.some((message) => message.content === "旧欠费提示"), "ephemeral host policy rows stay out of prompt history");
console.log("  ✅ legacy history remains readable while ephemeral host-policy rows are filtered");

console.log("✅ agent-history-current-turn.test.ts passed");
