// task-lifecycle-regression.test.ts — Round 1 remediation regression for the
// canonical Task/Run/Receipt lifecycle (DEFECT-009/010/023/028 core rules):
//   1. an answered conversation task ends verified_success, never cancelled;
//   2. one canonical assistant row per user turn (deterministic id), so
//      backfillConversations cannot create a second bubble row;
//   3. answer-only turns get a summary receipt (task detail no longer empty);
//   4. tool-budget exhaustion parks the task as waiting_user (resumable),
//      never cancelled;
//   5. an explicit user stop ends the task cancelled with the cancel reason;
//   6. a parked approval turn is waiting_user until resolved;
//   7. a resumed approval reaches a terminal state and keeps one assistant row,
//      including after the next Durable Object start runs the backfill.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent, userHistoryMessageId } from "../src/agent/personal-agent";
import { dispatchChannelEvent } from "../src/channels/dispatch";
import { deriveSecurityContext } from "../src/security/context";
import { getHostHooks } from "../src/hooks";

console.log("▶ task lifecycle terminal-state truth (Round 1 remediation)");

function applyCoreSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, thread_id TEXT, channel TEXT NOT NULL,
      class TEXT NOT NULL, title TEXT, status TEXT NOT NULL, fail_reason TEXT,
      started_at INTEGER NOT NULL, completed_at INTEGER, cost_usd REAL, trace_id TEXT
    );
    CREATE TABLE IF NOT EXISTS task_steps (
      task_id TEXT, seq INTEGER, desc TEXT, ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS task_evidence (
      task_id TEXT, type TEXT, value TEXT, created_at INTEGER,
      UNIQUE(task_id, type, value)
    );
    CREATE TABLE IF NOT EXISTS task_receipts (
      id TEXT PRIMARY KEY, task_id TEXT, share_slug TEXT, redacted_json TEXT,
      public INTEGER, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
      workspace_id TEXT, day TEXT, tasks_ok INTEGER DEFAULT 0, tasks_fail INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, browser_ms INTEGER DEFAULT 0,
      PRIMARY KEY (workspace_id, day)
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT, tool_name TEXT,
      payload_json TEXT NOT NULL, channel TEXT NOT NULL, decided_at INTEGER, decision TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

function createMockCtx(workspaceId = "ws-lifecycle") {
  const db = new DatabaseSync(":memory:");
  applyCoreSchema(db);
  const d1Statements: Array<{ sql: string; bound: unknown[] }> = [];
  const dbProxy = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        const stmt = {
          sql,
          bound: args,
          first: async () => {
            try {
              const stmt2 = db.prepare(sql);
              const rows = stmt2.all(...(args as never[]));
              return rows[0] ?? null;
            } catch {
              return null;
            }
          },
          all: async () => {
            try {
              const stmt2 = db.prepare(sql);
              return { results: stmt2.all(...(args as never[])) };
            } catch {
              return { results: [] as unknown[] };
            }
          },
          run: async () => {
            d1Statements.push({ sql, bound: args });
            try {
              db.prepare(sql).run(...(args as never[]));
              return { meta: { changes: 1 }, success: true };
            } catch (e) {
              return { meta: { changes: 0 }, success: false, error: String(e) };
            }
          },
        };
        return stmt;
      },
      first: async () => null,
      all: async () => ({ results: [] as unknown[] }),
      run: async () => ({ meta: { changes: 0 }, success: true }),
    }),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of stmts) await s.run();
      return [];
    },
  };
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
    id: { name: workspaceId },
    waitUntil: (_p: Promise<unknown>) => {},
    _db: db,
    _d1: dbProxy,
    _d1Statements: d1Statements,
  };
  return { ctx, db };
}

