// tests/vault-totp-fixture.test.ts — Deterministic TOTP fixture (V2 §32.5): RFC-known secret fill E2E.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BrowserWorker } from "../src/agent/browser-worker";
import { encryptVaultPayload, generateTotp, parseBase32Secret } from "../src/vault/service";
import type { Env } from "../src/env";

console.log("▶ Deterministic TOTP fixture (RFC-known secret) E2E...");

// Fixture secret: RFC 6238 SHA1 test key "12345678901234567890"
const FIXTURE_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const MASTER_KEY = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";

// 1. Sanity: the fixture secret reproduces the RFC vector (8 digits) at t=59
{
  const code = await generateTotp({ secretBase32: FIXTURE_SECRET, algorithm: "SHA1", digits: 8, period: 30 }, 59000);
  assert.equal(code, "94287082");
  assert.ok(parseBase32Secret(FIXTURE_SECRET).length === 20);
}

// 2. BrowserWorker fills the authenticator field with the deterministic code; tool output carries no code
{
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE used_vault_items (task_id TEXT NOT NULL, candidate_id TEXT NOT NULL, PRIMARY KEY (task_id, candidate_id));`);

  const mockCtx: any = {
    storage: { sql: { exec: (s: string, ...args: unknown[]) => Object.assign(db.prepare(s).all(...(args as never[])), { toArray() { return this; } }) } },
    id: { name: "ws-fixture" },
    blockConcurrencyWhile: async (fn: any) => await fn(),
  };

  const ws = "ws-fixture";
  const itemId = "vi_fixture";
  const vdb = new DatabaseSync(":memory:");
  vdb.exec(`
    CREATE TABLE vault_items (id TEXT PRIMARY KEY, workspace_id TEXT, kind TEXT, label TEXT, account TEXT, origin TEXT, has_totp INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE encrypted_secrets (workspace_id TEXT, namespace TEXT, id TEXT, ciphertext TEXT, updated_at INTEGER, PRIMARY KEY(workspace_id, namespace, id));
  `);
  const fields = {
    username: "alice",
    password: "pw",
    __totp: { status: "active", secretBase32: FIXTURE_SECRET, algorithm: "SHA1", digits: 6, period: 30, createdAt: Date.now() },
  };
  const ct = await encryptVaultPayload({ VAULT_MASTER_KEY: MASTER_KEY } as Env, ws, itemId, JSON.stringify(fields));
  vdb.prepare(`INSERT INTO vault_items (id, workspace_id, kind, label, account, origin, has_totp, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)`).run(itemId, ws, "login", "Fixture", "alice", "https://fixture.test", Date.now(), Date.now());
  vdb.prepare(`INSERT INTO encrypted_secrets (workspace_id, namespace, id, ciphertext, updated_at) VALUES (?,?,?,?,?)`).run(ws, "vault", itemId, ct, Date.now());

  let batchable: Array<{ sql: string; args: unknown[] }> = [];
  const makeStmt = (sql: string, args: unknown[] = []) => ({
    first: async () => (vdb.prepare(sql).get(...(args as never[])) ?? null),
    all: async () => ({ results: vdb.prepare(sql).all(...(args as never[])) }),
    run: async () => { const r = vdb.prepare(sql).run(...(args as never[])); return { meta: { changes: r.changes ?? 0 }, success: true }; },
  });
  const mockEnv: any = {
    BROWSER: {},
    VAULT_MASTER_KEY: MASTER_KEY,
    TOTP_ENABLED: "1",
    DB: {
      prepare: (sql: string) => {
        const bound = (args: unknown[]) => { batchable.push({ sql, args }); return makeStmt(sql, args); };
        return { bind: (...args: unknown[]) => bound(args), first: async () => (vdb.prepare(sql).get() ?? null), run: async () => { const r = vdb.prepare(sql).run(); return { meta: { changes: r.changes ?? 0 }, success: true }; } };
      },
      batch: async () => { for (const s of batchable) vdb.prepare(s.sql).run(...(s.args as never[])); batchable = []; return []; },
    },
  };

  const worker = new (BrowserWorker as any)(mockCtx, mockEnv);
  worker.onStart();
  const inserted: string[] = [];
  worker.markSecret = async () => {};
  const cdp: any = { send: async (cmd: string, params: any) => { if (cmd === "Input.insertText") inserted.push(params.text); return {}; } };

  // Freeze time inside the RFC vector period (counter=1, t=30..59) so the assertion is deterministic.
  const realNow = Date.now;
  Date.now = () => 35_000;

  const page: any = {
    url: () => "https://fixture.test/login",
    mouse: { click: async () => {} },
    evaluate: async () => ({
      elementText: "Two-Factor Authentication Enter code from your authenticator app",
      nearbyText: "Enter code from your authenticator app",
      inputs: [{ selector: 'input[data-totp-idx="0"]', x: 5, y: 6, name: "otp", id: "otp", type: "text", autocomplete: "one-time-code", ariaLabel: "Code", placeholder: "000000", maxlength: 6, filled: false }],
    }),
  };

  try {
    const res = await worker.fillTotpFromVault({ workspaceId: ws, taskId: "t_fixture", goal: "login" }, page, cdp, itemId);
    assert.equal(res.content, "Authenticator code filled.");
    assert.equal(inserted.length, 1);
    // Deterministic per RFC 6238 at counter=1 (t=30..59), 6 digits => last 6 of 94287082
    assert.equal(inserted[0], "287082");
    assert.equal(res.content.includes(inserted[0]), false, "Code must never appear in tool output");
  } finally {
    Date.now = realNow;
  }
}

console.log("✔ Deterministic TOTP fixture E2E passed!");
