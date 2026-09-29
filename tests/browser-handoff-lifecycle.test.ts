// tests/browser-handoff-lifecycle.test.ts
// A turn parked on a human in the cloud browser must always end well:
//  - "done" in chat (or Done on the browser page) takes control back and
//    resumes on the page the human left, without typing the reply into it
//  - control that cannot be taken back is never overridden
//  - a user taking over mid-task is a pause, not a failure
//  - an undeliverable, expired or cancelled handoff closes the cloud browser
//    instead of leaving it parked in handoff_requested
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersonalAgent } from "../src/agent/personal-agent";
import { setHostHooks, resetHostHooks } from "../src/hooks";

console.log("▶ Browser handoff lifecycle");

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
    id: { name: "ws-lifecycle" },
  };
}

type WorkerCall = { method: string; path: string; body: any };

function createHarness(opts: {
  session?: Record<string, unknown> | null;
  responses?: Record<string, { status?: number; body: any }>;
}) {
  const calls: WorkerCall[] = [];
  const sent: Array<{ channel: string; text: string; options?: any }> = [];
  const noRows = () => ({
    bind: (..._args: unknown[]) => ({
      first: async () => null,
      all: async () => ({ results: [] as unknown[] }),
      run: async () => ({ meta: { changes: 0 }, success: true }),
    }),
  });
  const env: any = {
    DB: { prepare: noRows, batch: async () => [] },
    PUBLIC_BASE_URL: "https://openinst.test",
    MODEL_PROVIDER: "workers-ai",
    MODEL_ROOT: "@cf/test/model",
    MODEL_WORKER: "@cf/test/model",
    AI: { run: async () => ({ response: "ok" }) },
    BROWSER_WORKER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async (url: string, init: any) => {
          const path = new URL(url).pathname;
          const method = init?.method ?? "GET";
          calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
          if (method === "GET" && path.startsWith("/session/")) {
            return opts.session ? Response.json(opts.session) : new Response("session_not_found", { status: 404 });
          }
          const r = opts.responses?.[path];
          if (r) return Response.json(r.body, { status: r.status ?? 200 });
          return Response.json({ success: true, controlEpoch: 5 });
        },
      }),
    },
  };
  setHostHooks({
    sendOutbound: async (_env: unknown, channel: string, _externalId: string, text: string, _ct?: string, options?: unknown) => {
      sent.push({ channel, text, options });
      return { handled: true, ok: true };
    },
  } as any);
  const agent = new (PersonalAgent as any)(createMockCtx(), env);
  agent.onStart();
  return { agent, env, calls, sent };
}

function parkHandoff(agent: any, taskId: string, extra: Record<string, unknown> = {}) {
  agent.setState({
    parked: {
      taskId,
      messages: [{ role: "user", content: "登录 example" }],
      pendingToolCall: { id: "call_browser", name: "browser_task", args: { goal: "登录 example" } },
      approvalCode: "",
      approvalId: "",
      replyContext: { channel: "telegram", senderId: "tg-owner" },
      browserBrief: { goal: "登录 example", startUrl: "https://example.com", vaultHints: [] },
      waitingFor: "browser_handoff",
      question: "请完成验证码",
      handoff: { reasonCode: "captcha", instructions: "请完成验证码", privacyMode: "normal", preferredView: "tab" },
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
      lang: "zh",
      ...extra,
    },
  });
}

const doneEvent = (text = "完成") => ({
  channel: "telegram",
  senderId: "tg-owner",
  messageId: `msg-${Math.random()}`,
  kind: "text",
  text,
  receivedAt: Date.now(),
}) as any;

const session = (state: string, extra: Record<string, unknown> = {}) => ({
  taskId: "t", sessionId: "sess_1", targetId: "TARGET_1", url: "https://example.com/login", title: "Login",
  state, controlEpoch: 2, goalRevision: 0, controlLease: { heldBy: null, expiresAt: null, held: false }, ...extra,
});

