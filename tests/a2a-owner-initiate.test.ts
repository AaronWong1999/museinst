// tests/a2a-owner-initiate.test.ts — Owner-initiated A2A scheduling coordination & tools tests.

import assert from "node:assert/strict";
import { generateSigningKey } from "../src/channels/email/a2a/sign";
import { startScheduleCoordination } from "../src/channels/email/a2a/initiate";
import { createTestD1 } from "./helpers/d1";
import type { Env } from "../src/env";
import {
  TOOL_trusted_people_list,
  TOOL_trusted_people_schedule,
  TOOL_trusted_people_block,
  TOOL_trusted_people_unblock,
  TOOL_trusted_people_introduce,
} from "../src/agent/tools-trusted-people";
import {
  listTrustRequests,
  listTrustEdges,
  countTrustRequests,
  countTrustEdges,
} from "../src/channels/email/trust-service";
import { toolDefsForSession, buildFullCatalog } from "../src/agent/tools";
import { createToolSession } from "../src/agent/tool-session";
import { setHostHooks, resetHostHooks } from "../src/hooks";

console.log("▶ Owner A2A scheduling initiator and tools tests...");

const nowMs = 1789000000_000;
const nowSec = Math.floor(nowMs / 1000);
const kid = "k_init_1";
const issuer = "openinst.com";
const signingKey = await generateSigningKey(kid);

function makeEnv(d1: unknown): Env {
  const localKeyConfig = {
    issuers: {
      "openinst.com": {
        mailDomains: ["openinst.com", "mail.openinst.com"],
        acceptsA2A: true,
        keys: {
          [kid]: { x: signingKey.publicJwk.x, notBefore: nowSec - 3600, notAfter: nowSec + 86400 * 30 },
        },
      },
    },
  };
  return {
    DB: d1,
    A2A_ENABLED: "1",
    A2A_ISSUER: issuer,
    A2A_SIGNING_PRIVATE_JWK: JSON.stringify({ ...signingKey.privateJwk, kid, issuer }),
    A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify(localKeyConfig),
    TRUSTED_PEOPLE_ENABLED: "1",
  } as unknown as Env;
}

