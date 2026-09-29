// email-audit-regressions.test.ts — regressions found in 2026-09-14 post-implementation audit.
import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import type { Env } from "../src/env";
import { queueEmailDispatch, consumeEmailDispatchEnvelope } from "../src/channels/email/dispatch-queue";
import { reserveEmailModelAdmission, releaseEmailModelAdmission } from "../src/channels/email/admission";
import { ensureOwnerEmailNotification, driveOwnerEmailNotifications } from "../src/channels/email/notifications";
import { resetHostHooks } from "../src/hooks";

console.log("▶ Agent Mail post-implementation audit regressions");

const WS = "w_audit_reg";
const TO = "agent@mail.openinst.com";
const FROM = "peer@example.net";

function envFor(d1: TestD1, extra: Record<string, unknown> = {}): Env {
  return { DB: d1 as any, ...extra } as unknown as Env;
}

function seed(d1: TestD1): void {
  d1Exec(d1, `INSERT OR IGNORE INTO users (id, created_at) VALUES ('u_audit_reg', 0)`);
  d1Exec(d1, `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_audit_reg', 0)`, WS);
  d1Exec(
    d1,
    `INSERT OR REPLACE INTO agent_mailboxes
      (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
     VALUES (?, 'agent', 'mail.openinst.com', ?, 'active', 100, 300, 1, 0, 0)`,
    WS, TO,
  );
}

function insertInbound(d1: TestD1, id: string, state = "dispatch_queued"): void {
  d1Exec(
    d1,
    `INSERT INTO email_messages
      (id, workspace_id, direction, fingerprint, raw_sha256, thread_id, from_addr, to_addr,
       subject, snippet, body_text, scope_key, message_auth, ingest_state, ingest_attempts, created_at)
     VALUES (?, ?, 'in', ?, 'sha', ?, ?, ?, 'Audit subject', 'hello', 'hello', ?, 'none', ?, 0, ?)`,
    id, WS, `fp_${id}`, `th_${id}`, FROM, TO, `scope_${id}`, state, Date.now(),
  );
}

// 1. Missing Queue binding must fail closed; handler may never run the Agent inline.
{
  const d1 = createTestD1();
  seed(d1);
  insertInbound(d1, "em_no_queue");
  const env = envFor(d1);

  await assert.rejects(
    () => queueEmailDispatch(env, { rowId: "em_no_queue", workspaceId: WS }),
    /email_dispatch_queue_unconfigured/,
  );
  const row = await d1Get<any>(d1, `SELECT dispatch_enqueued_at FROM email_messages WHERE id='em_no_queue'`);
  assert.equal(row.dispatch_enqueued_at, null);
  console.log("  ✅ missing EMAIL_DISPATCH_QUEUE fails closed without inline Agent work");
}

// 2. Queue consumer must not run a model when the Core row-id admission is missing/released.
{
  resetHostHooks();
  const d1 = createTestD1();
  seed(d1);
  insertInbound(d1, "em_missing_admission");
  let agentCalls = 0;
  const env = envFor(d1, {
    AGENT_EMAIL_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
    AGENT: {
      idFromName: (x: string) => x,
      get: () => ({ fetch: async () => { agentCalls++; return Response.json({ replies: ["bad"], taskId: "t_bad" }); } }),
    },
  });

  const outcome = await consumeEmailDispatchEnvelope(env, {
    v: 1,
    kind: "agent_mail_dispatch",
    rowId: "em_missing_admission",
    workspaceId: WS,
    enqueuedAt: Date.now(),
  });
  assert.equal(outcome.kind, "ack");
  assert.equal(agentCalls, 0);
  const row = await d1Get<any>(d1, `SELECT ingest_state, external_admission_reason FROM email_messages WHERE id='em_missing_admission'`);
  assert.equal(row.ingest_state, "stored_policy_revoked");
  assert.equal(row.external_admission_reason, "model_admission_invalid");
  console.log("  ✅ missing model admission fails closed before PersonalAgent");
}