try {
  {
    console.log("  [1] \"完成\" in chat takes control back, then resumes on the page without typing the reply");
    const { agent, calls } = createHarness({
      session: session("handoff_requested"),
      responses: { "/input": { body: { status: "done", result: { summary: "已登录" } } } },
    });
    parkHandoff(agent, "task_resume");
    const result = await agent.handleEvent(doneEvent("我做完了"), "zh");
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.path);
    assert.deepEqual(posts, ["/done", "/input"], "control is returned before the agent resumes");
    const input = calls.find((c) => c.path === "/input")!;
    assert.equal(input.body.inputKind, "manual_done", "the reply is never typed into the page");
    assert.ok(JSON.stringify(result.replies).includes("已登录"));
    assert.equal(agent.parkedForScope("owner:global"), undefined);
  }

  {
    console.log("  [2] control that cannot be taken back is never overridden");
    const { agent, calls } = createHarness({
      session: session("user_active"),
      responses: { "/done": { status: 502, body: { success: false, error: "revoke_unconfirmed" } } },
    });
    parkHandoff(agent, "task_held");
    const result = await agent.handleEvent(doneEvent(), "zh");
    assert.equal(calls.filter((c) => c.path === "/input").length, 0);
    assert.ok(JSON.stringify(result.replies).includes("交还 Agent"));
    assert.equal(agent.parkedForScope("owner:global")?.taskId, "task_held", "still waiting for the human");
  }

  {
    console.log("  [3] the user taking over mid-task parks the turn instead of failing it");
    const { agent, sent } = createHarness({
      session: session("user_active"),
      responses: { "/input": { body: { status: "failed", error: "stale_control_epoch", staleControlEpoch: true } } },
    });
    parkHandoff(agent, "task_takeover");
    // The first "done" returns control, then the human grabs it again.
    let sessionCalls = 0;
    const origGet = agent.env.BROWSER_WORKER.get;
    agent.env.BROWSER_WORKER.get = () => {
      const stub = origGet();
      return {
        fetch: async (url: string, init: any) => {
          if (new URL(url).pathname.startsWith("/session/")) {
            sessionCalls++;
            return Response.json(session(sessionCalls === 1 ? "completing" : "user_active"));
          }
          return stub.fetch(url, init);
        },
      };
    };
    const result = await agent.handleEvent(doneEvent(), "zh");
    assert.ok(!JSON.stringify(result.replies).includes("任务失败"), "not reported as a failure");
    const parked = agent.parkedForScope("owner:global");
    assert.equal(parked?.waitingFor, "browser_handoff");
    assert.equal(parked?.taskId, "task_takeover");
    assert.ok(sent.some((m) => m.text.includes("你已接管云浏览器")), "the user is told the agent paused");
  }

  {
    console.log("  [4] an undeliverable handoff closes the cloud browser and tells the user what to do");
    const { agent, calls, sent } = createHarness({ session: null });
    const ok = await agent.handoffToUser({
      base: {
        taskId: "task_undeliverable",
        messages: [],
        pendingToolCall: { id: "c", name: "browser_task", args: {} },
        replyContext: { channel: "telegram", senderId: "tg-owner" },
        browserBrief: { goal: "g", startUrl: "https://example.com", vaultHints: [] },
        lang: "zh",
      },
      scopeKey: "owner:global",
      out: { status: "needs_handoff", workerSessionId: "sess_1", handoff: { reasonCode: "captcha", instructions: "请完成验证码", privacyMode: "normal", preferredView: "tab" } },
    });
    assert.equal(ok, false);
    const cancel = calls.find((c) => c.path === "/cancel");
    assert.ok(cancel, "the stranded session is released");
    assert.equal(cancel.body.workspaceId, "ws-lifecycle");
    assert.match(cancel.body.reason, /handoff_undeliverable/);
    assert.ok(sent.some((m) => m.text.includes("云浏览器会话已经断开")));
    assert.equal(agent.parkedForScope("owner:global"), undefined, "nothing is left parked");
  }

  {
    console.log("  [5] an expired handoff closes the browser and notifies the user; an active human gets more time");
    const expired = createHarness({ session: session("handoff_requested") });
    parkHandoff(expired.agent, "task_expired", { expiresAt: Date.now() - 1000 });
    await expired.agent.expireBrowserHandoff("task_expired");
    assert.ok(expired.calls.some((c) => c.path === "/cancel" && c.body.reason === "handoff_expired"));
    assert.equal(expired.agent.parkedForScope("owner:global"), undefined);
    assert.ok(expired.sent.some((m) => m.text.includes("超时")));

    const busy = createHarness({ session: session("user_active", { controlLease: { heldBy: "phone", expiresAt: Date.now() + 60_000, held: true } }) });
    busy.agent.scheduleAtMs = async () => ({});
    parkHandoff(busy.agent, "task_busy", { expiresAt: Date.now() - 1000 });
    await busy.agent.expireBrowserHandoff("task_busy");
    assert.equal(busy.calls.filter((c) => c.path === "/cancel").length, 0);
    assert.ok(busy.agent.parkedForScope("owner:global").expiresAt > Date.now(), "extended while the human drives");

    const stale = createHarness({ session: session("handoff_requested") });
    parkHandoff(stale.agent, "task_other");
    await stale.agent.expireBrowserHandoff("task_expired");
    assert.equal(stale.calls.length, 0, "a watchdog for another task is a no-op");
  }

  {
    console.log("  [6] Done on the browser page resumes the task and delivers the result");
    const { agent, calls, sent } = createHarness({
      session: session("completing"),
      responses: { "/input": { body: { status: "done", result: { summary: "已提交表单" } } } },
    });
    parkHandoff(agent, "task_viewer_done");
    const scheduled: unknown[] = [];
    agent.scheduleAtMs = async (...args: unknown[]) => { scheduled.push(args); return {}; };
    const res = await agent.onRequest(new Request("https://agent/browser/handoff-done", {
      method: "POST",
      body: JSON.stringify({ taskId: "task_viewer_done" }),
    }));
    assert.deepEqual(await res.json(), { ok: true, resumed: true });
    assert.equal((scheduled[0] as any[])[1], "resumeBrowserAfterViewerDone");

    await agent.resumeBrowserAfterViewerDone("task_viewer_done");
    assert.equal(calls.filter((c) => c.path === "/done").length, 0, "already handed back by the page");
    assert.equal(calls.find((c) => c.path === "/input")?.body.inputKind, "manual_done");
    assert.ok(sent.some((m) => m.text.includes("已提交表单")), "result reaches the chat without typing done");

    const other = await agent.onRequest(new Request("https://agent/browser/handoff-done", {
      method: "POST",
      body: JSON.stringify({ taskId: "task_viewer_done" }),
    }));
    assert.deepEqual(await other.json(), { ok: true, resumed: false }, "a second press does nothing");
  }

  {
    console.log("  [7] cancelling a task closes its cloud browser");
    const { agent, calls } = createHarness({ session: session("handoff_requested") });
    parkHandoff(agent, "task_cancel");
    await agent.cancelTask("task_cancel");
    assert.ok(calls.some((c) => c.path === "/cancel" && c.body.taskId === "task_cancel"));
    assert.equal(agent.parkedForScope("owner:global"), undefined);
  }

  {
    console.log("  [8] starting a cloud browser posts a live watch/takeover card; a takeover mid-run pauses the task");
    const { agent, env, calls, sent } = createHarness({ session: session("agent_active") });
    env.BROWSER_LIVE_VIEW_ACCOUNT_ID = "acc";
    env.BROWSER_API_TOKEN = "tok";
    agent.scheduleAtMs = async () => ({});
    let releaseAssign!: () => void;
    const assignGate = new Promise<void>((r) => { releaseAssign = r; });
    const origGet = env.BROWSER_WORKER.get;
    let takenOver = false;
    env.BROWSER_WORKER.get = () => {
      const stub = origGet();
      return {
        fetch: async (url: string, init: any) => {
          const path = new URL(url).pathname;
          if (path === "/assign") {
            calls.push({ method: "POST", path, body: JSON.parse(init.body) });
            await assignGate;
            takenOver = true;
            return Response.json({ status: "failed", error: "stale_control_epoch", staleControlEpoch: true, workerSessionId: "sess_1" });
          }
          if (path.startsWith("/session/")) return Response.json(session(takenOver ? "user_active" : "agent_active"));
          return stub.fetch(url, init);
        },
      };
    };
    // Let the task "run" until the card is out, then the user takes over.
    const cardPosted = (async () => {
      for (let i = 0; i < 100 && !sent.some((m) => m.text.includes("🌐")); i++) await new Promise((r) => setTimeout(r, 20));
      releaseAssign();
    })();
    const tc = { id: "call_b", name: "browser_task", args: { goal: "查看订单", startUrl: "https://shop.example.com/orders" } };
    const ctx = { workspaceId: "ws-lifecycle", lang: "zh", say: async () => {} };
    const event = doneEvent("帮我查订单");
    const outcome = await agent.delegateBrowserTask(tc, ctx, event, { messages: [], taskId: "task_live" });
    await cardPosted;

    const card = sent.find((m) => m.text.includes("🌐"));
    assert.ok(card, "a live card is posted while the task runs");
    assert.ok(card.text.includes("https://openinst.test/b/"), "Telegram/WeChat text carries the link");
    assert.ok(card.text.includes("一键接管"));
    assert.match(card.options?.buttons?.[0]?.url ?? "", /^https:\/\/openinst\.test\/b\//, "Telegram gets a native button");
    assert.equal(outcome.parked, true, "a takeover is a pause, not a failure");
    assert.equal(agent.parkedForScope("owner:global")?.waitingFor, "browser_handoff");
    assert.ok(sent.some((m) => m.text.includes("你已接管云浏览器")));
  }

  {
    console.log("  [9] a task that finishes before its browser is up posts no card");
    const { agent, env, sent } = createHarness({ session: null });
    env.BROWSER_LIVE_VIEW_ACCOUNT_ID = "acc";
    env.BROWSER_API_TOKEN = "tok";
    const origGet = env.BROWSER_WORKER.get;
    env.BROWSER_WORKER.get = () => {
      const stub = origGet();
      return {
        fetch: async (url: string, init: any) => new URL(url).pathname === "/assign"
          ? Response.json({ status: "done", result: { summary: "ok" } })
          : stub.fetch(url, init),
      };
    };
    const outcome = await agent.delegateBrowserTask(
      { id: "c", name: "browser_task", args: { goal: "g", startUrl: "https://example.com" } },
      { workspaceId: "ws-lifecycle", lang: "zh", say: async () => {} },
      doneEvent("x"),
      { messages: [], taskId: "task_fast" },
    );
    assert.equal(outcome.parked, false);
    assert.ok(!sent.some((m) => m.text.includes("🌐")));
  }

  console.log("✅ Browser handoff lifecycle passed");
} finally {
  resetHostHooks();
}
