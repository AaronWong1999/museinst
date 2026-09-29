






import assert from "node:assert/strict";
import { handleInboundEmail } from "../src/channels/email/ingress";
import { consumeEmailDispatchEnvelope } from "../src/channels/email/dispatch-queue";
import { parseEmail } from "../src/channels/email/parse";
import { TOOL_agent_mail_list, TOOL_agent_mail_read, TOOL_agent_mail_thread } from "../src/agent/tools-agent-mail";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import { resetHostHooks } from "../src/hooks";
import { generateSigningKey, signEnvelope } from "../src/channels/email/a2a/sign";
import { b64urlEncode, sha256HexString } from "../src/channels/email/a2a/codec";
import type { A2aEnvelope } from "../src/channels/email/a2a/schema";

console.log("▶ Email routing / read surface / A2A wiring (A05/A11/A13)");

const DOMAIN = "mail.example.com";
const STRANGER = "stranger@outlook.com";

interface AgentCall {
  room: string;
  body: any;
}

function makeR2() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer) => void store.set(String(k), v),
    get: async (k: string) => {
      const v = store.get(String(k));
      return v ? { arrayBuffer: async () => v } : null;
    },
  };
}

function seedMailbox(d1: TestD1, ws: string, localPart: string, opts: { strangerAutoreply?: 0 | 1 } = {}): string {
  d1Exec(d1, `INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 0)`, `u_${ws}`);
  d1Exec(d1, `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, ?, 0)`, ws, `u_${ws}`);
  const address = `${localPart}@${DOMAIN}`;
  d1Exec(
    d1,
    `INSERT OR REPLACE INTO agent_mailboxes (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 100, 300, ?, 0, 0)`,
    ws,
    localPart,
    DOMAIN,
    address,
    opts.strangerAutoreply ?? 1,
  );
  return address;
}

interface EnvOpts {
  flags?: Record<string, string | undefined>;
  replies?: string[];
}

function makeEnv(d1: TestD1, o: EnvOpts = {}): { env: any; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  const env: any = {
    DB: d1,
    ARTIFACTS: makeR2(),
    AGENT_EMAIL_ENABLED: "1",
    AGENT_EMAIL_OUTBOUND_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
    ...(o.flags ?? {}),
    AGENT: {
      idFromName: (name: string) => name,
      get: (room: string) => ({
        fetch: async (_url: string, init: RequestInit) => {
          calls.push({ room, body: JSON.parse(String(init?.body ?? "{}")) });
          return Response.json({ replies: o.replies ?? ["auto reply"], taskId: "t1" });
        },
      }),
    },
  };
  env.EMAIL_DISPATCH_QUEUE = {
    send: async (envelope: any) => {
      const outcome = await consumeEmailDispatchEnvelope(env, envelope);
      if (outcome.kind === "retry") throw new Error("test_email_dispatch_retry");
    },
  };
  resetHostHooks();
  return { env, calls };
}

