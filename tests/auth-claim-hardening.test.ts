




import assert from "node:assert/strict";
import {
  dispatchChannelEvent,
  dispatchExternalEmail,
  createBindCode,
} from "../src/channels/dispatch";
import { consumeLoginNonceAndCreateSession, createSession, readSession, sessionCookieHeader } from "../src/session";
import { deriveSecurityContext, emailScopeKey } from "../src/security/context";
import { createTestD1, d1All, d1Get, type TestD1 } from "./helpers/d1";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ auth claim hardening (P0-01 / A05 / P1-12 / P2-03)");

const BIND_LEASE_MS = 60 * 1000;
const LOGIN_LEASE_MS = 60 * 1000;

let mock: TgMock | null = null;
process.on("exit", () => mock?.restore());

// ── helpers ─────────────────────────────────────────────────────────────────

function textEvent(senderId: string, text: string, messageId: string): any {
  return { channel: "telegram", senderId, messageId, kind: "text", text, receivedAt: Date.now() };
}

function sessionEnv(d1: TestD1, extra: Record<string, unknown> = {}): any {
  return { DB: d1, PUBLIC_BASE_URL: "https://example.com", OPENINST_SECRET: "claim-test-secret-0123456789", ...extra };
}

async function seedWorkspace(d1: TestD1, workspaceId: string, userId: string): Promise<void> {
  await d1.db.prepare(`INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 0)`).run(userId);
  await d1.db.prepare(`INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, ?, 0)`).run(workspaceId, userId);
}

async function seedBindCode(d1: TestD1, code: string, workspaceId = "ws_target", userId = "u_target"): Promise<void> {
  await seedWorkspace(d1, workspaceId, userId);
  await d1.db
    .prepare(`INSERT OR IGNORE INTO bind_nonces (nonce, workspace_id, user_id, purpose, expires_at) VALUES (?, ?, ?, 'bind_code', ?)`)
    .run(code, workspaceId, userId, Date.now() + 24 * 3600 * 1000);
}


async function seedPendingClaim(
  d1: TestD1,
  code: string,
  opts: { token: string; channel?: string; externalId?: string; claimedAt: number },
): Promise<void> {
  await d1.db
    .prepare(`UPDATE bind_nonces SET claim_state='pending', claim_token=?, claimed_at=?, claim_channel=?, claim_external_id=? WHERE nonce=?`)
    .run(opts.token, opts.claimedAt, opts.channel ?? "telegram", opts.externalId ?? "", code);
}

async function sendViaDispatch(d1: TestD1, senderId: string, text: string): Promise<{ replies: string[]; result: string }> {
  const collected: string[] = [];
  const env = sessionEnv(d1);
  const result = await dispatchChannelEvent(env, textEvent(senderId, text, `${senderId}:m`), async (texts) => {
    collected.push(...texts);
  });
  return { replies: collected, result };
}

async function seedLoginNonce(d1: TestD1, nonce: string, workspaceId = "ws_login", userId = "u_login"): Promise<void> {
  await seedWorkspace(d1, workspaceId, userId);
  await d1.db
    .prepare(`INSERT INTO bind_nonces (nonce, workspace_id, user_id, purpose, expires_at) VALUES (?, ?, ?, 'login', ?)`)
    .run(nonce, workspaceId, userId, Date.now() + 5 * 60 * 1000);
}

type RunResult = { meta: { changes: number }; success: boolean };


function interceptD1(
  d1: TestD1,
  hooks: {
    beforeRun?: (sql: string, args: unknown[]) => "skip" | void;
    afterRun?: (sql: string, args: unknown[], result: RunResult) => void;
  },
): TestD1 {
  return {
    db: d1.db,
    batch: (stmts) => d1.batch(stmts),
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        const inner = d1.prepare(sql).bind(...args);
        return {
          first: <T>() => inner.first<T>(),
          all: <T>() => inner.all<T>(),
          run: async (): Promise<RunResult> => {
            if (hooks.beforeRun?.(sql, args) === "skip") {
              const r: RunResult = { meta: { changes: 0 }, success: true };
              hooks.afterRun?.(sql, args, r);
              return r;
            }
            const r = (await inner.run()) as RunResult;
            hooks.afterRun?.(sql, args, r);
            return r;
          },
        };
      },
    }),
  };
}



