// tests/trust-control-crypto.test.ts — Cryptographic & protocol verification tests for trust-control.

import assert from "node:assert/strict";
import { generateSigningKey } from "../src/channels/email/trust-control/sign";
import { signTrustControlEnvelope, verifyTrustControlEnvelopeSig } from "../src/channels/email/trust-control/sign";
import { validateTrustControlEnvelope, type TrustControlEnvelope } from "../src/channels/email/trust-control/schema";
import { verifyTrustControl } from "../src/channels/email/trust-control/verify";
import { dispatchVerifiedTrustControl } from "../src/channels/email/trust-control/dispatch";
import { canonicalBytes } from "../src/channels/email/trust-control/canonical";
import { b64urlEncode } from "../src/channels/email/a2a/codec";
import { createTestD1 } from "./helpers/d1";
import type { Env } from "../src/env";

console.log("▶ Trust control crypto and envelope verification tests...");

const nowMs = 1789000000_000;
const nowSec = Math.floor(nowMs / 1000);
const issuer = "example.com";
const kid = "k_test_1";
const { publicJwk, privateJwk } = await generateSigningKey(kid);

function makeEnv(d1: unknown): Env {
  const localKeyConfig = {
    issuers: {
      "example.com": {
        mailDomains: ["example.com", "mail.example.com"],
        acceptsA2A: true,
        keys: {
          [kid]: { x: publicJwk.x, notBefore: nowSec - 3600, notAfter: nowSec + 3600 * 24 },
        },
      },
    },
  };
  return {
    DB: d1,
    A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify(localKeyConfig),
    TRUSTED_PEOPLE_CROSS_ISSUER_ENABLED: "1",
  } as unknown as Env;
}

// 1. Valid envelope shape & Ed25519 signing + verification
{
  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer,
    kid,
    fromAgent: "alice@example.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_test_1",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_1",
    displayName: "Alice",
  };

  const sig = await signTrustControlEnvelope(privateJwk, envelope);
  const verifySig = await verifyTrustControlEnvelopeSig(publicJwk, envelope, sig);
  assert.equal(verifySig, true, "Valid signature must verify");

  // Bad signature: modified payload
  const tampered: TrustControlEnvelope = { ...envelope, displayName: "Eve" };
  const badSig = await verifyTrustControlEnvelopeSig(publicJwk, tampered, sig);
  assert.equal(badSig, false, "Tampered envelope must fail verification");
}

// 2. Full verifyTrustControl: happy path
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer,
    kid,
    fromAgent: "alice@example.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_verify_1",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_1",
    displayName: "Alice",
  };
  const sig = await signTrustControlEnvelope(privateJwk, envelope);
  const envelopeB64 = b64urlEncode(canonicalBytes(envelope));

  const headers = {
    "x-openinst-trust-envelope": envelopeB64,
    "x-openinst-trust-sig": sig,
    "x-openinst-trust-kid": kid,
    "x-openinst-trust-issuer": issuer,
  };

  const res = await verifyTrustControl(env, {
    headers,
    recipient: "bob@mail.openinst.com",
    workspaceId: "ws_test",
    nowMs,
  });

  assert.equal(res.ok, true, "Happy path verification should succeed");
  if (res.ok) {
    assert.equal(res.peerAddress, "alice@example.com");
    assert.equal(res.issuer, issuer);
    assert.equal(res.kid, kid);
    assert.ok(res.envelopeSha256);
  }
}

// 3. Header issuer mismatch
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer,
    kid,
    fromAgent: "alice@example.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_verify_2",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_2",
  };
  const sig = await signTrustControlEnvelope(privateJwk, envelope);
  const envelopeB64 = b64urlEncode(canonicalBytes(envelope));

  const headers = {
    "x-openinst-trust-envelope": envelopeB64,
    "x-openinst-trust-sig": sig,
    "x-openinst-trust-kid": kid,
    "x-openinst-trust-issuer": "https://other.com",
  };

  const res = await verifyTrustControl(env, {
    headers,
    recipient: "bob@mail.openinst.com",
    workspaceId: "ws_test",
    nowMs,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "issuer_mismatch");
}

// 4. fromAgent domain mismatch
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer,
    kid,
    fromAgent: "alice@spoofed.com", // not in example.com mailDomains
    toAgent: "bob@mail.openinst.com",
    requestId: "req_verify_3",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_3",
  };
  const sig = await signTrustControlEnvelope(privateJwk, envelope);
  const envelopeB64 = b64urlEncode(canonicalBytes(envelope));

  const headers = {
    "x-openinst-trust-envelope": envelopeB64,
    "x-openinst-trust-sig": sig,
    "x-openinst-trust-kid": kid,
    "x-openinst-trust-issuer": issuer,
  };

  const res = await verifyTrustControl(env, {
    headers,
    recipient: "bob@mail.openinst.com",
    workspaceId: "ws_test",
    nowMs,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "from_domain_not_bound");
}

// 5. toAgent mismatch
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer,
    kid,
    fromAgent: "alice@example.com",
    toAgent: "charlie@mail.openinst.com",
    requestId: "req_verify_4",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_4",
  };
  const sig = await signTrustControlEnvelope(privateJwk, envelope);
  const envelopeB64 = b64urlEncode(canonicalBytes(envelope));

  const headers = {
    "x-openinst-trust-envelope": envelopeB64,
    "x-openinst-trust-sig": sig,
    "x-openinst-trust-kid": kid,
    "x-openinst-trust-issuer": issuer,
  };

  const res = await verifyTrustControl(env, {
    headers,
    recipient: "bob@mail.openinst.com", // recipient is bob, toAgent is charlie
    workspaceId: "ws_test",
    nowMs,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "to_agent_mismatch");
}

