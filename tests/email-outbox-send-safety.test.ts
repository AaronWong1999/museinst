
import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import {
  enqueueOutbox,
  sendOutboxRow,
  dueOutbox,
  sweepStuckSending,
  retryAcceptedCommit,
  buildProviderHeaders,
  classifySendError,
  findThreadByProviderMessageId,
  listUncertainOutbox,
  type OutboxRow,
} from "../src/channels/email/outbox";

console.log("▶ Email outbox send safety (A07 / A08)");

const WS = "ws_o";

function makeEnv() {
  const d1 = createTestD1();
  return { d1, env: { DB: d1, PUBLIC_BASE_URL: "https://example.com" } as any };
}

interface SentMail {
  headers: Record<string, string>;
  inReplyTo?: string;
  references?: string[];
  to: string;
  subject: string;
}


function strictSender(sent: SentMail[]): { send: (m: any) => Promise<{ messageId: string }> } {
  let n = 0;
  return {
    send: async (m: any) => {
      const headers = m.headers ?? {};
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === "message-id") {
          throw Object.assign(new Error("Header 'Message-ID' is not allowed."), { code: "E_HEADER_NOT_ALLOWED" });
        }
        if (k.toLowerCase() === "from" || k.toLowerCase() === "subject") {
          throw Object.assign(new Error(`Header '${k}' must be set via API field`), { code: "E_HEADER_USE_API_FIELD" });
        }
      }
      sent.push({ headers, inReplyTo: m.inReplyTo, references: m.references, to: m.to, subject: m.subject });
      n += 1;
      return { messageId: `prov_${n}` };
    },
  };
}

const rowBy = async (d1: TestD1, id: string) => (await d1Get<OutboxRow>(d1, `SELECT * FROM email_outbox WHERE id=?`, id))!;


{
  const { d1, env } = makeEnv();
  const enq = await enqueueOutbox(env, {
    workspaceId: WS,
    logicalKey: "k1",
    fromAddr: "a@mail.local.test",
    toAddr: "b@x.test",
    subject: "hi",
    textBody: "body",
    messageId: "<app-logical-id@mail.local.test>",
    headers: { "Message-ID": "<forged@mail.local.test>", "X-Custom": "ok" },
    inReplyTo: "<origin@x.test>",
    references: ["<origin@x.test>"],
    threadId: "th_1",
    autoSubmitted: "auto-replied",
  });
  const sent: SentMail[] = [];
  const st = await sendOutboxRow(env, strictSender(sent) as never, await rowBy(d1, enq.id));
  assert.equal(st, "accepted");
  assert.equal(sent.length, 1);
  assert.ok(!("Message-ID" in sent[0].headers), "自设 Message-ID 必须被剔除");
  assert.equal(sent[0].headers["X-Custom"], "ok");
  assert.equal(sent[0].headers["Auto-Submitted"], "auto-replied");
  const row = await rowBy(d1, enq.id);
  assert.equal(row.provider_message_id, "prov_1", "必须存 provider 真实 ID");
  assert.equal(row.message_id, "<app-logical-id@mail.local.test>", "应用 ID 与 provider ID 分开保存");
  console.log("  ✅ 剔除自设 Message-ID 后发送成功，provider ID 落库");
}


{
  const { d1, env } = makeEnv();
  const enq = await enqueueOutbox(env, {
    workspaceId: WS,
    logicalKey: "k2",
    fromAddr: "a@mail.local.test",
    toAddr: "b@x.test",
    subject: "re",
    textBody: "body",
    messageId: "<app2@mail.local.test>",
    inReplyTo: "<msg-1@x.test>",
    references: ["<msg-0@x.test>", "<msg-1@x.test>"],
  });
  const sent: SentMail[] = [];
  assert.equal(await sendOutboxRow(env, strictSender(sent) as never, await rowBy(d1, enq.id)), "accepted");
  assert.equal(sent[0].headers["In-Reply-To"], "<msg-1@x.test>");
  assert.equal(sent[0].headers["References"], "<msg-0@x.test> <msg-1@x.test>");
  assert.equal(sent[0].inReplyTo, "<msg-1@x.test>");
  assert.deepEqual(sent[0].references, ["<msg-0@x.test>", "<msg-1@x.test>"]);
  console.log("  ✅ In-Reply-To / References 透传 provider");
}