{
  const d1 = createTestD1();
  await seedBindCode(d1, "FRESHCODE1");

  await seedPendingClaim(d1, "FRESHCODE1", { token: "tok_a", externalId: "100", claimedAt: Date.now() });
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));

  const r = await sendViaDispatch(d1, "200", "/start FRESHCODE1");
  assert.ok(!r.replies.join(" ").includes("✅"), "fresh claim must not be stolen by another sender");
  const row = await d1Get<any>(d1, `SELECT claim_token, used_at FROM bind_nonces WHERE nonce='FRESHCODE1'`);
  assert.equal(row.claim_token, "tok_a", "claim token must stay with the first claimer");
  assert.equal(row.used_at, null);
  const ids = await d1All<any>(d1, `SELECT external_id FROM channel_identities`);
  assert.equal(ids.length, 0, "thief must not create any identity");
  console.log("  ✅ fresh pending claim: second sender cannot steal");

  mock.restore();
  mock = null;
}



{
  const d1 = createTestD1();
  await seedBindCode(d1, "STALECODE1");
  await seedPendingClaim(d1, "STALECODE1", { token: "tok_old", externalId: "100", claimedAt: Date.now() - 2 * BIND_LEASE_MS });
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));

  const r = await sendViaDispatch(d1, "100", "/start STALECODE1");
  assert.ok(r.replies.join(" ").includes("✅"), "same sender must recover a stale claim");
  const row = await d1Get<any>(d1, `SELECT used_at, used_by_external_id, claim_state FROM bind_nonces WHERE nonce='STALECODE1'`);
  assert.ok(row.used_at, "code consumed");
  assert.equal(row.used_by_external_id, "100");
  assert.equal(row.claim_state, "consumed");
  const id = await d1Get<any>(d1, `SELECT workspace_id FROM channel_identities WHERE channel='telegram' AND external_id='100'`);
  assert.equal(id.workspace_id, "ws_target");
  console.log("  ✅ stale pending claim: same sender recovers");

  mock.restore();
  mock = null;
}



{
  const d1 = createTestD1();
  await seedBindCode(d1, "STALECODE2");
  await seedPendingClaim(d1, "STALECODE2", { token: "tok_old", externalId: "100", claimedAt: Date.now() - 2 * BIND_LEASE_MS });
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));

  const r = await sendViaDispatch(d1, "300", "/start STALECODE2");
  assert.ok(!r.replies.join(" ").includes("✅"), "stale claim must not be taken over by a different sender");
  const row = await d1Get<any>(d1, `SELECT claim_token, used_at FROM bind_nonces WHERE nonce='STALECODE2'`);
  assert.equal(row.claim_token, "tok_old", "claimant identity binding must survive lease expiry");
  assert.equal(row.used_at, null);
  const ids = await d1All<any>(d1, `SELECT external_id FROM channel_identities`);
  assert.equal(ids.length, 0);
  console.log("  ✅ stale pending claim: different sender cannot take over");

  mock.restore();
  mock = null;
}



{
  const d1 = createTestD1();
  await seedBindCode(d1, "RACECODE01");
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));

  const [a, b] = await Promise.all([sendViaDispatch(d1, "410", "/start RACECODE01"), sendViaDispatch(d1, "411", "/start RACECODE01")]);
  const winners = [
    { sender: "410", ok: a.replies.join(" ").includes("✅") },
    { sender: "411", ok: b.replies.join(" ").includes("✅") },
  ].filter((w) => w.ok);
  assert.equal(winners.length, 1, "exactly one successful response");

  const row = await d1Get<any>(d1, `SELECT used_at, used_by_external_id, claim_state FROM bind_nonces WHERE nonce='RACECODE01'`);
  assert.ok(row.used_at);
  assert.equal(row.used_by_external_id, winners[0].sender, "consumed owner = the winning sender");
  assert.equal(row.claim_state, "consumed");

  const ids = await d1All<any>(d1, `SELECT external_id, workspace_id FROM channel_identities`);
  assert.equal(ids.length, 1, "exactly one identity created");
  assert.equal(ids[0].external_id, winners[0].sender);
  assert.equal(ids[0].workspace_id, "ws_target");
  console.log("  ✅ Promise.all race: exactly one identity / one success");

  mock.restore();
  mock = null;
}



{
  const d1 = createTestD1();
  const nonce = "LOGINNONCE000001";
  await seedLoginNonce(d1, nonce);

  await d1.db
    .prepare(`UPDATE bind_nonces SET claim_state='pending', claim_token='fresh_tok', claimed_at=? WHERE nonce=?`)
    .run(Date.now(), nonce);

  const r = await consumeLoginNonceAndCreateSession(sessionEnv(d1), nonce);
  assert.equal(r.ok, false, "fresh pending lease must not be stolen");
  const row = await d1Get<any>(d1, `SELECT claim_token FROM bind_nonces WHERE nonce=?`, nonce);
  assert.equal(row.claim_token, "fresh_tok");
  assert.equal((await d1All<any>(d1, `SELECT id FROM sessions`)).length, 0, "no session created for the thief");
  console.log("  ✅ login nonce: fresh pending claim not stealable");
}

