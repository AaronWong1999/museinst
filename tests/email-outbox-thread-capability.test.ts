
import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import {
  mintThreadCapability,
  verifyThreadCapability,
  revokeThreadCapability,
  rotateThreadCapabilityReplyTo,
  extractCapabilityToken,
  extractCapabilityRef,
  buildCapabilityReplyTo,
  buildVerificationReplyTo,
  createAddressVerificationChallenge,
  completeAddressVerification,
  sendAddressVerificationEmail,
  MAX_LOCAL_PART_BYTES,
  CAPABILITY_TOKEN_LENGTH,
} from "../src/channels/email/thread";

console.log("▶ Secure thread capability (A15)");

const WS = "ws_t";
const SECRET_LEGACY = "legacy-secret-1234567890";

const LONG_LOCAL = "a".repeat(30) + "z0";
const DOMAIN = "mail.openinst.com";
const PEER = "alice@example.org";

function makeEnv() {
  const d1 = createTestD1();
  d1Exec(d1, `INSERT INTO users (id, created_at) VALUES ('u_t', 0)`);
  d1Exec(d1, `INSERT INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_t', 0)`, WS);
  d1Exec(
    d1,
    `INSERT INTO agent_mailboxes (workspace_id, local_part, domain, address, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 0, 0)`,
    WS,
    LONG_LOCAL,
    DOMAIN,
    `${LONG_LOCAL}@${DOMAIN}`,
  );
  return { d1, env: { DB: d1, PUBLIC_BASE_URL: "https://example.com", EMAIL_THREAD_SECRET: "x" } as any };
}

const bytes = (s: string) => new TextEncoder().encode(s).length;


{
  const { env } = makeEnv();
  const minted = await mintThreadCapability(env, {
    workspaceId: WS,
    threadId: `th_${"9".repeat(64)}`,
    peerAddress: PEER,
    localPart: LONG_LOCAL,
    domain: DOMAIN,
  });
  assert.equal(minted.token.length, CAPABILITY_TOKEN_LENGTH);
  assert.equal(bytes(minted.token), CAPABILITY_TOKEN_LENGTH, "token 必须是纯 ASCII");
  assert.ok(minted.replyTo);
  const localPart = minted.replyTo!.split("@")[0];
  assert.ok(bytes(localPart) <= MAX_LOCAL_PART_BYTES, `local-part 超出 64 字节: ${bytes(localPart)}`);

  assert.throws(() => buildCapabilityReplyTo("x".repeat(80), DOMAIN, minted.token), /local_part_too_long/);
  console.log(`  ✅ 最长业务 ID：local-part ${bytes(localPart)} 字节 ≤ 64`);
}


{
  const { d1, env } = makeEnv();
  const minted = await mintThreadCapability(env, {
    workspaceId: WS,
    threadId: "th_scope",
    peerAddress: "Alice@Example.org",
    localPart: "agent",
    domain: DOMAIN,
    ttlMs: 3_600_000,
  });
  const ok = await verifyThreadCapability(env, minted.token, { workspaceId: WS, peerAddress: "alice@example.org" });
  assert.equal(ok.ok, true);
  assert.equal(ok.payload?.threadId, "th_scope");
  assert.equal(ok.payload?.capId, minted.capabilityId);
  assert.equal((await verifyThreadCapability(env, minted.token, { workspaceId: WS, peerAddress: "eve@evil.org" })).error, "peer_mismatch");
  assert.equal((await verifyThreadCapability(env, minted.token, { workspaceId: "ws_other", peerAddress: PEER })).error, "workspace_mismatch");
  const expired = await verifyThreadCapability(env, minted.token, { workspaceId: WS, peerAddress: "alice@example.org", nowMs: Date.now() + 7_200_000 });
  assert.equal(expired.error, "expired");
  await revokeThreadCapability(env, { workspaceId: WS, capabilityId: minted.capabilityId });
  assert.equal((await verifyThreadCapability(env, minted.token, { workspaceId: WS, peerAddress: "alice@example.org" })).error, "revoked");
  const stored = await d1Get<any>(d1, `SELECT * FROM email_thread_capabilities WHERE id=?`, minted.capabilityId);
  assert.ok(!JSON.stringify(stored).includes(minted.token), "DB 绝不能存 token 本身");
  console.log("  ✅ workspace/peer/过期/撤销全部拒绝，DB 只存 hash");
}


{
  const { env } = makeEnv();
  const minted = await mintThreadCapability(env, { workspaceId: WS, threadId: "th_A", peerAddress: PEER, localPart: "agent", domain: DOMAIN });
  const other = await verifyThreadCapability(env, minted.token, { workspaceId: WS, peerAddress: PEER, threadId: "th_B" });
  assert.equal(other.ok, false);
  assert.equal(other.error, "thread_mismatch");
  const same = await verifyThreadCapability(env, minted.token, { workspaceId: WS, peerAddress: PEER, threadId: "th_A" });
  assert.equal(same.ok, true);

  const addr = buildCapabilityReplyTo("agent", DOMAIN, minted.token);
  const ref = extractCapabilityRef(addr);
  assert.equal(ref?.kind, "thread");
  assert.equal(ref?.token, minted.token);
  console.log("  ✅ capability 只绑定自己的线程，不能迁移授权");
}


