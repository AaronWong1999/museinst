
import assert from "node:assert/strict";
import { createTestD1, d1Get, type TestD1 } from "./helpers/d1";
import type { Env } from "../src/env";
import {
  registerMailbox,
  KERNEL_RESERVED_LOCAL_PARTS,
  todayQuotaDay,
} from "../src/channels/email/mailbox";
import {
  reserveEmailModelAdmission,
  consumeEmailModelAdmission,
  releaseEmailModelAdmission,
} from "../src/channels/email/admission";

console.log("▶ Agent Mail admission & mailbox registration (V2 §10/§11)");

function mockEnv(d1: TestD1): Env {
  return {
    DB: d1 as any,
  } as unknown as Env;
}

const d1 = createTestD1();
const env = mockEnv(d1);
const WS = "w_admit_1";
const DOMAIN = "mail.openinst.com";




const tooShort = await registerMailbox(env, WS, "a", DOMAIN);
assert.equal(tooShort.ok, false);
assert.equal(tooShort.error, "invalid_local_part");

const valid2Char = await registerMailbox(env, WS, "ab", DOMAIN, Date.now(), { strangerAutoreply: 1, notifyChannel: "wechat" });
assert.equal(valid2Char.ok, true);
assert.equal(valid2Char.address, `ab@${DOMAIN}`);

const row2 = await d1Get<any>(d1, `SELECT * FROM agent_mailboxes WHERE address=?`, `ab@${DOMAIN}`);
assert.equal(row2.stranger_autoreply, 1);
assert.equal(row2.notify_channel, "wechat");


for (const word of KERNEL_RESERVED_LOCAL_PARTS) {
  const res = await registerMailbox(env, WS, word, DOMAIN);
  assert.equal(res.ok, false, `Word ${word} should be reserved`);
  assert.equal(res.error, "reserved");
}


const dupSelf = await registerMailbox(env, WS, "ab", DOMAIN);
assert.equal(dupSelf.ok, true);
assert.equal(dupSelf.address, `ab@${DOMAIN}`);

const otherWs = await registerMailbox(env, "w_other", "ab", DOMAIN);
assert.equal(otherWs.ok, false);
assert.equal(otherWs.error, "taken");



const peerHash = "0123456789abcdef";
const now = Date.now();
const day = todayQuotaDay(now);


const res1 = await reserveEmailModelAdmission(env, {
  workspaceId: WS,
  rowId: "row_1",
  peerHash,
  totalCap: 10,
  peerCap: 2,
  nowMs: now,
});
assert.equal(res1.allowed, true);
assert.equal(res1.reason, "reserved");

const totalCount1 = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope='inbound_model'`, WS, day);
const peerCount1 = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope=?`, WS, day, `inbound_model_peer:${peerHash}`);
assert.equal(totalCount1.count, 1);
assert.equal(peerCount1.count, 1);


const res1Replay = await reserveEmailModelAdmission(env, {
  workspaceId: WS,
  rowId: "row_1",
  peerHash,
  totalCap: 10,
  peerCap: 2,
  nowMs: now,
});
assert.equal(res1Replay.allowed, true);
assert.equal(res1Replay.reason, "reserved");

const totalCountReplay = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope='inbound_model'`, WS, day);
assert.equal(totalCountReplay.count, 1);


const res2 = await reserveEmailModelAdmission(env, {
  workspaceId: WS,
  rowId: "row_2",
  peerHash,
  totalCap: 10,
  peerCap: 2,
  nowMs: now,
});
assert.equal(res2.allowed, true);
const peerCount2 = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope=?`, WS, day, `inbound_model_peer:${peerHash}`);
assert.equal(peerCount2.count, 2);


const res3 = await reserveEmailModelAdmission(env, {
  workspaceId: WS,
  rowId: "row_3",
  peerHash,
  totalCap: 10,
  peerCap: 2,
  nowMs: now,
});
assert.equal(res3.allowed, false);
assert.equal(res3.reason, "peer_cap_exceeded");

const peerCountAfterReject = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope=?`, WS, day, `inbound_model_peer:${peerHash}`);
assert.equal(peerCountAfterReject.count, 2);
const totalCountAfterReject = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope='inbound_model'`, WS, day);
assert.equal(totalCountAfterReject.count, 2);



// 3.1 consume: reserved -> consumed
const consumed = await consumeEmailModelAdmission(env, WS, "row_1", now);
assert.equal(consumed, true);

const row1Admit = await d1Get<any>(d1, `SELECT status FROM email_model_admissions WHERE workspace_id=? AND email_row_id=?`, WS, "row_1");
assert.equal(row1Admit.status, "consumed");


const res1AfterConsume = await reserveEmailModelAdmission(env, {
  workspaceId: WS,
  rowId: "row_1",
  peerHash,
  totalCap: 10,
  peerCap: 2,
  nowMs: now,
});
assert.equal(res1AfterConsume.allowed, true);
assert.equal(res1AfterConsume.reason, "consumed");


const releaseConsumed = await releaseEmailModelAdmission(env, WS, "row_1", now);
assert.equal(releaseConsumed, false);


const releaseReserved = await releaseEmailModelAdmission(env, WS, "row_2", now);
assert.equal(releaseReserved, true);

const row2Admit = await d1Get<any>(d1, `SELECT status FROM email_model_admissions WHERE workspace_id=? AND email_row_id=?`, WS, "row_2");
assert.equal(row2Admit.status, "released");

const peerCountAfterRelease = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope=?`, WS, day, `inbound_model_peer:${peerHash}`);
assert.equal(peerCountAfterRelease.count, 1);
const totalCountAfterRelease = await d1Get<any>(d1, `SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope='inbound_model'`, WS, day);
assert.equal(totalCountAfterRelease.count, 1);

console.log("✅ email-admission: all assertions passed");
