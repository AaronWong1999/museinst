// tests/trusted-people-pause.test.ts — Pause / Resume runtime policy (V2 §15 / §31.5).

import assert from "node:assert/strict";
import { generateSigningKey } from "../src/channels/email/trust-control/sign";
import type { TrustControlEnvelope } from "../src/channels/email/trust-control/schema";
import { dispatchVerifiedTrustControl } from "../src/channels/email/trust-control/dispatch";
import { trustControlEnvelopeSha256 } from "../src/channels/email/trust-control/verify";
import {
  inviteTrustPerson,
  listTrustEdges,
  listTrustRequests,
  isTrustedPeoplePaused,
  setTrustedPeoplePaused,
} from "../src/channels/email/trust-service";
import { startScheduleCoordination } from "../src/channels/email/a2a/initiate";
import { createTestD1 } from "./helpers/d1";
import type { Env } from "../src/env";

console.log("▶ Trusted People pause / resume policy tests...");

const nowMs = 1789000000_000;
const nowSec = Math.floor(nowMs / 1000);
const kid = "k_pause";
const { publicJwk, privateJwk } = await generateSigningKey(kid);

function makeEnv(d1: unknown): Env {
  return {
    DB: d1,
    A2A_ISSUER: "openinst.com",
    A2A_SIGNING_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid, issuer: "openinst.com" }),
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

// 1. Pause preserves edges (T8)
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_pause_1";
  await setupMailbox(env, ws, "alice@mail.openinst.com");

  // Seed an active edge
  await env.DB.prepare(
    `INSERT INTO trust_edges (id, workspace_id, peer_address, peer_issuer, relation, status, disclosure_json, auto_accept, invited_at, confirmed_at)
     VALUES ('te_1', ?, 'bob@mail.openinst.com', 'openinst.com', 'trusted', 'active', '{}', 0, ?, ?)`,
  ).bind(ws, nowMs, nowMs).run();

  await setTrustedPeoplePaused(env, ws, true);
  const edgesDuring = await listTrustEdges(env, ws);
  assert.equal(edgesDuring.length, 1, "Pause must not delete the trust graph");
  assert.equal(edgesDuring[0].status, "active");

  await setTrustedPeoplePaused(env, ws, false);
  const edgesAfter = await listTrustEdges(env, ws);
  assert.equal(edgesAfter.length, 1);
  assert.equal(edgesAfter[0].status, "active");
}

// 2. Outbound invite denied while paused; pending invite retained after resume
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_pause_2";
  await setupMailbox(env, ws, "alice@mail.openinst.com");

  await setTrustedPeoplePaused(env, ws, true);
  const inviteRes = await inviteTrustPerson(env, {
    workspaceId: ws,
    peerAddress: "bob@mail.openinst.com",
    nowMs,
    signingKeyOverride: { privateJwk, publicX: String(publicJwk.x), kid, issuer: "openinst.com" },
  });
  assert.equal(inviteRes.ok, false);
  assert.equal(inviteRes.error, "connections_paused");

  await setTrustedPeoplePaused(env, ws, false);
  const okRes = await inviteTrustPerson(env, {
    workspaceId: ws,
    peerAddress: "bob@mail.openinst.com",
    nowMs,
    signingKeyOverride: { privateJwk, publicX: String(publicJwk.x), kid, issuer: "openinst.com" },
  });
  assert.equal(okRes.ok, true, "Resume must allow a fresh invite");
  const reqs = await listTrustRequests(env, ws, { direction: "out" });
  assert.equal(reqs.length, 1);
}

// 3. Inbound invite while paused: durable pending retained (V2 §15.2)
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_pause_3";
  await setupMailbox(env, ws, "bob@mail.openinst.com");
  await setTrustedPeoplePaused(env, ws, true);

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: "trust.invite",
    issuer: "openinst.com",
    kid,
    fromAgent: "alice@mail.openinst.com",
    toAgent: "bob@mail.openinst.com",
    requestId: "req_pause_3",
    iat: nowSec,
    exp: nowSec + 86400 * 7,
    nonce: "n_pause_3",
  };
  const res = await dispatchVerifiedTrustControl(env, {
    workspaceId: ws,
    verified: {
      ok: true, envelope, issuer: "openinst.com", kid,
      peerAddress: envelope.fromAgent, recipient: envelope.toAgent,
      keySource: "local_same_issuer", issuerMailDomains: [],
      envelopeSha256: await trustControlEnvelopeSha256(envelope), verifiedAt: nowMs,
    },
    nowMs,
  });
  // Data must be retained as pending (verification still durable)
  assert.equal(res.ok, true);

  await setTrustedPeoplePaused(env, ws, false);
  const reqs = await listTrustRequests(env, ws, { direction: "in" });
  assert.equal(reqs.length, 1, "Pending invite must be visible after resume");
  assert.equal(reqs[0].status, "pending");
}

// 4. Inbound schedule denied while paused; outbound schedule denied (V2 §15.1/§15.3)
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_pause_4";
  await setupMailbox(env, ws, "alice@mail.openinst.com");

  // Active edge + consent
  await env.DB.prepare(
    `INSERT INTO trust_edges (id, workspace_id, peer_address, peer_issuer, relation, status, disclosure_json, auto_accept, invited_at, confirmed_at)
     VALUES ('te_4', ?, 'bob@mail.openinst.com', 'openinst.com', 'trusted', 'active', '{}', 0, ?, ?)`,
  ).bind(ws, nowMs, nowMs).run();
  await env.DB.prepare(
    `INSERT INTO a2a_domain_consents (workspace_id, issuer, status, confirmed_by, confirmed_at) VALUES (?, 'openinst.com', 'allowed', 'test', ?)`,
  ).bind(ws, nowMs).run();

  await setTrustedPeoplePaused(env, ws, true);
  const schedRes = await startScheduleCoordination(env, {
    workspaceId: ws,
    peers: ["bob@mail.openinst.com"],
    facts: {},
    timeWindow: { start: "2026-09-18T18:00:00Z", end: "2026-09-18T23:00:00Z" },
    durationMinutes: 90,
    idempotencyKey: "pause_sched",
    nowMs,
  });
  assert.equal(schedRes.ok, false);
  assert.equal(schedRes.error, "connections_paused");

  assert.equal(await isTrustedPeoplePaused(env, ws), true);
}

console.log("✔ Trusted People pause tests passed!");