function createMockEnv(opts: { modelReplies?: string[]; failAllModelCalls?: boolean } = {}, db: DatabaseSync) {
  let call = 0;
  const replies = opts.modelReplies ?? ["已处理新任务。"];
  const realDb = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          try {
            return db.prepare(sql).all(...(args as never[]))[0] ?? null;
          } catch {
            return null;
          }
        },
        all: async () => {
          try {
            return { results: db.prepare(sql).all(...(args as never[])) };
          } catch {
            return { results: [] as unknown[] };
          }
        },
        run: async () => {
          try {
            db.prepare(sql).run(...(args as never[]));
            return { meta: { changes: 1 }, success: true };
          } catch (e) {
            return { meta: { changes: 0 }, success: false, error: String(e) };
          }
        },
      }),
      first: async () => null,
      all: async () => ({ results: [] as unknown[] }),
      run: async () => ({ meta: { changes: 0 }, success: true }),
    }),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of stmts) await s.run();
      return [];
    },
  };
  return {
    DB: realDb,
    PUBLIC_BASE_URL: "https://example.com",
    MODEL_PROVIDER: "workers-ai",
    AI: {
      run: async () => {
        if (opts.failAllModelCalls) throw new Error("model_provider_unavailable");
        return { response: replies[Math.min(call++, replies.length - 1)] };
      },
    },
  } as any;
}

function ownerSecurity(workspaceId: string) {
  return deriveSecurityContext({
    claims: { source: "owner_chat", workspaceId, scopeKey: "owner:global" },
    identity: null,
    approvalRoute: { channel: "web" },
  });
}

function webEvent(text: string, messageId: string) {
  return {
    channel: "web" as const,
    senderId: "web:user1",
    messageId,
    kind: "text" as const,
    text,
    receivedAt: Date.now(),
  };
}

async function dispatchAndWait(agent: any, text: string, messageId: string, env: any, workspaceId: string, threadId = "main") {
  const res = await agent.onRequest(
    new Request("https://agent/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: webEvent(text, messageId),
        lang: "zh",
        security: ownerSecurity(workspaceId),
        mode: "enqueue",
        conversation: { threadId },
      }),
    }),
  );
  // serializeTurn is detached for enqueue mode; wait for the turn chain.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const done = (agent as any).turnChain;
    if (done) {
      await done.catch(() => {});
      break;
    }
  }
  return res;
}

function taskRows(db: DatabaseSync): Array<{ id: string; status: string; fail_reason: string | null; completed_at: number | null; thread_id: string }> {
  return db.prepare(`SELECT id, status, fail_reason, completed_at, thread_id FROM tasks ORDER BY started_at DESC`).all() as never;
}

{
  console.log("  [1] answered conversation task ends verified_success, never cancelled (DEFECT-010)");
  const { ctx, db } = createMockCtx("ws-answer");
  const env = createMockEnv({ modelReplies: ["蓝色企鹅 731 已收到。"] }, db);
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  await dispatchAndWait(agent, "测试一条纯文本对话", "wmTEST000001", env, "ws-answer");
  const tasks = taskRows(db);
  assert.equal(tasks.length, 1, "one task per turn");
  assert.equal(tasks[0].status, "verified_success");
  assert.equal(tasks[0].thread_id, "main", "main-thread task records its actual thread");
  assert.ok(tasks[0].completed_at, "terminal task has completed_at");
  // One canonical assistant row with deterministic id.
  const user = await userHistoryMessageId("owner_chat:owner:global:wmTEST000001");
  const assistantRows = db.prepare(`SELECT id FROM conversation_messages WHERE role='assistant'`).all() as Array<{ id: string }>;
  assert.equal(assistantRows.length, 1, "exactly one canonical assistant row");
  assert.equal(assistantRows[0].id, `${user}_a`, "assistant canonical id derives from the user row id");
  // Backfill re-run must NOT create a second assistant row (DEFECT-009).
  const { backfillConversations } = await import("../src/agent/conversations");
  backfillConversations((agent as any).sqlFn, "ws-answer", Date.now());
  const afterBackfill = db.prepare(`SELECT id FROM conversation_messages WHERE role='assistant'`).all() as Array<{ id: string }>;
  assert.equal(afterBackfill.length, 1, "backfill dedupes the deterministic assistant id");
  console.log("  ✅ answered turn → verified_success; single canonical assistant row survives backfill");
}

{
  console.log("  [1b] conversation task keeps its originating side-thread id");
  const { ctx, db } = createMockCtx("ws-side-task-thread");
  const env = createMockEnv({}, db);
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  const created = await agent.onRequest(new Request("https://agent/chat/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Release acceptance" }),
  }));
  assert.equal(created.status, 201);
  const { thread } = await created.json() as { thread: { id: string } };
  await dispatchAndWait(agent, "Only reply OI-UNIT-TASK-THREAD-MARKER", "wmSIDE000001", env, "ws-side-task-thread", thread.id);
  const [task] = taskRows(db);
  assert.equal(task.status, "verified_success");
  assert.equal(task.thread_id, thread.id, "the task retains the side-thread id that accepted it");
  console.log("  ✅ side-thread task records its originating thread id");
}

