// BrowserWorker TOTP exact-origin regression coverage.
// The TOTP secret must not even be decrypted/generated until the current browser origin exactly
// matches the login item's bound origin. Sibling subdomains, scheme changes and port changes fail.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BrowserWorker } from "../src/agent/browser-worker";

console.log("▶ Browser TOTP exact-origin fail-closed gate...");

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
    id: { name: "ws-origin-gate" },
    blockConcurrencyWhile: async (fn: any) => await fn(),
  };

  let secretReads = 0;
  const mockEnv: any = {
    BROWSER: {},
    TOTP_ENABLED: "1",
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM vault_items")) {
              return {
                id: "vi_origin_gate",
                workspace_id: "ws-origin-gate",
                kind: "login",
                label: "OriginBound",
                account: "alice",
                origin,
                has_totp: 1,
              };
            }
            if (sql.includes("FROM encrypted_secrets")) {
              secretReads++;
              throw new Error("TOTP secret must not be read before origin admission");
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
    evaluate: async () => { evaluated = true; return {}; },
  };
  const cdp: any = { send: async () => { injected = true; return {}; } };

  const res = await worker.fillTotpFromVault(
    { workspaceId: "ws-origin-gate", taskId: `t_${currentUrl}`, goal: "login", startUrl: currentUrl, vaultHints: [], lang: "en" },
    page,
    cdp,
    "vi_origin_gate",
  );

  assert.match(res.content, code);
  assert.equal(secretReads(), 0, "rejection must happen before decrypting the TOTP secret");
  assert.equal(evaluated, false, "rejection must happen before page probing");
  assert.equal(injected, false, "rejection must not click or inject text");
}

await expectRejected("https://evil.example.com/mfa", "https://example.com", /vault_totp_origin_mismatch/);
await expectRejected("http://example.com/mfa", "https://example.com", /vault_totp_origin_mismatch/);
await expectRejected("https://example.com:8443/mfa", "https://example.com", /vault_totp_origin_mismatch/);
await expectRejected("https://example.com/mfa", null, /vault_totp_origin_missing/);
await expectRejected("not a url", "https://example.com", /vault_totp_origin_invalid/);

console.log("✔ Browser TOTP exact-origin gate passed!");
