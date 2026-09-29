






import assert from "node:assert/strict";
import { handleInboundEmail } from "../src/channels/email/ingress";
import { consumeEmailDispatchEnvelope } from "../src/channels/email/dispatch-queue";
import { TOOL_agent_mail_start_secure_thread } from "../src/agent/tools-agent-mail";
import { mintThreadCapability, revokeThreadCapability, verifyThreadCapability } from "../src/channels/email/thread";
import { normalizeThread } from "../src/channels/email/mailbox";
import { enqueueOutbox, getOutboundMessageId } from "../src/channels/email/outbox";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import { resetHostHooks } from "../src/hooks";

console.log("▶ Secure thread capability wiring (A15/A07)");

const WS = "ws_sec";
const OTHER_WS = "ws_other";
const LOCAL = "agent";
const DOMAIN = "mail.example.com";
const MAILBOX = `${LOCAL}@${DOMAIN}`;
const OWNER = "owner@personal.test";
const TH = "th_seeded";

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

function seedWorkspace(d1: TestD1, ws: string, localPart: string): void {
  d1Exec(d1, `INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 0)`, `u_${ws}`);
  d1Exec(d1, `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, ?, 0)`, ws, `u_${ws}`);
  d1Exec(
    d1,
    `INSERT OR REPLACE INTO agent_mailboxes (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 100, 300, 1, 0, 0)`,
    ws,
    localPart,
    DOMAIN,
    `${localPart}@${DOMAIN}`,
  );
}

