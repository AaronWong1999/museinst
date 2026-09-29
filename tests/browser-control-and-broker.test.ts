//
// Browser security + control regression tests.
//
import assert from "node:assert/strict";
import {
  transitionBrowserControlState,
  getWriterPermissions,
  assertSingleWriter,
  assertControlEpoch,
  type BrowserControlState,
} from "../src/browser/state-machine";
import { BrowserGrantRepository, sha256Hex } from "../src/browser/grants";
import { handleBrowserRoute } from "../src/browser/routes";
import { setHostHooks, resetHostHooks } from "../src/hooks";

console.log("▶ Browser Control & Watch Broker security regression");

function createMockD1(): any {
  const grants = new Map<string, any>();
  return {
    prepare(sql: string) {
      return {
        _bindings: [] as any[],
        bind(...args: any[]) { this._bindings = args; return this; },
        async run() {
          const b = this._bindings;
          if (sql.includes("INSERT INTO browser_access_grants")) {
            const row = {
              id: b[0], workspace_id: b[1], task_id: b[2], principal_id: b[3],
              origin_channel: b[4], origin_external_id: b[5], origin_scope: b[6],
              token_hash: b[7], status: "issued", requested_mode: b[8], current_mode: b[9],
              created_by: b[10], reason_code: b[11], instructions: b[12], privacy_mode: b[13],
              browser_session_ref: b[14], target_ref: b[15], control_epoch: b[16],
              max_redemptions: 1, redemption_count: 0, issued_at: b[17], expires_at: b[18],
              metadata_json: b[19], redeemed_at: null,
            };
            grants.set(row.id, row);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("status = 'redeemed'")) {
            const row = grants.get(b[1]);
            if (row && row.status === "issued" && row.redemption_count < row.max_redemptions) {
              row.status = "redeemed"; row.redemption_count += 1; row.redeemed_at = b[0];
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("current_mode = ?")) {
            const row = grants.get(b[4]);
            if (row) { row.current_mode = b[0]; row.control_epoch = b[1]; }
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.includes("status = 'completed'")) {
            const row = grants.get(b[1]);
            if (row) { row.status = "completed"; row.completed_at = b[0]; }
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.includes("status = 'revoked'")) {
            const row = grants.get(b[1]);
            if (row) { row.status = "revoked"; row.revoked_at = b[0]; }
            return { meta: { changes: row ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first<T = any>() {
          const b = this._bindings;
          if (sql.includes("WHERE token_hash = ?")) {
            for (const row of grants.values()) if (row.token_hash === b[0]) return { ...row } as T;
            return null;
          }
          if (sql.includes("WHERE id = ?")) {
            const row = grants.get(b[0]); return row ? ({ ...row } as T) : null;
          }
          return null;
        },
        async all<T = any>() {
          if (sql.includes("FROM browser_access_grants g") && sql.includes("WHERE g.workspace_id = ?")) {
            const ws = this._bindings[0];
            return { results: Array.from(grants.values()).filter((g) => g.workspace_id === ws).map((g) => ({ ...g })) as T[] };
          }
          return { results: [] as T[] };
        },
      };
    },
  };
}

// ── State machine invariant ──────────────────────────────────────────────────
{
  assert.deepEqual(getWriterPermissions("agent_active"), { agentWrite: true, humanWrite: false });
  assert.deepEqual(getWriterPermissions("watch_available"), { agentWrite: true, humanWrite: false });
  assert.deepEqual(getWriterPermissions("user_active"), { agentWrite: false, humanWrite: true });
  assert.doesNotThrow(() => assertSingleWriter("watch_available"));
  assert.doesNotThrow(() => assertSingleWriter("user_active"));

  let st: BrowserControlState = {
    taskId: "t1", workspaceId: "ws1", state: "created", controlEpoch: 0,
    goalRevision: 0, goal: "book flight", updatedAt: 1000,
  };
  st = transitionBrowserControlState(st, { type: "agent_start" }, 1001);
  st = transitionBrowserControlState(st, { type: "watch_enabled" }, 1002);
  st = transitionBrowserControlState(st, { type: "takeover_acquired", leaseDurationMs: 60_000 }, 1003);
  assert.equal(st.state, "user_active");
  assert.equal(st.controlEpoch, 1);
  assert.doesNotThrow(() => assertControlEpoch(st.controlEpoch, 1));
  assert.throws(() => assertControlEpoch(0, 1), /stale_control_epoch/);
}

// ── Grant + route security ───────────────────────────────────────────────────
{
  const db = createMockD1();
  const repo = new BrowserGrantRepository(db);
  const sessionId = "624e2202-0b29-4023-b509-97b956fb55cd";
  const targetId = "90AD1A631CF95CB728060533FF88CCFB";
  const issued = await repo.createGrant({
    workspaceId: "ws_http",
    taskId: "task_http",
    requestedMode: "readonly",
    createdBy: "agent",
    browserSessionRef: sessionId,
    targetRef: targetId,
  }, "https://openinst.test");

  const mockEnv: any = {
    DB: db,
    PUBLIC_BASE_URL: "https://openinst.test",
    BROWSER_LIVE_VIEW_ACCOUNT_ID: "acc12345",
    BROWSER_API_TOKEN: "tok_test",
    BROWSER_WORKER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string) => {
          if (url.includes("/session/")) {
            return Response.json({
              taskId: "task_http", sessionId, targetId, state: "agent_active",
              controlEpoch: 0, goalRevision: 0,
            });
          }
          if (url.includes("/takeover")) {
            return Response.json({ success: true, controlEpoch: 1 });
          }
          throw new Error("unexpected worker mutation");
        },
      }),
    },
  };

  setHostHooks({
    authenticateRequest: async (_env, req) => {
      const ws = req.headers.get("x-test-workspace");
      return ws ? { userId: `user_${ws}`, workspaceId: ws } : null;
    },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const urlStr = typeof input === "string" ? input : input?.url || "";
    if (urlStr.includes("/live_view")) {
      return new Response(JSON.stringify({
        webSocketDebuggerUrl: "wss://live.browser.run/api/devtools/browser/mock/page/mock",
        devtoolsFrontendUrl: "https://live.browser.run/ui/view?mode=tab",
        id: "mock_target",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return origFetch(input, init);
  };

  try {
    // Preflight does not consume the token.
    const preflight = await handleBrowserRoute(new Request(`https://openinst.test/b/${issued.rawToken}`), mockEnv);
    assert.equal(preflight?.status, 200);
    const hash = await sha256Hex(issued.rawToken);
    assert.equal((await repo.findByTokenHash(hash))?.status, "issued");

    // Redeem creates a restricted HttpOnly bearer bound to grant + token hash.
    const redeemed = await handleBrowserRoute(new Request(`https://openinst.test/b/${issued.rawToken}/redeem`, {
      method: "POST", headers: { accept: "application/json" },
    }), mockEnv);
    assert.equal(redeemed?.status, 200);
    const setCookie = redeemed!.headers.get("set-cookie") || "";
    assert.match(setCookie, /__Secure-oi-browser-control=/);
    assert.match(setCookie, /HttpOnly/);
    assert.ok(!setCookie.includes(":ws_http:"), "cookie no longer trusts forgeable workspace/task tuple");
    const cookiePair = setCookie.split(";", 1)[0];

    // Knowledge of grantId alone is not authorization.
    const nakedStatus = await handleBrowserRoute(new Request(`https://openinst.test/api/browser/access/${issued.grantId}/status`), mockEnv);
    assert.equal(nakedStatus?.status, 401);
    const nakedShell = await handleBrowserRoute(new Request(`https://openinst.test/browser/${issued.grantId}`), mockEnv);
    assert.equal(nakedShell?.status, 401);

    // The redeemed restricted cookie authorizes only this browser grant.
    const status = await handleBrowserRoute(new Request(`https://openinst.test/api/browser/access/${issued.grantId}/status`, {
      headers: { cookie: cookiePair },
    }), mockEnv);
    assert.equal(status?.status, 200);
    const statusData = await status!.json() as any;
    assert.equal(statusData.grantId, issued.grantId);
    assert.equal(statusData.capabilities.interactiveView, true, "takeover is available once the live-view token is configured");
    assert.ok(statusData.providerView?.providerViewUrl);
    assert.equal(statusData.workspaceId, undefined, "restricted status does not disclose workspace id");

    // Cross-workspace normal sessions cannot use another tenant's grant.
    const crossWorkspace = await handleBrowserRoute(new Request(`https://openinst.test/api/browser/access/${issued.grantId}/status`, {
      headers: { "x-test-workspace": "ws_other" },
    }), mockEnv);
    assert.equal(crossWorkspace?.status, 401);

    // Takeover still requires a device id.
    const noDevice = await handleBrowserRoute(new Request(`https://openinst.test/api/browser/access/${issued.grantId}/takeover`, {
      method: "POST",
      headers: { cookie: cookiePair, "content-type": "application/json" },
      body: JSON.stringify({}),
    }), mockEnv);
    assert.equal(noDevice?.status, 400);
    assert.equal((await noDevice!.json() as any).error, "device_id_required");

    // With a configured live-view token, the grant holder can take over the same session.
    const takeover = await handleBrowserRoute(new Request(`https://openinst.test/api/browser/access/${issued.grantId}/takeover`, {
      method: "POST",
      headers: { cookie: cookiePair, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "device-1" }),
    }), mockEnv);
    assert.equal(takeover?.status, 200);
    const takeoverData = await takeover!.json() as any;
    assert.equal(takeoverData.controlEpoch, 1);
    assert.equal(takeoverData.providerView.access, "interactive");
    assert.equal((await repo.findById(issued.grantId))?.current_mode, "interactive");

    // Computer session list is authenticated and workspace-scoped.
    const unauthList = await handleBrowserRoute(new Request("https://openinst.test/api/browser/sessions"), mockEnv);
    assert.equal(unauthList?.status, 401);
    const list = await handleBrowserRoute(new Request("https://openinst.test/api/browser/sessions", {
      headers: { "x-test-workspace": "ws_http" },
    }), mockEnv);
    assert.equal(list?.status, 200);
    const listData = await list!.json() as any;
    assert.equal(listData.sessions.length, 1);
    assert.ok(listData.sessions.every((s: any) => s.workspace_id === "ws_http"));
  } finally {
    globalThis.fetch = origFetch;
    resetHostHooks();
  }
}

console.log("✅ Browser Control & Watch Broker security regression passed");
