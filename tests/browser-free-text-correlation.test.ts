import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent } from "../src/agent/personal-agent";

console.log("▶ Running browser free-text correlation regression tests");

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
    id: { name: "ws-free-text-correlation" },
  };
}

function createMockEnv(browserWorkerCalls: Array<{ path: string; body: any }>, modelCalls: any[]) {
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
      get: () => ({
        fetch: async (url: string, fetchOpts: any) => {
          const path = new URL(url).pathname;
          const body = JSON.parse(fetchOpts.body);
          browserWorkerCalls.push({ path, body });
          if (path === "/input") {
            return new Response(JSON.stringify({ status: "done", result: { summary: "resumed" } }));
          }
          return new Response(JSON.stringify({ status: "done" }));
        },
      }),
    },
    AI: {
      run: async (_model: string, body: any) => {
        modelCalls.push(body);
        return { response: "handled as a new task" };
      },
    },
  };
}

function parkFreeText(agent: any, token = "T1234") {
  agent.setState({
    parked: {
      taskId: "task-free-text-old",
      messages: [{ role: "user", content: "搜索 36kr 文章" }],
      pendingToolCall: { id: "call_browser", name: "browser_task", args: { goal: "搜索 36kr 文章" } },
      approvalCode: "",
      approvalId: "",
      replyContext: {
        channel: "telegram",
        senderId: "tg-owner",
        messageId: "original-user-message",
        contextToken: "shared-channel-context",
      },
      browserBrief: { goal: "搜索 36kr 文章", startUrl: "https://36kr.com", vaultHints: [] },
      waitingFor: "browser_input",
      question: "请输入搜索关键词",
      expectedInput: { kind: "free_text", promptId: "prompt_long_identifier", resumeToken: token },
      createdAt: Date.now() - 30_000,
      expiresAt: Date.now() + 600_000,
    },
  });
}

// Wrong token + same channel context must NOT resume the parked browser task.
{
  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const agent = new (PersonalAgent as any)(createMockCtx(), createMockEnv(browserWorkerCalls, modelCalls));
  agent.onStart();
  parkFreeText(agent);

  await agent.handleEvent({
    channel: "telegram",
    senderId: "tg-owner",
    messageId: "new-message-1",
    contextToken: "shared-channel-context",
    replyToMessageId: "original-user-message",
    kind: "text",
    text: "#T9999 给我写一封邮件草稿",
    receivedAt: Date.now(),
  } as any, "zh");

  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 0,
    "wrong token must not resume even when contextToken/replyTo happen to match");
  assert.ok(modelCalls.length > 0, "wrong-token message must fall through to the normal Agent loop");
  assert.equal(agent.parkedForScope("owner:global")?.taskId, "task-free-text-old",
    "old parked task must remain intact after unrelated input");
}

// Correct token MUST resume and the token prefix must not be injected into the page.
{
  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const agent = new (PersonalAgent as any)(createMockCtx(), createMockEnv(browserWorkerCalls, modelCalls));
  agent.onStart();
  parkFreeText(agent);

  await agent.handleEvent({
    channel: "telegram",
    senderId: "tg-owner",
    messageId: "new-message-2",
    contextToken: "another-context",
    kind: "text",
    text: "#T1234 人工智能",
    receivedAt: Date.now(),
  } as any, "zh");

  const inputCalls = browserWorkerCalls.filter((c) => c.path === "/input");
  assert.equal(inputCalls.length, 1, "correct token must resume exactly once");
  assert.equal(inputCalls[0].body.input, "人工智能", "resume token must be stripped before BrowserWorker input");
  assert.equal(modelCalls.length, 0, "correctly correlated reply must not start a separate root-model task");
}

// Bare free text MUST NOT resume, even if reply/context metadata matches legacy parked metadata.
{
  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const agent = new (PersonalAgent as any)(createMockCtx(), createMockEnv(browserWorkerCalls, modelCalls));
  agent.onStart();
  parkFreeText(agent);

  await agent.handleEvent({
    channel: "telegram",
    senderId: "tg-owner",
    messageId: "new-message-3",
    contextToken: "shared-channel-context",
    replyToMessageId: "original-user-message",
    kind: "text",
    text: "新的完全无关任务",
    receivedAt: Date.now(),
  } as any, "zh");

  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 0,
    "free text without the bound resume token must never be consumed by an older parked browser task");
  assert.ok(modelCalls.length > 0);
}

console.log("✅ browser free-text correlation regression tests passed");