function makeEnv(d1: TestD1): { env: any; calls: any[] } {
  const calls: any[] = [];
  const env: any = {
    DB: d1,
    ARTIFACTS: makeR2(),
    AGENT_EMAIL_ENABLED: "1",
    AGENT_EMAIL_OUTBOUND_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
    AGENT: {
      idFromName: (name: string) => name,
      get: (room: string) => ({
        fetch: async (_url: string, init: RequestInit) => {
          calls.push({ room, body: JSON.parse(String(init?.body ?? "{}")) });
          return Response.json({ replies: ["auto reply"], taskId: "t1" });
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

function rawEmail(o: { from: string; to: string; body: string; messageId: string; inReplyTo?: string }): ArrayBuffer {
  const headers = [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Message-ID: ${o.messageId}`,
    `Subject: hello`,
    `Content-Type: text/plain; charset=utf-8`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
  ].join("\r\n");
  return new TextEncoder().encode(`${headers}\r\n\r\n${o.body}`).buffer as ArrayBuffer;
}

async function ingest(env: any, raw: ArrayBuffer, o: { from: string; to: string }): Promise<any> {
  const pending: Promise<unknown>[] = [];
  const result = await handleInboundEmail(
    { from: o.from, to: o.to, raw, rawSize: raw.byteLength, headers: new Headers(), setReject: () => {} },
    env,
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return result;
}

function toolCtx(env: any, workspaceId = WS): any {
  return { env, workspaceId, userId: `u_${workspaceId}`, channel: "web", lang: "zh", say: async () => {}, hasActiveBrowserTask: () => false };
}


async function seedSentOutbox(d1: TestD1, opts: { threadId: string; providerId: string; toAddr?: string }): Promise<string> {
  const r = await enqueueOutbox({ DB: d1 } as never, {
    workspaceId: WS,
    logicalKey: `seed:${opts.threadId}:${opts.providerId}`,
    fromAddr: MAILBOX,
    toAddr: opts.toAddr ?? OWNER,
    subject: "seed",
    textBody: "seed",
    messageId: getOutboundMessageId(MAILBOX),
    threadId: opts.threadId,
  });
  d1Exec(d1, `UPDATE email_outbox SET status='accepted', provider_message_id=? WHERE id=?`, opts.providerId, r.id);
  return r.id;
}

const tokenOf = (replyTo: string): string => replyTo.split("+r.")[1].split("@")[0];
const bytes = (s: string): number => new TextEncoder().encode(s).length;

process.on("exit", () => resetHostHooks());


{
  const d1 = createTestD1();
  seedWorkspace(d1, WS, LOCAL);
  const { env, calls } = makeEnv(d1);
  await seedSentOutbox(d1, { threadId: TH, providerId: "<prov-th@mail.example.com>" });
  const minted = await mintThreadCapability(env, {
    workspaceId: WS,
    threadId: TH,
    peerAddress: OWNER,
    localPart: LOCAL,
    domain: DOMAIN,
  });
  const r = await ingest(env, rawEmail({ from: OWNER, to: minted.replyTo!, body: "hello", messageId: "<i1@personal.test>", inReplyTo: "<prov-th@mail.example.com>" }), {
    from: OWNER,
    to: minted.replyTo!,
  });
  assert.equal(r.handled, true);
  const row = await d1Get<any>(d1, `SELECT thread_id, message_auth, capability_id, ingest_state FROM email_messages`);
  assert.equal(row.message_auth, "thread_capability", "正确 token+thread 必须认证通过");
  assert.equal(row.thread_id, TH, "授权线程 = capability 签发线程");
  assert.equal(row.capability_id, minted.capabilityId);
  assert.equal(row.ingest_state, "processed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.security.authenticatedOwner, false, "capability 不是主人身份");
  assert.equal(calls[0].body.security.messageAuth, "thread_capability");
  assert.equal(calls[0].body.security.promptProfile, "external_minimal");
  assert.deepEqual(calls[0].body.security.allowTools, []);
  assert.equal(calls[0].body.security.allowPrivateContext, false);
  console.log("  ✅ valid capability: thread-scoped, not owner");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1, WS, LOCAL);
  seedWorkspace(d1, OTHER_WS, "agento");
  const { env } = makeEnv(d1);
  await seedSentOutbox(d1, { threadId: TH, providerId: "<prov-A@mail.example.com>" });
  await seedSentOutbox(d1, { threadId: "th_B", providerId: "<prov-B@mail.example.com>" });
  const P_A = "<prov-A@mail.example.com>";

  const noneAuth = async (to: string, from: string, inReplyTo: string, messageId: string) => {
    await ingest(env, rawEmail({ from, to, body: "x", messageId, inReplyTo }), { from, to });
    const row = await d1Get<any>(d1, `SELECT message_auth FROM email_messages WHERE message_id=?`, messageId);
    return row?.message_auth;
  };

  const capPeer = await mintThreadCapability(env, { workspaceId: WS, threadId: TH, peerAddress: OWNER, localPart: LOCAL, domain: DOMAIN });
  assert.equal(await noneAuth(capPeer.replyTo!, "eve@evil.test", P_A, "<n-peer@evil.test>"), "none", "peer_mismatch 必须拒绝");

  const capThread = await mintThreadCapability(env, { workspaceId: WS, threadId: TH, peerAddress: OWNER, localPart: LOCAL, domain: DOMAIN });
  assert.equal(await noneAuth(capThread.replyTo!, OWNER, "<prov-B@mail.example.com>", "<n-thread@personal.test>"), "none", "不同线程不能复用授权");

  const capWs = await mintThreadCapability(env, { workspaceId: OTHER_WS, threadId: TH, peerAddress: OWNER, localPart: LOCAL, domain: DOMAIN });
  assert.equal(await noneAuth(capWs.replyTo!, OWNER, P_A, "<n-ws@personal.test>"), "none", "workspace_mismatch 必须拒绝");

  const capExp = await mintThreadCapability(env, { workspaceId: WS, threadId: TH, peerAddress: OWNER, localPart: LOCAL, domain: DOMAIN, ttlMs: -1000 });
  assert.equal(await noneAuth(capExp.replyTo!, OWNER, P_A, "<n-exp@personal.test>"), "none", "过期 token 必须拒绝");

  const capRev = await mintThreadCapability(env, { workspaceId: WS, threadId: TH, peerAddress: OWNER, localPart: LOCAL, domain: DOMAIN });
  await revokeThreadCapability(env, { workspaceId: WS, capabilityId: capRev.capabilityId });
  assert.equal(await noneAuth(capRev.replyTo!, OWNER, P_A, "<n-rev@personal.test>"), "none", "撤销 token 必须拒绝");
  console.log("  ✅ wrong peer/workspace/thread, expired, revoked all rejected");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1, WS, LOCAL);
  const { env } = makeEnv(d1);
  const ctx = toolCtx(env, WS);

  const refused = await TOOL_agent_mail_start_secure_thread.run(ctx, { to: OWNER });
  assert.equal(refused.ok, false, "address_verified_by_owner=0 必须拒绝");
  assert.equal(refused.error, "address_not_verified");
  assert.equal((refused.data as any).verificationSent, true);
  const challenge = await d1Get<any>(d1, `SELECT id, reply_to FROM email_outbox WHERE logical_key LIKE 'addr_verify:%'`);
  assert.ok(challenge?.reply_to?.includes("+v."), "拒绝时必须发出带 +v. 的一次性挑战");

  const verifiedResult = await ingest(env, rawEmail({ from: OWNER, to: challenge.reply_to, body: "confirmed", messageId: "<v1@personal.test>" }), {
    from: OWNER,
    to: challenge.reply_to,
  });
  assert.equal(verifiedResult.reason, "address_verified");
  const contact = await d1Get<any>(d1, `SELECT address_verified_by_owner FROM email_contacts WHERE workspace_id=? AND address=?`, WS, OWNER);
  assert.equal(contact.address_verified_by_owner, 1, "挑战回信必须建立 address_verified_by_owner");
  const replayVerify = await ingest(env, rawEmail({ from: OWNER, to: challenge.reply_to, body: "again", messageId: "<v2@personal.test>" }), {
    from: OWNER,
    to: challenge.reply_to,
  });
  assert.notEqual(replayVerify.reason, "address_verified", "挑战是一次性的，重放不得再次建立事实");

  const started = await TOOL_agent_mail_start_secure_thread.run(ctx, { to: OWNER });
  assert.equal(started.ok, true, JSON.stringify(started));
  const threadId = String((started.data as any).threadId);
  const replyTo1 = String((started.data as any).replyTo);
  assert.ok(bytes(replyTo1.split("@")[0]) <= 64, `local-part 必须 ≤ 64 字节，实际 ${bytes(replyTo1.split("@")[0])}`);
  const startRow = await d1Get<any>(d1, `SELECT id, thread_id, reply_to FROM email_outbox WHERE logical_key LIKE 'verification:secure_thread:%'`);
  assert.equal(startRow.thread_id, threadId);

  let replyTo = replyTo1;
  let providerId = "<prov-start@mail.example.com>";
  d1Exec(d1, `UPDATE email_outbox SET status='accepted', provider_message_id=? WHERE id=?`, providerId, startRow.id);
  const seenReplyTo: string[] = [];
  for (let round = 1; round <= 3; round++) {
    const msgId = `<round${round}@personal.test>`;
    const inReplyTo = providerId;
    const r = await ingest(env, rawEmail({ from: OWNER, to: replyTo, body: `round ${round}`, messageId: msgId, inReplyTo }), { from: OWNER, to: replyTo });
    assert.equal(r.handled, true);
    const row = await d1Get<any>(d1, `SELECT id, thread_id, message_auth FROM email_messages WHERE message_id=?`, msgId);
    assert.equal(row.message_auth, "thread_capability", `round ${round}: capability 认证必须持续有效`);
    assert.equal(row.thread_id, threadId, `round ${round}: 线程 scope 不能漂移`);

    const auto = await d1Get<any>(d1, `SELECT id, thread_id, reply_to FROM email_outbox WHERE logical_key=?`, `reply:${row.id}:0`);
    assert.ok(auto, `round ${round}: 必须产生自动回复`);
    assert.equal(auto.thread_id, threadId);
    assert.ok(auto.reply_to?.includes("+r."), `round ${round}: 自动回复必须携带 capability Reply-To`);
    seenReplyTo.push(auto.reply_to);
    const prevVerify = await verifyThreadCapability(env, tokenOf(replyTo), { workspaceId: WS, peerAddress: OWNER, threadId });
    assert.equal(prevVerify.ok, false, `round ${round}: 旧 Reply-To token 必须失效`);

    replyTo = auto.reply_to;
    providerId = `<prov-round${round}@mail.example.com>`;
    d1Exec(d1, `UPDATE email_outbox SET status='accepted', provider_message_id=? WHERE id=?`, providerId, auto.id);
  }
  assert.equal(new Set([replyTo1, ...seenReplyTo]).size, 4, "每轮 Reply-To 都必须轮换出新 token");
  const latest = await verifyThreadCapability(env, tokenOf(replyTo), { workspaceId: WS, peerAddress: OWNER, threadId });
  assert.equal(latest.ok, true, "最新 Reply-To 必须仍绑定同一线程");
  console.log("  ✅ challenge → tool → 3 round trips without losing thread scope");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1, WS, LOCAL);
  seedWorkspace(d1, OTHER_WS, "agento");
  const env: any = { DB: d1 };
  await seedSentOutbox(d1, { threadId: "th_provider", providerId: "<prov-real@mail.example.com>" });
  await seedSentOutbox(d1, { threadId: "th_app", providerId: "<prov-app@mail.example.com>" });
  d1Exec(d1, `UPDATE email_outbox SET message_id='<app-made@mail.example.com>' WHERE thread_id='th_app'`);
  await enqueueOutbox({ DB: d1 } as never, {
    workspaceId: OTHER_WS,
    logicalKey: "seed:other",
    fromAddr: MAILBOX,
    toAddr: OWNER,
    subject: "s",
    textBody: "t",
    messageId: getOutboundMessageId(MAILBOX),
    threadId: "th_other",
  });

  assert.equal(await normalizeThread(env, { workspaceId: WS, inReplyTo: "<prov-real@mail.example.com>", references: [] }), "th_provider");
  assert.equal(await normalizeThread(env, { workspaceId: WS, inReplyTo: "<app-made@mail.example.com>", references: [] }), "th_app", "应用 message_id 兼容匹配保留");
  assert.equal(
    await normalizeThread(env, { workspaceId: WS, inReplyTo: null, references: ["<unrelated@x>", "<prov-real@mail.example.com>"] }),
    "th_provider",
    "References 也必须能命中 provider ID",
  );
  const fresh = await normalizeThread(env, { workspaceId: WS, inReplyTo: "<nope@x>", references: [] });
  assert.ok(fresh.startsWith("th_"), "无命中时新建线程");
  assert.notEqual(
    await normalizeThread(env, { workspaceId: OTHER_WS, inReplyTo: "<prov-real@mail.example.com>", references: [] }),
    "th_provider",
    "provider ID 匹配必须受 workspace 隔离",
  );
  console.log("  ✅ normalizeThread: provider ID first, app message_id compat, workspace isolated");
}

console.log("✅ integr-secure-thread.test.ts passed");