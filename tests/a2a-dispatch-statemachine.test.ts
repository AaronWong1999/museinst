

import assert from "node:assert/strict";
import { createTestD1, d1Get, d1Exec, type TestD1 } from "./helpers/d1";
import { dispatchA2AEvent } from "../src/channels/email/a2a/dispatch";
import { stepConvo, recordOwnerApproval, chargeA2aConvo } from "../src/channels/email/a2a/statemachine";
import { verifyA2aInbound } from "../src/channels/email/a2a/verify";
import { generateSigningKey, signEnvelope } from "../src/channels/email/a2a/sign";
import { b64urlEncode, sha256HexString } from "../src/channels/email/a2a/codec";
import type { A2aEnvelope, A2aMessageType } from "../src/channels/email/a2a/schema";

console.log("▶ A2A dispatch / state machine (P0-06, A13)");

const PEER_ISSUER = "peer.example.net";
const PEER_AGENT = "alice@peer.example.net";
const LOCAL_WS = "ws_b";
const LOCAL_DOMAIN = "mail.local.test";
const LOCAL_AGENT = `agent@${LOCAL_DOMAIN}`;
const NOW = 1_800_000_000_000;

interface Fixture {
  d1: TestD1;
  env: any;
  peer: { privateJwk: JsonWebKey; publicJwk: JsonWebKey; kid: string };
  pending: Promise<unknown>[];
}

async function makeFixture(opts: { a2aEnabled?: string | null } = {}): Promise<Fixture> {
  const d1 = createTestD1();
  const peer = await generateSigningKey("peer_k1");
  const local = await generateSigningKey("local_k1");
  d1Exec(d1, `INSERT INTO users (id, created_at) VALUES ('u_b', 0)`);
  d1Exec(d1, `INSERT INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_b', 0)`, LOCAL_WS);
  d1Exec(
    d1,
    `INSERT INTO agent_mailboxes (workspace_id, local_part, domain, address, status, created_at, updated_at) VALUES (?, 'agent', ?, ?, 'active', 0, 0)`,
    LOCAL_WS,
    LOCAL_DOMAIN,
    LOCAL_AGENT,
  );
  d1Exec(
    d1,
    `INSERT INTO a2a_domain_consents (workspace_id, issuer, status, confirmed_by, confirmed_at) VALUES (?, ?, 'allowed', 'test', 0)`,
    LOCAL_WS,
    PEER_ISSUER,
  );
  d1Exec(
    d1,
    `INSERT INTO trust_edges (id, workspace_id, peer_address, peer_agent, peer_issuer, relation, status, disclosure_json, auto_accept, invited_at)
     VALUES ('te_1', ?, ?, ?, ?, 'assistant', 'active', '{}', 0, 0)`,
    LOCAL_WS,
    PEER_AGENT,
    PEER_AGENT,
    PEER_ISSUER,
  );
  const env: any = {
    DB: d1,
    A2A_ENABLED: opts.a2aEnabled === null ? undefined : (opts.a2aEnabled ?? "1"),
    A2A_SIGNING_PRIVATE_JWK: JSON.stringify({ ...local.privateJwk, kid: "local_k1", issuer: "local.test" }),
    A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify({
      issuers: {
        "local.test": { mailDomains: [LOCAL_DOMAIN], keys: { local_k1: { x: local.publicJwk.x } } },
        [PEER_ISSUER]: { mailDomains: [PEER_ISSUER], keys: { peer_k1: { x: peer.publicJwk.x } } },
      },
    }),
  };
  return { d1, env, peer: { ...peer, kid: "peer_k1" }, pending: [] };
}

let mailSeq = 0;
async function seedInboxRow(d1: TestD1, workspaceId: string, from: string, subject = "s"): Promise<string> {
  const id = `em_${++mailSeq}`;
  d1Exec(
    d1,
    `INSERT INTO email_messages (id, workspace_id, direction, message_id, fingerprint, raw_sha256, thread_id, from_addr, to_addr, subject, snippet, scope_key, message_auth, ingest_state, created_at)
     VALUES (?, ?, 'in', ?, ?, ?, 'th_1', ?, ?, ?, '', 'email:x:th_1', 'none', 'reserved', 0)`,
    id,
    workspaceId,
    `<${id}@peer.example.net>`,
    `fp_${id}`,
    `raw_${id}`,
    from,
    LOCAL_AGENT,
    subject,
  );
  return id;
}


