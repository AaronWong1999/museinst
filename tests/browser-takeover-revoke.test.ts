// tests/browser-takeover-revoke.test.ts
// Human takeover must be revocable: handing the browser back, cancelling, or a
// new controller taking over closes the previous controller's tab.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "@cloudflare/puppeteer";
import { BrowserWorker } from "../src/agent/browser-worker";

console.log("▶ Browser takeover revocation");

interface MockPage {
  id: string;
  closed: boolean;
  gotoUrl?: string;
  url(): string;
  goto(url: string): Promise<void>;
  close(): Promise<void>;
  target(): { _targetId: string };
}

function makePage(id: string, url: string, opts: { failClose?: boolean } = {}): MockPage {
  const page: MockPage = {
    id,
    closed: false,
    url: () => page.gotoUrl ?? url,
    goto: async (u: string) => {
      page.gotoUrl = u;
    },
    close: async () => {
      if (opts.failClose) throw new Error("close refused");
      page.closed = true;
    },
    target: () => ({ _targetId: id }),
  };
  return page;
}

function makeWorker() {
  const db = new DatabaseSync(":memory:");
  const ctx: any = {
    storage: {
      sql: {
        exec: (s: string, ...args: unknown[]) => {
          const rows = db.prepare(s).all(...(args as never[]));
          return Object.assign(rows, { toArray: () => rows });
        },
      },
    },
    id: { name: "ws-revoke" },
    blockConcurrencyWhile: async (fn: any) => await fn(),
  };
  const worker = new (BrowserWorker as any)(ctx, { BROWSER: {} });
  worker.onStart();
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (task_id, session_id, created_at, last_used_at, target_id, url, state) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("task_1", "sess_1", now, now, "TARGET_OLD", "https://airline.example.com/checkin", "agent_active");
  return { worker, db };
}

