



import assert from "node:assert/strict";
import { handleInboundEmail } from "../src/channels/email/ingress";
import { consumeEmailDispatchEnvelope } from "../src/channels/email/dispatch-queue";
import { reserveEmailQuota, emailQuotaDay, emailOutboundAllowed } from "../src/channels/email/mailbox";
import { setHostHooks, resetHostHooks } from "../src/hooks";
import { createTestD1, d1Get, type TestD1 } from "./helpers/d1";

console.log("▶ Email quota primitive & outbound policy");

const FROM = "sender@example.net";
const TO = "agent@mail.example.com";

function seedWorkspace(d1: TestD1, opts: { status?: string; dailyInCap?: number; dailyOutCap?: number } = {}): string {
  d1.db.prepare(`INSERT OR IGNORE INTO users (id, created_at) VALUES ('u1', 0)`).run();
  d1.db.prepare(`INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES ('w1', 'u1', 0)`).run();
  d1.db
    .prepare(
      `INSERT OR REPLACE INTO agent_mailboxes (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
       VALUES ('w1', 'agent', 'mail.example.com', ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run(TO, opts.status ?? "active", opts.dailyOutCap ?? 100, opts.dailyInCap ?? 300);
  return "w1";
}

function rawEmail(messageId: string, body = "hello"): ArrayBuffer {
  return new TextEncoder().encode(
    `From: ${FROM}\r\nTo: ${TO}\r\nMessage-ID: <${messageId}>\r\nSubject: t\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
  ).buffer as ArrayBuffer;
}

process.on("exit", () => resetHostHooks());


{
  const d1 = createTestD1();
  const env: any = { DB: d1 };
  const day = emailQuotaDay();
  let allowed = 0;
  for (let i = 0; i < 101; i++) {
    const r = await reserveEmailQuota(env, "w1", day, "outbound_send", 100);
    if (r.allowed) allowed++;
  }
  assert.equal(allowed, 100, "exactly cap reservations allowed");
  const counter = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id='w1' AND scope='outbound_send'`);
  assert.equal(Number(counter.count), 100, "counter never exceeds cap");
  const inbound = await reserveEmailQuota(env, "w1", day, "inbound_model", 1);
  assert.equal(inbound.allowed, true, "scopes are independent");
  const zeroCap = await reserveEmailQuota(env, "w1", day, "outbound_send", 0);
  assert.equal(zeroCap.allowed, false, "cap<=0 denies");
  console.log("  ✅ cap enforced exactly; scopes independent; cap<=0 denies");
}


{
  const d1 = createTestD1();
  const env: any = { DB: d1 };
  const day = emailQuotaDay();
  const results = await Promise.all(Array.from({ length: 50 }, () => reserveEmailQuota(env, "w1", day, "inbound_model", 10)));
  assert.equal(results.filter((r) => r.allowed).length, 10, "50 concurrent reservations must not exceed cap 10");
  const counter = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id='w1' AND scope='inbound_model'`);
  assert.equal(Number(counter.count), 10);
  console.log("  ✅ 50 concurrent reservations capped at 10");
}


{
  const env: any = { DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("d1_down"); }, first: async () => null, all: async () => ({ results: [] }) }) }) } };
  await assert.rejects(() => reserveEmailQuota(env, "w1", "2026-01-01", "outbound_send", 10), /d1_down/);
  console.log("  ✅ quota infra error propagates");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1, { dailyInCap: 1 });
  const calls = { n: 0 };
  const env: any = {
    DB: d1,
    ARTIFACTS: { put: async () => {}, get: async () => null },
    AGENT_EMAIL_ENABLED: "1",
    AGENT_EMAIL_OUTBOUND_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
    AGENT: {
      idFromName: (x: string) => x,
      get: () => ({ fetch: async () => { calls.n++; return Response.json({ replies: ["ok"], taskId: "t" }); } }),
    },
  };
  // Test Queue: exercise the same production consumer explicitly instead of relying on
  // the removed inline fallback.
  env.EMAIL_DISPATCH_QUEUE = {
    send: async (envelope: any) => {
      const outcome = await consumeEmailDispatchEnvelope(env, envelope);
      assert.equal(outcome.kind, "ack");
    },
  };
  const run = async (mid: string) => {
    const pending: Promise<unknown>[] = [];
    const raw = rawEmail(mid, `body ${mid}`);
    await handleInboundEmail({ from: FROM, to: TO, raw, rawSize: raw.byteLength, headers: new Headers(), setReject: () => {} }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  };
  await run("q1");
  await run("q2");
  assert.equal(calls.n, 1, "only the first mail may enter the model");
  const rows = d1.db.prepare(`SELECT message_id, ingest_state, body_text FROM email_messages ORDER BY created_at`).all() as any[];
  assert.equal(rows.length, 2, "over-cap mail is still stored");
  assert.ok(rows[1].body_text.includes("body q2"), "over-cap body persisted for later read");
  assert.equal(rows[1].ingest_state, "stored", "over-cap is store-only");
  console.log("  ✅ inbound cap: store body but no model dispatch");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1);
  const on: any = { DB: d1, AGENT_EMAIL_OUTBOUND_ENABLED: "1" };
  assert.equal((await emailOutboundAllowed(on, "w1")).allow, true);
  assert.equal((await emailOutboundAllowed({ ...on, AGENT_EMAIL_OUTBOUND_ENABLED: undefined }, "w1")).allow, false, "unset = off");
  assert.equal((await emailOutboundAllowed({ ...on, AGENT_EMAIL_OUTBOUND_ENABLED: "0" }, "w1")).allow, false, "0 = off");
  assert.equal((await emailOutboundAllowed(on, "missing-ws")).allow, false, "missing mailbox blocks send");

  d1.db.prepare(`UPDATE agent_mailboxes SET status='paused' WHERE workspace_id='w1'`).run();
  assert.equal((await emailOutboundAllowed(on, "w1")).allow, false, "workspace opt-out blocks send");
  d1.db.prepare(`UPDATE agent_mailboxes SET status='active' WHERE workspace_id='w1'`).run();

  setHostHooks({ beforeOutboundSend: async () => ({ allow: false, reason: "suspended" }) });
  assert.equal((await emailOutboundAllowed(on, "w1")).allow, false, "host deny blocks send");
  setHostHooks({ beforeOutboundSend: async () => { throw new Error("db down"); } });
  assert.equal((await emailOutboundAllowed(on, "w1")).allow, false, "host gate error must fail closed for email");
  resetHostHooks();
  assert.equal((await emailOutboundAllowed(on, "w1")).allow, true, "no host hook = self-hosted allow");
  console.log("  ✅ outbound policy: flags + mailbox + host gate (fail closed)");
}

console.log("✅ email-quota.test.ts passed");