{
  const { d1, env } = makeEnv();
  const enq = await enqueueOutbox(env, { workspaceId: WS, logicalKey: "k3", fromAddr: "a@m", toAddr: "b@x", subject: "s", textBody: "t", messageId: "<m3@d>" });
  let calls = 0;
  const timeoutSender = {
    send: async () => {
      calls += 1;

      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    },
  };
  const st = await sendOutboxRow(env, timeoutSender as never, await rowBy(d1, enq.id));
  assert.equal(st, "delivery_unknown");
  assert.equal(calls, 1);
  const again = await sendOutboxRow(env, timeoutSender as never, await rowBy(d1, enq.id));
  assert.equal(again, "delivery_unknown");
  assert.equal(calls, 1, "unknown 绝不能再次调用 send");
  assert.deepEqual(await dueOutbox(env), [], "unknown 不在待发队列里");
  const row = await rowBy(d1, enq.id);
  assert.ok(String(row.last_error).startsWith("unknown:"), "unknown 必须可见（last_error）");
  const uncertain = await listUncertainOutbox(env, WS);
  assert.equal(uncertain.length, 1, "unknown 必须出现在 ops 可见清单");
  console.log("  ✅ accepted-then-timeout → delivery_unknown，不自动重发");
}


{
  const { d1, env } = makeEnv();
  const enq = await enqueueOutbox(env, { workspaceId: WS, logicalKey: "k4", fromAddr: "a@m", toAddr: "b@x", subject: "s", textBody: "t", messageId: "<m4@d>" });
  const sent: SentMail[] = [];
  let commitFailed = false;
  const flakyDb = {
    prepare: (sql: string) => {
      const stmt = (env.DB as any).prepare(sql);
      if (!/SET status='accepted', provider_message_id=\?/.test(sql)) return stmt;
      return {
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            ...bound,
            run: async () => {
              if (!commitFailed) {
                commitFailed = true;
                throw new Error("D1 write unavailable");
              }
              return bound.run();
            },
          };
        },
      };
    },
  };
  const st = await sendOutboxRow({ ...env, DB: flakyDb }, strictSender(sent) as never, await rowBy(d1, enq.id));
  assert.equal(st, "accepted_pending_commit");
  assert.equal(sent.length, 1);
  assert.equal((await rowBy(d1, enq.id)).status, "accepted_pending_commit");

  const fixed = await retryAcceptedCommit(env);
  assert.equal(fixed, 1);
  assert.equal((await rowBy(d1, enq.id)).status, "accepted");
  assert.equal(sent.length, 1, "状态提交重试绝不能重新 send");
  assert.deepEqual(await dueOutbox(env), []);
  console.log("  ✅ accepted 后落库失败 → 只重试状态提交，不重发");
}


{
  const { d1, env } = makeEnv();
  const enq = await enqueueOutbox(env, { workspaceId: WS, logicalKey: "k5", fromAddr: "a@m", toAddr: "b@x", subject: "s", textBody: "t", messageId: "<m5@d>" });
  let calls = 0;
  const rateLimited = {
    send: async () => {
      calls += 1;
      throw Object.assign(new Error("rate limited"), { code: "E_RATE_LIMIT_EXCEEDED" });
    },
  };
  assert.equal(await sendOutboxRow(env, rateLimited as never, await rowBy(d1, enq.id)), "retry_wait");
  assert.equal(calls, 1);
  assert.equal((await rowBy(d1, enq.id)).status, "retry_wait");
  d1Exec(d1, `UPDATE email_outbox SET next_attempt_at=0 WHERE id=?`, enq.id);
  const due = await dueOutbox(env);
  assert.equal(due.length, 1, "限流退避后仍在待发队列");
  await sendOutboxRow(env, rateLimited as never, due[0]);
  assert.equal(calls, 2, "未被接受的限流允许再次 send");
  console.log("  ✅ 明确未被接受的限流 → retry_wait（允许重试）");
}


