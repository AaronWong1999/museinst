// tests/trust-control-dispatch.test.ts — State machine, lifecycle and dispatch tests for trust-control.

import assert from "node:assert/strict";
import { generateSigningKey } from "../src/channels/email/trust-control/sign";
import { signTrustControlEnvelope } from "../src/channels/email/trust-control/sign";
import type { TrustControlEnvelope } from "../src/channels/email/trust-control/schema";
import { verifyTrustControl } from "../src/channels/email/trust-control/verify";
import { dispatchVerifiedTrustControl } from "../src/channels/email/trust-control/dispatch";
import { canonicalBytes } from "../src/channels/email/trust-control/canonical";
import { b64urlEncode } from "../src/channels/email/a2a/codec";
import {
  inviteTrustPerson,
  acceptTrustRequest,
  declineTrustRequest,
  cancelTrustRequest,
  removeTrustPerson,
  blockTrustPeer,
  unblockTrustPeer,
  isTrustedPeoplePaused,
  setTrustedPeoplePaused,
  listTrustRequests,
  listTrustEdges,
} from "../src/channels/email/trust-service";
import { createTestD1 } from "./helpers/d1";
import type { Env } from "../src/env";

console.log("▶ Trust control dispatch and state machine tests...");

const nowMs = 1789000000_000;
const nowSec = Math.floor(nowMs / 1000);
const issuerA = "alice.openinst.com";
const kidA = "kid_a";
const keyA = await generateSigningKey(kidA);

const issuerB = "bob.openinst.com";
const kidB = "kid_b";
const keyB = await generateSigningKey(kidB);

function makeEnv(d1: unknown, overrides: Record<string, unknown> = {}): Env {
  const localKeyConfig = {
    issuers: {
      "alice.openinst.com": {
        mailDomains: ["alice.openinst.com", "mail.alice.com"],
        acceptsA2A: true,
        keys: { [kidA]: { x: keyA.publicJwk.x, notBefore: nowSec - 3600, notAfter: nowSec + 86400 * 30 } },
      },
      "bob.openinst.com": {
        mailDomains: ["bob.openinst.com", "mail.bob.com"],
        acceptsA2A: true,
        keys: { [kidB]: { x: keyB.publicJwk.x, notBefore: nowSec - 3600, notAfter: nowSec + 86400 * 30 } },
      },
    },
  };
  return {
    DB: d1,
    A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify(localKeyConfig),
    TRUSTED_PEOPLE_CROSS_ISSUER_ENABLED: "1",
    ...overrides,
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

// 1. Inbound invite creates pending request ONLY; NEVER automatically active
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const wsB = "ws_bob";
  await setupMailbox(env, wsB, "bob@bob.openinst.com");

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer: issuerA,
    kid: kidA,
    fromAgent: "alice@alice.openinst.com",
    toAgent: "bob@bob.openinst.com",
    requestId: "req_ab_1",
    iat: nowSec,
    exp: nowSec + 86400 * 7,
    nonce: "nonce_ab_1",
    displayName: "Alice",
  };
  const sig = await signTrustControlEnvelope(keyA.privateJwk, envelope);
  const verified = await verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(envelope)),
      "x-openinst-trust-sig": sig,
      "x-openinst-trust-kid": kidA,
      "x-openinst-trust-issuer": issuerA,
    },
    recipient: "bob@bob.openinst.com",
    workspaceId: wsB,
    nowMs,
  });
  assert.equal(verified.ok, true);
  if (verified.ok) {
    const dispatchRes = await dispatchVerifiedTrustControl(env, {
      workspaceId: wsB,
      verified,
      nowMs,
    });
    assert.equal(dispatchRes.ok, true);
    assert.equal(dispatchRes.status, "pending");

    const requests = await listTrustRequests(env, wsB);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, "pending");
    assert.equal(requests[0].direction, "in");
    assert.equal(requests[0].peerAddress, "alice@alice.openinst.com");

    const edges = await listTrustEdges(env, wsB);
    assert.equal(edges.length, 0, "Incoming invite must not create edge before accept");
  }
}

