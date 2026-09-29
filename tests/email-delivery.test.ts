import assert from "node:assert/strict";
import { parseEmail, cleanBodyText } from "../src/channels/email/parse";
import { inboundFingerprint } from "../src/channels/email/ingress";
import { enqueueOutbox, isRetryableSendError, isHardSendError, sweepStuckSending, dueOutbox, sendOutboxRow } from "../src/channels/email/outbox";

console.log("▶ V3 §9/§12 Email delivery semantics tests...");

// mock D1
function mockDb() {
  const outbox = new Map<string, Record<string, unknown>>();
  const byLogical = new Map<string, string>();
  const messages = new Map<string, Record<string, unknown>>();
  const db: any = {
    __outbox: outbox,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("FROM email_outbox WHERE workspace_id=? AND logical_key=?")) {
            const id = byLogical.get(`${args[0]}|${args[1]}`);
            return id ? { id } : null;
          }
          if (sql.includes("FROM email_outbox WHERE id=?")) return outbox.get(String(args[0])) ?? null;
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => {
          if (sql.startsWith("INSERT INTO email_outbox")) {
            const key = `${args[1]}|${args[2]}`;
            if (byLogical.has(key)) return { success: true, meta: { changes: 0 } };
            byLogical.set(key, String(args[0]));
            outbox.set(String(args[0]), { id: args[0], workspace_id: args[1], logical_key: args[2], status: "queued", attempts: 0, lease_token: null, headers_json: args[9], from_addr: args[3], to_addr: args[4], subject: args[5], text_body: args[6], html_body: args[7], reply_to: args[10], message_id: args[11], in_reply_to: args[12], root_task_id: args[15] });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE email_outbox SET status='sending'")) {
            const row = outbox.get(String(args[2]));
            if (!row || (row.status !== "queued" && row.status !== "retry_wait")) return { success: true, meta: { changes: 0 } };
            row.status = "sending"; row.attempts = Number(row.attempts) + 1; row.lease_token = args[0];
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("status='accepted'")) {
            const row = outbox.get(String(args[3]));
            if (row && row.lease_token === args[4]) { row.status = "accepted"; row.provider_message_id = args[0]; return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("status='retry_wait'")) {
            const row = outbox.get(String(args[2]));
            if (row && row.lease_token === args[3]) { row.status = "retry_wait"; return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("status='permanent_failed'")) {
            const row = outbox.get(String(args[1]));
            if (row) row.status = "permanent_failed";
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("status='delivery_unknown'")) {
            for (const r of outbox.values()) {
              if (sql.includes("lease_expired") && r.status === "sending") r.status = "delivery_unknown";
            }
            const row = outbox.get(String(args[1] ?? args[2] ?? ""));
            if (row) row.status = "delivery_unknown";
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      }),
    }),
    batch: async () => [],
  };
  return db;
}


{
  const a = await inboundFingerprint({ messageId: "<ABC@x.com>", envelopeFrom: "a@b.com", recipient: "m@mail.openinst.com", rawSha256: "r1" });
  assert.equal(a, "mid:<abc@x.com>");
  const b1 = await inboundFingerprint({ messageId: null, envelopeFrom: "a@b.com", recipient: "m@mail.openinst.com", rawSha256: "same" });
  const b2 = await inboundFingerprint({ messageId: null, envelopeFrom: "a@b.com", recipient: "m@mail.openinst.com", rawSha256: "same" });
  const b3 = await inboundFingerprint({ messageId: null, envelopeFrom: "a@b.com", recipient: "m@mail.openinst.com", rawSha256: "diff" });
  assert.equal(b1, b2);
  assert.notEqual(b1, b3);
}


{
  const env: any = { DB: mockDb() };
  const base = { workspaceId: "w1", fromAddr: "a@mail.openinst.com", toAddr: "b@x.com", subject: "hi", textBody: "same", messageId: "<m1@d>" };
  const r1 = await enqueueOutbox(env, { ...base, logicalKey: "reply:em1:0" });
  const r2 = await enqueueOutbox(env, { ...base, logicalKey: "reply:em1:0" });
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r1.id, r2.id);
  const r3 = await enqueueOutbox(env, { ...base, logicalKey: "reply:em1:1", messageId: "<m2@d>" });
  assert.equal(r3.created, true);
  assert.notEqual(r3.id, r1.id);
}



