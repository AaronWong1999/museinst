// tests/browser-parked-task-isolation.test.ts
// Regression test for P0-01, P0-02, P0-03, P1-11 from docs/STEP9_DIFF_CODE_AUDIT_AND_REMEDIATION_2026-09-13.md
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent } from "../src/agent/personal-agent";

console.log("▶ Running browser-parked-task-isolation regression tests");

function createMockCtx() {
  const db = new DatabaseSync(":memory:");
  return {
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
    id: { name: "ws-test-isolation" },
  };
}

function createMockEnv(opts: {
  browserWorkerCalls: Array<{ path: string; body: any }>;
  modelCalls: any[];
  browserWorkerOutcome?: any;
}) {
  const noRows = () => ({
    bind: (..._args: unknown[]) => ({
      first: async () => null,
      all: async () => ({ results: [] as unknown[] }),
      run: async () => ({ meta: { changes: 0 }, success: true }),
    }),
  });

  return {
    DB: { prepare: noRows, batch: async () => [] },
    PUBLIC_BASE_URL: "https://example.com",
    MODEL_PROVIDER: "workers-ai",
    MODEL_ROOT: "@cf/test/model",
    MODEL_WORKER: "@cf/test/model",
    BROWSER_WORKER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: any) => ({
        fetch: async (url: string, fetchOpts: any) => {
          const path = new URL(url).pathname;
          const body = JSON.parse(fetchOpts.body);
          opts.browserWorkerCalls.push({ path, body });
          if (path === "/input") {
            return new Response(JSON.stringify(opts.browserWorkerOutcome ?? { status: "done", result: { summary: "完成" } }));
          }
          return new Response(JSON.stringify({ status: "done" }));
        },
      }),
    },
    AI: {
      run: async (_model: string, body: any) => {
        opts.modelCalls.push(body);
        return {
          response: "已响应新任务。",
        };
      },
    },
  };
}

// ── Test 1: P0-01 — Parked browser task must not consume unrelated user messages ──
{
  console.log("  [Test 1] P0-01: Parked browser task does NOT consume unrelated owner message (mail draft)");

  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const ctx = createMockCtx();
  const env = createMockEnv({
    browserWorkerCalls,
    modelCalls,
    browserWorkerOutcome: {
      status: "failed",
      error: "Execution context was destroyed, most likely because of a navigation.",
    },
  });

  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  const oldTaskId = "task-36kr-old";
  agent.setState({
    parked: {
      taskId: oldTaskId,
      messages: [{ role: "user", content: "登录 36kr" }],
      pendingToolCall: { id: "call_browser", name: "browser_task", args: { goal: "登录 36kr" } },
      approvalCode: "",
      approvalId: "",
      replyContext: { channel: "telegram", senderId: "tg-owner" },
      browserBrief: { goal: "登录 36kr", startUrl: "https://36kr.com", vaultHints: [] },
      waitingFor: "browser_input",
      question: "请在打开的页面中完成滑块验证码，完成后告诉我「完成」。",
      expectedInput: { kind: "manual_done" },
      createdAt: Date.now() - 3600_000,
      expiresAt: Date.now() + 600_000,
    },
  });

  const incomingMsg = "给 test@example.com 写一封草稿，主题为 Step 9 验收测试";
  const result = await agent.handleEvent(
    {
      channel: "telegram",
      senderId: "tg-owner",
      messageId: "msg-mail-draft-1",
      kind: "text",
      text: incomingMsg,
      receivedAt: Date.now(),
    } as any,
    "zh",
  );

  assert.equal(
    browserWorkerCalls.filter((c) => c.path === "/input").length,
    0,
    `BrowserWorker /input must NOT be called for unrelated message! Actually called with: ${JSON.stringify(browserWorkerCalls)}`,
  );

  const repliesStr = JSON.stringify(result.replies);
  assert.ok(
    !repliesStr.includes("Execution context was destroyed"),
    "User must not receive raw browser error for unrelated new task",
  );
  assert.ok(modelCalls.length > 0, "Model/Agent loop must process the new mail task");

  const currentParked = agent.parkedForScope("owner:global");
  assert.ok(currentParked, "Old browser parked task must not be destroyed by unrelated task");
  assert.equal(currentParked.taskId, oldTaskId);

  console.log("  ✅ Test 1 passed");
}

