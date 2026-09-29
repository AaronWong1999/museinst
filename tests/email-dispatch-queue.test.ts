
import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import type { Env, EmailDispatchEnvelope } from "../src/env";
import {
  queueEmailDispatch,
  consumeEmailDispatchEnvelope,
  EMAIL_DISPATCH_LEASE_MS,
  MAX_DISPATCH_ATTEMPTS,
} from "../src/channels/email/dispatch-queue";
import { reserveEmailModelAdmission } from "../src/channels/email/admission";
import { setHostHooks, resetHostHooks } from "../src/hooks";

console.log("▶ Agent Mail dispatch queue & lease consumer (V2 §15/§16/§17)");

const WS = "w_queue_test";
const TO = "agent@mail.openinst.com";
const FROM = "peer@external.net";

function seed(d1: TestD1) {
  d1Exec(d1, `INSERT OR IGNORE INTO users (id, created_at) VALUES ('u_queue', 0)`);
  d1Exec(d1, `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_queue', 0)`, WS);
  d1Exec(
    d1,
    `INSERT OR REPLACE INTO agent_mailboxes
      (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
     VALUES (?, 'agent', 'mail.openinst.com', ?, 'active', 100, 300, 1, 0, 0)`,
    WS, TO,
  );
}

function insertInboundMessage(d1: TestD1, rowId: string, overrides: Partial<any> = {}) {
  const defaults = {
    id: rowId,
    workspace_id: WS,
    direction: "in",
    fingerprint: `fp_${rowId}`,
    raw_sha256: "sha_dummy",
    thread_id: `th_${rowId}`,
    from_addr: FROM,
    to_addr: TO,
    subject: "Test Subject",
    snippet: "Test Snippet",
    body_text: "Hello Agent",
    scope_key: `scope_${rowId}`,
    message_auth: "none",
    ingest_state: "dispatch_queued",
    ingest_attempts: 0,
    created_at: Date.now(),
  };
  const data = { ...defaults, ...overrides };
  d1Exec(
    d1,
    `INSERT INTO email_messages (id, workspace_id, direction, fingerprint, raw_sha256, thread_id,
      from_addr, to_addr, subject, snippet, body_text, scope_key, message_auth, ingest_state, ingest_attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    data.id, data.workspace_id, data.direction, data.fingerprint, data.raw_sha256, data.thread_id,
    data.from_addr, data.to_addr, data.subject, data.snippet, data.body_text, data.scope_key, data.message_auth,
    data.ingest_state, data.ingest_attempts, data.created_at,
  );
}

// ── 1. queueEmailDispatch ────────────────────────────────────────────────────
{
  const d1 = createTestD1();
  seed(d1);
  insertInboundMessage(d1, "row_q1");
  const queueMessages: any[] = [];
  const env: any = {
    DB: d1,
    EMAIL_DISPATCH_QUEUE: {
      send: async (msg: any) => { queueMessages.push(msg); },
    },
  };

  await queueEmailDispatch(env, { rowId: "row_q1", workspaceId: WS });
  assert.equal(queueMessages.length, 1);
  assert.equal(queueMessages[0].kind, "agent_mail_dispatch");
  assert.equal(queueMessages[0].rowId, "row_q1");

  const row = await d1Get<any>(d1, `SELECT dispatch_enqueued_at FROM email_messages WHERE id='row_q1'`);
  assert.ok(row.dispatch_enqueued_at > 0);
  console.log("  ✅ queueEmailDispatch produces envelope and stamps dispatch_enqueued_at");
}

// ── 2. consumeEmailDispatchEnvelope: Happy path ──────────────────────────────
{
  resetHostHooks();
  const d1 = createTestD1();
  seed(d1);
  insertInboundMessage(d1, "row_happy");

  await reserveEmailModelAdmission(mockEnv(d1), {
    workspaceId: WS,
    rowId: "row_happy",
    peerHash: "0123456789abcdef",
    totalCap: 100,
    peerCap: 50,
  });

  let agentCalled = false;
  const env: any = {
    DB: d1,
    AGENT_EMAIL_ENABLED: "1",
    AGENT_EMAIL_OUTBOUND_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
    AGENT: {
      idFromName: (x: string) => x,
      get: () => ({
        fetch: async () => {
          agentCalled = true;
          return Response.json({ replies: ["I received your email"], taskId: "task_h1" });
        },
      }),
    },
  };

  const outcome = await consumeEmailDispatchEnvelope(env, {
    v: 1,
    kind: "agent_mail_dispatch",
    rowId: "row_happy",
    workspaceId: WS,
    enqueuedAt: Date.now(),
  });

  assert.equal(outcome.kind, "ack");
  assert.equal(agentCalled, true);

  const row = await d1Get<any>(d1, `SELECT ingest_state, root_task_id, ingest_lease_token, ingest_lease_until FROM email_messages WHERE id='row_happy'`);
  assert.equal(row.ingest_state, "processed");
  assert.equal(row.root_task_id, "task_h1");
  assert.equal(row.ingest_lease_token, null, "lease token cleared on success");


  const admit = await d1Get<any>(d1, `SELECT status FROM email_model_admissions WHERE email_row_id='row_happy'`);
  assert.equal(admit.status, "consumed");

  console.log("  ✅ consumeEmailDispatchEnvelope happy path marks processed and consumes admission");
}

// ── 3. consumeEmailDispatchEnvelope: Policy Revoked before run ───────────────
{
  resetHostHooks();
  const d1 = createTestD1();
  seed(d1);
  insertInboundMessage(d1, "row_revoked");
  await reserveEmailModelAdmission(mockEnv(d1), {
    workspaceId: WS,
    rowId: "row_revoked",
    peerHash: "0123456789abcdef",
    totalCap: 100,
    peerCap: 50,
  });

  let releasedHostHookCalled = false;
  setHostHooks({
    revalidateExternalEvent: async () => ({ allow: false, reason: "suspension_active" }),
    releaseExternalEventAdmission: async () => { releasedHostHookCalled = true; },
  });

  const env: any = {
    DB: d1,
    AGENT_EMAIL_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
  };

  const outcome = await consumeEmailDispatchEnvelope(env, {
    v: 1,
    kind: "agent_mail_dispatch",
    rowId: "row_revoked",
    workspaceId: WS,
    enqueuedAt: Date.now(),
  });

  assert.equal(outcome.kind, "ack");
  assert.equal(releasedHostHookCalled, true);

  const row = await d1Get<any>(d1, `SELECT ingest_state, external_admission_state, external_admission_reason FROM email_messages WHERE id='row_revoked'`);
  assert.equal(row.ingest_state, "stored_policy_revoked");
  assert.equal(row.external_admission_state, "policy_revoked");
  assert.equal(row.external_admission_reason, "suspension_active");

  const admit = await d1Get<any>(d1, `SELECT status FROM email_model_admissions WHERE email_row_id='row_revoked'`);
  assert.equal(admit.status, "released");

  console.log("  ✅ consumeEmailDispatchEnvelope releases admission and marks stored_policy_revoked on policy revocation");
  resetHostHooks();
}

// ── 4. consumeEmailDispatchEnvelope: Dispatch Failure & Retry ─────────────────
{
  resetHostHooks();
  const d1 = createTestD1();
  seed(d1);
  insertInboundMessage(d1, "row_fail");
  await reserveEmailModelAdmission(mockEnv(d1), {
    workspaceId: WS,
    rowId: "row_fail",
    peerHash: "0123456789abcdef",
    totalCap: 100,
    peerCap: 50,
  });

  const env: any = {
    DB: d1,
    AGENT_EMAIL_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
    AGENT: {
      idFromName: (x: string) => x,
      get: () => ({
        fetch: async () => new Response("overloaded", { status: 503 }),
      }),
    },
  };

  const outcome = await consumeEmailDispatchEnvelope(env, {
    v: 1,
    kind: "agent_mail_dispatch",
    rowId: "row_fail",
    workspaceId: WS,
    enqueuedAt: Date.now(),
  });

  assert.equal(outcome.kind, "retry");
  assert.equal(outcome.delaySeconds, 20);

  const row = await d1Get<any>(d1, `SELECT ingest_state, ingest_attempts FROM email_messages WHERE id='row_fail'`);
  assert.equal(row.ingest_state, "dispatch_failed");
  assert.equal(Number(row.ingest_attempts), 1);

  console.log("  ✅ dispatch failure marks dispatch_failed and requests Queue retry");
}

// ── 5. consumeEmailDispatchEnvelope: Max attempts exceeded (exhausted) ─────────
{
  resetHostHooks();
  const d1 = createTestD1();
  seed(d1);
  insertInboundMessage(d1, "row_exhausted", { ingest_attempts: MAX_DISPATCH_ATTEMPTS });
  await reserveEmailModelAdmission(mockEnv(d1), {
    workspaceId: WS,
    rowId: "row_exhausted",
    peerHash: "0123456789abcdef",
    totalCap: 100,
    peerCap: 50,
  });

  const env: any = {
    DB: d1,
    AGENT_EMAIL_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
  };

  const outcome = await consumeEmailDispatchEnvelope(env, {
    v: 1,
    kind: "agent_mail_dispatch",
    rowId: "row_exhausted",
    workspaceId: WS,
    enqueuedAt: Date.now(),
  });

  assert.equal(outcome.kind, "ack");

  const row = await d1Get<any>(d1, `SELECT ingest_state FROM email_messages WHERE id='row_exhausted'`);
  assert.equal(row.ingest_state, "stored_dispatch_exhausted");

  console.log("  ✅ attempts > 5 marks stored_dispatch_exhausted and ACKs");
}

function mockEnv(d1: TestD1): Env {
  return { DB: d1 as any } as unknown as Env;
}

resetHostHooks();
console.log("✅ email-dispatch-queue: all assertions passed");
