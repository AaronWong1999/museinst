// tests/browser-session-publication.test.ts
// DEFECT-022 — P0 browser false success: a normal agent-run browser task that
// completes WITHOUT any handoff/transfer grant must still be visible in the
// Computer → Browser tab. The BrowserWorker publishes its real sessions to the
// D1 `browser_sessions` table (migration 0023) and GET /api/browser/sessions
// merges those rows with the existing access grants, workspace-scoped.
//
// Harness follows tests/browser-takeover-revoke.test.ts (DO storage over
// node:sqlite) and tests/browser-parked-task-isolation.test.ts (puppeteer +
// Workers-AI mocks around worker.onRequest("/assign")).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "@cloudflare/puppeteer";
import { BrowserWorker } from "../src/agent/browser-worker";
import { handleBrowserRoute } from "../src/browser/routes";
import { setHostHooks, resetHostHooks } from "../src/hooks";

console.log("▶ Browser session publication (DEFECT-022)");

// ── Shared harness ────────────────────────────────────────────────────────────

const WS = "ws-pub";
const TASK_DONE = "task_pub_done";
const TASK_FAIL = "task_pub_fail";

// Apply migration 0023 verbatim so the D1 mock matches the shipped schema.
const MIGRATION_SQL = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../migrations/0023_browser_session_publication.sql", import.meta.url), "utf8"),
);