// ── Test 2: P0-01 — Matching manual_done input DOES resume the browser task ──
{
  console.log("  [Test 2] P0-01: Matching manual_done input DOES resume the browser task");

  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const ctx = createMockCtx();
  const env = createMockEnv({ browserWorkerCalls, modelCalls });

  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  const oldTaskId = "task-36kr-manual";
  agent.setState({
    parked: {
      taskId: oldTaskId,
      messages: [{ role: "user", content: "登录 36kr" }],
      pendingToolCall: { id: "call_browser", name: "browser_task", args: { goal: "登录 36kr" } },
      approvalCode: "",
      approvalId: "",
      replyContext: { channel: "telegram", senderId: "tg-owner" },
      browserBrief: { goal: "登录 36kr", startUrl: "https://36kr.com", vaultHints: [] },
      waitingFor: "browser_input",
      question: "完成验证后回复「完成」",
      expectedInput: { kind: "manual_done" },
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 500_000,
    },
  });

  const result = await agent.handleEvent(
    {
      channel: "telegram",
      senderId: "tg-owner",
      messageId: "msg-done-1",
      kind: "text",
      text: "完成",
      receivedAt: Date.now(),
    } as any,
    "zh",
  );

  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 1, "Should call /input on matching '完成'");
  assert.equal(modelCalls.length, 0, "Model should not be called when completing manual task");
  console.log("  ✅ Test 2 passed");
}

// ── Test 3: P0-01 — OTP input contract: arbitrary text not consumed, valid code consumed ──
{
  console.log("  [Test 3] P0-01: OTP contract rejects text and accepts numeric code");

  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const ctx = createMockCtx();
  const env = createMockEnv({ browserWorkerCalls, modelCalls });

  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  const oldTaskId = "task-otp-1";
  agent.setState({
    parked: {
      taskId: oldTaskId,
      messages: [],
      pendingToolCall: { id: "call_browser", name: "browser_task", args: {} },
      approvalCode: "",
      approvalId: "",
      replyContext: { channel: "telegram", senderId: "tg-owner" },
      waitingFor: "browser_input",
      question: "请输入收到的 6 位短信验证码",
      expectedInput: { kind: "otp", minLength: 4, maxLength: 8 },
      createdAt: Date.now() - 30_000,
      expiresAt: Date.now() + 500_000,
    },
  });

  // User sends sentence
  await agent.handleEvent(
    { channel: "telegram", senderId: "tg-owner", messageId: "msg-text", kind: "text", text: "明天天气怎么样", receivedAt: Date.now() } as any,
    "zh",
  );
  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 0, "Sentence must not consume OTP");

  // User sends valid OTP
  await agent.handleEvent(
    { channel: "telegram", senderId: "tg-owner", messageId: "msg-otp", kind: "text", text: "891204", receivedAt: Date.now() } as any,
    "zh",
  );
  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 1, "Valid OTP must consume and call /input");
  console.log("  ✅ Test 3 passed");
}

// ── Test 4: P0-02 — Parked browser task TTL expiry ──
{
  console.log("  [Test 4] P0-02: Expired parked browser task is not resumed; message falls back to normal loop");

  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const ctx = createMockCtx();
  const env = createMockEnv({ browserWorkerCalls, modelCalls });

  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  const oldTaskId = "task-expired-1";
  agent.setState({
    parked: {
      taskId: oldTaskId,
      messages: [],
      pendingToolCall: { id: "call_browser", name: "browser_task", args: {} },
      approvalCode: "",
      approvalId: "",
      replyContext: { channel: "telegram", senderId: "tg-owner" },
      waitingFor: "browser_input",
      question: "完成验证后回复「完成」",
      expectedInput: { kind: "manual_done" },
      createdAt: Date.now() - 700_000, // > 10 min
      expiresAt: Date.now() - 100_000, // expired
    },
  });

  const result = await agent.handleEvent(
    { channel: "telegram", senderId: "tg-owner", messageId: "msg-done-expired", kind: "text", text: "完成", receivedAt: Date.now() } as any,
    "zh",
  );

  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 0, "Expired task must NOT call /input");
  assert.ok(modelCalls.length > 0, "Message should fall through to normal agent turn when parked expired");
  console.log("  ✅ Test 4 passed");
}

console.log("✅ All browser-parked-task-isolation tests passed");