async function inboundEvent(
  fx: Fixture,
  opts: { type: A2aMessageType; convo: string; seq: number; payload?: Record<string, unknown>; from?: string; expInMs?: number; nowMs?: number },
) {
  const nowMs = opts.nowMs ?? NOW;
  const body = `body ${opts.type} ${opts.seq}`;
  const envelope: A2aEnvelope = {
    v: 1,
    issuer: PEER_ISSUER,
    kid: fx.peer.kid,
    fromAgent: opts.from ?? PEER_AGENT,
    toAgent: LOCAL_AGENT,
    type: opts.type,
    convo: opts.convo,
    seq: opts.seq,
    intent: "coordinate.schedule",
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + (opts.expInMs ?? 86_400_000)) / 1000),
    nonce: `n_${opts.seq}`,
    payload: opts.payload ?? {},
    humanBodySha256: await sha256HexString(body),
  };
  const sig = await signEnvelope(fx.peer.privateJwk, envelope);
  const headers = {
    "X-OpenInst-A2A-Envelope": b64urlEncode(new TextEncoder().encode(JSON.stringify(envelope))),
    "X-OpenInst-A2A-Sig": sig,
    "X-OpenInst-A2A-Kid": fx.peer.kid,
    "X-OpenInst-A2A-Issuer": PEER_ISSUER,
  };
  const verified = await verifyA2aInbound(fx.env, {
    headers,
    text: body,
    recipient: LOCAL_AGENT,
    workspaceId: LOCAL_WS,
    nowMs,
  });
  assert.equal(verified.ok, true, `verify must pass for ${opts.type}: ${JSON.stringify(verified)}`);
  const rowId = await seedInboxRow(fx.d1, LOCAL_WS, opts.from ?? PEER_AGENT);
  return { rowId, verified: verified as never, body, envelope };
}

async function dispatch(fx: Fixture, input: { rowId: string; verified: unknown; humanBody: string; threadId?: string }) {
  let result: any;
  await dispatchA2AEvent(fx.env, { waitUntil: (p) => fx.pending.push(p) }, {
    route: { workspaceId: LOCAL_WS, address: LOCAL_AGENT },
    rowId: input.rowId,
    threadId: input.threadId ?? "th_1",
    verified: input.verified as never,
    humanBody: input.humanBody,
  }).then((r) => {
    result = r;
  });
  await Promise.all(fx.pending.splice(0));
  return result;
}

async function convoOf(d1: TestD1, convo: string) {
  return await d1Get<any>(d1, `SELECT * FROM a2a_convos WHERE workspace_id=? AND protocol_convo_id=?`, LOCAL_WS, convo);
}
async function ingestOf(d1: TestD1, rowId: string) {
  return await d1Get<any>(d1, `SELECT ingest_state, ingest_last_error FROM email_messages WHERE id=?`, rowId);
}


{
  const fx = await makeFixture();
  const e = await inboundEvent(fx, { type: "propose", convo: "cv_1", seq: 1, payload: { timezone: "Asia/Shanghai" } });
  const r = await dispatch(fx, { rowId: e.rowId, verified: e.verified, humanBody: e.body });
  assert.equal(r.reason, "processed_a2a");
  const convo = await convoOf(fx.d1, "cv_1");
  assert.equal(convo.state, "proposed");
  assert.equal(convo.peer_address, PEER_AGENT);
  assert.equal(convo.peer_issuer, PEER_ISSUER);
  assert.equal(convo.rounds, 1);
  assert.equal((await ingestOf(fx.d1, e.rowId)).ingest_state, "processed_a2a");
  const msg = await d1Get<any>(fx.d1, `SELECT * FROM a2a_messages WHERE protocol_convo_id='cv_1' AND direction='in' AND seq=1`);
  assert.equal(msg.type, "propose");
  assert.equal(msg.peer_address, PEER_AGENT);
  assert.equal(msg.verified, 1);
  assert.ok(msg.envelope_json.includes('"fromAgent"'), "完整 envelope 必须落库");
  console.log("  ✅ 首次 propose 原子建 convo 并进入 proposed");
}