function createMockD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS browser_access_grants (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
    principal_id TEXT, origin_channel TEXT, origin_external_id TEXT, origin_scope TEXT,
    token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, requested_mode TEXT NOT NULL,
    current_mode TEXT NOT NULL, created_by TEXT NOT NULL, reason_code TEXT, instructions TEXT,
    privacy_mode TEXT NOT NULL DEFAULT 'normal', browser_session_ref TEXT, target_ref TEXT,
    control_epoch INTEGER NOT NULL DEFAULT 0, max_redemptions INTEGER NOT NULL DEFAULT 1,
    redemption_count INTEGER NOT NULL DEFAULT 0, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    redeemed_at INTEGER, takeover_at INTEGER, completed_at INTEGER, revoked_at INTEGER, metadata_json TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT, goal TEXT
  )`);
  db.exec(MIGRATION_SQL);
  const d1: any = {
    prepare(sql: string) {
      return {
        _bindings: [] as any[],
        bind(...args: any[]) { this._bindings = args; return this; },
        async run() {
          db.prepare(sql).run(...(this._bindings as never[]));
          return { meta: { changes: 1 } };
        },
        async first<T = any>(): Promise<T | null> {
          const row = db.prepare(sql).get(...(this._bindings as never[])) as any;
          return (row as T) ?? null;
        },
        async all<T = any>(): Promise<{ results: T[] }> {
          const rows = db.prepare(sql).all(...(this._bindings as never[])) as any[];
          return { results: rows as T[] };
        },
      };
    },
  };
  return { d1, db };
}

function makeMockPage(url: string, title: string) {
  const cdpCalls: Array<{ method: string; params: any }> = [];
  const mockCdp = {
    send: async (method: string, params: any) => {
      cdpCalls.push({ method, params });
      return {};
    },
  };
  const page: any = {
    setViewport: async () => {},
    createCDPSession: async () => mockCdp,
    goto: async (u: string) => {},
    screenshot: async () => new Uint8Array([1, 2, 3]),
    url: () => url,
    title: async () => title,
    evaluate: async () => ({ url, title, elements: [] }),
    close: async () => {},
  };
  return { page, cdpCalls };
}

interface WorkerHarness {
  worker: any;
  db: DatabaseSync;
  d1: any;
  cleanup(): void;
}

/**
 * Builds a BrowserWorker whose model always calls `finish` on the first step.
 * success=true paths carry observed evidence (passing the fail-closed gate);
 * success=false paths fail the task. `modelGate` (optional) is awaited before
 * the first model response, letting a test observe mid-task DB state.
 */
function makeWorker(opts: {
  finishSuccess: boolean;
  taskId: string;
  launchShouldFail?: boolean;
  modelGate?: () => Promise<void>;
}): WorkerHarness {
  const { d1, db } = createMockD1();
  const { page } = makeMockPage("https://example.com/checkout", "订单确认 — Example");

  const mockBrowser = {
    sessionId: () => `sess_${opts.taskId}`,
    pages: async () => [page],
    newPage: async () => page,
  };

  const origConnect = puppeteer.connect;
  const origLaunch = puppeteer.launch;
  const origLimits = puppeteer.limits;
  const origSessions = puppeteer.sessions;
  puppeteer.limits = (async () => ({ activeSessions: [] }) as any) as any;
  puppeteer.sessions = (async () => [] as any) as any;
  puppeteer.launch = (async () => {
    if (opts.launchShouldFail) throw new Error("browser rendering is not enabled for this account");
    return mockBrowser as any;
  }) as any;
  puppeteer.connect = (async () => mockBrowser as any) as any;

  const workerCtx: any = {
    storage: {
      sql: {
        exec: (s: string, ...args: unknown[]) => {
          const stmt = db.prepare(s);
          const rows = stmt.all(...(args as never[]));
          return Object.assign(rows, { toArray: () => rows });
        },
      },
    },
    id: { name: WS },
    blockConcurrencyWhile: async (fn: any) => await fn(),
  };

  const aiCalls: Array<{ model: string; body: any }> = [];
  const workerEnv: any = {
    BROWSER: {},
    MODEL_PROVIDER: "workers-ai",
    MODEL_WORKER: "@cf/test/model",
    MODEL_ROOT: "@cf/test/model",
    DB: d1,
    AI: {
      run: async (model: string, body: any) => {
        aiCalls.push({ model, body });
        if (opts.modelGate && aiCalls.length === 1) await opts.modelGate();        return {
          response: "",
          tool_calls: [{
            id: "c1",
            name: "finish",
            arguments: JSON.stringify(
              opts.finishSuccess
                ? {
                    success: true,
                    summary: "已提交订单",
                    evidence: [{ type: "observed_text", value: "订单号 A-12345 已确认" }],
                  }
                : { success: false, summary: "页面无法打开登录框" },
            ),
          }],
        };
      },
    },
  };

  const worker = new (BrowserWorker as any)(workerCtx, workerEnv);
  worker.onStart();
  return {
    worker,
    db,
    d1,
    cleanup() {
      puppeteer.connect = origConnect;
      puppeteer.launch = origLaunch;
      puppeteer.limits = origLimits;
      puppeteer.sessions = origSessions;
    },
  };
}

async function assign(worker: any, taskId: string): Promise<any> {
  const res = await worker.onRequest(new Request("https://browser/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: WS,
      taskId,
      goal: "在示例商店下一单",
      startUrl: "https://example.com/checkout",
      vaultHints: [],
      lang: "zh",
    }),
  }));
  return res.json();
}

function publishedRow(db: DatabaseSync, taskId: string): any {
  return db
    .prepare(`SELECT * FROM browser_sessions WHERE task_id = ? AND workspace_id = ?`)
    .get(taskId, WS) as any;
}

// ── (a) Task start publishes an active browser_sessions row ──────────────────
{
  console.log("  [1] /assign publishes a browser_sessions row with state=active");
  let releaseModel: () => void = () => {};
  const modelGate = new Promise<void>((r) => { releaseModel = r; });
  const h = makeWorker({ finishSuccess: true, taskId: TASK_DONE, modelGate: () => modelGate });
  try {
    const started = Date.now();
    const task = assign(h.worker, TASK_DONE);

    // Mid-task: the row must already be published, still active.
    await new Promise((r) => setTimeout(r, 25));
    const midRow = publishedRow(h.db, TASK_DONE);
    assert.ok(midRow, "a browser_sessions row exists for the task at start");
    assert.equal(midRow.state, "active");
    assert.equal(midRow.workspace_id, WS);
    assert.equal(midRow.url, "https://example.com/checkout");
    assert.ok(midRow.started_at >= started - 1000 && midRow.started_at <= Date.now() + 1000);
    assert.equal(midRow.ended_at, null);

    releaseModel();
    const out = await task;
    assert.equal(out.status, "done", `the mocked model finishes successfully (error=${out.error})`);
  } finally {
    releaseModel();
    h.cleanup();
  }
}

// ── (b) done with observed evidence → completed + DO session state flips ─────
{
  console.log("  [2] done with observed evidence → browser_sessions completed + DO sessions state completed");
  const h = makeWorker({ finishSuccess: true, taskId: TASK_DONE });
  try {
    await assign(h.worker, TASK_DONE);

    const row = publishedRow(h.db, TASK_DONE);
    assert.equal(row.state, "completed");
    assert.equal(row.task_id, TASK_DONE);
    assert.equal(row.url, "https://example.com/checkout", "final url recorded");
    assert.equal(row.title, "订单确认 — Example", "final page title recorded");
    assert.ok((row.observed_text ?? "").includes("订单号 A-12345"), "observed_text carries the last observed fact");
    assert.ok(row.observed_text.length <= 210, "observed_text is clamped (~200 chars)");
    assert.ok(row.ended_at !== null && row.ended_at >= row.started_at, "ended_at set on completion");

    // DO-local sessions table row must have flipped off agent_active too.
    const doRow = h.db.prepare(`SELECT state FROM sessions WHERE task_id = ?`).get(TASK_DONE) as any;
    assert.equal(doRow.state, "completed", "DO-local sessions row leaves agent_active after done");
  } finally {
    h.cleanup();
  }
}

// ── (c) GET /api/browser/sessions returns real sessions alongside grants ─────
{
  console.log("  [3] GET /api/browser/sessions lists the real session + grants, workspace-scoped");
  const h = makeWorker({ finishSuccess: true, taskId: TASK_DONE });
  try {
    await assign(h.worker, TASK_DONE);

    // A grant in the same workspace (handoff path) and one in another workspace.
    h.d1.prepare(
      `INSERT INTO browser_access_grants (id, workspace_id, task_id, token_hash, status, requested_mode, current_mode, created_by, issued_at, expires_at)
       VALUES ('bg_pub1', '${WS}', '${TASK_DONE}', 'hash_pub1', 'issued', 'readonly', 'readonly', 'agent', ${Date.now()}, ${Date.now() + 60_000})`,
    ).run();
    h.d1.prepare(
      `INSERT INTO browser_access_grants (id, workspace_id, task_id, token_hash, status, requested_mode, current_mode, created_by, issued_at, expires_at)
       VALUES ('bg_other', 'ws_other', 'task_other', 'hash_other', 'issued', 'readonly', 'readonly', 'agent', ${Date.now()}, ${Date.now() + 60_000})`,
    ).run();

    setHostHooks({
      authenticateRequest: async (_env: any, req: Request) => {
        const ws = req.headers.get("x-test-workspace");
        return ws ? { userId: `user_${ws}`, workspaceId: ws } : null;
      },
    });

    try {
      const env: any = { DB: h.d1 };
      const unauth = await handleBrowserRoute(new Request("https://openinst.test/api/browser/sessions"), env);
      assert.equal(unauth?.status, 401, "list stays authenticated");

      const list = await handleBrowserRoute(new Request("https://openinst.test/api/browser/sessions", {
        headers: { "x-test-workspace": WS },
      }), env);
      assert.equal(list?.status, 200);
      const data = await list!.json() as any;

      const real = data.sessions.filter((s: any) => s.hasGrant === false && s.id.startsWith("bs_"));
      const grants = data.sessions.filter((s: any) => s.hasGrant === true);
      assert.equal(real.length, 1, "the real agent-run session is now listed (previously impossible)");
      assert.equal(real[0].task_id, TASK_DONE);
      assert.equal(real[0].url, "https://example.com/checkout");
      assert.equal(real[0].title, "订单确认 — Example");
      assert.equal(real[0].status, "completed", "state surfaces through the grant-shaped status field");
      assert.equal(real[0].workspace_id, WS);

      assert.equal(grants.length, 1, "the same-workspace grant is still listed");
      assert.equal(grants[0].id, "bg_pub1");
      assert.equal(grants[0].workspace_id, WS, "workspace scoping applies to grants as before");

      assert.ok(
        data.sessions.every((s: any) => s.workspace_id === WS),
        "cross-workspace grant (ws_other) must not leak into the list",
      );
    } finally {
      resetHostHooks();
    }
  } finally {
    h.cleanup();
  }
}

// ── (d) failed task → state failed ────────────────────────────────────────────
{
  console.log("  [4] finish success=false → browser_sessions state=failed");
  const h = makeWorker({ finishSuccess: false, taskId: TASK_FAIL });
  try {
    await assign(h.worker, TASK_FAIL);

    const row = publishedRow(h.db, TASK_FAIL);
    assert.ok(row, "row exists even for failed tasks");
    assert.equal(row.state, "failed");
    assert.ok(row.ended_at !== null, "failed tasks are closed out");
    const doRow = h.db.prepare(`SELECT state FROM sessions WHERE task_id = ?`).get(TASK_FAIL) as any;
    assert.equal(doRow.state, "failed", "DO-local sessions row flips to failed too");
  } finally {
    h.cleanup();
  }
}

// ── (e) launch failure → state failed (no silent stuck-active row) ────────────
{
  console.log("  [5] launch_failed → browser_sessions state=failed");
  const h = makeWorker({ finishSuccess: true, taskId: "task_pub_launch", launchShouldFail: true });
  try {
    const out = await assign(h.worker, "task_pub_launch");
    assert.equal(out.status, "failed");
    assert.match(out.error, /launch_failed/);

    const row = publishedRow(h.db, "task_pub_launch");
    assert.ok(row, "the row published at start must not stay stuck active");
    assert.equal(row.state, "failed");
  } finally {
    h.cleanup();
  }
}

console.log("✅ browser-session-publication passed");