{
  assert.equal(classifySendError(Object.assign(new Error("internal"), { status: 503 })), "unknown");
  assert.equal(classifySendError(new Error("503 unavailable")), "unknown");
  assert.equal(classifySendError(new Error("fetch failed")), "unknown");
  assert.equal(classifySendError(Object.assign(new Error("bad header"), { code: "E_HEADER_NOT_ALLOWED" })), "permanent");
  assert.equal(classifySendError(Object.assign(new Error("limited"), { status: 429 })), "not_accepted_retryable");

  const { d1, env } = makeEnv();
  const enq = await enqueueOutbox(env, { workspaceId: WS, logicalKey: "k6", fromAddr: "a@m", toAddr: "b@x", subject: "s", textBody: "t", messageId: "<m6@d>" });
  const server500 = { send: async () => { throw Object.assign(new Error("upstream error"), { status: 500 }); } };
  assert.equal(await sendOutboxRow(env, server500 as never, await rowBy(d1, enq.id)), "delivery_unknown");
  assert.equal((await rowBy(d1, enq.id)).status, "delivery_unknown");
  console.log("  ✅ 5xx/网络类错误 → unknown，不自动重发");
}


{
  const { d1, env } = makeEnv();
  const enq = await enqueueOutbox(env, { workspaceId: WS, logicalKey: "k7", fromAddr: "a@m", toAddr: "b@x", subject: "s", textBody: "t", messageId: "<m7@d>" });
  d1Exec(d1, `UPDATE email_outbox SET status='sending', lease_token='lease_x', lease_until=1 WHERE id=?`, enq.id);
  const n = await sweepStuckSending(env, Date.now());
  assert.equal(n, 1);
  assert.equal((await rowBy(d1, enq.id)).status, "delivery_unknown");
  assert.deepEqual(await dueOutbox(env), []);
  console.log("  ✅ lease 过期 sending → unknown，不重发");
}


{
  const { d1, env } = makeEnv();
  const enq = await enqueueOutbox(env, {
    workspaceId: WS,
    logicalKey: "k8",
    fromAddr: "a@m",
    toAddr: "b@x",
    subject: "s",
    textBody: "t",
    messageId: "<app-8@d>",
    threadId: "th_8",
  });
  const sent: SentMail[] = [];
  await sendOutboxRow(env, strictSender(sent) as never, await rowBy(d1, enq.id));
  assert.equal(await findThreadByProviderMessageId(env, WS, "prov_1"), "th_8");
  assert.equal(await findThreadByProviderMessageId(env, WS, "<app-8@d>"), null, "应用自造 ID 不是 provider ID");
  assert.equal(await findThreadByProviderMessageId(env, "ws_other", "prov_1"), null, "跨 workspace 不可见");
  console.log("  ✅ provider 真实 ID → thread 映射隔离到 workspace");
}


{
  const headers = buildProviderHeaders({
    headers_json: JSON.stringify({ "Message-ID": "<old@x>", Date: "x", From: "x", Subject: "x", "X-Keep": "1" }),
    in_reply_to: "<in@x>",
    references_json: JSON.stringify(["<r1@x>"]),
  });
  assert.deepEqual(Object.keys(headers).sort(), ["In-Reply-To", "References", "X-Keep"]);
  console.log("  ✅ 历史记录中的平台控制 header 一律剔除");
}
console.log("✔ Email outbox send safety tests passed!");