{
  const fx = await makeFixture();
  const e1 = await inboundEvent(fx, { type: "propose", convo: "cv_dup", seq: 1 });
  await dispatch(fx, { rowId: e1.rowId, verified: e1.verified, humanBody: e1.body });
  const before = await convoOf(fx.d1, "cv_dup");
  const e2 = await inboundEvent(fx, { type: "propose", convo: "cv_dup", seq: 1 });
  const r2 = await dispatch(fx, { rowId: e2.rowId, verified: e2.verified, humanBody: e2.body });
  assert.equal(r2.reason, "replay");
  assert.equal((await ingestOf(fx.d1, e2.rowId)).ingest_state, "rejected_a2a_replay");
  const after = await convoOf(fx.d1, "cv_dup");
  assert.equal(after.revision, before.revision);
  assert.equal(after.rounds, before.rounds);
  const count = await d1Get<any>(fx.d1, `SELECT COUNT(*) AS c FROM a2a_messages WHERE protocol_convo_id='cv_dup' AND direction='in'`);
  assert.equal(count.c, 1, "重复 seq 不得产生第二条协议记录");
  console.log("  ✅ duplicate seq 拒绝且无第二次副作用");
}


{
  const fx = await makeFixture();
  const steps: Array<[A2aMessageType, number, string]> = [
    ["propose", 1, "proposed"],
    ["counter", 2, "negotiating"],
    ["accept", 3, "pending_owner_ok"],
  ];
  for (const [type, seq, expect] of steps) {
    const e = await inboundEvent(fx, { type, convo: "cv_chain", seq, payload: { freeBusyWindows: [{ start: "a", end: "b", status: "free" }] } });
    const r = await dispatch(fx, { rowId: e.rowId, verified: e.verified, humanBody: e.body });
    assert.equal(r.reason, "processed_a2a");
    assert.equal((await convoOf(fx.d1, "cv_chain")).state, expect);
  }

  const e4 = await inboundEvent(fx, { type: "confirm", convo: "cv_chain", seq: 4 });
  const r4 = await dispatch(fx, { rowId: e4.rowId, verified: e4.verified, humanBody: e4.body });
  assert.equal(r4.reason, "owner_approval_required");
  assert.equal((await ingestOf(fx.d1, e4.rowId)).ingest_state, "rejected_a2a_transition");
  assert.equal((await convoOf(fx.d1, "cv_chain")).state, "pending_owner_ok");

  const approval = await recordOwnerApproval(fx.env, { workspaceId: LOCAL_WS, protocolConvoId: "cv_chain", approve: true, by: "owner" });
  assert.equal(approval.ok, true);
  const e5 = await inboundEvent(fx, { type: "confirm", convo: "cv_chain", seq: 5 });
  const r5 = await dispatch(fx, { rowId: e5.rowId, verified: e5.verified, humanBody: e5.body });
  assert.equal(r5.reason, "processed_a2a");
  const convo = await convoOf(fx.d1, "cv_chain");
  assert.equal(convo.state, "confirmed");
  assert.equal(convo.rounds, 4);
  console.log("  ✅ 全链路 propose→counter→accept→pending_owner_ok→confirm→confirmed");
}