// 3. Concurrent release attempts may refund model counters exactly once.
{
  const d1 = createTestD1();
  seed(d1);
  const env = envFor(d1);
  const peer = "0123456789abcdef";
  const reserved = await reserveEmailModelAdmission(env, {
    workspaceId: WS,
    rowId: "em_release_race",
    peerHash: peer,
    totalCap: 100,
    peerCap: 100,
  });
  assert.equal(reserved.allowed, true);
  const day = reserved.day;

  const results = await Promise.all([
    releaseEmailModelAdmission(env, WS, "em_release_race"),
    releaseEmailModelAdmission(env, WS, "em_release_race"),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const total = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope='inbound_model'`, WS, day);
  const peerCount = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope=?`, WS, day, `inbound_model_peer:${peer}`);
  assert.equal(Number(total.count), 0);
  assert.equal(Number(peerCount.count), 0);
  console.log("  ✅ concurrent model-admission release refunds counters once");
}

// 4. Expired owner-notification sending lease must be recovered and delivered.
{
  resetHostHooks();
  const d1 = createTestD1();
  seed(d1);
  insertInbound(d1, "em_notif_lease", "processed");
  const env = envFor(d1);
  const now = Date.now();
  const notifId = await ensureOwnerEmailNotification(env, {
    workspaceId: WS,
    rowId: "em_notif_lease",
    reason: "processed",
    nowMs: now - 120_000,
  });
  assert.ok(notifId);
  d1Exec(
    d1,
    `UPDATE email_owner_notifications
     SET status='sending', attempts=1, lease_token='dead_worker', lease_until=?
     WHERE id=?`,
    now - 1_000, notifId,
  );

  const driven = await driveOwnerEmailNotifications(env, 20, now);
  assert.ok(driven.retried >= 1);
  assert.equal(driven.sent, 1);
  const notif = await d1Get<any>(d1, `SELECT status, lease_token FROM email_owner_notifications WHERE id=?`, notifId);
  const mail = await d1Get<any>(d1, `SELECT notified_at FROM email_messages WHERE id='em_notif_lease'`);
  assert.equal(notif.status, "sent");
  assert.equal(notif.lease_token, null);
  assert.ok(Number(mail.notified_at) > 0);
  console.log("  ✅ expired notification sending lease recovers instead of sticking forever");
}

// 5. Legacy ingress reclaim must not steal a still-valid Queue dispatch lease.
{
  const d1 = createTestD1();
  seed(d1);
  insertInbound(d1, "em_live_lease", "processing");
  const now = Date.now();
  const originalStarted = now - 6 * 60_000; // legacy 5m timeout would consider this stale
  d1Exec(
    d1,
    `UPDATE email_messages
     SET processing_started_at=?, ingest_lease_token='live_worker', ingest_lease_until=?
     WHERE id='em_live_lease'`,
    originalStarted, now + 6 * 60_000,
  );

  const result: any = await (d1 as any).prepare(
    `UPDATE email_messages
     SET ingest_state='processing', processing_started_at=?, ingest_last_error=NULL
     WHERE id=? AND ingest_state='processing' AND (processing_started_at IS NULL OR processing_started_at < ?)`,
  ).bind(now, "em_live_lease", now - 5 * 60_000).run();
  assert.equal(Number(result?.meta?.changes ?? 0), 0);

  const row = await d1Get<any>(d1, `SELECT processing_started_at, ingest_lease_token, ingest_lease_until FROM email_messages WHERE id='em_live_lease'`);
  assert.equal(Number(row.processing_started_at), originalStarted);
  assert.equal(row.ingest_lease_token, "live_worker");
  assert.ok(Number(row.ingest_lease_until) > now);
  console.log("  ✅ live Queue lease is protected from legacy ingress reclaim");
}

// 6. Store-only outcomes before Queue dispatch must still enqueue owner notification durably.
{
  const d1 = createTestD1();
  seed(d1);
  insertInbound(d1, "em_store_only_notify", "processing");
  d1Exec(
    d1,
    `UPDATE email_messages
     SET ingest_state='stored', ingest_last_error='peer_cap_exceeded'
     WHERE id='em_store_only_notify'`,
  );
  const notif = await d1Get<any>(d1, `SELECT status, reason FROM email_owner_notifications WHERE email_row_id='em_store_only_notify' AND kind='inbound_email'`);
  assert.ok(notif);
  assert.equal(notif.status, "queued");
  assert.equal(notif.reason, "stored_quota_exceeded");
  console.log("  ✅ store-only quota outcome durably queues owner notification");
}

resetHostHooks();
console.log("✅ email-audit-regressions: all assertions passed");