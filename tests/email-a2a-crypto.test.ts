import assert from "node:assert/strict";
import { canonicalize } from "../src/channels/email/a2a/canonical";
import { validateEnvelopeShape, validateDiscoveryShape } from "../src/channels/email/a2a/schema";
import { generateSigningKey, signEnvelope, verifyEnvelopeSig } from "../src/channels/email/a2a/sign";
import { discoveryUrl } from "../src/channels/email/a2a/discovery";
import { nextState, TERMINAL_STATES } from "../src/channels/email/a2a/statemachine";
import { serializeDisclosure, readDisclosedFacts } from "../src/channels/email/a2a/disclosure";
import { renderHumanBody } from "../src/channels/email/a2a/render";
import { parseHumanScheduleReply, needsOwnerReview } from "../src/channels/email/a2a/human-fallback";
import { mintThreadCapability, verifyThreadCapability, extractCapabilityToken } from "../src/channels/email/thread";
import { classifyProtocol, screenOrdinary } from "../src/channels/email/screen";
import { createTestD1 } from "./helpers/d1";

console.log("▶ V3 A2A crypto / protocol / capability tests...");


{
  const a = canonicalize({ b: 1, a: { d: 2, c: 1 } });
  assert.equal(a, '{"a":{"c":1,"d":2},"b":1}');
  assert.equal(canonicalize({ x: [3, 2, 1] }), '{"x":[3,2,1]}');
}


{
  const { publicJwk, privateJwk } = await generateSigningKey("k1");
  const env: never = {
    v: 1, issuer: "openinst.com", kid: "k1",
    fromAgent: "a@mail.openinst.com", toAgent: "b@mail.openinst.com",
    type: "propose", convo: "cv_1", seq: 1, intent: "coordinate.schedule",
    iat: 1789000000, exp: 1789259200, nonce: "n_1", payload: {},
    humanBodySha256: "abc",
  } as never;
  const sig = await signEnvelope(privateJwk, env as never);
  assert.equal(await verifyEnvelopeSig(publicJwk, env as never, sig), true);
  assert.equal(await verifyEnvelopeSig(publicJwk, { ...(env as object), seq: 2 } as never, sig), false);
}


{
  const bad = validateEnvelopeShape({ v: 2 });
  assert.equal(bad.ok, false);
  const good = validateEnvelopeShape({
    v: 1, issuer: "evil.com", kid: "k1", fromAgent: "victim@mail.good.com", toAgent: "b@mail.openinst.com",
    type: "propose", convo: "cv_1", seq: 1, intent: "coordinate.schedule",
    iat: 1, exp: 2, nonce: "n", payload: {}, humanBodySha256: "x",
  });
  assert.equal(good.ok, true);
}


{
  assert.equal(discoveryUrl("1.2.3.4"), null);
  assert.equal(discoveryUrl("[::1]"), null);
  assert.equal(discoveryUrl("openinst.com"), "https://openinst.com/.well-known/openinst-agent");
  assert.equal(discoveryUrl("evil.com/.."), null);
  const badDoc = validateDiscoveryShape({ v: 1, issuer: "x", acceptsA2A: true, mailDomains: [], keys: [] });
  assert.equal(badDoc.ok, false);
}


{
  assert.equal(nextState("proposed", "counter"), "negotiating");
  assert.equal(nextState("proposed", "accept"), "pending_owner_ok");
  assert.equal(nextState("proposed", "confirm"), null);
  assert.equal(nextState("confirmed", "counter"), null);
  assert.ok(TERMINAL_STATES.has("halted"));
}


{
  const out = serializeDisclosure({ timezone: "Asia/Shanghai", exactLat: 31.23, vault: "x", freeBusyWindows: [{ start: "a", end: "b", status: "busy" }] });
  assert.deepEqual(Object.keys(out).sort(), ["freeBusyWindows", "timezone"]);
  const facts = readDisclosedFacts({ convoPayload: { broadCity: "Shanghai" }, allowEventTitle: true, eventTitle: "Secret Title" });
  assert.equal((facts as Record<string, unknown>).eventTitle, undefined);
}


{
  const a = renderHumanBody({ type: "propose", intent: "coordinate.schedule", facts: { timezone: "Asia/Shanghai" }, convo: "cv_1", seq: 1 });
  const b = renderHumanBody({ type: "propose", intent: "coordinate.schedule", facts: { timezone: "Asia/Shanghai" }, convo: "cv_1", seq: 1 });
  assert.equal(a, b);
}


{
  const d1 = createTestD1();
  const env = { DB: d1 } as never;
  const { token } = await mintThreadCapability(env, {
    workspaceId: "w1", threadId: "th_1", peerAddress: "alice@example.com",
    localPart: "agent", domain: "mail.openinst.com",
  });
  assert.equal(token.length, 22, "128-bit → 22 字符 base64url");
  const ok = await verifyThreadCapability(env, token, { workspaceId: "w1", peerAddress: "alice@example.com" });
  assert.equal(ok.ok, true);
  const wrongPeer = await verifyThreadCapability(env, token, { workspaceId: "w1", peerAddress: "eve@evil.com" });
  assert.equal(wrongPeer.ok, false);
  const expired = await verifyThreadCapability(env, token, { workspaceId: "w1", peerAddress: "alice@example.com", nowMs: Date.now() + 40 * 86_400_000 });
  assert.equal(expired.ok, false);
  assert.equal(extractCapabilityToken(`agent+r.${token}@mail.openinst.com`), token);
  assert.equal(extractCapabilityToken("agent@mail.openinst.com"), null);

  assert.equal(extractCapabilityToken(`agent+r.${"A".repeat(180)}.${"B".repeat(40)}@mail.openinst.com`), null);
}


{
  assert.equal(classifyProtocol({}).kind, "ordinary");
  assert.equal(classifyProtocol({ "X-OpenInst-A2A-Envelope": "x" }).kind, "maybe_a2a");
  assert.equal(screenOrdinary({ headers: { "auto-submitted": "auto-replied" }, from: "a@b.com", textLength: 10, contactClass: "unknown" }).action, "store_only");
  assert.equal(screenOrdinary({ headers: {}, from: "a@b.com", textLength: 10, contactClass: "blocked" }).action, "drop");
}


{
  const p = parseHumanScheduleReply("2026-09-12T15:00，UTC+8，可以吗？");
  assert.ok(p.windows && p.windows.length > 0);
  const low = parseHumanScheduleReply("随便聊聊");
  assert.equal(needsOwnerReview(low), true);
}

console.log("✔ A2A crypto/protocol tests passed!");