{
  const fx = await makeFixture();
  const p = await inboundEvent(fx, { type: "propose", convo: "cv_decline", seq: 1 });
  await dispatch(fx, { rowId: p.rowId, verified: p.verified, humanBody: p.body });
  const d = await inboundEvent(fx, { type: "decline", convo: "cv_decline", seq: 2 });
  const rd = await dispatch(fx, { rowId: d.rowId, verified: d.verified, humanBody: d.body });
  assert.equal(rd.reason, "processed_a2a");
  assert.equal((await convoOf(fx.d1, "cv_decline")).state, "declined");
  const after = await inboundEvent(fx, { type: "counter", convo: "cv_decline", seq: 3 });
  const ra = await dispatch(fx, { rowId: after.rowId, verified: after.verified, humanBody: after.body });
  assert.equal(ra.reason, "terminal_declined");
  assert.equal((await convoOf(fx.d1, "cv_decline")).state, "declined");

  const fx2 = await makeFixture();
  const p2 = await inboundEvent(fx2, { type: "propose", convo: "cv_cancel", seq: 1 });
  await dispatch(fx2, { rowId: p2.rowId, verified: p2.verified, humanBody: p2.body });
  const c2 = await inboundEvent(fx2, { type: "cancel", convo: "cv_cancel", seq: 2 });
  await dispatch(fx2, { rowId: c2.rowId, verified: c2.verified, humanBody: c2.body });
  assert.equal((await convoOf(fx2.d1, "cv_cancel")).state, "cancelled");
  console.log("  ✅ decline / cancel 终态");
}


{
  const fx = await makeFixture();
  const p = await inboundEvent(fx, { type: "propose", convo: "cv_limits", seq: 1 });
  await dispatch(fx, { rowId: p.rowId, verified: p.verified, humanBody: p.body });
  d1Exec(fx.d1, `UPDATE a2a_convos SET rounds=12, max_rounds=12 WHERE workspace_id=? AND protocol_convo_id='cv_limits'`, LOCAL_WS);
  const over = await inboundEvent(fx, { type: "counter", convo: "cv_limits", seq: 2 });
  const rOver = await dispatch(fx, { rowId: over.rowId, verified: over.verified, humanBody: over.body });
  assert.equal(rOver.reason, "halted_max_rounds");
  assert.equal((await convoOf(fx.d1, "cv_limits")).state, "halted");

  const fx2 = await makeFixture();
  const p2 = await inboundEvent(fx2, { type: "propose", convo: "cv_budget", seq: 1 });
  await dispatch(fx2, { rowId: p2.rowId, verified: p2.verified, humanBody: p2.body });
  const charged = await chargeA2aConvo(fx2.env, { workspaceId: LOCAL_WS, protocolConvoId: "cv_budget", micro: 10_000_000 });
  assert.equal(charged.ok, true);
  assert.equal(charged.spentMicro, 10_000_000);
  const over2 = await inboundEvent(fx2, { type: "counter", convo: "cv_budget", seq: 2 });
  const rOver2 = await dispatch(fx2, { rowId: over2.rowId, verified: over2.verified, humanBody: over2.body });
  assert.equal(rOver2.reason, "halted_budget_exceeded");
  assert.equal((await convoOf(fx2.d1, "cv_budget")).state, "halted");

  const fx3 = await makeFixture();
  const p3 = await inboundEvent(fx3, { type: "propose", convo: "cv_exp", seq: 1 });
  await dispatch(fx3, { rowId: p3.rowId, verified: p3.verified, humanBody: p3.body });
  d1Exec(fx3.d1, `UPDATE a2a_convos SET expires_at=1 WHERE workspace_id=? AND protocol_convo_id='cv_exp'`, LOCAL_WS);
  const over3 = await inboundEvent(fx3, { type: "counter", convo: "cv_exp", seq: 2 });
  const rOver3 = await dispatch(fx3, { rowId: over3.rowId, verified: over3.verified, humanBody: over3.body });
  assert.equal(rOver3.reason, "halted_expired");
  assert.equal((await convoOf(fx3.d1, "cv_exp")).state, "expired");
  console.log("  ✅ max_rounds / budget / expired 均 halt 且不再协商");
}