{
  const d1 = createTestD1();
  const nonce = "LOGINNONCE000002";
  await seedLoginNonce(d1, nonce);

  const [r1, r2] = await Promise.all([
    consumeLoginNonceAndCreateSession(sessionEnv(d1), nonce),
    consumeLoginNonceAndCreateSession(sessionEnv(d1), nonce),
  ]);
  assert.equal([r1, r2].filter((r) => r.ok).length, 1, "only one concurrent consumer creates a session");
  const sessions = await d1All<any>(d1, `SELECT id FROM sessions`);
  assert.equal(sessions.length, 1, "exactly one session row");
  const row = await d1Get<any>(d1, `SELECT used_at, claim_state FROM bind_nonces WHERE nonce=?`, nonce);
  assert.ok(row.used_at);
  assert.equal(row.claim_state, "consumed");
  console.log("  ✅ login nonce: Promise.all race → one session");
}



{
  const d1 = createTestD1();
  await seedBindCode(d1, "RELTOKEN01");
  let tookOver = false;
  const hooked = interceptD1(d1, {
    afterRun: (sql) => {

      if (!tookOver && sql.includes("SET claim_state='pending'") && sql.includes("claim_channel=?")) {
        tookOver = true;
        d1.db
          .prepare(`UPDATE bind_nonces SET claim_token='tok_new_worker', claimed_at=?, claim_channel='telegram', claim_external_id='999' WHERE nonce='RELTOKEN01'`)
          .run(Date.now());
      }
    },
  });
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));

  const r = await sendViaDispatch(hooked, "888", "/start RELTOKEN01");
  assert.ok(!r.replies.join(" ").includes("✅"), "lost claim must not be reported as success");
  const row = await d1Get<any>(d1, `SELECT claim_token, claim_state, claim_channel, claim_external_id FROM bind_nonces WHERE nonce='RELTOKEN01'`);
  assert.equal(row.claim_token, "tok_new_worker", "release must not clear another worker's claim token");
  assert.equal(row.claim_state, "pending");
  assert.equal(row.claim_external_id, "999");
  console.log("  ✅ stale worker release cannot clear the new claim token");

  mock.restore();
  mock = null;
}



{
  const d1 = createTestD1();
  await seedBindCode(d1, "FINALFAIL1");
  let blockedConsume = false;
  const hooked = interceptD1(d1, {
    beforeRun: (sql) => {

      if (!blockedConsume && sql.includes("result_login_nonce=?")) {
        blockedConsume = true;
        return "skip";
      }
    },
  });
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));

  const r = await sendViaDispatch(hooked, "501", "/start FINALFAIL1");
  assert.ok(blockedConsume, "consume path must be exercised");
  assert.ok(!r.replies.join(" ").includes("✅"), "failed consume must never announce success");
  const code = await d1Get<any>(d1, `SELECT used_at, claim_state, claim_token FROM bind_nonces WHERE nonce='FINALFAIL1'`);
  assert.equal(code.used_at, null, "code must not look consumed");
  assert.equal(code.claim_state, null, "claim released so the sender can retry");
  assert.equal(code.claim_token, null);
  const orphanNonces = await d1All<any>(d1, `SELECT nonce FROM bind_nonces WHERE purpose='login'`);
  assert.equal(orphanNonces.length, 0, "undelivered login nonce must be cleaned up");
  console.log("  ✅ failed finalize: no success announcement, no orphan login nonce");

  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  const nonce = "LOGINNONCE000003";
  await seedLoginNonce(d1, nonce);
  await d1.db
    .prepare(`UPDATE bind_nonces SET claim_state='pending', claim_token='stale_tok', claimed_at=? WHERE nonce=?`)
    .run(Date.now() - 2 * LOGIN_LEASE_MS, nonce);

  const r = await consumeLoginNonceAndCreateSession(sessionEnv(d1), nonce);
  assert.equal(r.ok, true, "stale login lease must be reclaimable");
  const row = await d1Get<any>(d1, `SELECT used_at, claim_state, claim_token FROM bind_nonces WHERE nonce=?`, nonce);
  assert.ok(row.used_at);
  assert.equal(row.claim_state, "consumed");
  assert.notEqual(row.claim_token, "stale_tok", "claim token rotated on reclaim");
  console.log("  ✅ login nonce: stale lease recoverable");
}



