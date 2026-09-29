






import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent } from "../src/agent/personal-agent";
import { deriveSecurityContext, emailScopeKey, OWNER_GLOBAL_SCOPE } from "../src/security/context";
import { setHostHooks, resetHostHooks } from "../src/hooks";

console.log("▶ PersonalAgent per-event SecurityContext (A06)");

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.prepare(`CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY NOT NULL, state TEXT)`).run();
  return db;
}

function makeAgent(db: DatabaseSync, captured: { payloads: any[]; usage: any[] }): any {
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
    id: { name: "ws-sec" },
  };
  const noRows = () => ({
    bind: (..._a: unknown[]) => ({
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
        captured.payloads.push(body);
        return { response: "done" };
      },
    },
  };
  const a = new (PersonalAgent as any)(ctx, env);
  a.onStart();
  return a;
}

function externalEmailSecurity() {
  const scopeKey = emailScopeKey("ab".repeat(32), "th_ext");
  return deriveSecurityContext({
    claims: {
      source: "email",
      workspaceId: "ws-sec",
      scopeKey,
      emailMessageRowId: "em_ext",
      threadId: "th_ext",
      peerAddress: "stranger@example.net",
    },
    identity: { peerAddress: "stranger@example.net", contactClass: "unknown", addressVerifiedByOwner: false, messageAuth: "none" },
    approvalRoute: null,
  });
}

function emailEvent(messageId: string, text: string): any {
  return { channel: "email", senderId: "stranger@example.net", messageId, kind: "text", text, receivedAt: Date.now() };
}
function ownerEvent(messageId: string, text: string): any {
  return { channel: "telegram", senderId: "77", messageId, kind: "text", text, receivedAt: Date.now() };
}

process.on("exit", () => resetHostHooks());


{
  const db = makeDb();
  const captured = { payloads: [] as any[], usage: [] as any[] };
  const a = makeAgent(db, captured);
  setHostHooks({
    afterTask: async (_env, ctx, _usage, usageCtx) => {
      captured.usage.push({ workspaceId: ctx.workspaceId, source: usageCtx?.source, messageAuth: usageCtx?.messageAuth });
    },
  });


  a.sql`INSERT INTO memory (key, value, kind, updated_at) VALUES ('secret_note', 'owner-private-value', 'memory', 1)`;

  await a.handleEvent(emailEvent("mid-ext", "hello from stranger"), "en", externalEmailSecurity());
  assert.equal(captured.payloads.length, 1, "external email must call the model");
  const extPayload = captured.payloads[0];
  const extSystem = extPayload.messages[0].content as string;
  assert.ok(extSystem.includes("unauthenticated external message"), "external prompt profile used");
  assert.ok(!extSystem.includes("owner-private-value"), "external prompt must not include owner memory");
  assert.equal(extPayload.tools, undefined, "external event must have zero tools");

  await a.handleEvent(ownerEvent("mid-owner", "hi there"), "en");
  assert.equal(captured.payloads.length, 2, "owner event must call the model");
  const ownerPayload = captured.payloads[1];
  const ownerSystem = ownerPayload.messages[0].content as string;
  assert.ok(!ownerSystem.includes("unauthenticated external message"), "owner event must NOT reuse external_minimal");
  assert.ok(ownerSystem.includes("owner-private-value"), "owner prompt includes owner memory");
  assert.ok(Array.isArray(ownerPayload.tools) && ownerPayload.tools.length > 0, "owner event keeps tools");
  const ownerPayloadJson = JSON.stringify(ownerPayload.messages);
  assert.ok(!ownerPayloadJson.includes("hello from stranger"), "external history must not leak into owner turn");
  assert.equal(
    ownerPayload.messages.filter((message: any) => message.role === "user" && message.content === "hi there").length,
    1,
    "current owner user turn must appear exactly once in the model input",
  );


  assert.equal(captured.usage.length, 2);
  assert.deepEqual(captured.usage[0].source, "email");
  assert.equal(captured.usage[0].workspaceId, "ws-sec");
  assert.deepEqual(captured.usage[1].source, "owner_chat");
  assert.equal(captured.usage[1].workspaceId, "ws-sec");


  const scopes = (db.prepare(`SELECT DISTINCT scope_key FROM messages`).all() as any[]).map((r) => r.scope_key).sort();
  assert.deepEqual(scopes, [OWNER_GLOBAL_SCOPE, emailScopeKey("ab".repeat(32), "th_ext")].sort());
  console.log("  ✅ external → owner: prompt/tools/history/billing do not leak across turns");
}


{
  const db = makeDb();
  const captured = { payloads: [] as any[], usage: [] as any[] };
  const a = makeAgent(db, captured);
  const secA = externalEmailSecurity();
  const secB = deriveSecurityContext({
    claims: { source: "email", workspaceId: "ws-sec", scopeKey: emailScopeKey("cd".repeat(32), "th_b"), threadId: "th_b", peerAddress: "other@example.net" },
    identity: { peerAddress: "other@example.net", contactClass: "unknown", addressVerifiedByOwner: false, messageAuth: "none" },
    approvalRoute: null,
  });
  await a.handleEvent(emailEvent("mid-a", "thread A secret"), "en", secA);
  await a.handleEvent({ ...emailEvent("mid-b", "thread B hello"), senderId: "other@example.net" }, "en", secB);
  assert.equal(captured.payloads.length, 2);
  assert.ok(!JSON.stringify(captured.payloads[1].messages).includes("thread A secret"), "threads must not share history");
  console.log("  ✅ two external threads keep separate scopes");
}


{
  const db = makeDb();
  const captured = { payloads: [] as any[], usage: [] as any[] };

  db.prepare(`INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_state_row_id', ?)`).run(
    JSON.stringify({ security: externalEmailSecurity() }),
  );
  const a = makeAgent(db, captured);
  assert.equal((a.state as any).security, undefined, "legacy state.security must be purged on migration");
  a.sql`INSERT INTO memory (key, value, kind, updated_at) VALUES ('secret_note', 'owner-private-value', 'memory', 1)`;

  await a.handleEvent(ownerEvent("mid-owner-2", "hi"), "en");
  const system = captured.payloads[0].messages[0].content as string;
  assert.ok(!system.includes("unauthenticated external message"), "legacy external context must not apply to owner turn");
  assert.ok(system.includes("owner-private-value"), "owner context rebuilt from this event");
  console.log("  ✅ legacy persisted security purged and ignored");
}


{
  const db = makeDb();
  const captured = { payloads: [] as any[], usage: [] as any[] };
  const a = makeAgent(db, captured);
  a.sql`INSERT INTO memory (key, value, kind, updated_at) VALUES ('secret_note', 'owner-private-value', 'memory', 1)`;
  const foreign = deriveSecurityContext({
    claims: { source: "email", workspaceId: "ws-other", scopeKey: emailScopeKey("ef".repeat(32), "th_x") },
    identity: { peerAddress: "who@example.net", contactClass: "unknown", addressVerifiedByOwner: false, messageAuth: "none" },
    approvalRoute: null,
  });
  await a.handleEvent(ownerEvent("mid-mismatch", "hi"), "en", foreign);
  const system = captured.payloads[0].messages[0].content as string;
  assert.ok(!system.includes("owner-private-value"), "mismatched workspace must not get owner context");
  assert.equal(captured.payloads[0].tools, undefined, "mismatched workspace gets zero tools");
  console.log("  ✅ mismatched workspace security downgraded, never owner");
}

console.log("✅ telegram-security-context-turn.test.ts passed");
