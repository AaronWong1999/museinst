//
// Agent-initiated browser handoff (worker returned needs_handoff):
//  - the grant/card is pinned to the target read from the BrowserWorker session
//  - interactive takeover yields a card with a browser_takeover action
//  - user_requested flow + clear refusal when takeover is unavailable
//  - root instructions tell the agent how to hand the browser to the user
//
import assert from "node:assert/strict";
import { announceBrowserSession, deliverAgentBrowserHandoff } from "../src/browser/cards";
import { telegramSend } from "../src/channels/outbound";
import { BrowserService } from "../src/browser/service";
import { systemPrompt } from "../src/agent/instructions";

console.log("▶ Agent browser handoff");

const SESSION_ID = "624e2202-0b29-4023-b509-97b956fb55cd";
const TARGET_ID = "90AD1A631CF95CB728060533FF88CCFB";

function createEnv(session: Record<string, unknown> | null | Array<Record<string, unknown> | null>) {
  const sequence = Array.isArray(session) ? [...session] : null;
  const grants: any[] = [];
  const workerCalls: string[] = [];
  const env: any = {
    PUBLIC_BASE_URL: "https://openinst.test",
    BROWSER_LIVE_VIEW_ACCOUNT_ID: "acc12345",
    BROWSER_API_TOKEN: "browser_only_token",
    DB: {
      prepare(sql: string) {
        return {
          _b: [] as any[],
          bind(...args: any[]) { this._b = args; return this; },
          async run() {
            if (sql.includes("INSERT INTO browser_access_grants")) {
              const b = this._b;
              grants.push({ id: b[0], workspace_id: b[1], task_id: b[2], requested_mode: b[8], created_by: b[10], reason_code: b[11], browser_session_ref: b[14], target_ref: b[15], control_epoch: b[16], expires_at: b[18] });
            }
            return { meta: { changes: 1 } };
          },
          async first() { return null; },
          async all() { return { results: [] }; },
        };
      },
    },
    BROWSER_WORKER: {
      idFromName: (name: string) => name,
      get: (room: string) => ({
        async fetch(url: string, init?: RequestInit) {
          workerCalls.push(`${init?.method ?? "GET"} ${room} ${new URL(url).pathname}`);
          const current = sequence ? (sequence.length > 1 ? sequence.shift() : sequence[0]) : session;
          if (!current) return new Response("session_not_found", { status: 404 });
          return Response.json(current);
        },
      }),
    },
  };
  return { env, grants, workerCalls };
}

const liveSession = {
  taskId: "t_handoff_1",
  sessionId: SESSION_ID,
  targetId: TARGET_ID,
  title: "Sign in – Example",
  url: "https://example.com/login",
  state: "handoff_requested",
  controlEpoch: 3,
  goalRevision: 0,
};

const baseInput = {
  workspaceId: "ws1",
  threadId: "th1",
  taskId: "t_handoff_1",
  workerSessionId: SESSION_ID,
  privacyMode: "normal" as const,
  originChannel: "web",
  originExternalId: "u1",
  originScope: "owner",
};

const originalCaps = BrowserService.prototype.capabilities;
const withTakeover = () => {
  BrowserService.prototype.capabilities = async () => ({
    readonlyView: true,
    interactiveView: true,
    structuredHandoff: true,
    recording: false,
    revokeInteractiveView: true,
    readonlySurface: "rest",
  });
};
const withoutTakeover = () => {
  BrowserService.prototype.capabilities = async () => ({
    readonlyView: true,
    interactiveView: false,
    structuredHandoff: false,
    recording: false,
    revokeInteractiveView: false,
    readonlySurface: "rest",
  });
};
const restoreCaps = () => { BrowserService.prototype.capabilities = originalCaps; };

