// BrowserWorker TOTP rollout kill-switch regression coverage.
// TOTP_ENABLED=0 must reject before any Vault DB read, page inspection, click, or CDP injection.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BrowserWorker } from "../src/agent/browser-worker";

console.log("▶ Browser TOTP rollout kill switch...");

const db = new DatabaseSync(":memory:");
const mockCtx: any = {
  storage: {
    sql: {
      exec: (sql: string, ...args: unknown[]) => {
        const stmt = db.prepare(sql);
        const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(sql);
        const rows = isRead ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
        return Object.assign(rows, { toArray: () => rows });
      },
    },
  },
  id: { name: "ws-totp-rollout-gate" },
  blockConcurrencyWhile: async (fn: any) => await fn(),
};

let dbTouches = 0;
let pageTouches = 0;
let cdpTouches = 0;
const mockEnv: any = {
  BROWSER: {},
  TOTP_ENABLED: "0",
  // Deliberately set enrollment on to prove the master TOTP switch wins first.
  TOTP_ENROLLMENT_ENABLED: "1",
  DB: {
    prepare: () => {
      dbTouches++;
      throw new Error("TOTP disabled gate must run before DB access");
    },
    batch: async () => {
      dbTouches++;
      throw new Error("TOTP disabled gate must run before DB access");
    },
  },
};

const worker = new (BrowserWorker as any)(mockCtx, mockEnv);
worker.onStart();

const page: any = new Proxy({}, {
  get() {
    pageTouches++;
    throw new Error("TOTP disabled gate must run before browser page access");
  },
});
const cdp: any = {
  send: async () => {
    cdpTouches++;
    throw new Error("TOTP disabled gate must run before CDP access");
  },
};
const payload = {
  workspaceId: "ws-totp-rollout-gate",
  taskId: "t_totp_rollout_gate",
  goal: "login",
  startUrl: "https://example.com",
  vaultHints: [],
  lang: "en",
};

const fill = await worker.fillTotpFromVault(payload, page, cdp, "vi_should_not_be_read");
assert.equal(fill.content, "totp_disabled");
assert.equal(dbTouches, 0);
assert.equal(pageTouches, 0);
assert.equal(cdpTouches, 0);

const enroll = await worker.captureTotpEnrollment(payload, page, cdp, "vi_should_not_be_read");
assert.equal(enroll.content, "totp_disabled");
assert.equal(dbTouches, 0);
assert.equal(pageTouches, 0);
assert.equal(cdpTouches, 0);

console.log("✔ Browser TOTP rollout kill switch passed!");
