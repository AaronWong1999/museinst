
import assert from "node:assert/strict";
import { dispatchChannelEvent } from "../src/channels/dispatch";
import { createTestD1, d1Get, type TestD1 } from "./helpers/d1";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ Telegram bind code race & replay");

let mock: TgMock | null = null;
process.on("exit", () => mock?.restore());

function textEvent(senderId: string, text: string, messageId: string): any {
  return { channel: "telegram", senderId, messageId, kind: "text", text, receivedAt: Date.now() };
}

async function seedCode(d1: TestD1, code: string, workspaceId = "ws_target", userId = "u_target"): Promise<void> {
  await d1.db.prepare(`INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 0)`).run(userId);
  await d1.db.prepare(`INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, ?, 0)`).run(workspaceId, userId);
  await d1.db.prepare(
    `INSERT OR IGNORE INTO bind_nonces (nonce, workspace_id, user_id, purpose, expires_at) VALUES (?, ?, ?, 'bind_code', ?)`,
  ).run(code, workspaceId, userId, Date.now() + 24 * 3600 * 1000);
}

async function sendViaDispatch(d1: TestD1, senderId: string, text: string): Promise<string[]> {
  const collected: string[] = [];
  const env: any = { DB: d1, PUBLIC_BASE_URL: "https://example.com" };
  await dispatchChannelEvent(env, textEvent(senderId, text, `${senderId}:m`), async (texts) => {
    collected.push(...texts);
  });
  return collected;
}


{
  const d1 = createTestD1();
  await seedCode(d1, "ABC123");
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));

  const r1 = await sendViaDispatch(d1, "111", "/start abc123");
  const code1 = await d1Get<any>(d1, `SELECT used_at, used_by_external_id, claim_state FROM bind_nonces WHERE nonce='ABC123'`);
  assert.ok(code1.used_at, "first consumer must win");
  assert.equal(code1.used_by_external_id, "111");
  assert.equal(code1.claim_state, "consumed");
  assert.ok(r1.join(" ").includes("✅"), "winner gets boundOk copy");

  const r2 = await sendViaDispatch(d1, "222", "/start ABC123");
  assert.ok(!r2.join(" ").includes("✅"), "second consumer must not bind");
  assert.ok(r2.join(" ").length > 0, "second consumer gets invalid-code guide");
  console.log("  ✅ concurrent consumption: exactly one winner");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await seedCode(d1, "DEF456");
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  await sendViaDispatch(d1, "333", "/start def456");
  const row1 = await d1Get<any>(d1, `SELECT result_login_nonce FROM bind_nonces WHERE nonce='DEF456'`);
  assert.ok(row1.result_login_nonce);
  const replay = await sendViaDispatch(d1, "333", "/start DEF456");
  const row2 = await d1Get<any>(d1, `SELECT result_login_nonce FROM bind_nonces WHERE nonce='DEF456'`);
  assert.equal(row1.result_login_nonce, row2.result_login_nonce, "same login nonce replayed");
  assert.ok(replay[0].includes(row1.result_login_nonce), "replayed reply contains the same nonce");
  console.log("  ✅ same sender re-delivery replays same login nonce");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await seedCode(d1, "GHI789", "ws_b", "u_b");

  await d1.db.prepare(`INSERT OR IGNORE INTO users (id, created_at) VALUES ('u_a', 0)`).run();
  await d1.db.prepare(`INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES ('ws_a', 'u_a', 0)`).run();
  await d1.db.prepare(`INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '444', 'ws_a', 0, 0)`).run();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));

  await sendViaDispatch(d1, "444", "/start GHI789");
  const row = await d1Get<any>(d1, `SELECT claim_state, used_at FROM bind_nonces WHERE nonce='GHI789'`);
  assert.equal(row.used_at, null, "must not be consumed on failed bind");
  assert.equal(row.claim_state, null, "claim must be released on failed bind");
  console.log("  ✅ failed bind releases claim");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await d1.db.prepare(`INSERT OR IGNORE INTO users (id, created_at) VALUES ('u_a', 0)`).run();
  await d1.db.prepare(`INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES ('ws_a', 'u_a', 0)`).run();
  await d1.db.prepare(`INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '555', 'ws_a', 0, 0)`).run();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  const r = await sendViaDispatch(d1, "555", "/start");
  assert.match(r[0], /\/bind\//, "already-bound sender gets one-time login link");
  console.log("  ✅ /start (bound) → login link");
  mock.restore();
  mock = null;
}

console.log("✅ telegram-bind-race.test.ts passed");