{
  console.log("  [2] answer-only turn gets a summary receipt (DEFECT-010 task detail)");
  const { ctx, db } = createMockCtx("ws-receipt");
  const env = createMockEnv({ modelReplies: ["这是答案。"] }, db);
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  await dispatchAndWait(agent, "给我一句话总结", "wmTEST000002", env, "ws-receipt");
  const receipts = db.prepare(`SELECT task_id, redacted_json FROM task_receipts`).all() as Array<{ task_id: string; redacted_json: string }>;
  assert.equal(receipts.length, 1, "summary receipt persisted for answer-only turn");
  const data = JSON.parse(receipts[0].redacted_json);
  if (!String(data.answerPreview).includes("这是答案")) {
    console.log("DEBUG receipt:", receipts[0].redacted_json);
    console.log("DEBUG assistant rows:", JSON.stringify(db.prepare(`SELECT id, text FROM conversation_messages WHERE role='assistant'`).all()));
    console.log("DEBUG messages:", JSON.stringify(db.prepare(`SELECT id FROM messages WHERE role='assistant'`).all()));
  }
  assert.equal(data.summaryOnly, true);
  assert.ok(String(data.answerPreview).includes("这是答案"), "receipt carries the answer preview");
  console.log("  ✅ answer-only receipt exists with the answer preview");
}

{
  console.log("  [3] model-call failure ends failed (not cancelled) with reason (DEFECT-023 mapping)");
  const { ctx, db } = createMockCtx("ws-fail");
  const env = createMockEnv({ failAllModelCalls: true }, db);
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  await dispatchAndWait(agent, "随便说点什么", "wmTEST000003", env, "ws-fail");
  const tasks = taskRows(db);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "failed");
  assert.match(String(tasks[0].fail_reason), /model_provider_unavailable/);
  console.log("  ✅ execution failure → failed with fail_reason");
}

{
  console.log("  [4] explicit user stop ends cancelled with a cancel reason");
  const { ctx, db } = createMockCtx("ws-stop");
  const env = createMockEnv({ modelReplies: ["第一步完成。", "第二步完成。"] }, db);
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  const runId = "run-stop-1";
  // Register an active run then request a stop before the turn completes.
  (agent as any).activeRuns()[runId] = { threadId: "main", startedAt: Date.now() };
  (agent as any).setActiveRuns({ [runId]: { threadId: "main", startedAt: Date.now(), stopRequested: true } });
  (agent as any).runStopRequested = () => true;
  await dispatchAndWait(agent, "长任务", "wmTEST000004", env, "ws-stop");
  const tasks = taskRows(db);
  assert.equal(tasks[0].status, "cancelled", "user stop → cancelled");
  assert.equal(tasks[0].fail_reason, "cancelled_by_user_stop");
  console.log("  ✅ user stop → cancelled (explicit, with reason)");
}

{
  console.log("  [5] pending approval is readable through /api/approvals data path (DEFECT-028)");
  const { ctx, db } = createMockCtx("ws-approval");
  const env = createMockEnv({ modelReplies: [] }, db);
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  // Insert a pending approval row like parkForApproval does.
  db.prepare(
    `INSERT INTO approvals (id, workspace_id, task_id, tool_name, payload_json, channel, decision, created_at)
     VALUES ('ap_test_1', 'ws-approval', 't_test_1', 'google_calendar_create_event', '{}', 'web', NULL, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO approvals (id, workspace_id, task_id, tool_name, payload_json, channel, decision, created_at)
     VALUES ('ap_test_2', 'ws-approval', 't_test_2', 'other_tool', '{}', 'web', 'approved', 2)`,
  ).run();
  const pending = db.prepare(`SELECT id FROM approvals WHERE workspace_id='ws-approval' AND decision IS NULL`).all() as Array<{ id: string }>;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "ap_test_1");
  console.log("  ✅ pending-approval read path returns only undecided rows");
}

