import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import { handleInboundEmail } from "../src/channels/email/reliable-ingress";
import { enqueueOutbox } from "../src/channels/email/outbox";
import { resetHostHooks } from "../src/hooks";

console.log("▶ Email reliable ingress / quota compensation");

const WS = "w_email_rel";
const TO = "agent@mail.example.com";
const FROM = "sender@example.net";

function seed(d1: TestD1) {
  d1Exec(d1, `INSERT INTO users (id, created_at) VALUES ('u_email_rel', 0)`);
  d1Exec(d1, `INSERT INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_email_rel', 0)`, WS);
  d1Exec(
    d1,
    `INSERT INTO agent_mailboxes
      (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
     VALUES (?, 'agent', 'mail.example.com', ?, 'active', 100, 300, 1, 0, 0)`,
    WS, TO,
  );
}

function rawEmail(messageId = "<rel-1@example.net>"): ArrayBuffer {
  return new TextEncoder().encode([
    `From: ${FROM}`,
    `To: ${TO}`,
    `Message-ID: ${messageId}`,
    `Subject: retry me`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `hello`,
  ].join("\r\n")).buffer as ArrayBuffer;
}



{
  resetHostHooks();
  const d1 = createTestD1();
  seed(d1);
  let fail = true;
  let calls = 0;
  const queuedMessages: any[] = [];
  const env: any = {
    DB: d1,
    AGENT_EMAIL_ENABLED: "1",
    AGENT_EMAIL_OUTBOUND_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
    EMAIL_DISPATCH_QUEUE: {
      send: async (msg: any) => { queuedMessages.push(msg); },
    },
    AGENT: {
      idFromName: (x: string) => x,
      get: () => ({
        fetch: async () => {
          calls++;
          if (fail) return new Response("temporary", { status: 503 });
          return Response.json({ replies: [], taskId: "t_recovered" });
        },
      }),
    },
  };
  const raw = rawEmail();
  const msg = () => ({
    from: FROM,
    to: TO,
    raw,
    rawSize: raw.byteLength,
    headers: new Headers(),
    setReject: (_reason: string) => {},
  });

  const ingressRes = await handleInboundEmail(msg(), env, { waitUntil: () => {} });
  assert.equal(ingressRes.handled, true);
  assert.equal(queuedMessages.length, 1);

  let row = await d1Get<any>(d1, `SELECT ingest_state, dispatch_enqueued_at FROM email_messages WHERE workspace_id=?`, WS);
  assert.equal(row!.ingest_state, "dispatch_queued");
  assert.ok(row!.dispatch_enqueued_at > 0);


  const { consumeEmailDispatchEnvelope } = await import("../src/channels/email/dispatch-queue");
  const firstConsume = await consumeEmailDispatchEnvelope(env, queuedMessages[0]);
  assert.equal(firstConsume.kind, "retry");

  row = await d1Get<any>(d1, `SELECT ingest_state, ingest_attempts FROM email_messages WHERE workspace_id=?`, WS);
  assert.equal(row!.ingest_state, "dispatch_failed");
  assert.equal(Number(row!.ingest_attempts), 1);


  fail = false;
  const secondConsume = await consumeEmailDispatchEnvelope(env, queuedMessages[0]);
  assert.equal(secondConsume.kind, "ack");

  row = await d1Get<any>(d1, `SELECT ingest_state, ingest_attempts, root_task_id FROM email_messages WHERE workspace_id=?`, WS);
  assert.equal(row!.ingest_state, "processed");
  assert.equal(Number(row!.ingest_attempts), 2);
  assert.equal(row!.root_task_id, "t_recovered");
  assert.equal(calls, 2);
  console.log("  ✅ ingress queues dispatch and consumer recovers on retry");
}


{
  const d1 = createTestD1();
  seed(d1);
  const day = new Date().toISOString().slice(0, 10);
  d1Exec(d1, `INSERT INTO email_counters (workspace_id, day, scope, count, updated_at) VALUES (?, ?, 'outbound_send', 1, ?)`, WS, day, Date.now());
  const realPrepare = d1.prepare.bind(d1);
  const env: any = {
    DB: {
      prepare(sql: string) {
        if (sql.includes("INSERT INTO email_outbox")) {
          return {
            bind: () => ({
              run: async () => { throw new Error("d1_outbox_down"); },
              first: async () => null,
              all: async () => ({ results: [] }),
            }),
          };
        }
        return realPrepare(sql);
      },
      batch: d1.batch,
    },
  };
  await assert.rejects(
    () => enqueueOutbox(env, {
      workspaceId: WS,
      logicalKey: "reply:em_fault:0",
      fromAddr: TO,
      toAddr: FROM,
      subject: "Re: retry",
      textBody: "reply",
      messageId: "<app-id@mail.example.com>",
    }),
    /d1_outbox_down/,
  );
  const counter = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope='outbound_send'`, WS, day);
  assert.equal(Number(counter!.count), 0, "failed auto-reply enqueue must refund its reserved quota");
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM email_outbox`))!.n), 0);
  console.log("  ✅ auto-reply enqueue failure refunds outbound quota and creates no outbox row");
}

resetHostHooks();
console.log("✅ Email reliable ingress tests passed");
