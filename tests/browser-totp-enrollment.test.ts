// tests/browser-totp-enrollment.test.ts — Deterministic authenticator enrollment tests (V2 §25/§31.11).

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BrowserWorker } from "../src/agent/browser-worker";
import { encryptVaultPayload, getItemFields } from "../src/vault/service";
import {
  extractEnrollmentSecret,
  hasEnrollmentSuccessEvidence,
  isHighRiskMfaAction,
  requiresOwnerApprovalForEnrollment,
} from "../src/vault/totp-enrollment";
import type { Env } from "../src/env";

console.log("▶ Testing Browser TOTP enrollment extraction & pending->active...");

{
  const r1 = extractEnrollmentSecret([{ text: "Scan or enter: otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme" }]);
  assert.equal(r1.ok, true);
  assert.equal(r1.source, "otpauth_uri");
  assert.ok(r1.otpauthUri?.startsWith("otpauth://totp/"));

  const r2 = extractEnrollmentSecret([{ value: "", href: "otpauth://totp/X:y?secret=JBSWY3DPEHPK3PXP" }]);
  assert.equal(r2.ok, true);
  assert.equal(r2.source, "otpauth_uri");

  const r3 = extractEnrollmentSecret([{ text: "", dataAttrs: { "data-otpauth": "otpauth://totp/Z:q?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" } }]);
  assert.equal(r3.ok, true);
}