{
  assert.equal(isRetryableSendError(Object.assign(new Error("rate limited"), { code: "E_RATE_LIMIT_EXCEEDED" })), true);
  assert.equal(isRetryableSendError(new Error("429 rate limited")), false, "无结构化 code 的文本不足以决定外部副作用");
  assert.equal(isHardSendError(Object.assign(new Error("bad header"), { code: "E_HEADER_NOT_ALLOWED" })), true);
  const env: any = { DB: mockDb() };
  const enq = await enqueueOutbox(env, { workspaceId: "w1", logicalKey: "k1", fromAddr: "a@m", toAddr: "b@x", subject: "s", textBody: "t", messageId: "<mm@d>" });
  const row: any = { ...(env.DB.__outbox.get(enq.id) as object), lease_token: null };
  let retryCalls = 0;
  const retrySender: any = {
    send: async () => {
      retryCalls++;
      throw Object.assign(new Error("rate limited"), { code: "E_RATE_LIMIT_EXCEEDED" });
    },
  };
  assert.equal(await sendOutboxRow(env, retrySender, row, { maxAttempts: 5 }), "retry_wait");
  assert.equal(retryCalls, 1);
  let unknownCalls = 0;
  const unknownSender: any = {
    send: async () => {
      unknownCalls++;
      throw new Error("503 unavailable");
    },
  };
  const enq2 = await enqueueOutbox(env, { workspaceId: "w1", logicalKey: "k2", fromAddr: "a@m", toAddr: "b@x", subject: "s", textBody: "t", messageId: "<mm2@d>" });
  const row2: any = { ...(env.DB.__outbox.get(enq2.id) as object), lease_token: null };
  assert.equal(await sendOutboxRow(env, unknownSender, row2), "delivery_unknown");
  assert.equal(unknownCalls, 1);
  await sendOutboxRow(env, unknownSender, { ...(env.DB.__outbox.get(enq2.id) as object) });
  assert.equal(unknownCalls, 1, "unknown 绝不自动重发");
  const hardSender: any = { send: async () => { throw Object.assign(new Error("invalid recipient"), { code: "E_RECIPIENT_NOT_ALLOWED" }); } };
  const enq3 = await enqueueOutbox(env, { workspaceId: "w1", logicalKey: "k3", fromAddr: "a@m", toAddr: "b@x", subject: "s", textBody: "t", messageId: "<mm3@d>" });
  const row3: any = { ...(env.DB.__outbox.get(enq3.id) as object), lease_token: null };
  assert.equal(await sendOutboxRow(env, hardSender, row3), "permanent_failed");
  const okSender: any = { send: async () => ({ messageId: "prov_1" }) };
  const enq4 = await enqueueOutbox(env, { workspaceId: "w1", logicalKey: "k4", fromAddr: "a@m", toAddr: "b@x", subject: "s", textBody: "t", messageId: "<mm4@d>" });
  const row4: any = { ...(env.DB.__outbox.get(enq4.id) as object), lease_token: null };
  assert.equal(await sendOutboxRow(env, okSender, row4), "accepted");
  assert.equal((env.DB.__outbox.get(enq4.id) as any).provider_message_id, "prov_1", "provider 真实 ID 必须落库");
  void sweepStuckSending;
  void dueOutbox;
}


{
  const raw = new TextEncoder().encode(
    "From: alice@example.com\r\nTo: agent@mail.openinst.com\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nMessage-ID: <m1@x>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n你好",
  ).buffer as ArrayBuffer;
  const p = await parseEmail(raw, "alice@example.com");
  assert.equal(p.from, "alice@example.com");
  assert.ok(p.text.includes("你好"));
  assert.equal(p.messageId, "<m1@x>");
  assert.ok(cleanBodyText("  a\n\n\nb  ").includes("a"));
}

console.log("✔ Email delivery tests passed!");