async function post(worker: any, path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res: Response = await worker.onRequest(new Request(`https://browser${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, data: await res.json() };
}

const origConnect = puppeteer.connect;
const origSessions = puppeteer.sessions;

function installBrowser(pages: MockPage[], opts: { connectThrows?: boolean; sessionAlive?: boolean } = {}) {
  let disconnected = 0;
  let closedSession = false;
  const created: MockPage[] = [];
  puppeteer.connect = (async () => {
    if (opts.connectThrows) throw new Error("session unavailable");
    return {
      pages: async () => pages.filter((p) => !p.closed),
      newPage: async () => {
        const fresh = makePage(`TARGET_NEW_${created.length + 1}`, "about:blank");
        created.push(fresh);
        pages.push(fresh);
        return fresh;
      },
      close: async () => {
        closedSession = true;
      },
      disconnect: () => {
        disconnected++;
      },
    } as any;
  }) as any;
  puppeteer.sessions = (async () => (opts.sessionAlive ? [{ sessionId: "sess_1", startTime: 0 }] : [])) as any;
  return { created, disconnectedCount: () => disconnected, sessionClosed: () => closedSession };
}

try {
  {
    console.log("  [1] Done closes the controller's tab and reopens the page in a fresh tab");
    const { worker, db } = makeWorker();
    const old = makePage("TARGET_OLD", "https://airline.example.com/checkin/seat");
    const env = installBrowser([old]);

    const takeover = await post(worker, "/takeover", { taskId: "task_1", deviceId: "phone" });
    assert.equal(takeover.status, 200);
    assert.equal(takeover.data.targetId, undefined, "first controller needs no rotation");
    assert.equal(old.closed, false);

    const done = await post(worker, "/done", { taskId: "task_1" });
    assert.equal(done.status, 200);
    assert.equal(done.data.success, true);
    assert.equal(done.data.targetId, "TARGET_NEW_1");
    assert.equal(old.closed, true, "the tab the human controlled must be closed");
    assert.equal(env.created[0].gotoUrl, "https://airline.example.com/checkin/seat", "page reopens where the human left it");
    assert.ok(env.disconnectedCount() >= 1, "the worker must not keep the session connection");

    const row = db.prepare(`SELECT target_id, state FROM sessions WHERE task_id = ?`).get("task_1") as any;
    assert.equal(row.target_id, "TARGET_NEW_1");
    assert.equal(row.state, "completing");
  }

  {
    console.log("  [2] Done fails closed when the old tab cannot be closed");
    const { worker, db } = makeWorker();
    const old = makePage("TARGET_OLD", "https://airline.example.com/checkin", { failClose: true });
    installBrowser([old]);

    await post(worker, "/takeover", { taskId: "task_1", deviceId: "phone" });
    const done = await post(worker, "/done", { taskId: "task_1" });
    assert.equal(done.status, 502);
    assert.equal(done.data.error, "revoke_unconfirmed");
    const row = db.prepare(`SELECT state FROM sessions WHERE task_id = ?`).get("task_1") as any;
    assert.equal(row.state, "user_active", "control stays with the human, the agent does not resume");
  }

  {
    console.log("  [3] Done fails closed when a live session refuses a connection");
    const { worker } = makeWorker();
    installBrowser([], { connectThrows: true, sessionAlive: true });
    await post(worker, "/takeover", { taskId: "task_1", deviceId: "phone" });
    const done = await post(worker, "/done", { taskId: "task_1" });
    assert.equal(done.status, 502);
    assert.equal(done.data.error, "revoke_unconfirmed");
  }

  {
    console.log("  [4] Done succeeds when the browser session is already gone");
    const { worker } = makeWorker();
    installBrowser([], { connectThrows: true, sessionAlive: false });
    await post(worker, "/takeover", { taskId: "task_1", deviceId: "phone" });
    const done = await post(worker, "/done", { taskId: "task_1" });
    assert.equal(done.status, 200);
    assert.equal(done.data.targetId, null);
  }

  {
    console.log("  [5] A new controller after a lapsed lease cuts off the previous one");
    const { worker, db } = makeWorker();
    const old = makePage("TARGET_OLD", "https://airline.example.com/checkin");
    installBrowser([old]);

    await post(worker, "/takeover", { taskId: "task_1", deviceId: "phone" });
    db.prepare(`UPDATE control_leases SET lease_expires_at = ? WHERE task_id = ?`).run(Date.now() - 1, "task_1");

    const second = await post(worker, "/takeover", { taskId: "task_1", deviceId: "laptop" });
    assert.equal(second.status, 200);
    assert.equal(second.data.targetId, "TARGET_NEW_1");
    assert.equal(old.closed, true, "the phone's tab must be closed before the laptop gets control");
  }

  {
    console.log("  [6] The same controller renewing does not rotate the tab");
    const { worker } = makeWorker();
    const old = makePage("TARGET_OLD", "https://airline.example.com/checkin");
    installBrowser([old]);
    await post(worker, "/takeover", { taskId: "task_1", deviceId: "phone" });
    const again = await post(worker, "/takeover", { taskId: "task_1", deviceId: "phone" });
    assert.equal(again.status, 200);
    assert.equal(old.closed, false);
  }

  {
    console.log("  [7] Cancel after a takeover ends the browser session");
    const { worker } = makeWorker();
    const old = makePage("TARGET_OLD", "https://airline.example.com/checkin");
    const env = installBrowser([old]);
    await post(worker, "/takeover", { taskId: "task_1", deviceId: "phone" });
    const cancel = await post(worker, "/cancel", { taskId: "task_1" });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.success, true);
    assert.equal(env.sessionClosed(), true);
  }

  {
    console.log("  [8] Done without any human controller does not touch the browser");
    const { worker } = makeWorker();
    const old = makePage("TARGET_OLD", "https://airline.example.com/checkin");
    let connected = false;
    installBrowser([old]);
    const inner = puppeteer.connect;
    puppeteer.connect = (async (...args: any[]) => {
      connected = true;
      return (inner as any)(...args);
    }) as any;
    const done = await post(worker, "/done", { taskId: "task_1" });
    assert.equal(done.status, 200);
    assert.equal(connected, false);
    assert.equal(old.closed, false);
  }

  {
    console.log("  [9] Cancel without any takeover still ends the cloud browser and its published session");
    const { worker, db } = makeWorker();
    const published: Array<{ sql: string; args: unknown[] }> = [];
    worker.env.DB = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            published.push({ sql, args });
            return { meta: { changes: 1 } };
          },
        }),
      }),
    };
    const env = installBrowser([makePage("TARGET_OLD", "https://airline.example.com/checkin")]);
    const cancel = await post(worker, "/cancel", { taskId: "task_1", workspaceId: "ws-revoke", reason: "handoff_expired" });
    assert.equal(cancel.status, 200);
    assert.equal(env.sessionClosed(), true, "an idle agent session is closed too");
    const row = db.prepare(`SELECT state FROM sessions WHERE task_id = ?`).get("task_1") as any;
    assert.equal(row.state, "cancelled");
    const end = published.find((p) => p.sql.includes("UPDATE browser_sessions"));
    assert.ok(end, "the Computer tab stops showing the session as active");
    assert.equal(end.args[0], "failed");
    assert.equal(end.args[3], "handoff_expired");
  }

  console.log("✅ browser-takeover-revoke passed");
} finally {
  puppeteer.connect = origConnect;
  puppeteer.sessions = origSessions;
}