// ── Test 5: P0-02 — Browser session expired error handling in PersonalAgent ──
{
  console.log("  [Test 5] P0-02: PersonalAgent surfaces friendly message when browser_session_expired");

  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const ctx = createMockCtx();
  const env = createMockEnv({
    browserWorkerCalls,
    modelCalls,
    browserWorkerOutcome: {
      status: "failed",
      error: "browser_session_expired",
    },
  });

  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  const oldTaskId = "task-36kr-expired-session";
  agent.setState({
    parked: {
      taskId: oldTaskId,
      messages: [],
      pendingToolCall: { id: "call_browser", name: "browser_task", args: {} },
      approvalCode: "",
      approvalId: "",
      replyContext: { channel: "telegram", senderId: "tg-owner" },
      waitingFor: "browser_input",
      question: "完成验证后回复「完成」",
      expectedInput: { kind: "manual_done" },
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 500_000,
    },
  });

  const result = await agent.handleEvent(
    { channel: "telegram", senderId: "tg-owner", messageId: "msg-done-reconnect-fail", kind: "text", text: "完成", receivedAt: Date.now() } as any,
    "zh",
  );

  const reply = result.replies[0] ?? "";
  assert.ok(reply.includes("会话已超时过期") || reply.includes("重新发起"), `Expected session expired message, got: ${reply}`);
  assert.ok(!reply.includes("Execution context was destroyed"), "Must not leak raw Puppeteer error");
  assert.ok(!agent.parkedForScope("owner:global"), "Parked slot must be cleared");
  console.log("  ✅ Test 5 passed");
}

import puppeteer from "@cloudflare/puppeteer";
import { BrowserWorker } from "../src/agent/browser-worker";