{
  const fx = await makeFixture();
  const p = await inboundEvent(fx, { type: "propose", convo: "cv_cas", seq: 1 });
  await dispatch(fx, { rowId: p.rowId, verified: p.verified, humanBody: p.body });
  let failedOnce = false;
  const wrapped = {
    ...fx.env,
    DB: {
      prepare: (sql: string) => {
        const stmt = (fx.env.DB as any).prepare(sql);
        if (!/UPDATE a2a_convos SET state=\?/.test(sql)) return stmt;
        return {
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              ...bound,
              run: async () => {
                if (!failedOnce) {
                  failedOnce = true;
                  return { meta: { changes: 0 }, success: true };
                }
                return bound.run();
              },
            };
          },
        };
      },
    },
  };
  const e = await inboundEvent(fx, { type: "propose", convo: "cv_cas", seq: 2 });
  const r = await dispatch({ ...fx, env: wrapped }, { rowId: e.rowId, verified: e.verified, humanBody: e.body });
  assert.equal(r.reason, "processed_a2a");
  assert.equal((await convoOf(fx.d1, "cv_cas")).state, "negotiating");
  assert.equal(failedOnce, true, "CAS 必须真的先失败过一次");
  console.log("  ✅ CAS conflict 重读后恢复");
}


{
  const fx = await makeFixture({ a2aEnabled: null });
  const e = await inboundEvent(fx, { type: "propose", convo: "cv_off", seq: 1 });
  const r = await dispatch(fx, { rowId: e.rowId, verified: e.verified, humanBody: e.body });
  assert.equal(r.reason, "a2a_disabled_store_only");
  assert.equal((await ingestOf(fx.d1, e.rowId)).ingest_state, "stored_a2a_disabled");
  assert.equal(await convoOf(fx.d1, "cv_off"), null);
  const msgs = await d1Get<any>(fx.d1, `SELECT COUNT(*) AS c FROM a2a_messages`);
  const res = await d1Get<any>(fx.d1, `SELECT COUNT(*) AS c FROM a2a_seq_reservations`);
  assert.equal(msgs.c, 0);
  assert.equal(res.c, 0);
  console.log("  ✅ flag unset 时没有任何 state side effect");
}


{
  const fx = await makeFixture();
  const e = await inboundEvent(fx, { type: "propose", convo: "cv_durable", seq: 1 });
  await dispatch(fx, { rowId: e.rowId, verified: e.verified, humanBody: e.body });
  const rows = await fx.d1.db.prepare(`SELECT id FROM email_messages WHERE ingest_state='processed_a2a'`).all() as any[];
  assert.equal(rows.length, 1);
  const msg = await d1Get<any>(fx.d1, `SELECT payload_json FROM a2a_messages WHERE direction='in' AND seq=1`);
  assert.ok(msg.payload_json.includes("__applied"), "协议记录必须带 applied 标记");
  const convo = await convoOf(fx.d1, "cv_durable");
  assert.ok(convo.revision >= 1 && convo.rounds >= 1);
  console.log("  ✅ processed_a2a ⇒ durable state effect");
}


{
  const fx = await makeFixture();
  d1Exec(
    fx.d1,
    `INSERT INTO settings (workspace_id, key, value) VALUES (?, 'a2a_policy_json', ?)`,
    LOCAL_WS,
    JSON.stringify({ autoCounter: true, windows: [{ start: "2026-09-12T09:00", end: "2026-09-12T10:00", status: "free" }], timezone: "Asia/Shanghai" }),
  );
  const e = await inboundEvent(fx, { type: "propose", convo: "cv_reply", seq: 1 });
  const r = await dispatch(fx, { rowId: e.rowId, verified: e.verified, humanBody: e.body });
  assert.equal(r.reason, "processed_a2a");
  const out = await d1Get<any>(fx.d1, `SELECT * FROM email_outbox WHERE workspace_id=? AND status='queued'`, LOCAL_WS);
  assert.ok(out, "必须产生一条 outbox 出站");
  const headers = JSON.parse(out.headers_json);
  assert.ok(headers["X-OpenInst-A2A-Sig"], "出站必须带签名 header");
  assert.ok(headers["X-OpenInst-A2A-Envelope"]);
  assert.ok(!("Message-ID" in headers), "出站不得自设 Message-ID");
  const outMsg = await d1Get<any>(fx.d1, `SELECT * FROM a2a_messages WHERE direction='out'`);
  assert.equal(outMsg.type, "counter");
  assert.equal(outMsg.verified, 0);
  console.log("  ✅ 策略驱动响应出站（counter）已签名入队");
}


