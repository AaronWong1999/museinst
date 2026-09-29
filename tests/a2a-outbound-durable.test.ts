import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import { generateSigningKey } from "../src/channels/email/a2a/sign";
import { approveAndSendConfirm, sendA2aResponse } from "../src/channels/email/a2a/outbound";
import { recordOwnerApproval, stepConvo } from "../src/channels/email/a2a/statemachine";
import type { A2aEnvelope } from "../src/channels/email/a2a/schema";

console.log("▶ A2A durable outbound intent / crash recovery");

const WS = "w_out";
const LOCAL = "agent@mail.local.test";
const PEER = "peer@peer.example.net";
const CONVO = "cv_out";
const NOW = 1_800_000_000_000;

async function fixture(state: string, opts: { approved?: boolean } = {}) {
  const d1 = createTestD1();
  const local = await generateSigningKey("local_k1");
  d1Exec(d1, `INSERT INTO users (id, created_at) VALUES ('u_out', 0)`);
  d1Exec(d1, `INSERT INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_out', 0)`, WS);
  const payload = opts.approved
    ? JSON.stringify({ __a2a: { ownerApprovalAt: NOW - 1_000, ownerApprovedBy: "owner" } })
    : JSON.stringify({ __a2a: {} });
  d1Exec(
    d1,
    `INSERT INTO a2a_convos
      (id, workspace_id, protocol_convo_id, role, peer_address, peer_issuer, intent, state, payload_json,
       revision, rounds, max_rounds, budget_micro, spent_micro, expires_at, created_at, updated_at)
     VALUES ('acv_out', ?, ?, 'recipient', ?, 'peer.example.net', 'coordinate.schedule', ?, ?, 0, 0, 12, 10000000, 0, ?, ?, ?)`,
    WS, CONVO, PEER, state, payload, NOW + 86_400_000, NOW, NOW,
  );
  const env: any = {
    DB: d1,
    A2A_SIGNING_PRIVATE_JWK: JSON.stringify({ ...local.privateJwk, kid: "local_k1", issuer: "local.test" }),
    A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify({
      issuers: { "local.test": { mailDomains: ["mail.local.test"], keys: { local_k1: { x: local.publicJwk.x } } } },
    }),
  };
  return { d1, env };
}

function sendOpts(type: "counter" | "accept", logicalKey: string) {
  return {
    workspaceId: WS,
    fromAgent: LOCAL,
    toAgent: PEER,
    type,
    convo: CONVO,
    intent: "coordinate.schedule" as const,
    payload: type === "counter" ? { timezone: "UTC" } : { accepted: true },
    facts: {},
    logicalKey,
    nowMs: NOW,
  };
}


{
  const { d1, env } = await fixture("negotiating");
  const r = await sendA2aResponse(env, sendOpts("accept", "a2a:cv_out:accept"));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state, "pending_owner_ok");
  const convo = await d1Get<any>(d1, `SELECT state, revision, rounds FROM a2a_convos WHERE id='acv_out'`);
  assert.equal(convo!.state, "pending_owner_ok");
  assert.equal(Number(convo!.revision), 1);
  assert.equal(Number(convo!.rounds), 1);
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM email_outbox`))!.n), 1);
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM a2a_messages WHERE direction='out'`))!.n), 1);
  assert.equal((await d1Get<any>(d1, `SELECT state FROM a2a_outbound_intents`))!.state, "state_committed");


  const approval = await recordOwnerApproval(env, { workspaceId: WS, protocolConvoId: CONVO, approve: true, by: "owner", nowMs: NOW + 10 });
  assert.equal(approval.ok, true);
  const confirm: A2aEnvelope = {
    v: 1,
    issuer: "peer.example.net",
    kid: "peer_k1",
    fromAgent: PEER,
    toAgent: LOCAL,
    type: "confirm",
    convo: CONVO,
    seq: 1,
    intent: "coordinate.schedule",
    iat: Math.floor(NOW / 1000),
    exp: Math.floor((NOW + 86_400_000) / 1000),
    nonce: "peer_confirm_1",
    payload: {},
    humanBodySha256: "0".repeat(64),
  };
  const confirmed = await stepConvo(env, { workspaceId: WS, protocolConvoId: CONVO, envelope: confirm, nowMs: NOW + 20 });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.equal(confirmed.state, "confirmed");
  console.log("  ✅ autoAccept commits pending_owner_ok; subsequent confirm is legal");
}