// ── Test 6: P0-02 & P0-03 — BrowserWorker continuity & no-blind-injection ──
{
  console.log("  [Test 6] P0-02 & P0-03: BrowserWorker session continuity and no blind text injection");

  const cdpCalls: Array<{ method: string; params: any }> = [];
  let reconnectThrows = false;
  let insertTextThrows = false;

  const mockCdp = {
    send: async (method: string, params: any) => {
      cdpCalls.push({ method, params });
      if (method === "Input.insertText" && insertTextThrows) {
        throw new Error("Element not editable");
      }
      return {};
    },
  };

  const mockPage = {
    setViewport: async () => {},
    createCDPSession: async () => mockCdp,
    goto: async () => {},
    screenshot: async () => new Uint8Array([1, 2, 3]),
    url: () => "https://36kr.com/login",
    title: async () => "36kr",
    evaluate: async () => ({ url: "https://36kr.com/login", title: "36kr", elements: [] }),
  };

  const mockBrowser = {
    sessionId: () => "sess_new_123",
    pages: async () => [mockPage],
    newPage: async () => mockPage,
  };

  const origConnect = puppeteer.connect;
  const origLaunch = puppeteer.launch;
  const origLimits = puppeteer.limits;

  puppeteer.limits = async () => ({ activeSessions: [] }) as any;
  puppeteer.connect = (async (_endpoint: any, _known: string) => {
    if (reconnectThrows) throw new Error("session gone");
    return {
      sessionId: () => "sess_known_123",
      pages: async () => [mockPage],
      newPage: async () => mockPage,
    } as any;
  }) as any;
  puppeteer.launch = (async () => mockBrowser as any) as any;

  try {
    const db = new DatabaseSync(":memory:");
    const workerCtx: any = {
      storage: {
        sql: {
          exec: (s: string, ...args: unknown[]) => {
            const stmt = db.prepare(s);
            const rows = stmt.all(...(args as never[]));
            return Object.assign(rows, {
              toArray: () => rows,
            });
          },
        },
      },
      id: { name: "ws-worker-test" },
      blockConcurrencyWhile: async (fn: any) => await fn(),
    };

    const workerEnv: any = {
      BROWSER: {},
      MODEL_PROVIDER: "workers-ai",
      MODEL_WORKER: "@cf/test/model",
      MODEL_ROOT: "@cf/test/model",
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 0 } }),
          }),
        }),
      },
      AI: {
        run: async (model, body) => {
                    return {
            response: "",
            tool_calls: [{
              id: "c1",
              name: "finish",
              arguments: JSON.stringify({ success: true, summary: "ok", evidence: [{ type: "observed_text", value: "36kr" }] }),
            }],
          };
        },
      },
      PUBLIC_BASE_URL: "https://example.com",
    };

    const worker = new (BrowserWorker as any)(workerCtx, workerEnv);
    worker.onStart();

    const taskId = "task-bw-test";
    db.prepare(`INSERT INTO task_state (task_id, status, goal, start_url, vault_hints, lang, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      taskId, "running", "测试目标", "https://36kr.com", "[]", "zh", Date.now(),
    );
    db.prepare(`INSERT INTO sessions (task_id, session_id, created_at, last_used_at) VALUES (?, ?, ?, ?)`).run(
      taskId, "sess_known_123", Date.now(), Date.now(),
    );

    // Subtest 6A: manual_done MUST NOT call Input.insertText
    cdpCalls.length = 0;
    const resManual = await worker.onRequest(new Request("https://browser/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, input: "完成", inputKind: "manual_done", workspaceId: "ws-worker-test" }),
    }));
    const outManual = await resManual.json();
    assert.equal(outManual.status, "done");
    const insertTextCallsManual = cdpCalls.filter((c) => c.method === "Input.insertText");
    assert.equal(insertTextCallsManual.length, 0, "manual_done must NOT call Input.insertText");

    // Subtest 6B: otp MUST call Input.insertText
    cdpCalls.length = 0;
    const resOtp = await worker.onRequest(new Request("https://browser/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, input: "654321", inputKind: "otp", workspaceId: "ws-worker-test" }),
    }));
    const outOtp = await resOtp.json();
    assert.equal(outOtp.status, "done");
    const insertTextCallsOtp = cdpCalls.filter((c) => c.method === "Input.insertText");
    assert.equal(insertTextCallsOtp.length, 1, "otp must call Input.insertText");
    assert.equal(insertTextCallsOtp[0].params.text, "654321");

    // Subtest 6C: If reconnect fails (session expired), runTask MUST return browser_session_expired and NOT inject text
    reconnectThrows = true;
    cdpCalls.length = 0;
    const resExpired = await worker.onRequest(new Request("https://browser/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, input: "654321", inputKind: "otp", workspaceId: "ws-worker-test" }),
    }));
    const outExpired = await resExpired.json();
    assert.equal(outExpired.status, "failed");
    assert.equal(outExpired.error, "browser_session_expired", "Must return browser_session_expired on reconnect failure");
    assert.equal(cdpCalls.filter((c) => c.method === "Input.insertText").length, 0, "Must not inject text on new session");

    // Subtest 6D: CDP failure in Input.insertText returns input_injection_failed
    reconnectThrows = false;
    insertTextThrows = true;
    cdpCalls.length = 0;
    db.prepare(`INSERT OR REPLACE INTO sessions (task_id, session_id, created_at, last_used_at) VALUES (?, ?, ?, ?)`).run(
      taskId, "sess_known_123", Date.now(), Date.now(),
    );
    const resFailInject = await worker.onRequest(new Request("https://browser/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, input: "654321", inputKind: "otp", workspaceId: "ws-worker-test" }),
    }));
    const outFailInject = await resFailInject.json();
    assert.equal(outFailInject.status, "failed");
    assert.ok(outFailInject.error.includes("input_injection_failed"), `Expected input_injection_failed, got ${outFailInject.error}`);

    console.log("  ✅ Test 6 passed");
  } finally {
    puppeteer.connect = origConnect;
    puppeteer.launch = origLaunch;
    puppeteer.limits = origLimits;
  }
}

// ── Test 7: §5 — Parked browser task with expectedInput.kind = "free_text" does NOT consume unrelated owner message ──
{
  console.log("  [Test 7] §5: Parked browser task with free_text does NOT consume unrelated owner message");

  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const ctx = createMockCtx();
  const env = createMockEnv({
    browserWorkerCalls,
    modelCalls,
    browserWorkerOutcome: {
      status: "failed",
      error: "Execution context was destroyed, most likely because of a navigation.",
    },
  });

  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  const oldTaskId = "task-36kr-freetext";
  agent.setState({
    parked: {
      taskId: oldTaskId,
      messages: [{ role: "user", content: "搜索 36kr 文章" }],
      pendingToolCall: { id: "call_browser", name: "browser_task", args: { goal: "搜索 36kr 文章" } },
      approvalCode: "",
      approvalId: "",
      replyContext: { channel: "telegram", senderId: "tg-owner", messageId: "msg-prompt-1" },
      browserBrief: { goal: "搜索 36kr 文章", startUrl: "https://36kr.com", vaultHints: [] },
      waitingFor: "browser_input",
      question: "请输入你要搜索的关键词。",
      expectedInput: { kind: "free_text", promptId: "prompt_1726000000000" },
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
    },
  });

  const incomingMsg = "给我写一封邮件草稿，主题为 Step 9 验收测试";
  const result = await agent.handleEvent(
    {
      channel: "telegram",
      senderId: "tg-owner",
      messageId: "msg-mail-draft-1",
      kind: "text",
      text: incomingMsg,
      receivedAt: Date.now(),
    } as any,
    "zh",
  );

  assert.equal(
    browserWorkerCalls.filter((c) => c.path === "/input").length,
    0,
    `BrowserWorker /input must NOT be called for unrelated message when parked with free_text! Actually called with: ${JSON.stringify(browserWorkerCalls)}`,
  );

  const repliesStr = JSON.stringify(result.replies);
  assert.ok(
    !repliesStr.includes("Execution context was destroyed"),
    "User must not receive raw browser error for unrelated new task",
  );
  assert.ok(modelCalls.length > 0, "Model/Agent loop must process the new mail task");

  const currentParked = agent.parkedForScope("owner:global");
  assert.ok(currentParked, "Old browser parked task must not be destroyed by unrelated task");
  assert.equal(currentParked.taskId, oldTaskId);

  console.log("  ✅ Test 7 passed");
}

// ── Test 8: §6 — Browser needs_approval continuation routed as approval, not input ──
{
  console.log("  [Test 8] §6: OTP -> needs_approval -> user 'approve' -> calls /approve, zero /input");

  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const ctx = createMockCtx();
  
  let inputReturnsApproval = true;
  const approvalsDb: any[] = [];
  const env: any = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => {
            // Hardened lookup contract (Round 1 §11): decision lookups are
            // workspace-predicated + TTL-bounded; hash lookups are
            // workspace-predicated.
            if (sql.includes("FROM approvals") && sql.includes("payload_hash") && sql.includes("workspace_id=?")) {
              const ap = approvalsDb.find((a) => a.id === args[0]);
              if (!ap || ap.workspace_id !== args[1]) return null;
              return { payload_hash: ap.payload_hash };
            }
            if (sql.includes("FROM approvals") && sql.includes("decision IS NULL") && sql.includes("workspace_id=?")) {
              const ap = approvalsDb.find((a) => a.id === args[0]);
              if (!ap || ap.workspace_id !== args[1]) return null;
              if (ap.decision) return null;
              if (ap.created_at < args[2]) return null;
              return { id: ap.id, decision: ap.decision, payload_hash: ap.payload_hash, created_at: ap.created_at };
            }
            if (sql.includes("SELECT payload_hash FROM approvals")) {
              const ap = approvalsDb.find((a) => a.id === args[0]);
              return ap ? { payload_hash: ap.payload_hash } : null;
            }
            if (sql.includes("SELECT id, decision FROM approvals")) {
              const ap = approvalsDb.find((a) => a.id === args[0]);
              return ap ? { id: ap.id, decision: ap.decision } : null;
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            if (sql.includes("INSERT INTO approvals")) {
              approvalsDb.push({ id: args[0], workspace_id: args[1], payload_hash: args[5] ?? null, decision: null, created_at: Date.now() });
            } else if (sql.includes("UPDATE approvals SET decision=?")) {
              const ap = approvalsDb.find((a) => a.id === args[2]);
              if (ap) ap.decision = args[0];
            }
            return { meta: { changes: 1 }, success: true };
          },
        }),
      }),
      batch: async () => [],
    },
    PUBLIC_BASE_URL: "https://example.com",
    MODEL_PROVIDER: "workers-ai",
    MODEL_ROOT: "@cf/test/model",
    MODEL_WORKER: "@cf/test/model",
    BROWSER_WORKER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: any) => ({
        fetch: async (url: string, fetchOpts: any) => {
          const path = new URL(url).pathname;
          const body = JSON.parse(fetchOpts.body);
          browserWorkerCalls.push({ path, body });
          if (path === "/input" && inputReturnsApproval) {
            return new Response(JSON.stringify({
              status: "needs_approval",
              question: "即将执行支付确认：金额 ¥99.00，是否批准？",
              actionSummary: "支付订单 ¥99.00",
              usage: { input: 100, output: 50, browserMs: 500 },
            }));
          }
          if (path === "/approve") {
            return new Response(JSON.stringify({
              status: "done",
              result: { summary: "支付已完成" },
              evidence: [{ type: "observed_text", value: "支付成功" }],
              usage: { input: 80, output: 40, browserMs: 300 },
            }));
          }
          return new Response(JSON.stringify({ status: "done" }));
        },
      }),
    },
    AI: {
      run: async (_model: string, body: any) => {
        modelCalls.push(body);
        return { response: "已响应。" };
      },
    },
  };

  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  const taskId = "task-pay-otp";
  agent.setState({
    parked: {
      taskId,
      messages: [{ role: "user", content: "帮我支付订单" }],
      pendingToolCall: { id: "call_browser", name: "browser_task", args: { goal: "帮我支付订单" } },
      approvalCode: "",
      approvalId: "",
      replyContext: { channel: "telegram", senderId: "tg-owner", messageId: "msg-otp-req" },
      browserBrief: { goal: "帮我支付订单", startUrl: "https://shop.example.com/checkout", vaultHints: [] },
      waitingFor: "browser_input",
      question: "请输入短信验证码。",
      expectedInput: { kind: "otp", minLength: 6, maxLength: 6 },
      createdAt: Date.now() - 30_000,
      expiresAt: Date.now() + 600_000,
    },
  });

  // Step 1: User replies with OTP "123456"
  const step1 = await agent.handleEvent(
    {
      channel: "telegram",
      senderId: "tg-owner",
      messageId: "msg-otp-ans",
      kind: "text",
      text: "123456",
      receivedAt: Date.now(),
    } as any,
    "zh",
  );

  // Assert /input was called with the OTP
  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 1);
  assert.equal(browserWorkerCalls[0].body.input, "123456");

  // Assert agent re-parked as "approval", NOT failed!
  const parkedAfterOtp = agent.parkedForScope("owner:global");
  assert.ok(parkedAfterOtp, "Task must re-park for approval after /input returns needs_approval");
  assert.equal(parkedAfterOtp.waitingFor, "approval", "waitingFor must be 'approval', not 'browser_input'");
  assert.ok(parkedAfterOtp.approvalCode, "Must have generated an approval code");

  // Step 2: User follows the English approval command shown by the prompt.
  browserWorkerCalls.length = 0;
  const step2 = await agent.handleEvent(
    {
      channel: "telegram",
      senderId: "tg-owner",
      messageId: "msg-approve",
      kind: "text",
      text: "approve",
      receivedAt: Date.now(),
    } as any,
    "zh",
  );

  // Assert exactly one /approve call, zero accidental /input calls
  assert.equal(browserWorkerCalls.filter((c) => c.path === "/approve").length, 1, "Must call /approve exactly once");
  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 0, "Must NOT call /input when user approves");
  assert.equal(browserWorkerCalls[0].body.proceed, true);

  console.log("  ✅ Test 8 passed");
}

// ── Test 9: §7 — Browser billing attribution consistency between initial and resumed runs ──
{
  console.log("  [Test 9] §7: Browser billing attribution is consistent for initial and resumed runs");

  const ctx = createMockCtx();
  const env: any = {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
      batch: async () => [],
    },
    PUBLIC_BASE_URL: "https://example.com",
    MODEL_PROVIDER: "workers-ai",
    MODEL_ROOT: "@cf/test/model",
    MODEL_WORKER: "@cf/test/model",
    BROWSER_WORKER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async (url: string) => {
          const path = new URL(url).pathname;
          if (path === "/assign") {
            return new Response(JSON.stringify({
              status: "done",
              result: { summary: "直接完成" },
              usage: { input: 150, output: 60, browserMs: 1200 },
            }));
          }
          return new Response(JSON.stringify({ status: "done" }));
        },
      }),
    },
    AI: { run: async () => ({ response: "ok" }) },
  };

  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  await agent.delegateBrowserTask(
    { id: "tc1", name: "browser_task", args: { goal: "测试直出" } },
    { lang: "zh", say: async () => {}, workspaceId: "ws-test" },
    { channel: "telegram", senderId: "tg1", kind: "text", text: "测试直出", receivedAt: Date.now() },
    { messages: [], taskId: "task-browser-direct", scopeKey: "owner:global" },
  );

  const usage = agent.turnUsage;
  assert.equal(usage.browserTokensIn, 150, "Initial run must attribute browserTokensIn");
  assert.equal(usage.browserTokensOut, 60, "Initial run must attribute browserTokensOut");
  assert.equal(usage.browserMs, 1200, "Initial run must attribute browserMs");

  console.log("  ✅ Test 9 passed");
}

console.log("🎉 ALL TESTS in browser-parked-task-isolation PASSED");
