import assert from "node:assert/strict";
import { BrowserService } from "../src/browser/service";

console.log("▶ Browser cancel fail-closed regression");

const baseGrant = {
  id: "bg_cancel",
  workspace_id: "ws_cancel",
  task_id: "task_cancel",
  token_hash: "a".repeat(64),
  status: "redeemed",
  requested_mode: "readonly",
  current_mode: "readonly",
  created_by: "user",
  privacy_mode: "normal",
  control_epoch: 0,
  max_redemptions: 1,
  redemption_count: 1,
  issued_at: Date.now() - 1_000,
  expires_at: Date.now() + 60_000,
  redeemed_at: Date.now() - 500,
};

function mockDb() {
  let revoked = false;
  const db: any = {
    prepare(sql: string) {
      return {
        args: [] as any[],
        bind(...args: any[]) { this.args = args; return this; },
        async first<T = any>() {
          if (sql.includes("SELECT * FROM browser_access_grants WHERE id = ?") && this.args[0] === baseGrant.id) {
            return { ...baseGrant, status: revoked ? "revoked" : baseGrant.status } as T;
          }
          return null;
        },
        async run() {
          if (sql.includes("SET status = 'revoked'") && this.args[1] === baseGrant.id) revoked = true;
          return { meta: { changes: 1 } };
        },
      };
    },
    wasRevoked: () => revoked,
  };
  return db;
}

function serviceWith(workerFetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const DB = mockDb();
  const env: any = {
    DB,
    BROWSER_WORKER: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: workerFetch }),
    },
  };
  return { service: new BrowserService(env), DB };
}

{
  const { service, DB } = serviceWith(async () => { throw new Error("worker_down"); });
  await assert.rejects(() => service.cancel("ws_cancel", "bg_cancel"), /cancel_failed: worker_down/);
  assert.equal(DB.wasRevoked(), false, "transport failure must not revoke the grant or claim cancellation");
}

{
  const { service, DB } = serviceWith(async () => Response.json({ error: "cancel_rejected" }, { status: 503 }));
  await assert.rejects(() => service.cancel("ws_cancel", "bg_cancel"), /cancel_failed: cancel_rejected/);
  assert.equal(DB.wasRevoked(), false, "non-2xx worker response must remain retryable");
}

{
  const { service, DB } = serviceWith(async () => Response.json({ success: false }));
  await assert.rejects(() => service.cancel("ws_cancel", "bg_cancel"), /cancel_failed: worker_not_confirmed/);
  assert.equal(DB.wasRevoked(), false, "ambiguous worker acknowledgement must fail closed");
}

{
  const { service, DB } = serviceWith(async (url) => {
    assert.ok(url.endsWith("/cancel"));
    return Response.json({ success: true });
  });
  assert.deepEqual(await service.cancel("ws_cancel", "bg_cancel"), { success: true });
  assert.equal(DB.wasRevoked(), true, "grant revocation follows confirmed worker cancellation");
}

console.log("✅ Browser cancel fail-closed regression passed");
