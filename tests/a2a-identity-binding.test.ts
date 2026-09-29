


import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import { verifyA2aInbound, resolveIssuerKey, assertFromAgentDomainBound } from "../src/channels/email/a2a/verify";
import { validateDiscoveryShape } from "../src/channels/email/a2a/schema";
import { storeDiscoveryKeys, fetchDiscovery, DISCOVERY_CACHE_TTL_MS } from "../src/channels/email/a2a/discovery";
import { generateSigningKey, signEnvelope } from "../src/channels/email/a2a/sign";
import { b64urlEncode, sha256HexString } from "../src/channels/email/a2a/codec";
import type { A2aEnvelope } from "../src/channels/email/a2a/schema";

console.log("▶ A2A issuer identity binding (A14 / P2-01)");

const NOW = 1_800_000_000_000;
const WS = "ws_i";
const LOCAL_AGENT = "agent@mail.local.test";
const PEER_ISSUER = "peer.example.net";
const VICTIM = "victim@unrelated.example.org";
const LEGIT = `alice@${PEER_ISSUER}`;

async function makeEnv(overrides: Record<string, unknown> = {}) {
  const d1 = createTestD1();
  d1Exec(d1, `INSERT INTO a2a_domain_consents (workspace_id, issuer, status, confirmed_by, confirmed_at) VALUES (?, ?, 'allowed', 'test', 0)`, WS, PEER_ISSUER);
  d1Exec(
    d1,
    `INSERT INTO trust_edges (id, workspace_id, peer_address, peer_agent, peer_issuer, relation, status, disclosure_json, auto_accept, invited_at)
     VALUES ('te_a', ?, ?, ?, ?, 'assistant', 'active', '{}', 0, 0)`,
    WS,
    LEGIT,
    LEGIT,
    PEER_ISSUER,
  );
  const env: any = { DB: d1, ...overrides };
  return { d1, env };
}

async function signedRequest(opts: {
  privateJwk: JsonWebKey;
  kid: string;
  issuer: string;
  fromAgent: string;
  intent?: string;
  bodyText?: string;
  nowMs?: number;
  toAgent?: string;
}) {
  const body = opts.bodyText ?? `hello ${opts.fromAgent}`;
  const envelope = {
    v: 1,
    issuer: opts.issuer,
    kid: opts.kid,
    fromAgent: opts.fromAgent,
    toAgent: opts.toAgent ?? LOCAL_AGENT,
    type: "propose",
    convo: "cv_id",
    seq: 1,
    intent: opts.intent ?? "coordinate.schedule",
    iat: Math.floor((opts.nowMs ?? NOW) / 1000),
    exp: Math.floor(((opts.nowMs ?? NOW) + 86_400_000) / 1000),
    nonce: "n1",
    payload: {},
    humanBodySha256: await sha256HexString(body),
  } as A2aEnvelope;
  const sig = await signEnvelope(opts.privateJwk, envelope);
  return {
    text: body,
    headers: {
      "X-OpenInst-A2A-Envelope": b64urlEncode(new TextEncoder().encode(JSON.stringify(envelope))),
      "X-OpenInst-A2A-Sig": sig,
      "X-OpenInst-A2A-Kid": opts.kid,
      "X-OpenInst-A2A-Issuer": opts.issuer,
    },
  };
}

async function verify(env: any, req: { headers: Record<string, string>; text: string }, nowMs = NOW) {
  return await verifyA2aInbound(env, {
    headers: req.headers,
    text: req.text,
    recipient: LOCAL_AGENT,
    workspaceId: WS,
    nowMs,
  });
}

const localJwks = (issuer: string, kid: string, x: string, mailDomains: string[]) =>
  JSON.stringify({ issuers: { [issuer]: { mailDomains, keys: { [kid]: { x } } } } });


{
  const peer = await generateSigningKey("peer_k1");
  const { env } = await makeEnv({ A2A_SIGNING_PUBLIC_JWKS_JSON: localJwks(PEER_ISSUER, "peer_k1", peer.publicJwk.x, [PEER_ISSUER]) });
  const bad = await verify(env, await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: VICTIM }));
  assert.equal(bad.ok, false);
  assert.equal((bad as any).error, "from_domain_not_bound");
  const good = await verify(env, await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT }));
  assert.equal(good.ok, true);
  assert.equal((good as any).keySource, "local", "local config 分支必须被使用");
  console.log("  ✅ local config 分支：跨域冒充拒绝 / 合法域通过");
}


