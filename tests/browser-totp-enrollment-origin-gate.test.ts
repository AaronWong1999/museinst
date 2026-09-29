// BrowserWorker TOTP enrollment exact-origin regression coverage.
// Enrollment material is long-lived authentication state and must never be extracted from a page
// whose origin differs from the login item's bound origin.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BrowserWorker } from "../src/agent/browser-worker";

console.log("▶ Browser TOTP enrollment exact-origin fail-closed gate...");

function makeWorker(origin: string | null) {
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
    id: { name: "ws-enrollment-origin-gate" },
    blockConcurrencyWhile: async (fn: any) => await fn(),
  };

  let secretReads = 0;
  const mockEnv: any = {
    BROWSER: {},
    TOTP_ENABLED: "1",
    TOTP_ENROLLMENT_ENABLED: "1",
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM vault_items")) {
              return {
                id: "vi_enrollment_origin_gate",
                workspace_id: "ws-enrollment-origin-gate",
                kind: "login",
                label: "OriginBound",
                account: "alice",
                origin,
                has_totp: 0,
              };
            }
            if (sql.includes("FROM encrypted_secrets")) {
              secretReads++;
              throw new Error("enrollment must reject before reading Vault secret state");
            }
            return null;
          },
          run: async () => ({ meta: { changes: 1 }, success: true }),
        }),
      }),
      batch: async () => [],
    },
  };

  const worker = new (BrowserWorker as any)(mockCtx, mockEnv);
  worker.onStart();
  return { worker, secretReads: () => secretReads };
}

async function expectRejected(currentUrl: string, boundOrigin: string | null, code: RegExp) {
  const { worker, secretReads } = makeWorker(boundOrigin);
  let evaluated = false;
  let injected = false;
  const page: any = {
    url: () => currentUrl,
    mouse: { click: async () => { injected = true; } },
    evaluate: async () => { evaluated = true; throw new Error("must not inspect enrollment material on rejected origin"); },
  };
  const cdp: any = { send: async () => { injected = true; return {}; } };

  const res = await worker.captureTotpEnrollment(
    { workspaceId: "ws-enrollment-origin-gate", taskId: `t_${currentUrl}`, goal: "setup authenticator", startUrl: currentUrl, vaultHints: [], lang: "en" },
    page,
    cdp,
    "vi_enrollment_origin_gate",
  );

  assert.match(res.content, code);
  assert.equal(secretReads(), 0);
  assert.equal(evaluated, false, "origin rejection must precede otpauth/setup-key DOM extraction");
  assert.equal(injected, false);
}

await expectRejected("https://evil.example.com/security", "https://example.com", /vault_totp_enrollment_origin_mismatch/);
await expectRejected("http://example.com/security", "https://example.com", /vault_totp_enrollment_origin_mismatch/);
await expectRejected("https://example.com:8443/security", "https://example.com", /vault_totp_enrollment_origin_mismatch/);
await expectRejected("https://example.com/security", null, /vault_totp_enrollment_origin_missing/);
await expectRejected("not a url", "https://example.com", /vault_totp_enrollment_origin_invalid/);

console.log("✔ Browser TOTP enrollment exact-origin gate passed!");