// 6. Expired envelope
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer,
    kid,
    fromAgent: "alice@example.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_verify_5",
    iat: nowSec - 100000,
    exp: nowSec - 1000, // expired
    nonce: "nonce_5",
  };
  const sig = await signTrustControlEnvelope(privateJwk, envelope);
  const envelopeB64 = b64urlEncode(canonicalBytes(envelope));

  const headers = {
    "x-openinst-trust-envelope": envelopeB64,
    "x-openinst-trust-sig": sig,
    "x-openinst-trust-kid": kid,
    "x-openinst-trust-issuer": issuer,
  };

  const res = await verifyTrustControl(env, {
    headers,
    recipient: "bob@mail.openinst.com",
    workspaceId: "ws_test",
    nowMs,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "expired");
}

// 7. Future iat
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer,
    kid,
    fromAgent: "alice@example.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_verify_6",
    iat: nowSec + 3600 * 2, // 2 hours into future
    exp: nowSec + 3600 * 24,
    nonce: "nonce_6",
  };
  const sig = await signTrustControlEnvelope(privateJwk, envelope);
  const envelopeB64 = b64urlEncode(canonicalBytes(envelope));

  const headers = {
    "x-openinst-trust-envelope": envelopeB64,
    "x-openinst-trust-sig": sig,
    "x-openinst-trust-kid": kid,
    "x-openinst-trust-issuer": issuer,
  };

  const res = await verifyTrustControl(env, {
    headers,
    recipient: "bob@mail.openinst.com",
    workspaceId: "ws_test",
    nowMs,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "iat_in_future");
}

// 8. Unknown kid
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer,
    kid: "unknown_kid",
    fromAgent: "alice@example.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_verify_7",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_7",
  };
  const sig = await signTrustControlEnvelope(privateJwk, envelope);
  const envelopeB64 = b64urlEncode(canonicalBytes(envelope));

  const headers = {
    "x-openinst-trust-envelope": envelopeB64,
    "x-openinst-trust-sig": sig,
    "x-openinst-trust-kid": "unknown_kid",
    "x-openinst-trust-issuer": issuer,
  };

  const res = await verifyTrustControl(env, {
    headers,
    recipient: "bob@mail.openinst.com",
    workspaceId: "ws_test",
    nowMs,
  });
  assert.equal(res.ok, false);
}

// 9. Replay & Conflict: same envelope -> replay/idempotent; same key different hash -> conflict
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const envelope1: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer,
    kid,
    fromAgent: "alice@example.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_replay_1",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_a",
  };
  const sig1 = await signTrustControlEnvelope(privateJwk, envelope1);
  const v1 = await verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(envelope1)),
      "x-openinst-trust-sig": sig1,
      "x-openinst-trust-kid": kid,
      "x-openinst-trust-issuer": issuer,
    },
    recipient: "bob@mail.openinst.com",
    workspaceId: "ws_test",
    nowMs,
  });
  assert.equal(v1.ok, true);
  if (v1.ok) {
    const r1 = await dispatchVerifiedTrustControl(env, { workspaceId: "ws_test", verified: v1, nowMs });
    assert.equal(r1.ok, true);
    assert.equal(r1.status, "pending");

    // Replay same envelope
    const r1Replay = await dispatchVerifiedTrustControl(env, { workspaceId: "ws_test", verified: v1, nowMs });
    assert.equal(r1Replay.ok, true);
    assert.equal(r1Replay.duplicate, true);
    assert.equal(r1Replay.status, "seen_duplicate");

    // Different envelope with same requestId and kind -> conflict!
    const envelopeConflict: TrustControlEnvelope = {
      ...envelope1,
      displayName: "Different",
      nonce: "nonce_different",
    };
    const sigConflict = await signTrustControlEnvelope(privateJwk, envelopeConflict);
    const vConflict = await verifyTrustControl(env, {
      headers: {
        "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(envelopeConflict)),
        "x-openinst-trust-sig": sigConflict,
        "x-openinst-trust-kid": kid,
        "x-openinst-trust-issuer": issuer,
      },
      recipient: "bob@mail.openinst.com",
      workspaceId: "ws_test",
      nowMs,
    });
    assert.equal(vConflict.ok, true);
    if (vConflict.ok) {
      const rConflict = await dispatchVerifiedTrustControl(env, { workspaceId: "ws_test", verified: vConflict, nowMs });
      assert.equal(rConflict.ok, false);
      assert.equal(rConflict.error, "trust_control_conflict");
    }
  }
}

// 10. Accept requires matching request
{
  const d1 = createTestD1();
  const env = makeEnv(d1);

  const envelopeAccept: TrustControlEnvelope = {
    v: 1,
    kind: "trust.accept",
    issuer,
    kid,
    fromAgent: "alice@example.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_nonexistent",
    iat: nowSec,
    exp: nowSec + 86400,
    nonce: "nonce_acc",
  };
  const sig = await signTrustControlEnvelope(privateJwk, envelopeAccept);
  const v = await verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(envelopeAccept)),
      "x-openinst-trust-sig": sig,
      "x-openinst-trust-kid": kid,
      "x-openinst-trust-issuer": issuer,
    },
    recipient: "bob@mail.openinst.com",
    workspaceId: "ws_test",
    nowMs,
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    const r = await dispatchVerifiedTrustControl(env, { workspaceId: "ws_test", verified: v, nowMs });
    assert.equal(r.ok, false);
    assert.equal(r.error, "no_matching_outgoing_request");
  }
}

console.log("✔ trust-control crypto and envelope verification tests passed!");