{
  const peer = await generateSigningKey("peer_k1");
  const { d1, env } = await makeEnv();
  await storeDiscoveryKeys(
    env,
    { v: 1, issuer: PEER_ISSUER, acceptsA2A: true, mailDomains: [PEER_ISSUER], keys: [{ kid: "peer_k1", publicKey: { kty: "OKP", crv: "Ed25519", x: peer.publicJwk.x }, notBefore: 0, notAfter: 2_000_000_000 }] },
    NOW,
  );
  const facts = await d1Get<any>(d1, `SELECT * FROM a2a_discovery_issuers WHERE issuer=?`, PEER_ISSUER);
  assert.equal(facts.mail_domains_json, JSON.stringify([PEER_ISSUER]), "缓存必须保存完整 mailDomains");
  const bad = await verify(env, await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: VICTIM }));
  assert.equal(bad.ok, false);
  assert.equal((bad as any).error, "from_domain_not_bound");
  const good = await verify(env, await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT }));
  assert.equal(good.ok, true);
  assert.equal((good as any).keySource, "cache", "必须命中 D1 热缓存分支");
  console.log("  ✅ D1 热缓存分支：跨域冒充拒绝 / 合法域通过");
}


{
  const peer = await generateSigningKey("peer_k1");
  const { d1, env } = await makeEnv();
  let fetched = 0;
  const fakeFetch = (async () => {
    fetched++;
    return new Response(
      JSON.stringify({
        v: 1,
        issuer: PEER_ISSUER,
        acceptsA2A: true,
        mailDomains: [PEER_ISSUER],
        keys: [{ kid: "peer_k1", publicKey: { kty: "OKP", crv: "Ed25519", x: peer.publicJwk.x }, notBefore: 0, notAfter: 2_000_000_000 }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const bad = await verifyA2aInbound(env, {
    ...(await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: VICTIM })),
    recipient: LOCAL_AGENT,
    workspaceId: WS,
    nowMs: NOW,
    fetchFn: fakeFetch,
  });
  assert.equal(bad.ok, false);
  assert.equal((bad as any).error, "from_domain_not_bound");
  assert.equal(fetched, 1);
  const good = await verifyA2aInbound(env, {
    ...(await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT })),
    recipient: LOCAL_AGENT,
    workspaceId: WS,
    nowMs: NOW,
    fetchFn: fakeFetch,
  });
  assert.equal(good.ok, true);
  assert.equal((good as any).keySource, "cache", "第二次必须命中已写入的完整事实缓存");
  assert.equal(fetched, 1, "已写入完整事实后不得重复 fetch");
  const facts = await d1Get<any>(d1, `SELECT * FROM a2a_discovery_issuers WHERE issuer=?`, PEER_ISSUER);
  assert.ok(facts && facts.cache_expires_at > NOW);
  console.log("  ✅ fresh fetch 分支：跨域冒充拒绝 / 合法域通过并落缓存");
}


{
  const peer = await generateSigningKey("peer_k1");
  const { env } = await makeEnv();
  d1Exec((env as any).DB, `INSERT INTO a2a_domain_keys (issuer, kid, public_key, not_before, not_after, fetched_at, cache_expires_at) VALUES (?, 'peer_k1', ?, 0, 2000000000, ?, ?)`, PEER_ISSUER, peer.publicJwk.x, NOW, NOW + DISCOVERY_CACHE_TTL_MS);
  let fetched = 0;
  const failingFetch = (async () => {
    fetched++;
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const r = await verifyA2aInbound(env, {
    ...(await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT })),
    recipient: LOCAL_AGENT,
    workspaceId: WS,
    nowMs: NOW,
    fetchFn: failingFetch,
  });
  assert.equal(r.ok, false, "没有域约束的旧缓存不得直接用于验签");
  assert.equal(fetched, 1, "必须重取 discovery");
  console.log("  ✅ 缺失 mailDomains 的旧缓存失效并重取（重取失败则拒绝）");
}


{
  const other = await generateSigningKey("other_k1");
  const otherIssuer = "other.example.net";
  const { env, d1 } = await makeEnv({ A2A_SIGNING_PUBLIC_JWKS_JSON: localJwks(otherIssuer, "other_k1", other.publicJwk.x, [otherIssuer]) });


  d1Exec(d1, `INSERT INTO a2a_domain_consents (workspace_id, issuer, status, confirmed_by, confirmed_at) VALUES (?, ?, 'allowed', 'test', 0)`, WS, otherIssuer);
  d1Exec(
    d1,
    `INSERT INTO trust_edges (id, workspace_id, peer_address, peer_agent, peer_issuer, relation, status, disclosure_json, auto_accept, invited_at)
     VALUES ('te_other', ?, ?, ?, ?, 'assistant', 'active', '{}', 0, 0)`,
    WS,
    "alice@other.example.net",
    "alice@other.example.net",
    otherIssuer,
  );

  const bad = await verify(env, await signedRequest({ privateJwk: other.privateJwk, kid: "other_k1", issuer: otherIssuer, fromAgent: LEGIT }));
  assert.equal(bad.ok, false);
  assert.equal((bad as any).error, "from_domain_not_bound");

  const { env: env2, d1: d12 } = await makeEnv({
    A2A_SIGNING_PUBLIC_JWKS_JSON: localJwks("third.example.net", "third_k1", "x", ["peer.example.net"]),
  });
  const third = await generateSigningKey("third_k1");
  d1Exec(d12, `UPDATE a2a_domain_consents SET status='allowed' WHERE workspace_id=?`, WS);
  d1Exec(d12, `INSERT OR REPLACE INTO a2a_domain_consents (workspace_id, issuer, status, confirmed_by, confirmed_at) VALUES (?, 'third.example.net', 'allowed', 'test', 0)`, WS);
  (env2 as any).A2A_SIGNING_PUBLIC_JWKS_JSON = localJwks("third.example.net", "third_k1", third.publicJwk.x, ["peer.example.net"]);
  const mismatch = await verify(env2, await signedRequest({ privateJwk: third.privateJwk, kid: "third_k1", issuer: "third.example.net", fromAgent: LEGIT }));
  assert.equal(mismatch.ok, false);
  assert.equal((mismatch as any).error, "trust_edge_issuer_mismatch");
  console.log("  ✅ 不同 issuer 不能复用同地址 trust edge");
}


{
  const peer = await generateSigningKey("peer_k1");
  const expiredKeyEnv = { DB: (await makeEnv()).env.DB, A2A_SIGNING_PUBLIC_JWKS_JSON: JSON.stringify({ issuers: { [PEER_ISSUER]: { mailDomains: [PEER_ISSUER], keys: { peer_k1: { x: peer.publicJwk.x, notAfter: 1 } } } } }) };
  const exp = await verify(expiredKeyEnv, await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT }));
  assert.equal((exp as any).error, "key_expired");

  const { env: goodEnv } = await makeEnv({ A2A_SIGNING_PUBLIC_JWKS_JSON: localJwks(PEER_ISSUER, "peer_k1", peer.publicJwk.x, [PEER_ISSUER]) });
  const toOther = await verify(goodEnv, await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT, toAgent: "someone-else@mail.local.test" }));
  assert.equal((toOther as any).error, "to_mismatch");

  const tampered = await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT });
  const forged = { ...tampered, text: tampered.text + "tampered" };
  const badBody = await verify(goodEnv, forged);
  assert.equal((badBody as any).error, "body_tamper");
  const badSig = await verify(goodEnv, { headers: { ...tampered.headers, "X-OpenInst-A2A-Sig": "AAAA" }, text: tampered.text });
  assert.equal((badSig as any).error, "bad_sig");
  const unknownKid = await verifyA2aInbound(goodEnv, {
    ...(await signedRequest({ privateJwk: peer.privateJwk, kid: "nope", issuer: PEER_ISSUER, fromAgent: LEGIT })),
    recipient: LOCAL_AGENT,
    workspaceId: WS,
    nowMs: NOW,
    fetchFn: (async () =>
      new Response(
        JSON.stringify({
          v: 1,
          issuer: PEER_ISSUER,
          acceptsA2A: true,
          mailDomains: [PEER_ISSUER],
          keys: [{ kid: "peer_k1", publicKey: { kty: "OKP", crv: "Ed25519", x: peer.publicJwk.x }, notBefore: 0, notAfter: 2_000_000_000 }],
        }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  });
  assert.equal((unknownKid as any).error, "unknown_kid");
  console.log("  ✅ 过期 key / 目标不匹配 / 篡改 / 未知 kid 全部拒绝");
}


{
  const peer = await generateSigningKey("peer_k1");
  const { env } = await makeEnv({ A2A_SIGNING_PUBLIC_JWKS_JSON: localJwks(PEER_ISSUER, "peer_k1", peer.publicJwk.x, [PEER_ISSUER]) });
  const unsupported = await verify(env, await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT, intent: "transfer.money" }));
  assert.equal((unsupported as any).ok, false);
  assert.equal((unsupported as any).error, "unsupported_intent");
  assert.equal((unsupported as any).schemaError, true, "验签通过后才允许 schemaError 分类");

  const forged = await signedRequest({ privateJwk: await generateSigningKey("x").then((k) => k.privateJwk), kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT, intent: "transfer.money" });
  const badSig = await verify(env, forged);
  assert.equal((badSig as any).schemaError, undefined);
  assert.equal((badSig as any).error, "bad_sig");
  console.log("  ✅ schemaError 只在验签通过后出现");
}


