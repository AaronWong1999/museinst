
import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import type { Env } from "../src/env";
import {
  TOOL_agent_mail_list,
  TOOL_agent_mail_read,
  TOOL_agent_mail_reply,
  TOOL_agent_mail_forward,
  agentMailToolsFor,
} from "../src/agent/tools-agent-mail";
import { TOOL_get_self_info } from "../src/agent/self-info";
import { enqueueOutbox } from "../src/channels/email/outbox";

console.log("▶ Agent Mail tools & self-info contract (V2 §29/§30/§32)");

const WS = "w_tools_test";
const TO = "agent@mail.openinst.com";
const FROM = "peer@example.net";

function seed(d1: TestD1) {
  d1Exec(d1, `INSERT OR IGNORE INTO users (id, created_at) VALUES ('u_tools', 0)`);
  d1Exec(d1, `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_tools', 0)`, WS);
  d1Exec(
    d1,
    `INSERT OR REPLACE INTO agent_mailboxes
      (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
     VALUES (?, 'agent', 'mail.openinst.com', ?, 'active', 100, 300, 1, 0, 0)`,
    WS, TO,
  );
}

function insertMessage(d1: TestD1, id: string, direction = "in", subject = "Subject A", text = "Body Text") {
  d1Exec(
    d1,
    `INSERT INTO email_messages (id, workspace_id, direction, fingerprint, raw_sha256, thread_id,
      from_addr, to_addr, subject, snippet, body_text, scope_key, message_auth, ingest_state, created_at)
     VALUES (?, ?, ?, ?, 'sha', ?, ?, ?, ?, 'snip', ?, 'scope', 'none', 'processed', ?)`,
    id, WS, direction, `fp_${id}`, `th_${id}`, FROM, TO, subject, text, Date.now(),
  );
}

const d1 = createTestD1();
seed(d1);
insertMessage(d1, "em_in_1", "in", "Invoice for August", "Please pay attached invoice.");
insertMessage(d1, "em_out_1", "out", "Project Alpha Update", "Status is green.");

const env: any = {
  DB: d1,
  AGENT_EMAIL_ENABLED: "1",
  AGENT_EMAIL_OUTBOUND_ENABLED: "1",
  MODEL_PROVIDER: "workers-ai",
  MODEL_ROOT: "@cf/test",
  MODEL_WORKER: "@cf/test",
};

const ctx: any = {
  env,
  workspaceId: WS,
  userId: "u_tools",
  channel: "web",
  taskId: "task_tool_001",
};


{

  const all = await TOOL_agent_mail_list.run(ctx, { limit: 10 });
  assert.equal(all.ok, true);
  assert.equal(all.data.length, 2);


  const inOnly = await TOOL_agent_mail_list.run(ctx, { direction: "in" });
  assert.equal(inOnly.ok, true);
  assert.equal(inOnly.data.length, 1);
  assert.equal(inOnly.data[0].id, "em_in_1");


  const outOnly = await TOOL_agent_mail_list.run(ctx, { direction: "out" });
  assert.equal(outOnly.ok, true);
  assert.equal(outOnly.data.length, 1);
  assert.equal(outOnly.data[0].id, "em_out_1");


  const queryRes = await TOOL_agent_mail_list.run(ctx, { query: "Invoice" });
  assert.equal(queryRes.ok, true);
  assert.equal(queryRes.data.length, 1);
  assert.equal(queryRes.data[0].id, "em_in_1");

  console.log("  ✅ agent_mail_list supports direction filtering and query search");
}


{

  await enqueueOutbox(env, {
    workspaceId: WS,
    logicalKey: "reply:em_in_1:0",
    fromAddr: TO,
    toAddr: FROM,
    subject: "Re: Invoice for August",
    textBody: "Auto acknowledgment",
    messageId: "<auto@mail.openinst.com>",
  });


  const replyRes = await TOOL_agent_mail_reply.run(ctx, {
    inboundId: "em_in_1",
    body: "Owner confirmed payment will be sent tomorrow.",
  });
  assert.equal(replyRes.ok, true);
  const outboxId = replyRes.data.outboxId;

  const ownerOutbox = await d1Get<any>(d1, `SELECT logical_key FROM email_outbox WHERE id=?`, outboxId);
  assert.equal(ownerOutbox.logical_key, "reply:em_in_1:owner:task_tool_001", "owner reply logical key must be partitioned by taskId");


  const totalOutbox = await d1Get<any>(d1, `SELECT COUNT(*) AS c FROM email_outbox WHERE workspace_id=?`, WS);
  assert.equal(totalOutbox.c, 2, "auto reply and owner reply must coexist without collision");

  console.log("  ✅ agent_mail_reply creates independent owner outbox without colliding with auto reply");
}


{
  assert.equal(TOOL_agent_mail_forward.needsApproval, true, "forward must require approval");

  const forwardRes = await TOOL_agent_mail_forward.run(ctx, {
    inboundId: "em_in_1",
    to: "finance@company.com",
    note: "Please handle this invoice.",
  });
  assert.equal(forwardRes.ok, true);
  const fwdOutboxId = forwardRes.data.outboxId;

  const fwdOutbox = await d1Get<any>(d1, `SELECT * FROM email_outbox WHERE id=?`, fwdOutboxId);
  assert.equal(fwdOutbox.logical_key, "forward:em_in_1:finance@company.com:task_tool_001");
  assert.equal(fwdOutbox.to_addr, "finance@company.com");
  assert.ok(fwdOutbox.subject.startsWith("Fwd:"));
  assert.ok(fwdOutbox.text_body.includes("Please handle this invoice."));
  assert.ok(fwdOutbox.text_body.includes("---------- Forwarded message ---------"));
  assert.ok(fwdOutbox.text_body.includes("Please pay attached invoice."));

  console.log("  ✅ agent_mail_forward generates formatted forward outbox with approval");
}


{
  const emailTools = agentMailToolsFor("email");
  assert.equal(emailTools.length, 0, "external email turn must have zero agent_mail tools");

  const a2aTools = agentMailToolsFor("a2a");
  assert.equal(a2aTools.length, 0, "external a2a turn must have zero agent_mail tools");

  const ownerTools = agentMailToolsFor("owner_chat");
  assert.ok(ownerTools.length >= 7, "owner chat turn has all agent_mail tools");

  console.log("  ✅ agentMailToolsFor completely hides mail tools from external turns");
}


{
  const infoRes = await TOOL_get_self_info.run(ctx, { aspect: "channels" });
  assert.equal(infoRes.ok, true);
  const agentMail = infoRes.data.channels.agent_mail;
  assert.ok(agentMail);
  assert.equal(agentMail.configured, true);
  assert.equal(agentMail.address, TO);
  assert.equal(agentMail.domain, "mail.openinst.com");
  assert.equal(agentMail.stranger_autoreply, true);

  console.log("  ✅ get_self_info exposes channels.agent_mail truthfully");
}

console.log("✅ email-tools-and-self-info: all assertions passed");