{
  const fx = await makeFixture();
  const e = await inboundEvent(fx, { type: "accept", convo: "cv_missing", seq: 1 });
  const r = await dispatch(fx, { rowId: e.rowId, verified: e.verified, humanBody: e.body });
  assert.equal(r.reason, "unknown_convo");
  assert.equal(await convoOf(fx.d1, "cv_missing"), null);
  console.log("  ✅ 未知 convo 的 accept 被拒绝");
}


{
  const fx = await makeFixture();
  const { createTrustInvite, trustInviteTokenHash } = await import("../src/channels/email/a2a/trust");
  (fx.env as any).PUBLIC_BASE_URL = "https://app.example.com";
  const inv = await createTrustInvite(fx.env, {
    workspaceId: LOCAL_WS,
    peerAddress: "bob@partner.example.org",
    peerAgent: "bob@partner.example.org",
    peerIssuer: "partner.example.org",
    relation: "assistant",
  });
  assert.equal(inv.ok, true);
  const edge = await d1Get<any>(fx.d1, `SELECT * FROM trust_edges WHERE workspace_id=? AND peer_address='bob@partner.example.org'`, LOCAL_WS);
  assert.equal(edge.status, "pending");
  assert.equal(edge.peer_issuer, "partner.example.org");
  const invite = await d1Get<any>(fx.d1, `SELECT * FROM trust_invites WHERE id=?`, inv.inviteId);
  assert.equal(invite.token_hash, await trustInviteTokenHash(inv.token!), "hash 必须与宿主 trust 路由一致");
  assert.ok(inv.actionUrl?.startsWith("https://app.example.com/trust/action/"));
  const mail = await d1Get<any>(fx.d1, `SELECT * FROM email_outbox WHERE id=?`, inv.outboxId);
  assert.equal(mail.to_addr, "bob@partner.example.org");
  assert.ok(String(mail.text_body).includes(inv.token!));
  assert.ok(!("Message-ID" in JSON.parse(mail.headers_json)));
  console.log("  ✅ Trust 创建/发送入口（edge + 一次性 invite + 邀请邮件）");
}


{
  const fx = await makeFixture();
  const e = await inboundEvent(fx, { type: "propose", convo: "cv_crash", seq: 1 });
  await dispatch(fx, { rowId: e.rowId, verified: e.verified, humanBody: e.body });
  const before = await convoOf(fx.d1, "cv_crash");

  d1Exec(fx.d1, `DELETE FROM a2a_messages WHERE protocol_convo_id='cv_crash'`);
  const retry = await inboundEvent(fx, { type: "propose", convo: "cv_crash", seq: 1 });
  const r = await dispatch(fx, { rowId: retry.rowId, verified: retry.verified, humanBody: retry.body });
  assert.equal(r.reason, "processed_a2a", "崩溃续跑必须补齐记录并结束，而不是永久卡死");
  const after = await convoOf(fx.d1, "cv_crash");
  assert.equal(after.rounds, before.rounds, "恢复不得产生第二次状态副作用");
  assert.equal(after.revision, before.revision);
  const msg = await d1Get<any>(fx.d1, `SELECT payload_json FROM a2a_messages WHERE protocol_convo_id='cv_crash' AND seq=1`);
  assert.ok(msg?.payload_json.includes("__applied"), "补齐的记录必须带 applied 标记");
  assert.equal((await ingestOf(fx.d1, retry.rowId)).ingest_state, "processed_a2a");
  console.log("  ✅ 崩溃恢复：补齐协议记录且无第二次副作用");
}


{
  const fx = await makeFixture();
  const e = await inboundEvent(fx, { type: "propose", convo: "cv_direct", seq: 1 });
  const ensured = await dispatch(fx, { rowId: e.rowId, verified: e.verified, humanBody: e.body });
  assert.equal(ensured.reason, "processed_a2a");
  const again = await stepConvo(fx.env, {
    workspaceId: LOCAL_WS,
    protocolConvoId: "cv_direct",
    envelope: e.envelope,
    nowMs: NOW + 1000,
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, "seq_replay");
  console.log("  ✅ stepConvo 直接调用：重复 seq → seq_replay（非 db_error 伪装）");
}

console.log("✔ A2A dispatch/state machine tests passed!");