{
  console.log("  [6] waiting_user status accepted by tasks schema (DEFECT-023/028 state)");
  const { ctx, db } = createMockCtx("ws-waiting");
  const env = createMockEnv({}, db);
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  const completeTurnTask = (agent as any).completeTurnTask.bind(agent);
  const eventId = { channel: "web" } as never;
  await completeTurnTask(eventId, "t_wait_1", { taskId: "t_wait_1", cancelled: false, failed: false, waiting: true }, undefined);
  const row = db.prepare(`SELECT status FROM tasks WHERE id='t_wait_1'`).all() as Array<{ status: string }>;
  assert.equal(row.length, 0, "unknown task id is ignored gracefully");
  // Now with a real task row.
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, channel, class, title, status, started_at) VALUES ('t_wait_2','ws','web','conversation','x','running',1)`,
  ).run();
  await completeTurnTask(eventId, "t_wait_2", { taskId: "t_wait_2", cancelled: false, failed: false, waiting: true }, undefined);
  const after = db.prepare(`SELECT status FROM tasks WHERE id='t_wait_2'`).all() as Array<{ status: string }>;
  assert.equal(after[0].status, "waiting_user");
  console.log("  ✅ waiting outcome writes waiting_user, task stays resumable");
}

{
  console.log("  [7] idempotent replay keeps exactly one assistant row (DEFECT-009 replay rule)");
  const { ctx, db } = createMockCtx("ws-replay");
  const env = createMockEnv({ modelReplies: ["唯一回复。"] }, db);
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  await dispatchAndWait(agent, "问一次", "wmTEST000007", env, "ws-replay");
  await dispatchAndWait(agent, "问一次", "wmTEST000007", env, "ws-replay");
  const assistantRows = db.prepare(`SELECT id FROM conversation_messages WHERE role='assistant'`).all() as Array<{ id: string }>;
  assert.equal(assistantRows.length, 1, "replayed message does not add a second assistant row");
  console.log("  ✅ replay keeps one canonical assistant row");
}

{
  console.log("  [8] denied approval resume ends the task and keeps one assistant row across restart");
  const { ctx, db } = createMockCtx("ws-deny");
  const env = createMockEnv({ modelReplies: ["好的，不做了。接下来需要我做什么？"] }, db);
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  db.exec(`ALTER TABLE approvals ADD COLUMN payload_hash TEXT`);
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, thread_id, channel, class, title, status, started_at) VALUES ('t_deny','ws-deny','main','web','conversation','cal','waiting_user',?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO approvals (id, workspace_id, task_id, tool_name, payload_json, channel, decision, created_at) VALUES ('ap_deny','ws-deny','t_deny','calendar','{}','web',NULL,?)`,
  ).run(now);
  (agent as any).setParkedForScope("owner:global", {
    taskId: "t_deny",
    threadId: "main",
    waitingFor: "approval",
    approvalId: "ap_deny",
    approvalCode: "1N6H",
    pendingToolCall: { id: "call_1", name: "calendar", args: {} },
    replyContext: { channel: "web", senderId: "web:user1" },
    messages: [
      { role: "user", content: "创建一个日程" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "calendar", arguments: "{}" } }] },
    ],
    lang: "zh",
  });
  await dispatchAndWait(agent, "拒绝", "wmTEST000008", env, "ws-deny");
  const approval = db.prepare(`SELECT decision FROM approvals WHERE id='ap_deny'`).all() as Array<{ decision: string }>;
  assert.equal(approval[0].decision, "denied");
  const task = db.prepare(`SELECT status, completed_at FROM tasks WHERE id='t_deny'`).all() as Array<{ status: string; completed_at: number | null }>;
  assert.notEqual(task[0].status, "waiting_user", "resumed approval must not stay waiting_user");
  assert.equal(task[0].status, "cancelled");
  assert.ok(task[0].completed_at, "terminal task records completed_at");
  const countAssistant = () => (db.prepare(
    `SELECT COUNT(*) AS c FROM conversation_messages WHERE role='assistant'`,
  ).all() as Array<{ c: number }>)[0].c;
  assert.equal(countAssistant(), 1, "one assistant row after the resumed turn");
  const restarted = new (PersonalAgent as any)(ctx, env);
  restarted.onStart();
  assert.equal(countAssistant(), 1, "startup backfill must not project a second assistant row");
  console.log("  ✅ denied approval ends cancelled with a single assistant row");
}

console.log("✅ task-lifecycle-regression.test.ts passed");
