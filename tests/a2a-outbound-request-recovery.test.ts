import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get } from "./helpers/d1";
import { generateSigningKey } from "../src/channels/email/a2a/sign";
import { resumeA2aResponse, sendA2aResponse } from "../src/channels/email/a2a/outbound";

console.log("▶ A2A allocation-time request recovery");

const WS = "w_req_recovery";
const CONVO = "cv_req_recovery";
const PEER = "peer@peer.example.net";
const LOCAL = "agent@mail.local.test";
const NOW = 1_800_000_000_000;

const d1 = createTestD1();
const local = await generateSigningKey("local_k1");
d1Exec(d1, `INSERT INTO users (id, created_at) VALUES ('u_req',0)`);
d1Exec(d1, `INSERT INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u_req',0)`, WS);
d1Exec(
  d1,
  `INSERT INTO a2a_convos
    (id,workspace_id,protocol_convo_id,role,peer_address,peer_issuer,intent,state,payload_json,
     revision,rounds,max_rounds,budget_micro,spent_micro,expires_at,created_at,updated_at)
   VALUES ('acv_req',?,?, 'recipient',?,'peer.example.net','coordinate.schedule','proposed','{"__a2a":{}}',0,0,12,10000000,0,?,?,?)`,
  WS, CONVO, PEER, NOW + 86_400_000, NOW, NOW,
);
const baseEnv: any = {
  DB: d1,
  A2A_SIGNING_PRIVATE_JWK: JSON.stringify({ ...local.privateJwk, kid: "local_k1", issuer: "local.test" }),
  A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify({
    issuers: { "local.test": { mailDomains: ["mail.local.test"], keys: { local_k1: { x: local.publicJwk.x } } } },
  }),
};

const original = {
  workspaceId: WS,
  fromAgent: LOCAL,
  toAgent: PEER,
  type: "counter" as const,
  convo: CONVO,
  intent: "coordinate.schedule" as const,
  payload: { freeBusyWindows: [{ start: "2026-09-11T10:00:00Z", end: "2026-09-11T11:00:00Z", status: "free" }] },
  facts: { timezone: "UTC", meetingPreference: "30 minutes" },
  threadId: "thread-original",
  logicalKey: `a2a:${CONVO}:counter`,
  nowMs: NOW,
};

// Fault exactly after allocation: request_json exists, envelope/signature do not.
let failPrepare = true;
const realPrepare = d1.prepare.bind(d1);
const faultyEnv: any = {
  ...baseEnv,
  DB: {
    prepare(sql: string) {
      if (failPrepare && sql.includes("UPDATE a2a_outbound_intents SET") && sql.includes("envelope_json=COALESCE")) {
        return {
          bind: () => ({
            run: async () => {
              failPrepare = false;
              throw new Error("crash_after_allocation");
            },
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      }
      return realPrepare(sql);
    },
    batch: d1.batch,
  },
};

await assert.rejects(() => sendA2aResponse(faultyEnv, original), /crash_after_allocation/);
const allocated = await d1Get<any>(d1, `SELECT state,seq,request_json,envelope_json FROM a2a_outbound_intents WHERE workspace_id=? AND logical_key=?`, WS, original.logicalKey);
assert.equal(allocated!.state, "allocated");
assert.ok(String(allocated!.request_json).includes("thread-original"));
assert.equal(allocated!.envelope_json, null);
const fixedSeq = Number(allocated!.seq);

// No caller payload/policy is supplied here. Recovery must use the persisted original request.
const resumed = await resumeA2aResponse(baseEnv, WS, original.logicalKey);
assert.equal(resumed.ok, true, JSON.stringify(resumed));
assert.equal(resumed.seq, fixedSeq);
assert.equal(resumed.state, "negotiating");
const out = await d1Get<any>(d1, `SELECT thread_id,text_body FROM email_outbox WHERE workspace_id=? AND logical_key=?`, WS, original.logicalKey);
assert.equal(out!.thread_id, "thread-original", "recovery must preserve allocation-time thread request");
assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM email_outbox`))!.n), 1);
assert.equal(Number((await d1Get<any>(d1, `SELECT COUNT(*) AS n FROM a2a_messages WHERE direction='out'`))!.n), 1);
assert.equal((await d1Get<any>(d1, `SELECT state FROM a2a_convos WHERE id='acv_req'`))!.state, "negotiating");
console.log("  ✅ allocated intent resumes from stored original request with the same seq");