{
  const peer = await generateSigningKey("peer_k1");
  const { env } = await makeEnv({ A2A_SIGNING_PUBLIC_JWKS_JSON: localJwks(PEER_ISSUER, "peer_k1", peer.publicJwk.x, []) });
  const r = await verify(env, await signedRequest({ privateJwk: peer.privateJwk, kid: "peer_k1", issuer: PEER_ISSUER, fromAgent: LEGIT }));
  assert.equal((r as any).error, "local_key_missing_mail_domains");
  const resolved = await resolveIssuerKey(env, { issuer: PEER_ISSUER, kid: "peer_k1", nowMs: NOW });
  assert.equal(resolved.ok, false);
  console.log("  ✅ local config 缺 mailDomains → fail closed");
}


{
  assert.equal(assertFromAgentDomainBound({ issuer: "x", mailDomains: ["Peer.Example.NET"] }, "a@peer.example.net").ok, true);
  assert.equal(assertFromAgentDomainBound({ issuer: "x", mailDomains: ["peer.example.net"] }, "a@sub.peer.example.net").ok, false);
  assert.equal(assertFromAgentDomainBound({ issuer: "x", mailDomains: ["peer.example.net"] }, "a@notpeer.example.net").ok, false);
  assert.equal(assertFromAgentDomainBound({ issuer: "x", mailDomains: [] }, "a@peer.example.net").error, "issuer_mail_domains_missing");
  console.log("  ✅ 域绑定：精确匹配、拒绝子域伪装");
}


{
  const disabled = { v: 1, issuer: "openinst.com", acceptsA2A: false, mailDomains: [], keys: [] };
  const shaped = validateDiscoveryShape(disabled);
  assert.equal(shaped.ok, true, "acceptsA2A=false 的空 keys discovery 必须通过");
  assert.equal(validateDiscoveryShape({ ...disabled, acceptsA2A: true }).ok, false);
  assert.equal(validateDiscoveryShape({ v: 1, issuer: "x", acceptsA2A: true, mailDomains: ["x.com"], keys: [] }).error, "no_keys");

  const fakeFetch = (async () =>
    new Response(JSON.stringify(disabled), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const doc = await fetchDiscovery("openinst.com", fakeFetch);
  assert.equal(doc.ok, true);
  assert.equal(doc.doc?.acceptsA2A, false);
  assert.equal(doc.doc?.keys.length, 0);
  console.log("  ✅ P2-01 disabled discovery 通过自身 validator");
}

console.log("✔ A2A issuer identity binding tests passed!");
