// trust-control replay barrier crash-recovery regression.
// A transient failure while applying a verified control message must NOT leave a durable "seen"
// marker that turns provider redelivery into a no-op forever.

import assert from "node:assert/strict";
import { dispatchVerifiedTrustControl } from "../src/channels/email/trust-control/dispatch";
import { createTestD1 } from "./helpers/d1";
import type { Env } from "../src/env";

console.log("▶ Trust-control replay barrier crash recovery...");

const base = createTestD1();
let failTrustRequestInsertOnce = true;

const flakyDb: any = {
  prepare(sql: string) {
    const prepared = base.prepare(sql);
    return {
      bind: (...args: unknown[]) => {
        const bound = prepared.bind(...args);
        if (sql.includes("INSERT INTO trust_requests")) {
          return {
            ...bound,
            run: async () => {
              if (failTrustRequestInsertOnce) {
                failTrustRequestInsertOnce = false;
                throw new Error("injected_trust_request_write_failure");
              }
              return await bound.run();
            },
          };
        }
        return bound;
      },
    };
  },
  batch: base.batch,
};

const env = {
  DB: flakyDb,
  TRUSTED_PEOPLE_ENABLED: "1",
  TRUSTED_PEOPLE_CROSS_ISSUER_ENABLED: "1",
} as unknown as Env;

const nowMs = 1_789_000_000_000;
const verified: any = {
  ok: true,
  envelope: {
    v: 1,
    kind: "trust.invite",
    issuer: "peer.example",
    kid: "kid_peer",
    fromAgent: "alice@peer.example",
    toAgent: "bob@local.example",
    requestId: "req_crash_recovery",
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + 86400,
    nonce: "nonce_crash_recovery",
  },
  issuer: "peer.example",
  kid: "kid_peer",
  peerAddress: "alice@peer.example",
  recipient: "bob@local.example",
  keySource: "test",
  issuerMailDomains: ["peer.example"],
  envelopeSha256: "sha256_crash_recovery_fixture",
  verifiedAt: nowMs,
};

await assert.rejects(
  () => dispatchVerifiedTrustControl(env, { workspaceId: "ws_crash", verified, nowMs }),
  /injected_trust_request_write_failure/,
);

const seenAfterFailure = await base.prepare(
  `SELECT COUNT(*) AS c FROM trust_control_seen WHERE workspace_id=? AND protocol_request_id=?`,
).bind("ws_crash", "req_crash_recovery").first<{ c: number }>();
assert.equal(seenAfterFailure?.c, 0, "failed state effect must not poison redelivery with a seen marker");

const recovered = await dispatchVerifiedTrustControl(env, { workspaceId: "ws_crash", verified, nowMs: nowMs + 1000 });
assert.equal(recovered.ok, true);
assert.equal(recovered.status, "pending");

const requestCount = await base.prepare(
  `SELECT COUNT(*) AS c FROM trust_requests WHERE workspace_id=? AND protocol_request_id=? AND direction='in'`,
).bind("ws_crash", "req_crash_recovery").first<{ c: number }>();
const seenAfterSuccess = await base.prepare(
  `SELECT COUNT(*) AS c FROM trust_control_seen WHERE workspace_id=? AND protocol_request_id=?`,
).bind("ws_crash", "req_crash_recovery").first<{ c: number }>();
assert.equal(requestCount?.c, 1);
assert.equal(seenAfterSuccess?.c, 1);

const replay = await dispatchVerifiedTrustControl(env, { workspaceId: "ws_crash", verified, nowMs: nowMs + 2000 });
assert.equal(replay.ok, true);
assert.equal(replay.duplicate, true);
assert.equal(replay.status, "seen_duplicate");

console.log("✔ Trust-control replay barrier crash recovery passed!");