function fakeAgentNamespace(replies: string[]): { ns: any; calls: Array<{ room: string; path: string; body: any }> } {
  const calls: Array<{ room: string; path: string; body: any }> = [];
  const ns = {
    idFromName: (name: string) => ({ __room: name }),
    get: (id: any) => ({
      fetch: async (url: string | URL, init?: RequestInit) => {
        const u = new URL(String(url));
        calls.push({ room: id.__room, path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ replies, taskId: "task_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };
  return { ns, calls };
}

function emailSecurity(workspaceId: string, from: string) {
  return deriveSecurityContext({
    claims: {
      source: "email",
      workspaceId,
      scopeKey: emailScopeKey("aabbccddeeff0011", "thread_1"),
      peerAddress: from,
    },
    identity: { peerAddress: from, contactClass: "unknown", addressVerifiedByOwner: false, messageAuth: "none" },
    approvalRoute: null,
  });
}

{
  const d1 = createTestD1();
  const { ns, calls } = fakeAgentNamespace(["hello from agent"]);
  const env = sessionEnv(d1, { AGENT: ns });
  const sent: string[] = [];

  const r = await dispatchExternalEmail(
    env,
    { workspaceId: "ws_recipient", from: "stranger@example.net", to: "agent@openinst.com", text: "hi", messageRowId: "em_1", messageId: "fp_1" },
    async (texts) => {
      sent.push(...texts);
    },
    { security: emailSecurity("ws_recipient", "stranger@example.net") },
  );

  assert.equal(r, "handled");
  assert.equal(calls.length, 1, "DO must be called even for an unregistered sender");
  assert.equal(calls[0].room, "ws_recipient", "DO target comes from the trusted mailbox route");
  assert.equal(calls[0].path, "/event");
  assert.equal(calls[0].body.event.channel, "email");
  assert.equal(calls[0].body.event.senderId, "stranger@example.net");
  assert.equal(calls[0].body.security.workspaceId, "ws_recipient");
  assert.equal(calls[0].body.security.authenticatedOwner, false);
  assert.equal(sent[0], "hello from agent");
  const ids = await d1All<any>(d1, `SELECT channel, external_id FROM channel_identities`);
  assert.equal(ids.length, 0, "external email must not create channel_identities for the sender");
  console.log("  ✅ A05: stranger email routed to recipient workspace, no identity created");
}

{
  const d1 = createTestD1();
  await seedBindCode(d1, "EMAILBIND1", "ws_recipient", "u_recipient");
  const { ns, calls } = fakeAgentNamespace(["ok"]);
  const env = sessionEnv(d1, { AGENT: ns });

  const r = await dispatchExternalEmail(
    env,
    { workspaceId: "ws_recipient", from: "stranger@example.net", text: "/bind EMAILBIND1", messageRowId: "em_2", messageId: "fp_2" },
    async () => {},
    { security: emailSecurity("ws_recipient", "stranger@example.net") },
  );

  assert.equal(r, "handled");
  const code = await d1Get<any>(d1, `SELECT used_at, claim_state, claim_token FROM bind_nonces WHERE nonce='EMAILBIND1'`);
  assert.equal(code.used_at, null, "/bind inside an email body must not consume the code");
  assert.equal(code.claim_state, null);
  assert.equal(code.claim_token, null);
  assert.equal((await d1All<any>(d1, `SELECT channel, external_id FROM channel_identities`)).length, 0, "no identity/link created");
  assert.equal((await d1All<any>(d1, `SELECT id FROM sessions`)).length, 0, "no owner session created");
  assert.equal(calls[0].body.event.text, "/bind EMAILBIND1", "body text reaches the agent as plain text");
  console.log("  ✅ A05: /bind in email body never consumes a bind code");
}

{
  const d1 = createTestD1();
  const { ns, calls } = fakeAgentNamespace(["x"]);
  const env = sessionEnv(d1, { AGENT: ns });


  const mismatch = await dispatchExternalEmail(
    env,
    { workspaceId: "ws_attacker", from: "stranger@example.net", text: "hi", messageRowId: "em_3", messageId: "fp_3" },
    async () => {},
    { security: emailSecurity("ws_recipient", "stranger@example.net") },
  );
  assert.equal(mismatch, "failed");
  assert.equal(calls.length, 0, "mismatched target must not reach any DO");


  const noSecurity = await dispatchChannelEvent(
    env,
    { channel: "email", senderId: "stranger@example.net", messageId: "fp_4", kind: "text", text: "hi", receivedAt: Date.now() },
    async () => {},
  );
  assert.equal(noSecurity, "failed");
  assert.equal(calls.length, 0);
  console.log("  ✅ A05: mismatched/missing trusted context is refused, never sender-routed");
}



{
  const d1 = createTestD1();
  const hostedNoSecret: any = { DB: d1, EDITION: "hosted", PUBLIC_BASE_URL: "https://example.com" };
  await assert.rejects(() => createSession(hostedNoSecret, "u1", "w1"), /OPENINST_SECRET_REQUIRED/);

  const hostedDevDefault: any = { ...hostedNoSecret, OPENINST_SECRET: "dev-insecure" };
  await assert.rejects(() => createSession(hostedDevDefault, "u1", "w1"), /OPENINST_SECRET_REQUIRED/);

  const hostedShort: any = { ...hostedNoSecret, OPENINST_SECRET: "short-secret" };
  await assert.rejects(() => createSession(hostedShort, "u1", "w1"), /OPENINST_SECRET_REQUIRED/);

  const nonce = "HOSTEDNONCE00001";
  await seedLoginNonce(d1, nonce);
  await assert.rejects(() => consumeLoginNonceAndCreateSession(hostedNoSecret, nonce), /OPENINST_SECRET_REQUIRED/);

  await assert.rejects(
    () => readSession(hostedNoSecret, new Request("https://example.com/workspace", { headers: { cookie: "oi=deadbeef.c2ln" } })),
    /OPENINST_SECRET_REQUIRED/,
  );
  assert.equal((await d1All<any>(d1, `SELECT id FROM sessions`)).length, 0, "hosted must not create any session without secret");
  assert.equal((await d1Get<any>(d1, `SELECT used_at FROM bind_nonces WHERE nonce=?`, nonce))?.used_at, null, "nonce not consumed");
  console.log("  ✅ P1-12: deployed instance without a valid secret hard-fails");
}

{
  // Local insecure fallback exists only behind an explicit development flag.
  const d1 = createTestD1();
  const dev: any = { DB: d1, PUBLIC_BASE_URL: "http://127.0.0.1:8787", ALLOW_INSECURE_DEV_SESSION: "1" };
  const { cookie } = await createSession(dev, "u_dev", "w_dev");
  const req = new Request("http://127.0.0.1:8787/workspace", { headers: { cookie: sessionCookieHeader(cookie) } });
  const s = await readSession(dev, req);
  assert.equal(s?.userId, "u_dev");
  assert.equal(s?.workspaceId, "w_dev");
  console.log("  ✅ P1-12: insecure local dev fallback requires explicit opt-in");
}



{
  const d1 = createTestD1();
  let insertAttempts = 0;
  const failFirst = 7;
  const flaky = interceptD1(d1, {
    beforeRun: (sql) => {
      if (!sql.includes("INSERT OR IGNORE INTO bind_nonces")) return;
      insertAttempts++;
      if (insertAttempts <= failFirst) return "skip";
    },
  });

  const code = await createBindCode(sessionEnv(flaky), "ws_code", "u_code");
  assert.equal(insertAttempts, failFirst + 1, "retries until an insert actually succeeds");
  assert.equal(code.length, 10, "bind code entropy >= 10 base32 chars");
  assert.match(code, /^[A-Z0-9]{10}$/);
  assert.match(code, /^[A-Za-z0-9]{8,64}$/, "compatible with /bind/:nonce route validation");
  const row = await d1Get<any>(d1, `SELECT workspace_id, user_id, purpose FROM bind_nonces WHERE nonce=?`, code);
  assert.ok(row, "returned code must really be inserted");
  assert.equal(row.workspace_id, "ws_code");
  assert.equal(row.purpose, "bind_code");
  console.log("  ✅ P2-03: collisions retried, only inserted code returned");
}

{
  const d1 = createTestD1();
  let attempts = 0;
  const always = interceptD1(d1, {
    beforeRun: (sql) => {
      if (!sql.includes("INSERT OR IGNORE INTO bind_nonces")) return;
      attempts++;
      return "skip";
    },
  });
  await assert.rejects(() => createBindCode(sessionEnv(always), "ws_code", "u_code"), /bind_code_generation_failed/);
  assert.equal(attempts, 20, "retry cap reached → hard fail");
  assert.equal((await d1All<any>(d1, `SELECT nonce FROM bind_nonces`)).length, 0, "nothing inserted");
  console.log("  ✅ P2-03: retry cap → hard fail, never returns an uninserted code");
}

console.log("✅ auth-claim-hardening.test.ts passed");
