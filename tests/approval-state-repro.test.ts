import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent } from "../src/agent/personal-agent";

const db = new DatabaseSync(":memory:");
const ctx: any = {
  storage: {
    sql: { exec: (s: string, ...args: unknown[]) => db.prepare(s).all(...(args as never[])) },
    setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {},
    setState: async () => {}, getState: async () => ({}), delete: async () => {}, list: async () => ({ rows: [] }),
  },
  getWebSockets: () => [], acceptWebSocket: () => {}, getTags: () => [],
  setWebSocketAutoResponse: () => {}, getWebSocketAutoResponse: () => null,
  blockConcurrencyWhile: async (fn: () => Promise<unknown>) => await fn(), id: { name: "ws-approval-state" },
};
const env: any = { DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ meta: { changes: 1 } }) }) }) } };
const parked = {
  taskId: "t-1", messages: [], pendingToolCall: { id: "c-1", name: "calendar", args: { action: "create" } },
  approvalCode: "CODE", approvalId: "ap-1", replyContext: { channel: "telegram", senderId: "77" }, waitingFor: "approval",
};

const first: any = new (PersonalAgent as any)(ctx, env);
first.onStart();
first.setParkedForScope("owner:global", parked);
assert.equal(first.parkedForScope("owner:global")?.approvalId, "ap-1");

const second: any = new (PersonalAgent as any)(ctx, env);
second.onStart();
assert.equal(second.parkedForScope("owner:global")?.approvalId, "ap-1");
console.log("approval-state-repro: ok");