// 2. Full cycle: A invites B -> B accepts -> signed accept activates A edge (mutual trust)
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const wsA = "ws_alice";
  const wsB = "ws_bob";
  await setupMailbox(env, wsA, "alice@alice.openinst.com");
  await setupMailbox(env, wsB, "bob@bob.openinst.com");

  const inviteRes = await inviteTrustPerson(env, {
    workspaceId: wsA,
    peerAddress: "bob@bob.openinst.com",
    displayName: "Bob",
    nowMs,
    signingKeyOverride: {
      privateJwk: keyA.privateJwk,
      publicX: String(keyA.publicJwk.x),
      kid: kidA,
      issuer: issuerA,
    },
  });
  assert.equal(inviteRes.ok, true);
  assert.ok(inviteRes.requestId);
  assert.ok(inviteRes.protocolRequestId);
  assert.ok(inviteRes.envelope);

  const aRequests = await listTrustRequests(env, wsA, { direction: "out" });
  assert.equal(aRequests.length, 1);
  assert.equal(aRequests[0].status, "pending");

  const aEdges = await listTrustEdges(env, wsA);
  assert.equal(aEdges.length, 1);
  assert.equal(aEdges[0].status, "pending");

  const bVerified = await verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(inviteRes.envelope!)),
      "x-openinst-trust-sig": (await signTrustControlEnvelope(keyA.privateJwk, inviteRes.envelope!)),
      "x-openinst-trust-kid": kidA,
      "x-openinst-trust-issuer": issuerA,
    },
    recipient: "bob@bob.openinst.com",
    workspaceId: wsB,
    nowMs,
  });
  assert.equal(bVerified.ok, true);
  if (bVerified.ok) {
    await dispatchVerifiedTrustControl(env, {
      workspaceId: wsB,
      verified: bVerified,
      nowMs,
    });
  }

  const bRequests = await listTrustRequests(env, wsB, { direction: "in" });
  assert.equal(bRequests.length, 1);
  assert.equal(bRequests[0].status, "pending");

  const acceptRes = await acceptTrustRequest(env, {
    workspaceId: wsB,
    requestId: bRequests[0].id,
    nowMs: nowMs + 1000,
    signingKeyOverride: {
      privateJwk: keyB.privateJwk,
      publicX: String(keyB.publicJwk.x),
      kid: kidB,
      issuer: issuerB,
    },
  });
  assert.equal(acceptRes.ok, true);

  const bReqAfter = await listTrustRequests(env, wsB, { direction: "in" });
  assert.equal(bReqAfter[0].status, "accepted");
  const bEdgesAfter = await listTrustEdges(env, wsB);
  assert.equal(bEdgesAfter.length, 1);
  assert.equal(bEdgesAfter[0].status, "active");

  const acceptEnvelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.accept",
    issuer: issuerB,
    kid: kidB,
    fromAgent: "bob@bob.openinst.com",
    toAgent: "alice@alice.openinst.com",
    requestId: inviteRes.protocolRequestId!,
    iat: nowSec + 1,
    exp: nowSec + 86400 * 7,
    nonce: "nonce_accept_1",
  };
  const acceptSig = await signTrustControlEnvelope(keyB.privateJwk, acceptEnvelope);
  const aVerifiedAccept = await verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(acceptEnvelope)),
      "x-openinst-trust-sig": acceptSig,
      "x-openinst-trust-kid": kidB,
      "x-openinst-trust-issuer": issuerB,
    },
    recipient: "alice@alice.openinst.com",
    workspaceId: wsA,
    nowMs: nowMs + 1000,
  });
  assert.equal(aVerifiedAccept.ok, true);
  if (aVerifiedAccept.ok) {
    const aDispatch = await dispatchVerifiedTrustControl(env, {
      workspaceId: wsA,
      verified: aVerifiedAccept,
      nowMs: nowMs + 1000,
    });
    assert.equal(aDispatch.ok, true);
    assert.equal(aDispatch.status, "accepted");
  }

  const aReqAfter = await listTrustRequests(env, wsA, { direction: "out" });
  assert.equal(aReqAfter[0].status, "accepted");
  const aEdgesAfter = await listTrustEdges(env, wsA);
  assert.equal(aEdgesAfter.length, 1);
  assert.equal(aEdgesAfter[0].status, "active");

  assert.equal(aEdgesAfter[0].status, "active");
  assert.equal(bEdgesAfter[0].status, "active");
}

