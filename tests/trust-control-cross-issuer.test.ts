// tests/trust-control-cross-issuer.test.ts — Cross issuer product gate (V2 §11 / §31.4).

import assert from "node:assert/strict";
import { generateSigningKey } from "../src/channels/email/trust-control/sign";
import { signTrustControlEnvelope } from "../src/channels/email/trust-control/sign";
import type { TrustControlEnvelope } from "../src/channels/email/trust-control/schema";
import { verifyTrustControl } from "../src/channels/email/trust-control/verify";
import { dispatchVerifiedTrustControl } from "../src/channels/email/trust-control/dispatch";
import { canonicalBytes } from "../src/channels/email/trust-control/canonical";
import { b64urlEncode } from "../src/channels/email/a2a/codec";
import { listTrustRequests } from "../src/channels/email/trust-service";
import { createTestD1 } from "./helpers/d1";
import type { Env } from "../src/env";

console.log("▶ Trust control cross-issuer gate tests...");

const nowMs = 1789000000_000;
const nowSec = Math.floor(nowMs / 1000);
const localIssuer = "openinst.com";
const externalIssuer = "selfhost.example.net";
const kidLocal = "k_local";
const kidExt = "k_ext";
const localKey = await generateSigningKey(kidLocal);
const extKey = await generateSigningKey(kidExt);

function makeEnv(d1: unknown, crossEnabled: boolean): Env {
  return {
    DB: d1,
    A2A_ISSUER: localIssuer,
    TRUSTED_PEOPLE_CROSS_ISSUER_ENABLED: crossEnabled ? "1" : "0",
    A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify({
      issuers: {
        [localIssuer]: { mailDomains: ["openinst.com", "mail.openinst.com"], acceptsA2A: true, keys: { [kidLocal]: { x: localKey.publicJwk.x } } },
        [externalIssuer]: { mailDomains: ["selfhost.example.net", "mail.selfhost.example.net"], acceptsA2A: true, keys: { [kidExt]: { x: extKey.publicJwk.x } } },
      },
    }),
  } as unknown as Env;
}

function externalEnvelope(): TrustControlEnvelope {
  return {
    v: 1,
    kind: "trust.invite",
    issuer: externalIssuer,
    kid: kidExt,
    fromAgent: "carol@selfhost.example.net",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_ext_1",
    iat: nowSec,
    exp: nowSec + 86400 * 7,
    nonce: "n_ext_1",
    displayName: "Carol",
  };
}

async function verifiedFor(env: Env, envelope: TrustControlEnvelope, sig: string) {
  return verifyTrustControl(env, {
    headers: {
      "x-openinst-trust-envelope": b64urlEncode(canonicalBytes(envelope)),
      "x-openinst-trust-sig": sig,
      "x-openinst-trust-kid": envelope.kid,
      "x-openinst-trust-issuer": envelope.issuer,
    },
    recipient: "bob@mail.openinst.com",
    workspaceId: "ws_cross",
    nowMs,
  });
}

// 1. flag off -> valid external invite cryptographic verification succeeds but creates NO visible request
{
  const d1 = createTestD1();
  const env = makeEnv(d1, false);
  const ws = "ws_cross";
  await env.DB.prepare(
    `INSERT INTO agent_mailboxes (workspace_id, local_part, domain, address, status, created_at, updated_at)
     VALUES (?, 'bob', 'mail.openinst.com', 'bob@mail.openinst.com', 'active', ?, ?)`,
  ).bind(ws, nowMs, nowMs).run();

  const envelope = externalEnvelope();
  const sig = await signTrustControlEnvelope(extKey.privateJwk, envelope);
  const v = await verifiedFor(env, envelope, sig);
  assert.equal(v.ok, true, "Cryptographic verification must succeed regardless of product gate");

  if (v.ok) {
    const res = await dispatchVerifiedTrustControl(env, { workspaceId: ws, verified: v, nowMs });
    assert.equal(res.ok, true);
    assert.equal(res.ignored, true);
    assert.equal(res.reason, "cross_issuer_trust_disabled");
  }

  const reqs = await listTrustRequests(env, ws, { direction: "in" });
  assert.equal(reqs.length, 0, "No visible request when cross-issuer is off");
}

// 2. flag on -> discovery-verified external invite creates incoming request
{
  const d1 = createTestD1();
  const env = makeEnv(d1, true);
  const ws = "ws_cross";
  await env.DB.prepare(
    `INSERT INTO agent_mailboxes (workspace_id, local_part, domain, address, status, created_at, updated_at)
     VALUES (?, 'bob', 'mail.openinst.com', 'bob@mail.openinst.com', 'active', ?, ?)`,
  ).bind(ws, nowMs, nowMs).run();

  const envelope = externalEnvelope();
  const sig = await signTrustControlEnvelope(extKey.privateJwk, envelope);
  const v = await verifiedFor(env, envelope, sig);
  assert.equal(v.ok, true);

  if (v.ok) {
    const res = await dispatchVerifiedTrustControl(env, { workspaceId: ws, verified: v, nowMs });
    assert.equal(res.ok, true);
    assert.equal(res.status, "pending");
  }

  const reqs = await listTrustRequests(env, ws, { direction: "in" });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].peerIssuer, externalIssuer);
}

// 3. Malicious issuer cannot impersonate a fromAgent from another mailDomain
{
  const d1 = createTestD1();
  const env = makeEnv(d1, true);

  const spoof: TrustControlEnvelope = {
    ...externalEnvelope(),
    fromAgent: "alice@mail.openinst.com", // local domain, but signed by external issuer
  };
  const sig = await signTrustControlEnvelope(extKey.privateJwk, spoof);
  const v = await verifiedFor(env, spoof, sig);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.error, "from_domain_not_bound");
}

console.log("✔ Trust control cross-issuer gate tests passed!");
