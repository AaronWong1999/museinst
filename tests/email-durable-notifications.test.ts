
import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import type { Env } from "../src/env";
import {
  shouldNotifyOwner,
  ensureOwnerEmailNotification,
  driveOwnerEmailNotifications,
  resolveOwnerNotificationChannel,
  formatOwnerNotificationText,
} from "../src/channels/email/notifications";
import { setHostHooks, resetHostHooks } from "../src/hooks";

console.log("▶ Agent Mail durable owner notifications (V2 §22/§23/§24/§41)");

const WS = "w_notif_test";
const TO = "agent@mail.openinst.com";
const FROM = "client@example.org";

function seed(d1: TestD1) {
  d1Exec(d1, `INSERT OR IGNORE INTO users (id, created_at) VALUES ('u_notif', 0)`);
  d1Exec(d1, `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_notif', 0)`, WS);
  d1Exec(
    d1,
    `INSERT OR REPLACE INTO agent_mailboxes
      (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, notify_channel, created_at, updated_at)
     VALUES (?, 'agent', 'mail.openinst.com', ?, 'active', 100, 300, 1, 'wechat', 0, 0)`,
    WS, TO,
  );
}

function insertMessage(d1: TestD1, id: string, overrides: Record<string, any> = {}) {
  const defaults = {
    id,
    workspace_id: WS,
    direction: "in",
    fingerprint: `fp_${id}`,
    raw_sha256: "sha_dummy",
    thread_id: `th_${id}`,
    from_addr: FROM,
    to_addr: TO,
    subject: "Meeting Request for Q3 Review and Planning",
    snippet: "Hi there...",
    body_text: "Hi there, let's meet.",
    scope_key: `scope_${id}`,
    message_auth: "none",
    ingest_state: "processed",
    created_at: Date.now(),
  };
  const d = { ...defaults, ...overrides };
  d1Exec(
    d1,
    `INSERT INTO email_messages (id, workspace_id, direction, fingerprint, raw_sha256, thread_id,
      from_addr, to_addr, subject, snippet, body_text, scope_key, message_auth, ingest_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.id, d.workspace_id, d.direction, d.fingerprint, d.raw_sha256, d.thread_id,
    d.from_addr, d.to_addr, d.subject, d.snippet, d.body_text, d.scope_key, d.message_auth,
    d.ingest_state, d.created_at,
  );
}


assert.equal(shouldNotifyOwner("processed"), true);
assert.equal(shouldNotifyOwner("stored_empty_body"), true);
assert.equal(shouldNotifyOwner("stranger_autoreply_off"), true);
assert.equal(shouldNotifyOwner("stored_quota_exceeded"), true);
assert.equal(shouldNotifyOwner("stored_dispatch_exhausted"), true);
assert.equal(shouldNotifyOwner("stored_policy_revoked"), true);

assert.equal(shouldNotifyOwner("unparseable"), false);
assert.equal(shouldNotifyOwner("blocked"), false);
assert.equal(shouldNotifyOwner("auto_submitted"), false);
assert.equal(shouldNotifyOwner("dispatch_failed"), false, "transient failure must not notify");


{
  const d1 = createTestD1();
  seed(d1);
  insertMessage(d1, "em_n1");
  const env: any = { DB: d1 };

  const id1 = await ensureOwnerEmailNotification(env, { workspaceId: WS, rowId: "em_n1", reason: "processed" });
  assert.ok(id1);


  const id2 = await ensureOwnerEmailNotification(env, { workspaceId: WS, rowId: "em_n1", reason: "processed" });
  assert.equal(id1, id2);

  const count = await d1Get<any>(d1, `SELECT COUNT(*) AS c FROM email_owner_notifications WHERE email_row_id='em_n1'`);
  assert.equal(count.c, 1);
  console.log("  ✅ ensureOwnerEmailNotification is idempotent by (email_row_id, kind)");
}


{
  const d1 = createTestD1();
  seed(d1);
  const env: any = { DB: d1 };


  const routeWeb = await resolveOwnerNotificationChannel(env, WS);
  assert.equal(routeWeb.channel, "web");


  d1Exec(d1, `INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', 'tg_123', ?, 0, 100)`, WS);
  const routeTg = await resolveOwnerNotificationChannel(env, WS);
  assert.equal(routeTg.channel, "telegram");
  assert.equal(routeTg.externalId, "tg_123");


  d1Exec(d1, `INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('wechat', 'wx_456', ?, 0, 200)`, WS);
  const routeWx = await resolveOwnerNotificationChannel(env, WS);
  assert.equal(routeWx.channel, "wechat");
  assert.equal(routeWx.externalId, "wx_456");

  console.log("  ✅ resolveOwnerNotificationChannel follows preferred -> wechat -> telegram -> web");
}


{
  resetHostHooks();
  const d1 = createTestD1();
  seed(d1);
  insertMessage(d1, "em_n2");
  d1Exec(d1, `INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '123456', ?, 0, 100)`, WS);

  let failSend = true;
  let sentOutbounds: any[] = [];

  setHostHooks({
    sendOutbound: async (_e, channel, externalId, text) => {
      if (failSend) return { handled: true, ok: false, error: "network_timeout" };
      sentOutbounds.push({ channel, externalId, text });
      return { handled: true, ok: true };
    },
  });

  const env: any = { DB: d1 };
  await ensureOwnerEmailNotification(env, { workspaceId: WS, rowId: "em_n2", reason: "processed" });


  const run1 = await driveOwnerEmailNotifications(env, 20, Date.now());
  assert.equal(run1.retried, 1);
  assert.equal(run1.sent, 0);


  let mailRow = await d1Get<any>(d1, `SELECT notified_at FROM email_messages WHERE id='em_n2'`);
  assert.equal(mailRow.notified_at, null, "notified_at must remain NULL until accepted");

  const notifRow1 = await d1Get<any>(d1, `SELECT status, attempts, next_attempt_at FROM email_owner_notifications WHERE email_row_id='em_n2'`);
  assert.equal(notifRow1.status, "retry_wait");
  assert.equal(notifRow1.attempts, 1);
  assert.ok(notifRow1.next_attempt_at > Date.now());


  failSend = false;
  const run2 = await driveOwnerEmailNotifications(env, 20, notifRow1.next_attempt_at + 1000);
  assert.equal(run2.sent, 1);


  mailRow = await d1Get<any>(d1, `SELECT notified_at FROM email_messages WHERE id='em_n2'`);
  assert.ok(mailRow.notified_at > 0, "notified_at is stamped after successful delivery");

  const notifRow2 = await d1Get<any>(d1, `SELECT status, sent_at FROM email_owner_notifications WHERE email_row_id='em_n2'`);
  assert.equal(notifRow2.status, "sent");
  assert.ok(notifRow2.sent_at > 0);

  assert.equal(sentOutbounds.length, 1);
  assert.ok(sentOutbounds[0].text.includes("agent@mail.openinst.com"));
  assert.ok(sentOutbounds[0].text.includes("client@example.org"));

  console.log("  ✅ notifications retry reliably and notified_at is written only after accepted");
  resetHostHooks();
}


{
  resetHostHooks();
  const d1 = createTestD1();
  seed(d1);
  insertMessage(d1, "em_web");
  const env: any = { DB: d1 };

  await ensureOwnerEmailNotification(env, { workspaceId: WS, rowId: "em_web", reason: "stored_empty_body" });
  const runWeb = await driveOwnerEmailNotifications(env, 20, Date.now());
  assert.equal(runWeb.sent, 1);

  const mailRow = await d1Get<any>(d1, `SELECT notified_at FROM email_messages WHERE id='em_web'`);
  assert.ok(mailRow.notified_at > 0, "Web fallback marks notified_at");

  console.log("  ✅ Web fallback automatically completes without push failure");
}

resetHostHooks();
console.log("✅ email-durable-notifications: all assertions passed");