{
  const { env } = makeEnv();
  const legacyToken = `${"A".repeat(180)}.${"B".repeat(40)}`;
  assert.equal(extractCapabilityToken(`agent+r.${legacyToken}@${DOMAIN}`), null, "旧长 token 解析必须失败");
  const v = await verifyThreadCapability(env, legacyToken, { workspaceId: WS, peerAddress: PEER });
  assert.equal(v.ok, false);

  const v2 = await verifyThreadCapability(SECRET_LEGACY, "abcdefghijklmnopqrstuv", { workspaceId: WS, peerAddress: PEER });
  assert.equal(v2.ok, false);
  assert.equal(v2.error, "thread_capability_requires_db");
  assert.equal(extractCapabilityToken("agent@mail.openinst.com"), null);

  assert.equal((await verifyThreadCapability(env, "aaaaaaaaaaaaaaaaaaaaaa", { workspaceId: WS, peerAddress: PEER })).error, "unknown_capability");
  console.log("  ✅ 旧长 token / 无 DB 签名 / 未知 token 全部 fail closed");
}


{
  const { d1, env } = makeEnv();
  const ch = await createAddressVerificationChallenge(env, { workspaceId: WS, address: "owner@personal.test", localPart: LONG_LOCAL, domain: DOMAIN });
  assert.equal(ch.ok, true);
  if (!ch.ok) throw new Error("unreachable");
  const addr = buildVerificationReplyTo(LONG_LOCAL, DOMAIN, ch.token);
  assert.ok(bytes(addr.split("@")[0]) <= MAX_LOCAL_PART_BYTES);
  assert.equal(extractCapabilityRef(addr)?.kind, "verify");

  const wrongPeer = await completeAddressVerification(env, { token: ch.token, workspaceId: WS, peerAddress: "someone@else.test" });
  assert.equal(wrongPeer.ok, false);
  assert.equal(wrongPeer.error, "peer_mismatch");
  assert.equal(await d1Get(d1, `SELECT 1 AS x FROM email_contacts WHERE workspace_id=? AND address='someone@else.test'`, WS), null);

  const done = await completeAddressVerification(env, { token: ch.token, workspaceId: WS, peerAddress: "Owner@Personal.test" });
  assert.equal(done.ok, true);
  const contact = await d1Get<any>(d1, `SELECT * FROM email_contacts WHERE workspace_id=? AND address='owner@personal.test'`, WS);
  assert.equal(contact.address_verified_by_owner, 1);
  assert.ok(contact.verified_at > 0);

  const replay = await completeAddressVerification(env, { token: ch.token, workspaceId: WS, peerAddress: "owner@personal.test" });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "already_used");

  const minted = await mintThreadCapability(env, { workspaceId: WS, threadId: "th_x", peerAddress: PEER, localPart: "agent", domain: DOMAIN });
  assert.equal((await completeAddressVerification(env, { token: minted.token, workspaceId: WS, peerAddress: PEER })).error, "kind_mismatch");
  console.log("  ✅ 一次性挑战建立 address_verified_by_owner（重放/错 From/类型混用拒绝）");
}


{
  const { env } = makeEnv();
  const first = await mintThreadCapability(env, { workspaceId: WS, threadId: "th_rot", peerAddress: PEER, localPart: "agent", domain: DOMAIN });
  const rotated = await rotateThreadCapabilityReplyTo(env, { workspaceId: WS, threadId: "th_rot", peerAddress: PEER, localPart: "agent", domain: DOMAIN });
  assert.equal(rotated.ok, true);
  if (!rotated.ok) throw new Error("unreachable");
  assert.equal((await verifyThreadCapability(env, first.token, { workspaceId: WS, peerAddress: PEER })).error, "revoked");
  const fresh = await verifyThreadCapability(env, rotated.replyTo.split("+r.")[1].split("@")[0], { workspaceId: WS, peerAddress: PEER, threadId: "th_rot" });
  assert.equal(fresh.ok, true);
  console.log("  ✅ 回复轮换：新 Reply-To 有效、旧 token 立即失效");
}


{
  const { d1, env } = makeEnv();
  const sent = await sendAddressVerificationEmail(env, { workspaceId: WS, address: PEER });
  assert.equal(sent.ok, true);
  if (!sent.ok) throw new Error("unreachable");
  const row = await d1Get<any>(d1, `SELECT * FROM email_outbox WHERE id=?`, sent.outboxId);
  assert.ok(row.reply_to.includes("+v."), "挑战邮件的 Reply-To 必须带 v tag");
  assert.equal(extractCapabilityRef(row.reply_to)?.kind, "verify");
  console.log("  ✅ 验证挑战邮件入口已入队（Reply-To 带 v tag）");
}

console.log("✔ Secure thread capability tests passed!");
