// tests/trusted-people-local-fastpath.test.ts — Same-issuer local fast path (V2 §10 / §31.3).

import assert from "node:assert/strict";
import { generateSigningKey } from "../src/channels/email/trust-control/sign";
import type { TrustControlEnvelope } from "../src/channels/email/trust-control/schema";
import { dispatchVerifiedTrustControl } from "../src/channels/email/trust-control/dispatch";
import { trustControlEnvelopeSha256 } from "../src/channels/email/trust-control/verify";
import { materializeVerifiedLocalTrustInvite, listTrustRequests, listTrustEdges } from "../src/channels/email/trust-service";
import { createTestD1 } from "./helpers/d1";
import type { Env } from "../src/env";

console.log("▶ Same-issuer local fast path tests...");

const nowMs = 1789000000_000;
const nowSec = Math.floor(nowMs / 1000);
const kid = "k_fp";
const { publicJwk } = await generateSigningKey(kid);

function makeEnv(d1: unknown): Env {
  return {
    DB: d1,
    A2A_ISSUER: "openinst.com",
    A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify({
      issuers: {
        "openinst.com": {
          mailDomains: ["openinst.com", "mail.openinst.com"],
          acceptsA2A: true,
          keys: { [kid]: { x: publicJwk.x, notBefore: nowSec - 3600, notAfter: nowSec + 86400 * 30 } },
        },
      },
    }),
    TRUSTED_PEOPLE_CROSS_ISSUER_ENABLED: "1",
  } as unknown as Env;
}

async function setupMailbox(env: Env, workspaceId: string, address: string) {
  const [local, domain] = address.split("@");
  await env.DB.prepare(
    `INSERT INTO agent_mailboxes (workspace_id, local_part, domain, address, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(workspaceId, local, domain, address, nowMs, nowMs)
    .run();
}

// 1. Local target gets request WITHOUT waiting for transport; fast path does NOT activate edge
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const wsB = "ws_bob_fp";
  await setupMailbox(env, wsB, "bob@mail.openinst.com");

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer: "openinst.com",
    kid,
    fromAgent: "alice@mail.openinst.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_fp_1",
    iat: nowSec,
    exp: nowSec + 86400 * 7,
    nonce: "nonce_fp_1",
    displayName: "Alice",
  };

  const res = await materializeVerifiedLocalTrustInvite(env, {
    recipientWorkspaceId: wsB,
    envelope,
    verificationSource: "local_same_issuer",
    nowMs,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, "pending");

  const requests = await listTrustRequests(env, wsB, { direction: "in" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].peerAddress, "alice@mail.openinst.com");

  // Fast path must NOT activate an edge
  const edges = await listTrustEdges(env, wsB);
  assert.equal(edges.length, 0, "Fast path must not create an active edge");
}

// 2. Real email duplicate after fast path does NOT create a second request (same envelope hash)
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const wsB = "ws_bob_fp2";
  await setupMailbox(env, wsB, "bob@mail.openinst.com");

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer: "openinst.com",
    kid,
    fromAgent: "alice@mail.openinst.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_fp_2",
    iat: nowSec,
    exp: nowSec + 86400 * 7,
    nonce: "nonce_fp_2",
  };

  // Fast path first
  await materializeVerifiedLocalTrustInvite(env, { recipientWorkspaceId: wsB, envelope, nowMs });

  // Then the real email arrives with the SAME envelope (same hash) -> duplicate, no second request
  const sha = await trustControlEnvelopeSha256(envelope);
  const emailRes = await dispatchVerifiedTrustControl(env, {
    workspaceId: wsB,
    verified: {
      ok: true,
      envelope,
      issuer: "openinst.com",
      kid,
      peerAddress: envelope.fromAgent,
      recipient: envelope.toAgent,
      keySource: "cache",
      issuerMailDomains: ["openinst.com"],
      envelopeSha256: sha,
      verifiedAt: nowMs,
    },
    nowMs: nowMs + 5000,
  });

  assert.equal(emailRes.ok, true);
  assert.equal(emailRes.duplicate, true, "Real email after fast path must be a duplicate");

  const requests = await listTrustRequests(env, wsB, { direction: "in" });
  assert.equal(requests.length, 1, "Exactly one pending request");
}

// 3. Accept fast path + later real email remains idempotent (real signed envelope hash matches)
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const wsB = "ws_bob_fp3";
  await setupMailbox(env, wsB, "bob@mail.openinst.com");

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer: "openinst.com",
    kid,
    fromAgent: "alice@mail.openinst.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_fp_3",
    iat: nowSec,
    exp: nowSec + 86400 * 7,
    nonce: "nonce_fp_3",
  };

  await materializeVerifiedLocalTrustInvite(env, { recipientWorkspaceId: wsB, envelope, nowMs });
  const reqs = await listTrustRequests(env, wsB, { direction: "in" });
  assert.equal(reqs.length, 1);

  // Simulate accepting (edge active) then a duplicate trust.accept for the same requestId
  await env.DB.prepare(
    `INSERT INTO trust_requests (id, workspace_id, protocol_request_id, direction, peer_address, status, created_at, updated_at, expires_at)
     VALUES ('trq_out_1', 'ws_alice_fp3', 'req_fp_3', 'out', 'bob@mail.openinst.com', 'pending', ?, ?, ?)`,
  ).bind(nowMs, nowMs, nowMs + 86400 * 7).run();

  const acceptEnvelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.accept",
    issuer: "openinst.com",
    kid,
    fromAgent: "bob@mail.openinst.com",
    toAgent: "alice@mail.openinst.com",
    requestId: "req_fp_3",
    iat: nowSec,
    exp: nowSec + 86400 * 7,
    nonce: "nonce_acc_fp3",
  };
  const acceptSha = await trustControlEnvelopeSha256(acceptEnvelope);

  const first = await dispatchVerifiedTrustControl(env, {
    workspaceId: "ws_alice_fp3",
    verified: {
      ok: true, envelope: acceptEnvelope, issuer: "openinst.com", kid,
      peerAddress: acceptEnvelope.fromAgent, recipient: acceptEnvelope.toAgent,
      keySource: "local_same_issuer", issuerMailDomains: [], envelopeSha256: acceptSha, verifiedAt: nowMs,
    },
    nowMs,
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, "accepted");

  // Later real email with same envelope -> duplicate, no double effect
  const second = await dispatchVerifiedTrustControl(env, {
    workspaceId: "ws_alice_fp3",
    verified: {
      ok: true, envelope: acceptEnvelope, issuer: "openinst.com", kid,
      peerAddress: acceptEnvelope.fromAgent, recipient: acceptEnvelope.toAgent,
      keySource: "fetch", issuerMailDomains: ["openinst.com"], envelopeSha256: acceptSha, verifiedAt: nowMs + 3000,
    },
    nowMs: nowMs + 3000,
  });
  assert.equal(second.duplicate, true);
}

console.log("✔ Same-issuer local fast path tests passed!");