{
  const { d1, env } = await fixture("proposed");
  const realBatch = d1.batch;
  let failOnce = true;
  env.DB = {
    prepare: d1.prepare,
    batch: async (stmts: any[]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("fault_before_atomic_commit");
      }
      return realBatch(stmts);
    },
  };
  const opts = sendOpts("counter", "a2a:cv_out:counter");
  const first = await sendA2aResponse(env, opts);
  assert.equal(first.ok, false);
  const prepared = await d1Get<any>(d1, `SELECT seq, state, envelope_json FROM a2a_outbound_intents WHERE logical_key=?`, opts.logicalKey);
  assert.ok(prepared);
  assert.equal(prepared!.state, "prepared");
  const fixedSeq = Number(prepared!.seq);
  assert.equal((await d1Get<any>(d1, `SELECT state FROM a2a_convos WHERE id='acv_out'`))!.state, "proposed");
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM email_outbox`))!.n), 0);
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM a2a_messages WHERE direction='out'`))!.n), 0);

  env.DB = d1;
  for (let i = 0; i < 20; i++) {
    const r = await sendA2aResponse(env, { ...opts, nowMs: NOW + i + 100 });
    assert.equal(r.ok, true, `replay ${i}: ${JSON.stringify(r)}`);
    assert.equal(r.seq, fixedSeq, "retry must reuse the original seq");
  }
  assert.equal((await d1Get<any>(d1, `SELECT state FROM a2a_convos WHERE id='acv_out'`))!.state, "negotiating");
  assert.equal(Number((await d1Get<any>(d1, `SELECT revision FROM a2a_convos WHERE id='acv_out'`))!.revision), 1);
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM a2a_outbound_intents`))!.n), 1);
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM email_outbox`))!.n), 1);
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM a2a_messages WHERE direction='out'`))!.n), 1);
  assert.equal(Number((await d1Get<any>(d1, `SELECT MAX(seq) AS n FROM a2a_messages WHERE direction='out'`))!.n), fixedSeq);
  console.log("  ✅ crash before atomic commit + 20 replays => one immutable seq/outbox/message/state transition");
}


{
  const { d1, env } = await fixture("pending_owner_ok", { approved: true });
  const realBatch = d1.batch;
  let failOnce = true;
  env.DB = {
    prepare: d1.prepare,
    batch: async (stmts: any[]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("confirm_commit_fault");
      }
      return realBatch(stmts);
    },
  };
  const first = await approveAndSendConfirm(env, {
    workspaceId: WS,
    protocolConvoId: CONVO,
    fromAgent: LOCAL,
    nowMs: NOW,
  });
  assert.equal(first.ok, false);
  assert.equal((await d1Get<any>(d1, `SELECT state FROM a2a_convos WHERE id='acv_out'`))!.state, "pending_owner_ok", "failed enqueue/commit must not terminalize locally");
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM email_outbox`))!.n), 0);

  env.DB = d1;
  const retry = await approveAndSendConfirm(env, {
    workspaceId: WS,
    protocolConvoId: CONVO,
    fromAgent: LOCAL,
    nowMs: NOW + 5_000,
  });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal((await d1Get<any>(d1, `SELECT state FROM a2a_convos WHERE id='acv_out'`))!.state, "confirmed");
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM email_outbox WHERE logical_key='a2a:cv_out:confirm'`))!.n), 1);
  assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM a2a_messages WHERE direction='out' AND type='confirm'`))!.n), 1);
  assert.equal((await d1Get<any>(d1, `SELECT state FROM a2a_outbound_intents WHERE logical_key='a2a:cv_out:confirm'`))!.state, "state_committed");
  console.log("  ✅ owner confirm is atomic: no confirmed-without-outbox window");
}

console.log("✅ A2A durable outbound tests passed");
