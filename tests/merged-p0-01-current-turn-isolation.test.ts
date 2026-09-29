



import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent } from "../src/agent/personal-agent";
import { systemPrompt } from "../src/agent/instructions";

console.log("▶ P0-01 current-turn isolation (merged audit §3)");

function createMockCtx(workspaceId = "ws-p001") {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    ctx: {
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
    } as any,
  };
}

function createMockEnv(opts: { browserWorkerCalls: Array<{ path: string; body: any }>; modelCalls: any[] }) {
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
          opts.browserWorkerCalls.push({ path, body: JSON.parse(fetchOpts.body) });
          return new Response(JSON.stringify({ status: "done", result: { summary: "ok" } }));
        },
      }),
    },
    AI: {
      run: async (_model: string, body: any) => {
        opts.modelCalls.push(body);
        return { response: "已处理新任务。" };
      },
    },
  } as any;
}


{
  console.log("  [Test 1] dirty 36kr pending + new draft = 0 old browser calls");
  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const { ctx } = createMockCtx();
  const env = createMockEnv({ browserWorkerCalls, modelCalls });
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  const oldTaskId = "task-36kr-dirty";
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
  agent.sql`INSERT INTO pending_tasks (id, task_id, channel, external_id, context_token, kind, goal_summary, wait_reason, provider, original_message, revision, status, follow_up_at, follow_up_count, created_at, updated_at)
    VALUES ('pt-old', ${oldTaskId}, 'telegram', 'tg-owner', NULL, 'browser_input', '登录 36kr', '等待用户输入', NULL, NULL, 0, 'pending', 9999999999999, 0, 1, 1)`;

  const result = await agent.handleEvent(
    { channel: "telegram", senderId: "tg-owner", messageId: "msg-new-draft", kind: "text", text: "给 test@example.com 写一封测试草稿，不要发送", receivedAt: Date.now() } as any,
    "zh",
  );

  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 0, "旧 Browser /input 必须为 0");
  assert.ok(modelCalls.length > 0, "新草稿任务必须进模型循环");
  const still = agent.parkedForScope("owner:global");
  assert.ok(still && still.taskId === oldTaskId, "旧 pending 保留但未推进");
  const suppressed = (agent as any).suppressedPendingTaskIds as string[] | undefined;
  assert.ok(Array.isArray(suppressed) && suppressed.includes(oldTaskId), "suppressedPendingTaskIds 必须记录旧 task");
  const prompt = await agent.buildSystemPrompt("zh", "telegram", "", "owner:global", null);
  assert.ok(!prompt.includes("登录 36kr"), "本轮 prompt 不得再拼接被抑制的旧 parked 待办");
  assert.ok(result.replies.length >= 0);
  console.log("  ✅ Test 1 passed");
}


{
  console.log("  [Test 2] explicit waiting-contract reply restores old parked job");
  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const { ctx } = createMockCtx();
  const env = createMockEnv({ browserWorkerCalls, modelCalls });
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();

  const oldTaskId = "task-36kr-resume";
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
  await agent.handleEvent(
    { channel: "telegram", senderId: "tg-owner", messageId: "msg-resume", kind: "text", text: "完成", receivedAt: Date.now() } as any,
    "zh",
  );
  assert.equal(browserWorkerCalls.filter((c) => c.path === "/input").length, 1, "满足等待合同时必须恢复旧任务");
  console.log("  ✅ Test 2 passed");
}


{
  console.log("  [Test 3] prompts preserve semantic continuity while prioritizing the current message");
  const zh = systemPrompt({ lang: "zh", workspaceId: "w", channel: "telegram", memoryBlock: "", personalInfoBlock: "", connectorsBlock: "", vaultBlock: "", locationBlock: "", pendingTasksBlock: "· 待办目标: 旧任务 (当前等待: 等待)", nowIso: new Date().toISOString() });
  assert.ok(zh.includes("当前消息优先"), "中文 prompt 必须明确当前消息优先");
  assert.ok(zh.includes("语义上明显"), "中文 prompt 必须允许语义连续承接，而不是要求机械关键词");
  assert.ok(zh.includes("自然承接"), "中文 pending 应允许智能恢复上下文");
  const en = systemPrompt({ lang: "en", workspaceId: "w", channel: "telegram", memoryBlock: "", personalInfoBlock: "", connectorsBlock: "", vaultBlock: "", locationBlock: "", pendingTasksBlock: "old", nowIso: new Date().toISOString() });
  assert.ok(en.includes("Current message first"), "英文 prompt 必须明确 current message first");
  assert.ok(en.includes("semantically"), "英文 prompt 必须允许 semantic continuation");
  assert.ok(en.includes("pick it up naturally"), "英文 pending 应允许智能恢复上下文");
  console.log("  ✅ Test 3 passed");
}


{
  console.log("  [Test 4] new browser_task on same site is not blocked");
  const browserWorkerCalls: Array<{ path: string; body: any }> = [];
  const modelCalls: any[] = [];
  const { ctx } = createMockCtx();
  const env = createMockEnv({ browserWorkerCalls, modelCalls });
  const agent = new (PersonalAgent as any)(ctx, env);
  agent.onStart();
  agent.setState({
    parked: {
      taskId: "task-old-site",
      messages: [],
      pendingToolCall: { id: "c1", name: "browser_task", args: { goal: "old", startUrl: "https://36kr.com" } },
      approvalCode: "",
      approvalId: "",
      replyContext: { channel: "telegram", senderId: "tg-owner" },
      browserBrief: { goal: "old", startUrl: "https://36kr.com", vaultHints: [] },
      waitingFor: "browser_input",
      expectedInput: { kind: "manual_done" },
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 500_000,
    },
  });
  const guard = (agent as any).browserOwnershipGuarded("task-new-same-site");
  assert.equal(guard.blocked, false, "不得仅因同站点阻止新任务");
  console.log("  ✅ Test 4 passed");
}

console.log("✅ merged-p0-01-current-turn-isolation tests passed");