// ── 1. CAPTCHA handoff resolves targetId from the worker session ───────────
{
  console.log("  [1] needs_handoff delivery pins targetId and yields a browser_takeover card");
  withTakeover();
  try {
    const { env, grants, workerCalls } = createEnv(liveSession);
    const res = await deliverAgentBrowserHandoff(env, {
      ...baseInput,
      reasonCode: "captcha",
      instructions: "请完成页面上的人机验证",
      lang: "zh",
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const { card, grant, text } = res.delivery;

    assert.deepEqual(workerCalls, ["GET ws1 /session/t_handoff_1"]);
    assert.equal(card.type, "browser_session");
    assert.equal(card.state, "handoff_requested");
    assert.equal(card.ref.targetRef, TARGET_ID);
    assert.equal(card.title, "Sign in – Example");
    assert.equal(card.displayUrl, "https://example.com/login");
    const takeover = card.actions.find((a) => a.kind === "browser_takeover");
    assert.ok(takeover, "card must carry a browser_takeover action");
    assert.equal(takeover.targetId, grant.grantId);
    assert.ok(card.actions.some((a) => a.kind === "browser_watch"));

    assert.equal(grants.length, 1);
    assert.equal(grants[0].requested_mode, "interactive");
    assert.equal(grants[0].created_by, "agent");
    assert.equal(grants[0].browser_session_ref, SESSION_ID);
    assert.equal(grants[0].target_ref, TARGET_ID);
    assert.equal(grants[0].control_epoch, 3);

    assert.ok(text.includes(grant.accessUrl));
    assert.deepEqual(res.delivery.buttons, [{ text: "🖐 接管浏览器", url: grant.accessUrl }]);
    assert.ok(!res.delivery.webText.includes("/b/"), "web shows the card button, not the single-use link");
    assert.ok(res.delivery.webText.includes("交还 Agent"));
    assert.ok(!text.includes(SESSION_ID));
    assert.ok(!text.includes(TARGET_ID));
  } finally {
    restoreCaps();
  }
}

// ── 2. user_requested flow ─────────────────────────────────────────────────
{
  console.log("  [2] user_requested handoff gives the user a takeover card");
  withTakeover();
  try {
    const { env, grants } = createEnv(liveSession);
    const res = await deliverAgentBrowserHandoff(env, {
      ...baseInput,
      reasonCode: "user_requested",
      instructions: "Example.com is open — go ahead.",
      lang: "en",
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.ok(res.delivery.card.actions.some((a) => a.kind === "browser_takeover"));
    assert.equal(grants[0].reason_code, "user_requested");
    assert.ok(res.delivery.text.includes("the browser is yours"));
    assert.ok(res.delivery.text.includes(res.delivery.grant.accessUrl));
  } finally {
    restoreCaps();
  }
}

// ── 3. Takeover unavailable → clear message, no grant ──────────────────────
{
  console.log("  [3] takeover unavailable returns a user-facing message instead of throwing");
  withoutTakeover();
  try {
    const { env, grants } = createEnv(liveSession);
    const res = await deliverAgentBrowserHandoff(env, {
      ...baseInput,
      reasonCode: "user_requested",
      instructions: "打开了网站，交给你",
      lang: "zh",
    });
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("unreachable");
    assert.equal(res.error, "browser_takeover_unavailable");
    assert.ok(res.text.includes("还不支持"));
    assert.ok(res.text.includes("已关闭"), "the user is told the session was closed");
    assert.ok(res.text.includes("https://example.com/login"), "the user can finish on their own");
    assert.ok(!res.text.includes("浏览器交给你\n"), "must not claim the browser was handed over");
    assert.equal(grants.length, 0);

    const captcha = await deliverAgentBrowserHandoff(env, {
      ...baseInput,
      reasonCode: "captcha",
      instructions: "Solve the CAPTCHA on the page",
      lang: "en",
    });
    assert.equal(captcha.ok, false);
    if (captcha.ok) throw new Error("unreachable");
    assert.ok(captcha.text.includes("Solve the CAPTCHA on the page"));
    assert.ok(captcha.text.includes("isn't supported"));
    assert.ok(captcha.text.includes("https://example.com/login"));
  } finally {
    restoreCaps();
  }
}

// ── 4. Missing / substituted sessions never mint a grant ───────────────────
{
  console.log("  [4] missing target or a different worker session is refused");
  withTakeover();
  try {
    for (const session of [null, { ...liveSession, targetId: "" }, { ...liveSession, sessionId: "other-session" }]) {
      const { env, grants } = createEnv(session);
      const res = await deliverAgentBrowserHandoff(env, {
        ...baseInput,
        reasonCode: "mfa",
        instructions: "Enter the SMS code",
        lang: "en",
        sessionWaitMs: 30,
      });
      assert.equal(res.ok, false);
      if (res.ok) throw new Error("unreachable");
      assert.equal(res.error, "browser_session_not_ready");
      assert.equal(grants.length, 0);
    }
  } finally {
    restoreCaps();
  }
}


// ── 4b. A session that is still coming up is waited for ────────────────────
{
  console.log("  [4b] handoff waits for the worker to record the session target");
  withTakeover();
  try {
    const { env, grants, workerCalls } = createEnv([null, { ...liveSession, targetId: "" }, liveSession]);
    const res = await deliverAgentBrowserHandoff(env, {
      ...baseInput,
      reasonCode: "captcha",
      instructions: "Solve it",
      lang: "en",
      sessionWaitMs: 5000,
    });
    assert.equal(res.ok, true);
    assert.equal(workerCalls.length, 3);
    assert.equal(grants[0].target_ref, TARGET_ID);
  } finally {
    restoreCaps();
  }
}

// ── 6. Live session card when the agent starts a cloud browser ─────────────
{
  console.log("  [6] a live browser gets a readonly watch card with one-click takeover");
  withTakeover();
  try {
    const { env, grants } = createEnv(liveSession);
    const ann = await announceBrowserSession(env, {
      workspaceId: "ws1",
      threadId: "th1",
      taskId: "t_handoff_1",
      session: liveSession as any,
      originChannel: "telegram",
      lang: "zh",
    });
    assert.ok(ann);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].requested_mode, "readonly");
    assert.equal(grants[0].target_ref, TARGET_ID);
    assert.equal(grants[0].control_epoch, 3);
    assert.ok(grants[0].expires_at - Date.now() > 25 * 60_000, "watch link outlives a long task");
    assert.equal(ann.card.state, "agent_active");
    assert.ok(ann.card.actions.some((a) => a.kind === "browser_watch" && a.targetId === ann.grant.grantId));
    assert.ok(ann.card.actions.some((a) => a.kind === "browser_takeover" && a.targetId === ann.grant.grantId));
    assert.ok(ann.text.includes("example.com"));
    assert.ok(ann.text.includes(ann.grant.accessUrl));
    assert.ok(ann.text.includes("接管"));
    assert.ok(!ann.text.includes(SESSION_ID) && !ann.text.includes(TARGET_ID));
    assert.equal(ann.buttons[0].url, ann.grant.accessUrl);
    assert.ok(!ann.webText.includes("/b/") && ann.webText.includes("一键接管"), "web text relies on the card");
  } finally {
    restoreCaps();
  }

  withoutTakeover();
  try {
    const { env } = createEnv(liveSession);
    const ann = await announceBrowserSession(env, { workspaceId: "ws1", threadId: "th1", taskId: "t_handoff_1", session: liveSession as any, lang: "en" });
    assert.ok(ann, "watching still works without takeover");
    assert.ok(!ann.card.actions.some((a) => a.kind === "browser_takeover"));
    assert.ok(!ann.text.includes("take over"));
  } finally {
    restoreCaps();
  }

  BrowserService.prototype.capabilities = async () => ({
    readonlyView: false, interactiveView: false, structuredHandoff: false, recording: false, revokeInteractiveView: false, readonlySurface: "unavailable",
  });
  try {
    const { env, grants } = createEnv(liveSession);
    const ann = await announceBrowserSession(env, { workspaceId: "ws1", threadId: "th1", taskId: "t_handoff_1", session: liveSession as any, lang: "en" });
    assert.equal(ann, null);
    assert.equal(grants.length, 0);
  } finally {
    restoreCaps();
  }
}

// ── 7. Telegram renders link buttons natively ──────────────────────────────
{
  console.log("  [7] Telegram gets an inline link button on the last chunk");
  const bodies: any[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as any;
  try {
    const env: any = { TELEGRAM_ENABLED: "1", TELEGRAM_BOT_TOKEN: "t" };
    const r = await telegramSend(env, "42", "Open it:\nhttps://openinst.test/b/tok", {
      buttons: [{ text: "🖐 接管浏览器", url: "https://openinst.test/b/tok" }, { text: "bad", url: "javascript:alert(1)" }],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(bodies[0].reply_markup, { inline_keyboard: [[{ text: "🖐 接管浏览器", url: "https://openinst.test/b/tok" }]] });
    bodies.length = 0;
    await telegramSend(env, "42", "plain");
    assert.equal(bodies[0].reply_markup, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── 5. Root instructions route "let me take over" through request_handoff ───
{
  console.log("  [5] root prompt tells the agent to hand the browser over via user_requested");
  for (const lang of ["zh", "en"] as const) {
    const prompt = systemPrompt({
      lang,
      workspaceId: "ws1",
      channel: "web",
      memoryBlock: "",
      personalInfoBlock: "",
      connectorsBlock: "",
      vaultBlock: "",
      locationBlock: "",
      nowIso: "2026-09-29T00:00:00Z",
    });
    assert.match(prompt, /browser_task[^\n]*request_handoff[^\n]*reason_code=user_requested/);
    // Public pages are read directly; the cloud browser is the exception.
    assert.match(prompt, /(36氪|36Kr)[^\n]*web_fetch/);
    assert.match(prompt, lang === "zh" ? /只有这几种情况才用 browser_task/ : /Use browser_task \(a cloud browser\) only when/);
  }
}

console.log("✅ Agent browser handoff passed");