{
  const r = extractEnrollmentSecret([
    { text: "Can't scan? Enter this setup key manually", label: "setup key" },
    { text: "JBSWY3DPEHPK3PXP" },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.source, "manual_key");
  assert.equal(r.secretBase32, "JBSWY3DPEHPK3PXP");
}

// A bare Base32-looking value is not enrollment proof; it could be an unrelated token.
{
  const r = extractEnrollmentSecret([{ value: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }]);
  assert.equal(r.ok, false);
}

{
  const r = extractEnrollmentSecret([{ text: "Open your authenticator app and scan the QR code below" }]);
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_secret_found");
}

{
  assert.equal(hasEnrollmentSuccessEvidence({ enabledCopy: true, securityEntry: false, subsequentChallenge: false }), false);
  assert.equal(hasEnrollmentSuccessEvidence({ enabledCopy: false, securityEntry: true, subsequentChallenge: false }), false);
  assert.equal(hasEnrollmentSuccessEvidence({ enabledCopy: true, securityEntry: true, subsequentChallenge: false }), true);
  assert.equal(hasEnrollmentSuccessEvidence({ enabledCopy: false, securityEntry: false, subsequentChallenge: true }), true);
  assert.equal(hasEnrollmentSuccessEvidence({ enabledCopy: false, securityEntry: false, subsequentChallenge: false }), false);
}

{
  assert.equal(isHighRiskMfaAction("Add authenticator"), true);
  assert.equal(isHighRiskMfaAction("Enable 2FA"), true);
  assert.equal(isHighRiskMfaAction("Remove authenticator"), true);
  assert.equal(isHighRiskMfaAction("Disable 2FA"), true);
  assert.equal(isHighRiskMfaAction("Replace authenticator"), true);
  assert.equal(isHighRiskMfaAction("Save"), false);
  assert.equal(requiresOwnerApprovalForEnrollment("Remove authenticator"), true);
  assert.equal(requiresOwnerApprovalForEnrollment("Disable 2FA"), true);
  assert.equal(requiresOwnerApprovalForEnrollment("Add authenticator"), true);
}

{
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE used_vault_items (task_id TEXT NOT NULL, candidate_id TEXT NOT NULL, PRIMARY KEY (task_id, candidate_id));`);

  const mockCtx: any = {
    storage: { sql: { exec: (s: string, ...args: unknown[]) => Object.assign(db.prepare(s).all(...(args as never[])), { toArray() { return this; } }) } },
    id: { name: "ws-enroll" },
    blockConcurrencyWhile: async (fn: any) => await fn(),
  };

  const ws = "ws-enroll";
  const itemId = "vi_enroll";
  const masterKey = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";
  const vdb = new DatabaseSync(":memory:");
  vdb.exec(`
    CREATE TABLE vault_items (id TEXT PRIMARY KEY, workspace_id TEXT, kind TEXT, label TEXT, account TEXT, origin TEXT, has_totp INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE encrypted_secrets (workspace_id TEXT, namespace TEXT, id TEXT, ciphertext TEXT, updated_at INTEGER, PRIMARY KEY(workspace_id, namespace, id));
  `);
  const initialFields = { username: "alice", password: "pw" };
  const ct0 = await encryptVaultPayload({ VAULT_MASTER_KEY: masterKey } as Env, ws, itemId, JSON.stringify(initialFields));
  vdb.prepare(`INSERT INTO vault_items (id, workspace_id, kind, label, account, origin, has_totp, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)`).run(itemId, ws, "login", "GitHub", "alice", "https://github.com", Date.now(), Date.now());
  vdb.prepare(`INSERT INTO encrypted_secrets (workspace_id, namespace, id, ciphertext, updated_at) VALUES (?,?,?,?,?)`).run(ws, "vault", itemId, ct0, Date.now());

  const mockEnv: any = {
    BROWSER: {},
    VAULT_MASTER_KEY: masterKey,
    TOTP_ENABLED: "1",
    TOTP_ENROLLMENT_ENABLED: "1",
    DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ meta: { changes: 1 } }) }) }), batch: async () => [] },
  };

  let batchable: Array<{ sql: string; args: unknown[] }> = [];
  const makeStmt = (sql: string, args: unknown[] = []) => ({
    first: async () => (vdb.prepare(sql).get(...(args as never[])) ?? null),
    all: async () => ({ results: vdb.prepare(sql).all(...(args as never[])) }),
    run: async () => { const r = vdb.prepare(sql).run(...(args as never[])); return { meta: { changes: r.changes ?? 0 }, success: true }; },
  });
  mockEnv.DB.prepare = (sql: string) => {
    const bound = (args: unknown[]) => {
      batchable.push({ sql, args });
      return makeStmt(sql, args);
    };
    return { bind: (...args: unknown[]) => bound(args), first: async () => (vdb.prepare(sql).get() ?? null), run: async () => { const r = vdb.prepare(sql).run(); return { meta: { changes: r.changes ?? 0 }, success: true }; } };
  };
  mockEnv.DB.batch = async () => {
    const out: any[] = [];
    for (const s of batchable) {
      const r = vdb.prepare(s.sql).run(...(s.args as never[]));
      out.push({ meta: { changes: r.changes ?? 0 }, success: true });
    }
    batchable = [];
    return out;
  };

  const worker = new (BrowserWorker as any)(mockCtx, mockEnv);
  worker.onStart();
  const inserted: string[] = [];
  worker.markSecret = async () => {};
  const mockCDP: any = { send: async (cmd: string, params: any) => { if (cmd === "Input.insertText") inserted.push(params.text); return {}; } };

  let evalCalls = 0;
  const mockPage: any = {
    url: () => "https://github.com/settings/two_factor_authentication/configure",
    mouse: { click: async () => {} },
    title: async () => "Configure 2FA",
    evaluate: async () => {
      evalCalls++;
      if (evalCalls === 1) {
        return [
          { text: "1. Scan this QR code or enter the setup key manually", value: "", href: "", dataAttrs: {}, label: "" },
          { text: "", value: "", href: "", dataAttrs: { "data-otpauth": "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub" }, label: "" },
        ];
      }
      if (evalCalls === 2) {
        return { inputs: [{ selector: 'input[data-totp-enroll-idx="0"]', x: 10, y: 20, name: "otp", id: "otp", autocomplete: "one-time-code", maxlength: 6, filled: false }] };
      }
      // Corroborated success: both enabled copy and a durable security-settings entry are visible.
      return { enabledCopy: true, securityEntry: true };
    },
  };

  const res = await worker.captureTotpEnrollment({ workspaceId: ws, taskId: "t_enroll", goal: "setup 2fa" }, mockPage, mockCDP, itemId);
  assert.equal(res.content, "Authenticator enrollment completed (pending -> active).");
  assert.equal(inserted.length >= 1, true);
  assert.match(inserted[0], /^\d{6}$/);
  assert.equal(res.content.includes(inserted[0]), false);

  const fields = await getItemFields(mockEnv, ws, itemId);
  const totp = fields?.__totp as any;
  assert.equal(totp.status, "active");
  assert.equal(totp.secretBase32, "JBSWY3DPEHPK3PXP");
  const hasTotpRow = vdb.prepare(`SELECT has_totp FROM vault_items WHERE id=?`).get(itemId) as any;
  assert.equal(hasTotpRow.has_totp, 1);
}

{
  const mockCtx: any = { storage: { sql: { exec: () => Object.assign([], { toArray() { return []; } }) } }, id: { name: "ws" }, blockConcurrencyWhile: async (f: any) => await f() };
  const worker = new (BrowserWorker as any)(mockCtx, { BROWSER: {}, TOTP_ENABLED: "1", TOTP_ENROLLMENT_ENABLED: "0" } as any);
  worker.onStart();
  const res = await worker.captureTotpEnrollment({ workspaceId: "ws", taskId: "t", goal: "g" }, {} as any, {} as any, "vi_x");
  assert.ok(res.content.includes("未启用"));
}

console.log("✔ Browser TOTP enrollment tests passed!");