function rawEmail(o: {
  from: string;
  to: string;
  body: string;
  messageId: string;
  contentType?: string;
  extraHeaders?: string[];
}): ArrayBuffer {
  const headers = [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Message-ID: ${o.messageId}`,
    `Subject: hello`,
    `Content-Type: ${o.contentType ?? "text/plain; charset=utf-8"}`,
    ...(o.extraHeaders ?? []),
  ].join("\r\n");
  return new TextEncoder().encode(`${headers}\r\n\r\n${o.body}`).buffer as ArrayBuffer;
}

async function ingest(env: any, raw: ArrayBuffer, opts: { from: string; to: string }): Promise<any> {
  const rejects: string[] = [];
  const pending: Promise<unknown>[] = [];
  const result = await handleInboundEmail(
    {
      from: opts.from,
      to: opts.to,
      raw,
      rawSize: raw.byteLength,
      headers: new Headers(),
      setReject: (r: string) => rejects.push(r),
    },
    env,
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return result;
}

function toolCtx(env: any, workspaceId: string): any {
  return { env, workspaceId, userId: `u_${workspaceId}`, channel: "web", lang: "zh", say: async () => {}, hasActiveBrowserTask: () => false };
}

process.on("exit", () => resetHostHooks());


{
  const d1 = createTestD1();
  const toA = seedMailbox(d1, "wsA", "agenta");
  const { env, calls } = makeEnv(d1);
  const r = await ingest(env, rawEmail({ from: STRANGER, to: toA, body: "你好，帮我看看", messageId: "<r1@outlook.com>" }), {
    from: STRANGER,
    to: toA,
  });
  assert.equal(r.handled, true);
  assert.equal(r.reason, "dispatched");
  assert.equal(calls.length, 1, "未注册发件人也必须调用收件 Agent");
  assert.equal(calls[0].room, "wsA", "目标只能是收件 mailbox 的 workspace");
  assert.equal(calls[0].body.security.workspaceId, "wsA");
  assert.equal(calls[0].body.security.authenticatedOwner, false, "普通邮件不是 owner 身份");
  assert.equal(calls[0].body.event.senderId, STRANGER);
  const row = await d1Get<any>(d1, `SELECT ingest_state, message_auth FROM email_messages`);
  assert.equal(row.ingest_state, "processed");
  assert.equal(row.message_auth, "none", "未认证发件人 messageAuth=none");
  console.log("  ✅ stranger → recipient workspace agent (route = mailbox)");
}


{
  const d1 = createTestD1();
  const toA = seedMailbox(d1, "wsA", "agenta");
  const toB = seedMailbox(d1, "wsB", "agentb");
  const { env, calls } = makeEnv(d1);
  await ingest(env, rawEmail({ from: STRANGER, to: toA, body: "for A", messageId: "<ab1@x.com>" }), { from: STRANGER, to: toA });
  await ingest(env, rawEmail({ from: STRANGER, to: toB, body: "for B", messageId: "<ab2@x.com>" }), { from: STRANGER, to: toB });
  assert.deepEqual(calls.map((c) => c.room), ["wsA", "wsB"]);
  const rows = d1.db.prepare(`SELECT workspace_id, to_addr FROM email_messages ORDER BY created_at`).all() as any[];
  assert.deepEqual(rows.map((r) => r.workspace_id), ["wsA", "wsB"]);
  assert.deepEqual(rows.map((r) => r.to_addr), [toA, toB]);
  console.log("  ✅ same sender → A/B each only its own agent");
}


{
  const d1 = createTestD1();
  const toA = seedMailbox(d1, "wsA", "agenta");
  seedMailbox(d1, "wsC", "agentc");
  d1Exec(
    d1,
    `INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('email', ?, 'wsC', 0, 0)`,
    STRANGER,
  );
  const { env, calls } = makeEnv(d1);
  await ingest(env, rawEmail({ from: STRANGER, to: toA, body: "hi A", messageId: "<c1@x.com>" }), { from: STRANGER, to: toA });
  assert.deepEqual(calls.map((c) => c.room), ["wsA"], "发件人所属 workspace 不得改变路由");
  const row = await d1Get<any>(d1, `SELECT workspace_id, scope_key FROM email_messages`);
  assert.equal(row.workspace_id, "wsA");
  assert.ok(!String(row.scope_key).includes("wsC"));
  console.log("  ✅ sender bound to C cannot route A's mail to C");
}


{
  const d1 = createTestD1();
  const toA = seedMailbox(d1, "wsA", "agenta");
  seedMailbox(d1, "wsTarget", "agentt");
  d1Exec(d1, `INSERT INTO bind_nonces (nonce, workspace_id, user_id, purpose, expires_at) VALUES ('BIND123', 'wsTarget', 'u_wsTarget', 'bind_code', ?)`, Date.now() + 86_400_000);
  const { env, calls } = makeEnv(d1);
  const workspacesBefore = (d1.db.prepare(`SELECT COUNT(*) AS c FROM workspaces`).get() as any).c;

  const body = ["/bind BIND123", "/start BIND123", "/start", "/bind"].join("\n");
  const r = await ingest(env, rawEmail({ from: STRANGER, to: toA, body, messageId: "<cmd@x.com>" }), { from: STRANGER, to: toA });
  assert.equal(r.handled, true);
  assert.equal(calls.length, 1, "命令字样只作为正文进入收件 Agent");

  const code = await d1Get<any>(d1, `SELECT used_at, claim_state, claim_token, result_login_nonce FROM bind_nonces WHERE nonce='BIND123'`);
  assert.equal(code.used_at, null, "验证码绝不能被邮件正文消耗");
  assert.equal(code.claim_state, null);
  assert.equal(code.claim_token, null);
  assert.equal(code.result_login_nonce, null);

  const loginCount = (d1.db.prepare(`SELECT COUNT(*) AS c FROM bind_nonces WHERE purpose='login'`).get() as any).c;
  assert.equal(loginCount, 0, "邮件正文绝不能创建主人登录链接");
  const workspacesAfter = (d1.db.prepare(`SELECT COUNT(*) AS c FROM workspaces`).get() as any).c;
  assert.equal(workspacesAfter, workspacesBefore, "邮件正文绝不能建号");
  console.log("  ✅ /bind & /start in body: no code consumption, no account, no login link");
}


{
  const d1 = createTestD1();
  const toA = seedMailbox(d1, "wsA", "agenta");
  const { env } = makeEnv(d1);
  const body = "x".repeat(1499) + "MARKER-1500" + "y".repeat(500);
  await ingest(env, rawEmail({ from: STRANGER, to: toA, body, messageId: "<long@x.com>" }), { from: STRANGER, to: toA });
  const row = await d1Get<any>(d1, `SELECT id, thread_id, snippet FROM email_messages`);

  const read = await TOOL_agent_mail_read.run(toolCtx(env, "wsA"), { id: row.id });
  assert.equal(read.ok, true);
  const full = read.data as any;
  assert.equal(String(full.body).slice(1499, 1499 + 11), "MARKER-1500", "read 必须能读到第 1500 字");
  assert.equal(full.bodyAvailable, true);

  const list = await TOOL_agent_mail_list.run(toolCtx(env, "wsA"), {});
  const listRows = list.data as any[];
  assert.ok(listRows[0].snippet && !("body_text" in listRows[0]) && !("body" in listRows[0]), "列表仍只给 snippet");

  const thread = await TOOL_agent_mail_thread.run(toolCtx(env, "wsA"), { threadId: row.thread_id });
  assert.equal(thread.ok, true);
  assert.equal(String((thread.data as any[])[0].body).slice(1499, 1499 + 11), "MARKER-1500", "thread 也返回完整正文");

  const cross = await TOOL_agent_mail_read.run(toolCtx(env, "wsB"), { id: row.id });
  assert.equal(cross.ok, false, "跨 workspace 读取必须失败");

  const html = `<html><body><style>p{color:red}</style><p>Hello <b>HTML</b> world</p><p>Second line</p></body></html>`;
  await ingest(env, rawEmail({ from: STRANGER, to: toA, body: html, contentType: "text/html; charset=utf-8", messageId: "<html@x.com>" }), {
    from: STRANGER,
    to: toA,
  });
  const htmlRow = await d1Get<any>(d1, `SELECT id FROM email_messages WHERE message_id='<html@x.com>'`);
  const htmlRead = await TOOL_agent_mail_read.run(toolCtx(env, "wsA"), { id: htmlRow.id });
  assert.equal(htmlRead.ok, true);
  assert.ok(String((htmlRead.data as any).body).includes("Hello HTML world"), "HTML-only 邮件正文可读");
  console.log("  ✅ read/thread full body, list snippet, workspace isolation, HTML-only readable");
}


const PEER_ISSUER = "peer.example.net";
const PEER_AGENT = "alice@peer.example.net";

async function a2aFixture(): Promise<{ d1: TestD1; raw: ArrayBuffer; a2aEnv: Record<string, string> }> {
  const d1 = createTestD1();
  seedMailbox(d1, "wsA", "agenta");
  const peer = await generateSigningKey("peer_k1");
  d1Exec(
    d1,
    `INSERT INTO a2a_domain_consents (workspace_id, issuer, status, confirmed_by, confirmed_at) VALUES ('wsA', ?, 'allowed', 'test', 0)`,
    PEER_ISSUER,
  );
  d1Exec(
    d1,
    `INSERT INTO trust_edges (id, workspace_id, peer_address, peer_agent, peer_issuer, relation, status, disclosure_json, auto_accept, invited_at)
     VALUES ('te_1', 'wsA', ?, ?, ?, 'assistant', 'active', '{}', 0, 0)`,
    PEER_AGENT,
    PEER_AGENT,
    PEER_ISSUER,
  );
  const local = await generateSigningKey("local_k1");
  const a2aEnv: Record<string, string> = {
    A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify({
      issuers: { [PEER_ISSUER]: { mailDomains: [PEER_ISSUER], keys: { peer_k1: { x: peer.publicJwk.x } } } },
    }),
    A2A_SIGNING_PRIVATE_JWK: JSON.stringify({ ...local.privateJwk, kid: "local_k1", issuer: "local.test" }),
  };

  const bodyText = "please coordinate a schedule";
  const to = `agenta@${DOMAIN}`;
  const base: A2aEnvelope = {
    v: 1,
    issuer: PEER_ISSUER,
    kid: "peer_k1",
    fromAgent: PEER_AGENT,
    toAgent: to,
    type: "propose",
    convo: "cv_integr",
    seq: 1,
    intent: "coordinate.schedule",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86_400,
    nonce: "n1",
    payload: { timezone: "Asia/Shanghai" },
    humanBodySha256: "",
  };
  const probe = rawEmail({ from: PEER_AGENT, to, body: bodyText, messageId: "<a2a-probe@peer.example.net>" });
  const parsed = await parseEmail(probe, PEER_AGENT);
  base.humanBodySha256 = await sha256HexString(parsed.text);
  const sig = await signEnvelope(peer.privateJwk, base);
  const raw = rawEmail({
    from: PEER_AGENT,
    to,
    body: bodyText,
    messageId: "<a2a-1@peer.example.net>",
    extraHeaders: [
      `X-OpenInst-A2A-Envelope: ${b64urlEncode(new TextEncoder().encode(JSON.stringify(base)))}`,
      `X-OpenInst-A2A-Sig: ${sig}`,
      `X-OpenInst-A2A-Kid: peer_k1`,
      `X-OpenInst-A2A-Issuer: ${PEER_ISSUER}`,
    ],
  });
  return { d1, raw, a2aEnv };
}

{
  const { d1, raw, a2aEnv } = await a2aFixture();
  const { env, calls } = makeEnv(d1, { flags: { ...a2aEnv, A2A_ENABLED: undefined } });
  const r = await ingest(env, raw, { from: PEER_AGENT, to: `agenta@${DOMAIN}` });
  assert.equal(r.handled, true);
  for (const t of ["a2a_convos", "a2a_messages", "a2a_seq_reservations", "a2a_discovery_issuers"]) {
    const c = (d1.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c;
    assert.equal(c, 0, `A2A 未开启不得写 ${t}`);
  }
  assert.equal(calls.length, 1, "未开启时按普通邮件降级处理（不做协议状态机、不发协议错误）");
  const row = await d1Get<any>(d1, `SELECT ingest_state FROM email_messages`);
  assert.equal(row.ingest_state, "processed");

  const { d1: d1b, raw: rawB, a2aEnv: a2aEnvB } = await a2aFixture();
  const { env: envB, calls: callsB } = makeEnv(d1b, { flags: { ...a2aEnvB, A2A_ENABLED: "1" } });
  const rb = await ingest(envB, rawB, { from: PEER_AGENT, to: `agenta@${DOMAIN}` });
  assert.equal(rb.handled, true);
  assert.equal(rb.reason, "processed_a2a", `A2A 必须真正走完 dispatch: ${JSON.stringify(rb)}`);
  assert.equal(callsB.length, 0, "A2A 不进入普通聊天分发");
  const convo = await d1Get<any>(d1b, `SELECT state, peer_address, peer_issuer FROM a2a_convos WHERE workspace_id='wsA' AND protocol_convo_id='cv_integr'`);
  assert.equal(convo.state, "proposed");
  assert.equal(convo.peer_address, PEER_AGENT);
  assert.equal(convo.peer_issuer, PEER_ISSUER, "完整 envelope 的 issuer 必须透传到状态机");
  const msg = await d1Get<any>(d1b, `SELECT envelope_json, human_body, peer_address FROM a2a_messages WHERE workspace_id='wsA'`);
  assert.ok(msg, "协议消息必须持久化");
  const envl = JSON.parse(msg.envelope_json);
  assert.equal(envl.type, "propose");
  assert.equal(envl.convo, "cv_integr");
  assert.equal(envl.fromAgent, PEER_AGENT, "完整 envelope（不是降维字段）必须进入 dispatch");
  assert.equal(envl.payload.timezone, "Asia/Shanghai");
  assert.ok(String(msg.human_body).includes("please coordinate"), "humanBody 必须一起传入");
  console.log("  ✅ A2A gate: disabled = no side effect; enabled = full envelope dispatched");
}

console.log("✅ integr-email-routing.test.ts passed");