async function setupMailbox(env: Env, workspaceId: string, address: string) {
  const [local, domain] = address.split("@");
  await env.DB.prepare(
    `INSERT INTO agent_mailboxes (workspace_id, local_part, domain, address, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).bind(workspaceId, local, domain, address, nowMs, nowMs).run();
}

async function setupActiveEdgeAndConsent(env: Env, workspaceId: string, peerAddress: string, peerIssuer: string) {
  await env.DB.prepare(
    `INSERT INTO trust_edges (id, workspace_id, peer_address, peer_issuer, relation, status, disclosure_json, auto_accept, invited_at, confirmed_at)
     VALUES ('te_' || hex(randomblob(4)), ?, ?, ?, 'trusted', 'active', '{}', 0, ?, ?)
     ON CONFLICT(workspace_id, peer_address) DO UPDATE SET status='active', peer_issuer=excluded.peer_issuer`,
  ).bind(workspaceId, peerAddress.toLowerCase(), peerIssuer, nowMs, nowMs).run();

  await env.DB.prepare(
    `INSERT INTO a2a_domain_consents (workspace_id, issuer, status, confirmed_by, confirmed_at)
     VALUES (?, ?, 'allowed', 'test', ?)
     ON CONFLICT(workspace_id, issuer) DO UPDATE SET status='allowed'`,
  ).bind(workspaceId, peerIssuer, nowMs).run();
}

const window1 = { start: "2026-09-18T18:00:00Z", end: "2026-09-18T23:00:00Z" };

// 1. Trust/domain preconditions are checked before any protocol side effect.
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_initiator_preconditions";
  await setupMailbox(env, ws, "aaron@mail.openinst.com");

  const noEdge = await startScheduleCoordination(env, {
    workspaceId: ws, peers: ["bob@mail.openinst.com"], facts: {}, timeWindow: window1,
    durationMinutes: 90, idempotencyKey: "no_edge", nowMs,
  });
  assert.equal(noEdge.ok, false);
  assert.equal(noEdge.results[0].error, "trust_edge_not_active");

  await env.DB.prepare(
    `INSERT INTO trust_edges (id, workspace_id, peer_address, peer_issuer, relation, status, disclosure_json, auto_accept, invited_at)
     VALUES ('te_pre', ?, 'bob@mail.openinst.com', 'openinst.com', 'trusted', 'active', '{}', 0, ?)`,
  ).bind(ws, nowMs).run();
  const noConsent = await startScheduleCoordination(env, {
    workspaceId: ws, peers: ["bob@mail.openinst.com"], facts: {}, timeWindow: window1,
    durationMinutes: 90, idempotencyKey: "no_consent", nowMs,
  });
  assert.equal(noConsent.ok, false);
  assert.equal(noConsent.results[0].error, "domain_consent_not_allowed");

  const sideEffects = await env.DB.prepare(`SELECT count(*) AS c FROM a2a_convos WHERE workspace_id=?`).bind(ws).first<{ c: number }>();
  assert.equal(sideEffects?.c, 0);
}

// 2. Successful coordination is durable/idempotent and returns the same convo/outbox.
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_initiator_idempotent";
  await setupMailbox(env, ws, "aaron@mail.openinst.com");
  await setupActiveEdgeAndConsent(env, ws, "bob@mail.openinst.com", "openinst.com");

  const res1 = await startScheduleCoordination(env, {
    workspaceId: ws,
    peers: ["bob@mail.openinst.com"],
    facts: { timezone: "Asia/Shanghai" },
    timeWindow: window1,
    durationMinutes: 90,
    idempotencyKey: "idemp_key_1",
    nowMs,
  });
  assert.equal(res1.ok, true);
  const convoId = res1.results[0].protocolConvoId;
  const outboxId = res1.results[0].outboxId;
  assert.ok(convoId);
  assert.ok(outboxId);

  const convo = await env.DB.prepare(`SELECT state, role, peer_address FROM a2a_convos WHERE protocol_convo_id=?`)
    .bind(convoId).first<{ state: string; role: string; peer_address: string }>();
  assert.equal(convo?.state, "proposed");
  assert.equal(convo?.role, "initiator");
  assert.equal(convo?.peer_address, "bob@mail.openinst.com");

  const res2 = await startScheduleCoordination(env, {
    workspaceId: ws,
    peers: ["bob@mail.openinst.com"],
    facts: { timezone: "Asia/Shanghai" },
    timeWindow: window1,
    durationMinutes: 90,
    idempotencyKey: "idemp_key_1",
    nowMs: nowMs + 1000,
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.results[0].protocolConvoId, convoId);
  assert.equal(res2.results[0].outboxId, outboxId);

  const countOutbox = await env.DB.prepare(`SELECT count(*) AS cnt FROM email_outbox WHERE logical_key=?`)
    .bind(`a2a:init:idemp_key_1:bob@mail.openinst.com`).first<{ cnt: number }>();
  assert.equal(countOutbox?.cnt, 1);

  // Same idempotency key with different semantics must fail closed rather than mutate the old intent.
  const mismatch = await startScheduleCoordination(env, {
    workspaceId: ws,
    peers: ["bob@mail.openinst.com"],
    facts: {},
    timeWindow: window1,
    durationMinutes: 60,
    idempotencyKey: "idemp_key_1",
    nowMs: nowMs + 2000,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.results[0].error, "idempotency_key_reused_with_different_request");
}

// 3. Multiple peers use isolated conversations and recipients.
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_initiator_multi";
  await setupMailbox(env, ws, "aaron@mail.openinst.com");
  await setupActiveEdgeAndConsent(env, ws, "bob@mail.openinst.com", "openinst.com");
  await setupActiveEdgeAndConsent(env, ws, "charlie@mail.openinst.com", "openinst.com");

  const res = await startScheduleCoordination(env, {
    workspaceId: ws,
    peers: ["bob@mail.openinst.com", "charlie@mail.openinst.com"],
    facts: { timezone: "Asia/Shanghai" },
    timeWindow: window1,
    durationMinutes: 60,
    idempotencyKey: "multi_peer_key",
    nowMs,
  });
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 2);
  const bob = res.results.find((r) => r.peer === "bob@mail.openinst.com");
  const charlie = res.results.find((r) => r.peer === "charlie@mail.openinst.com");
  assert.notEqual(bob?.protocolConvoId, charlie?.protocolConvoId);

  const bobMsg = await env.DB.prepare(`SELECT to_addr FROM email_outbox WHERE logical_key=?`)
    .bind(`a2a:init:multi_peer_key:bob@mail.openinst.com`).first<{ to_addr: string }>();
  const charlieMsg = await env.DB.prepare(`SELECT to_addr FROM email_outbox WHERE logical_key=?`)
    .bind(`a2a:init:multi_peer_key:charlie@mail.openinst.com`).first<{ to_addr: string }>();
  assert.equal(bobMsg?.to_addr, "bob@mail.openinst.com");
  assert.equal(charlieMsg?.to_addr, "charlie@mail.openinst.com");
}

// 4. Trusted tools never appear in external contexts, and fake Introduction is not in the catalog.
{
  const env = makeEnv(createTestD1());
  const catalog = buildFullCatalog(env, { workspaceId: "ws_test" } as never);
  const session = createToolSession([]);
  const defsExternal = toolDefsForSession(catalog, session, { env, agentMailAllowed: false });
  assert.equal(defsExternal.filter((d) => d.name.startsWith("trusted_people_")).length, 0);
  assert.ok(catalog.some((e) => e.tool.name === "trusted_people_list"));
  assert.ok(catalog.some((e) => e.tool.name === "trusted_people_schedule"));
  assert.ok(!catalog.some((e) => e.tool.name === "trusted_people_introduce"));
}

// 5. Host budget denial occurs before convo/outbox side effects.
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_budget_hook";
  await setupMailbox(env, ws, "aaron@mail.openinst.com");
  await setupActiveEdgeAndConsent(env, ws, "bob@mail.openinst.com", "openinst.com");
  let seen = 0;
  setHostHooks({
    beforeA2aOutbound: async () => { seen++; return { allow: false, reason: "a2a_quota_exceeded" }; },
  });
  try {
    const res = await startScheduleCoordination(env, {
      workspaceId: ws, peers: ["bob@mail.openinst.com"], facts: {}, timeWindow: window1,
      durationMinutes: 60, idempotencyKey: "budget_deny_key", nowMs,
    });
    assert.equal(res.ok, false);
    assert.equal(res.results[0].error, "a2a_quota_exceeded");
    assert.equal(seen, 1);
    const convos = await env.DB.prepare(`SELECT count(*) AS c FROM a2a_convos WHERE workspace_id=?`).bind(ws).first<{ c: number }>();
    assert.equal(convos?.c, 0);
  } finally {
    resetHostHooks();
  }
}

// 6. Multi-peer admission rollback releases earlier exact reservations when a later peer is denied.
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_budget_rollback";
  await setupMailbox(env, ws, "aaron@mail.openinst.com");
  await setupActiveEdgeAndConsent(env, ws, "bob@mail.openinst.com", "openinst.com");
  await setupActiveEdgeAndConsent(env, ws, "charlie@mail.openinst.com", "openinst.com");
  const reserved: string[] = [];
  const released: string[] = [];
  setHostHooks({
    beforeA2aOutbound: async (_env, req) => {
      if (req.peerAddress === "charlie@mail.openinst.com") return { allow: false, reason: "a2a_quota_exceeded" };
      reserved.push(req.logicalKey);
      return { allow: true };
    },
    releaseA2aOutbound: async (_env, req) => { released.push(req.logicalKey); },
  });
  try {
    const res = await startScheduleCoordination(env, {
      workspaceId: ws,
      peers: ["bob@mail.openinst.com", "charlie@mail.openinst.com"],
      facts: {}, timeWindow: window1, durationMinutes: 60,
      idempotencyKey: "rollback_key", nowMs,
    });
    assert.equal(res.ok, false);
    assert.deepEqual(reserved, ["a2a:init:rollback_key:bob@mail.openinst.com"]);
    assert.deepEqual(released, reserved, "earlier exact-key reservation must be released");
    const convos = await env.DB.prepare(`SELECT count(*) AS c FROM a2a_convos WHERE workspace_id=?`).bind(ws).first<{ c: number }>();
    assert.equal(convos?.c, 0);
  } finally {
    resetHostHooks();
  }
}

// 7. V3 tools: unblock never restores trust; Introduction fails truthfully; explicit schedule facts work.
{
  const d1 = createTestD1();
  const env = makeEnv(d1);
  const ws = "ws_v3_tools";
  const ctx = { env, workspaceId: ws, channel: "console" } as any;
  await setupMailbox(env, ws, "alice@mail.openinst.com");
  await setupActiveEdgeAndConsent(env, ws, "bob@mail.openinst.com", "openinst.com");

  const blockRes = await TOOL_trusted_people_block.run(ctx, { target: "bob@mail.openinst.com" });
  assert.equal(blockRes.ok, true);
  const blockedList = await TOOL_trusted_people_list.run(ctx, { status: "blocked" });
  assert.equal(blockedList.data.length, 1);

  const unblockRes = await TOOL_trusted_people_unblock.run(ctx, { target: "bob@mail.openinst.com" });
  assert.equal(unblockRes.ok, true);
  const afterUnblock = await TOOL_trusted_people_list.run(ctx, { status: "active" });
  assert.equal(afterUnblock.data.length, 0, "Unblock must not fabricate active trust");
  await setupActiveEdgeAndConsent(env, ws, "bob@mail.openinst.com", "openinst.com");

  const intro = await TOOL_trusted_people_introduce.run(ctx, {
    friendAddress: "bob@mail.openinst.com",
    targetAddress: "carol@mail.openinst.com",
  });
  assert.equal(intro.ok, false);
  assert.equal(intro.error, "trusted_introduction_not_available");

  const sched = await TOOL_trusted_people_schedule.run(ctx, {
    peers: ["bob@mail.openinst.com"],
    timeWindow: window1,
    durationMinutes: 60,
    freeBusyWindows: [
      { start: "2026-09-18T18:00:00Z", end: "2026-09-18T19:00:00Z", status: "busy" },
    ],
  });
  assert.equal(sched.ok, true);
  assert.equal(sched.calendarEvidence, "explicit");
  assert.match(sched.message, /free\/busy/);

  const edgeCount = await countTrustEdges(env, ws, { status: "active" });
  assert.equal(edgeCount, 1);
  assert.equal((await listTrustEdges(env, ws, { status: "active", limit: 10, offset: 0 })).length, 1);
  assert.equal((await listTrustEdges(env, ws, { status: "active", limit: 10, offset: 10 })).length, 0);
  assert.equal(typeof (await countTrustRequests(env, ws)), "number");
  assert.ok(Array.isArray(await listTrustRequests(env, ws, { limit: 10, offset: 0 })));
}

console.log("✔ Owner A2A initiator and tools tests passed!");