// 3. Decline flow
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const wsA = "ws_alice";
  const wsB = "ws_bob";
  await setupMailbox(env, wsA, "alice@alice.openinst.com");
  await setupMailbox(env, wsB, "bob@bob.openinst.com");

  const inviteRes = await inviteTrustPerson(env, {
    workspaceId: wsA,
    peerAddress: "bob@bob.openinst.com",
    nowMs,
    signingKeyOverride: { privateJwk: keyA.privateJwk, publicX: String(keyA.publicJwk.x), kid: kidA, issuer: issuerA },
  });
  assert.equal(inviteRes.ok, true);

  const verified = await verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(inviteRes.envelope!)),
      "x-openinst-trust-sig": (await signTrustControlEnvelope(keyA.privateJwk, inviteRes.envelope!)),
      "x-openinst-trust-kid": kidA,
      "x-openinst-trust-issuer": issuerA,
    },
    recipient: "bob@bob.openinst.com",
    workspaceId: wsB,
    nowMs,
  });
  assert.equal(verified.ok, true);
  if (verified.ok) {
    await dispatchVerifiedTrustControl(env, { workspaceId: wsB, verified, nowMs });
  }

  const bReq = (await listTrustRequests(env, wsB, { direction: "in" }))[0];
  const declineRes = await declineTrustRequest(env, {
    workspaceId: wsB,
    requestId: bReq.id,
    nowMs: nowMs + 1000,
    signingKeyOverride: { privateJwk: keyB.privateJwk, publicX: String(keyB.publicJwk.x), kid: kidB, issuer: issuerB },
  });
  assert.equal(declineRes.ok, true);

  const bReqAfter = (await listTrustRequests(env, wsB, { direction: "in" }))[0];
  assert.equal(bReqAfter.status, "declined");
  assert.equal((await listTrustEdges(env, wsB)).length, 0);

  const declineEnvelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.decline",
    issuer: issuerB,
    kid: kidB,
    fromAgent: "bob@bob.openinst.com",
    toAgent: "alice@alice.openinst.com",
    requestId: inviteRes.protocolRequestId!,
    iat: nowSec + 1,
    exp: nowSec + 86400,
    nonce: "nonce_dec_1",
  };
  const vDec = await verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(declineEnvelope)),
      "x-openinst-trust-sig": (await signTrustControlEnvelope(keyB.privateJwk, declineEnvelope)),
      "x-openinst-trust-kid": kidB,
      "x-openinst-trust-issuer": issuerB,
    },
    recipient: "alice@alice.openinst.com",
    workspaceId: wsA,
    nowMs: nowMs + 1000,
  });
  assert.equal(vDec.ok, true);
  if (vDec.ok) {
    await dispatchVerifiedTrustControl(env, { workspaceId: wsA, verified: vDec, nowMs: nowMs + 1000 });
  }

  const aReqAfter = (await listTrustRequests(env, wsA, { direction: "out" }))[0];
  assert.equal(aReqAfter.status, "declined");
  const aEdgeAfter = (await listTrustEdges(env, wsA))[0];
  assert.equal(aEdgeAfter.status, "declined");
}

// 4. Cancel outgoing request
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const wsA = "ws_alice";
  await setupMailbox(env, wsA, "alice@alice.openinst.com");

  const inviteRes = await inviteTrustPerson(env, {
    workspaceId: wsA,
    peerAddress: "bob@bob.openinst.com",
    peerIssuer: issuerB,
    nowMs,
    signingKeyOverride: { privateJwk: keyA.privateJwk, publicX: String(keyA.publicJwk.x), kid: kidA, issuer: issuerA },
  });
  assert.equal(inviteRes.ok, true);

  const cancelRes = await cancelTrustRequest(env, {
    workspaceId: wsA,
    requestId: inviteRes.requestId!,
    nowMs: nowMs + 500,
    signingKeyOverride: { privateJwk: keyA.privateJwk, publicX: String(keyA.publicJwk.x), kid: kidA, issuer: issuerA },
  });
  assert.equal(cancelRes.ok, true);

  const req = (await listTrustRequests(env, wsA))[0];
  assert.equal(req.status, "cancelled");
  const edge = (await listTrustEdges(env, wsA))[0];
  assert.equal(edge.status, "revoked");
}

