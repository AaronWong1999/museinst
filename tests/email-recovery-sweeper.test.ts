
import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import type { Env } from "../src/env";
import { sweepEmailDispatchQueue } from "../src/channels/email/drive";
import { reserveEmailModelAdmission } from "../src/channels/email/admission";

console.log("▶ Agent Mail recovery sweeper (V2 §18)");

const WS = "w_sweep_test";
const TO = "agent@mail.openinst.com";
const FROM = "peer@external.net";

function seed(d1: TestD1) {
  d1Exec(d1, `INSERT OR IGNORE INTO users (id, created_at) VALUES ('u_sweep', 0)`);
  d1Exec(d1, `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_sweep', 0)`, WS);
  d1Exec(
    d1,
    `INSERT OR REPLACE INTO agent_mailboxes
      (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
     VALUES (?, 'agent', 'mail.openinst.com', ?, 'active', 100, 300, 1, 0, 0)`,
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
    subject: "Sub",
    snippet: "Snip",
    body_text: "Text",
    scope_key: `scope_${id}`,
    message_auth: "none",
    ingest_state: "dispatch_queued",
    ingest_attempts: 0,
    created_at: Date.now() - 120_000,
  };
  const d = { ...defaults, ...overrides };
  d1Exec(
    d1,
    `INSERT INTO email_messages (id, workspace_id, direction, fingerprint, raw_sha256, thread_id,
      from_addr, to_addr, subject, snippet, body_text, scope_key, message_auth, ingest_state,
      ingest_attempts, dispatch_enqueued_at, ingest_lease_token, ingest_lease_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.id, d.workspace_id, d.direction, d.fingerprint, d.raw_sha256, d.thread_id,
    d.from_addr, d.to_addr, d.subject, d.snippet, d.body_text, d.scope_key, d.message_auth,
    d.ingest_state, d.ingest_attempts, d.dispatch_enqueued_at ?? null, d.ingest_lease_token ?? null,
    d.ingest_lease_until ?? null, d.created_at,
  );
}

const d1 = createTestD1();
seed(d1);

const queuedEnvelopes: any[] = [];
const env: any = {
  DB: d1,
  EMAIL_DISPATCH_QUEUE: {
    send: async (msg: any) => { queuedEnvelopes.push(msg); },
  },
};

const now = Date.now();


insertMessage(d1, "em_unconfirmed", {
  ingest_state: "dispatch_queued",
  dispatch_enqueued_at: null,
});


insertMessage(d1, "em_stale_processing", {
  ingest_state: "processing",
  ingest_lease_token: "old_tok",
  ingest_lease_until: now - 10_000,
  ingest_attempts: 1,
});


insertMessage(d1, "em_failed_retryable", {
  ingest_state: "dispatch_failed",
  ingest_attempts: 2,
});


insertMessage(d1, "em_failed_exhausted", {
  ingest_state: "dispatch_failed",
  ingest_attempts: 5,
});
await reserveEmailModelAdmission({ DB: d1 as any } as any, {
  workspaceId: WS,
  rowId: "em_failed_exhausted",
  peerHash: "0123456789abcdef",
  totalCap: 10,
  peerCap: 5,
});


const stats = await sweepEmailDispatchQueue(env, 50, now);


assert.equal(stats.requeued, 3, "3 rows should be requeued (unconfirmed, stale, retryable)");
assert.equal(stats.staleRecovered, 1, "1 stale row recovered from processing");
assert.equal(stats.exhausted, 1, "1 row marked exhausted");


assert.equal(queuedEnvelopes.length, 3);
const requeuedIds = queuedEnvelopes.map((e) => e.rowId);
assert.ok(requeuedIds.includes("em_unconfirmed"));
assert.ok(requeuedIds.includes("em_stale_processing"));
assert.ok(requeuedIds.includes("em_failed_retryable"));


const exhaustedRow = await d1Get<any>(d1, `SELECT ingest_state FROM email_messages WHERE id='em_failed_exhausted'`);
assert.equal(exhaustedRow.ingest_state, "stored_dispatch_exhausted");


const admitRow = await d1Get<any>(d1, `SELECT status FROM email_model_admissions WHERE email_row_id='em_failed_exhausted'`);
assert.equal(admitRow.status, "released");

console.log("✅ email-recovery-sweeper: all assertions passed");
