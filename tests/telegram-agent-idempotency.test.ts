

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent, userHistoryMessageId } from "../src/agent/personal-agent";

console.log("▶ PersonalAgent idempotency state machine");

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
    id: { name: "ws-test" },
  };
  const env: any = { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } };
  const a = new (PersonalAgent as any)(ctx, env);
  a.onStart();
  return a;
}

function event(messageId: string, text: string): any {
  return { channel: "telegram", senderId: "77", messageId, kind: "text", text, receivedAt: Date.now() };
}


{
  const a = makeAgent(new DatabaseSync(":memory:"));
  a.sql`INSERT INTO idempotency (key, status, started_at, completed_at, replies_json) VALUES ('owner_chat:owner:global:m1', 'completed', 0, 1, ${JSON.stringify({ replies: ["cached reply"] })})`;
  const { replies } = await a.handleEvent(event("m1", "hello"), "en");
  assert.deepEqual(replies, ["cached reply"], "completed message replays stored replies");
  console.log("  ✅ completed → replay persisted replies_json");
}


{
  const a = makeAgent(new DatabaseSync(":memory:"));
  a.sql`INSERT INTO idempotency (key, status, started_at) VALUES ('owner_chat:owner:global:m2', 'running', ${Date.now()})`;
  await assert.rejects(
    () => a.handleEvent(event("m2", "hello"), "en"),
    /idempotency_busy/,
    "concurrent/recent running must surface busy, not empty replies",
  );
  console.log("  ✅ running + fresh lease → busy error (no empty replies)");
}


{
  const a = makeAgent(new DatabaseSync(":memory:"));
  const stale = Date.now() - 11 * 60 * 1000;
  a.sql`INSERT INTO idempotency (key, status, started_at) VALUES ('owner_chat:owner:global:m3', 'running', ${stale})`;

  const { replies } = await a.handleEvent(event("m3", "123456"), "en");
  assert.ok(replies.length > 0, "expired lease must be reclaimed and processed");
  const row = a.sql<{ status: string; replies_json: string }>`SELECT status, replies_json FROM idempotency WHERE key = 'owner_chat:owner:global:m3'`[0];
  assert.equal(row.status, "completed");
  assert.deepEqual(JSON.parse(row.replies_json).replies, replies);
  const historyId = await userHistoryMessageId("owner_chat:owner:global:m3");
  assert.equal(a.sql<{ c: number }>`SELECT COUNT(*) AS c FROM messages WHERE id=${historyId}`[0].c, 1);
  console.log("  ✅ running + expired lease → reclaimed, completed with replies");
}


{
  const a = makeAgent(new DatabaseSync(":memory:"));
  const { replies } = await a.handleEvent(event("m4", "654321"), "en");
  assert.ok(replies.length > 0);
  const row = a.sql<{ status: string }>`SELECT status FROM idempotency WHERE key = 'owner_chat:owner:global:m4'`[0];
  assert.equal(row.status, "completed");
  const historyId = await userHistoryMessageId("owner_chat:owner:global:m4");
  assert.equal(a.sql<{ c: number }>`SELECT COUNT(*) AS c FROM messages WHERE id=${historyId}`[0].c, 1);
  console.log("  ✅ fresh event → running → completed");
}




{
  const db = new DatabaseSync(":memory:");

  db.exec(`CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, seen_at INTEGER)`);
  db.prepare(`INSERT INTO idempotency (key, seen_at) VALUES (?, ?)`).run("old1", 123);
  const a = makeAgent(db);
  const row = a.sql<{ status: string; replies_json: string }>`SELECT status, replies_json FROM idempotency WHERE key = 'old1'`[0];
  assert.equal(row.status, "completed", "legacy seen rows migrate to completed");
  assert.equal(row.replies_json, "[]");
  console.log("  ✅ legacy (key, seen_at) rows migrate safely");
}

console.log("✅ telegram-agent-idempotency.test.ts passed");