// 5. Block outranks late retry / incoming invite (T7)
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const wsB = "ws_bob";
  await setupMailbox(env, wsB, "bob@bob.openinst.com");

  await blockTrustPeer(env, {
    workspaceId: wsB,
    edgeIdOrPeerAddress: "alice@alice.openinst.com",
    nowMs,
    signingKeyOverride: { privateJwk: keyB.privateJwk, publicX: String(keyB.publicJwk.x), kid: kidB, issuer: issuerB },
  });

  const bEdges = await listTrustEdges(env, wsB);
  assert.equal(bEdges.length, 1);
  assert.equal(bEdges[0].status, "blocked");

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer: issuerA,
    kid: kidA,
    fromAgent: "alice@alice.openinst.com",
    toAgent: "bob@bob.openinst.com",
    requestId: "req_from_blocked",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_blk",
  };
  const sig = await signTrustControlEnvelope(keyA.privateJwk, envelope);
  const verified = await verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(envelope)),
      "x-openinst-trust-sig": sig,
      "x-openinst-trust-kid": kidA,
      "x-openinst-trust-issuer": issuerA,
    },
    recipient: "bob@bob.openinst.com",
    workspaceId: wsB,
    nowMs,
  });
  assert.equal(verified.ok, true);
  if (verified.ok) {
    const res = await dispatchVerifiedTrustControl(env, {
      workspaceId: wsB,
      verified,
      nowMs,
    });
    assert.equal(res.ok, true);
    assert.equal(res.ignored, true);
    assert.equal(res.reason, "peer_blocked");
  }

  const bReqs = await listTrustRequests(env, wsB);
  assert.equal(bReqs.length, 0, "Blocked peer invites must not surface as pending requests");

  const acceptEnv: TrustControlEnvelope = {
    v: 1,
    kind: "trust.accept",
    issuer: issuerA,
    kid: kidA,
    fromAgent: "alice@alice.openinst.com",
    toAgent: "bob@bob.openinst.com",
    requestId: "req_late_accept",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_late_acc",
  };
  const vAccept = await verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(acceptEnv)),
      "x-openinst-trust-sig": (await signTrustControlEnvelope(keyA.privateJwk, acceptEnv)),
      "x-openinst-trust-kid": kidA,
      "x-openinst-trust-issuer": issuerA,
    },
    recipient: "bob@bob.openinst.com",
    workspaceId: wsB,
    nowMs,
  });
  assert.equal(vAccept.ok, true);
  if (vAccept.ok) {
    await dispatchVerifiedTrustControl(env, { workspaceId: wsB, verified: vAccept, nowMs });
  }
  const bEdgesStillBlocked = await listTrustEdges(env, wsB);
  assert.equal(bEdgesStillBlocked[0].status, "blocked", "Late accept cannot unblock a blocked peer");

  await unblockTrustPeer(env, { workspaceId: wsB, edgeIdOrPeerAddress: "alice@alice.openinst.com", nowMs });
  const bEdgesUnblocked = await listTrustEdges(env, wsB);
  assert.equal(bEdgesUnblocked[0].status, "revoked", "Unblock must transition to revoked, not active");
}

// 6. Pause / Resume (T8)
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_pause_test";
  await setupMailbox(env, ws, "agent@mail.openinst.com");

  assert.equal(await isTrustedPeoplePaused(env, ws), false);
  await setTrustedPeoplePaused(env, ws, true);
  assert.equal(await isTrustedPeoplePaused(env, ws), true);

  const res = await inviteTrustPerson(env, {
    workspaceId: ws,
    peerAddress: "peer@other.com",
    nowMs,
    signingKeyOverride: { privateJwk: keyA.privateJwk, publicX: String(keyA.publicJwk.x), kid: kidA, issuer: issuerA },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "connections_paused");

  await setTrustedPeoplePaused(env, ws, false);
  assert.equal(await isTrustedPeoplePaused(env, ws), false);
}

// 7. Agent Mail prerequisite gate (T1)
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const wsNoMail = "ws_no_mail";

  const res = await inviteTrustPerson(env, {
    workspaceId: wsNoMail,
    peerAddress: "peer@other.com",
    nowMs,
    signingKeyOverride: { privateJwk: keyA.privateJwk, publicX: String(keyA.publicJwk.x), kid: kidA, issuer: issuerA },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "agent_mail_required");
}

console.log("✔ trust-control dispatch and state machine tests passed!");
