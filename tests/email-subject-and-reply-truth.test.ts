
import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import type { Env } from "../src/env";
import { enqueueReply } from "../src/channels/email/ingress";
import { formatOwnerNotificationText } from "../src/channels/email/notifications";
import { dispatchExternalEmail } from "../src/channels/dispatch";
import { deriveSecurityContext } from "../src/security/context";

console.log("▶ Agent Mail subject & auto-reply truth (V2 §20/§21)");

const WS = "w_truth_test";
const TO = "agent@mail.openinst.com";
const FROM = "sender@client.com";

function seed(d1: TestD1) {
  d1Exec(d1, `INSERT OR IGNORE INTO users (id, created_at) VALUES ('u_truth', 0)`);
  d1Exec(d1, `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_truth', 0)`, WS);
  d1Exec(
    d1,
    `INSERT OR REPLACE INTO agent_mailboxes
      (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
     VALUES (?, 'agent', 'mail.openinst.com', ?, 'active', 100, 300, 1, 0, 0)`,
    WS, TO,
  );
}


{
  const d1 = createTestD1();
  seed(d1);

  let capturedEvent: any = null;
  let capturedModelMessages: any[] = [];

  const env: any = {
    DB: d1,
    AGENT: {
      idFromName: (x: string) => x,
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          capturedEvent = body.event;
          return Response.json({ replies: ["ok"], taskId: "task_subject" });
        },
      }),
    },
  };

  const security = deriveSecurityContext({
    claims: {
      source: "email",
      workspaceId: WS,
      scopeKey: "scope_sub",
      emailMessageRowId: "em_sub",
      threadId: "th_sub",
      peerAddress: FROM,
    },
    identity: { messageAuth: "none", peerAddress: FROM },
    approvalRoute: null,
    publicFacts: {},
  });

  const dispatchRes = await dispatchExternalEmail(
    env,
    {
      workspaceId: WS,
      from: FROM,
      to: TO,
      text: "Brief text",
      subject: "Important Project Alpha Launch Dates",
      messageRowId: "em_sub",
      messageId: "fp_sub",
      messageAuth: "none",
      receivedAt: Date.now(),
    },
    async () => {},
    { security },
  );

  assert.equal(dispatchRes, "handled");
  assert.equal(capturedEvent.channel, "email");
  assert.equal(capturedEvent.emailSubject, "Important Project Alpha Launch Dates");

  console.log("  ✅ dispatchExternalEmail preserves emailSubject into ChannelEvent");
}


{
  const d1 = createTestD1();
  seed(d1);
  d1Exec(
    d1,
    `INSERT INTO email_messages (id, workspace_id, direction, fingerprint, raw_sha256, thread_id, from_addr, to_addr, scope_key, message_auth, ingest_state, created_at)
     VALUES ('em_reply_1', ?, 'in', 'fp1', 'sha1', 'th1', ?, ?, 'scope1', 'none', 'processing', 0)`,
    WS, FROM, TO,
  );

  const env: any = {
    DB: d1,
    AGENT_EMAIL_ENABLED: "1",
    AGENT_EMAIL_OUTBOUND_ENABLED: "1",
  };


  const replyRes = await enqueueReply(env, {
    route: { workspaceId: WS, localPart: "agent", domain: "mail.openinst.com", address: TO },
    rowId: "em_reply_1",
    threadId: "th1",
    texts: ["Thank you for reaching out."],
    rootTaskId: "task_reply_1",
  });

  assert.equal(replyRes.kind, "queued");
  assert.equal(replyRes.created, true);

  const outboxRow = await d1Get<any>(d1, `SELECT * FROM email_outbox WHERE id=?`, (replyRes as any).outboxId);
  assert.ok(outboxRow);
  assert.equal(outboxRow.logical_key, "reply:em_reply_1:0");

  const headers = JSON.parse(outboxRow.headers_json);
  assert.equal(headers["Auto-Submitted"], "auto-replied", "Auto-Submitted header must be auto-replied");


  const emptyRes = await enqueueReply(env, {
    route: { workspaceId: WS, localPart: "agent", domain: "mail.openinst.com", address: TO },
    rowId: "em_reply_1",
    threadId: "th1",
    texts: [],
  });
  assert.equal(emptyRes.kind, "none");


  const envDisabled: any = {
    DB: d1,
    AGENT_EMAIL_ENABLED: "1",
    AGENT_EMAIL_OUTBOUND_ENABLED: "0",
  };
  const suppRes = await enqueueReply(envDisabled, {
    route: { workspaceId: WS, localPart: "agent", domain: "mail.openinst.com", address: TO },
    rowId: "em_reply_1",
    threadId: "th1",
    texts: ["hello"],
  });
  assert.equal(suppRes.kind, "suppressed");
  assert.equal(suppRes.reason, "outbound_disabled");

  console.log("  ✅ enqueueReply returns typed result and enforces Auto-Submitted: auto-replied");
}


{
  const agentAddr = "myagent@mail.openinst.com";
  const clientAddr = "client@example.com";
  const sub = "Project Review";


  const textNoRow = formatOwnerNotificationText(agentAddr, clientAddr, sub, "processed", null);
  assert.ok(textNoRow.includes("已收下，未自动回复。"), "processed with no outbox must not claim auto-replied");

  // 3.2 queued
  const textQueued = formatOwnerNotificationText(agentAddr, clientAddr, sub, "processed", "queued");
  assert.ok(textQueued.includes("已生成自动回复，正在投递。"));

  // 3.3 accepted
  const textAccepted = formatOwnerNotificationText(agentAddr, clientAddr, sub, "processed", "accepted");
  assert.ok(textAccepted.includes("已自动回复。"));

  // 3.4 accepted_pending_commit
  const textPending = formatOwnerNotificationText(agentAddr, clientAddr, sub, "processed", "accepted_pending_commit");
  assert.ok(textPending.includes("邮件服务已接受，正在确认状态。"));

  // 3.5 delivery_unknown
  const textUnknown = formatOwnerNotificationText(agentAddr, clientAddr, sub, "processed", "delivery_unknown");
  assert.ok(textUnknown.includes("已生成自动回复，但投递结果未知。"));

  // 3.6 permanent_failed
  const textFailed = formatOwnerNotificationText(agentAddr, clientAddr, sub, "processed", "permanent_failed");
  assert.ok(textFailed.includes("自动回复投递失败。"));

  console.log("  ✅ formatOwnerNotificationText matches V2 §21 auto-reply truth table");
}

console.log("✅ email-subject-and-reply-truth: all assertions passed");
