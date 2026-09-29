




//


import type { Env } from "../../../env";
import { validateEnvelopeShape, type A2aEnvelope } from "./schema";
import { verifyEnvelopeSig } from "./sign";
import { fetchDiscovery, getCachedIssuerKey, storeDiscoveryKeys, discoveryUrl } from "./discovery";
import { sha256HexString } from "./codec";

export const CLOCK_SKEW_MS = 5 * 60_000;


export type A2aKeySource = "local" | "cache" | "fetch";


export interface ResolvedIssuerKey {
  issuer: string;
  kid: string;
  jwk: JsonWebKey;
  mailDomains: string[];
  acceptsA2A: boolean;
  notBefore: number | null;
  notAfter: number | null;
  source: A2aKeySource;
}





export interface VerifiedA2A {
  envelope: A2aEnvelope;

  issuer: string;
  kid: string;

  peerAddress: string;
  protocolConvoId: string;

  recipient: string;
  keySource: A2aKeySource;
  issuerMailDomains: string[];
  verifiedAt: number;
}

export interface VerifyOk extends VerifiedA2A {
  ok: true;
}

export interface VerifyFail {
  ok: false;
  error: string;

  schemaError?: boolean;
}

function domainOf(addr: string): string {
  return String(addr ?? "").split("@")[1]?.toLowerCase() ?? "";
}

export function assertFromAgentDomainBound(
  issuerMetadata: { issuer: string; mailDomains: string[] },
  fromAgent: string,
): { ok: boolean; error?: string } {
  const fromDomain = domainOf(fromAgent);
  if (!fromDomain) return { ok: false, error: "bad_from" };
  const domains = (issuerMetadata.mailDomains ?? []).map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean);
  if (domains.length === 0) return { ok: false, error: "issuer_mail_domains_missing" };
  if (!domains.includes(fromDomain)) return { ok: false, error: "from_domain_not_bound" };
  return { ok: true };
}

function parseA2aHeaders(headers: Record<string, string>): { envelopeB64?: string; sigB64?: string; kid?: string; issuer?: string } {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = String(v ?? "");
  return {
    envelopeB64: h["x-openinst-a2a-envelope"],
    sigB64: h["x-openinst-a2a-sig"],
    kid: h["x-openinst-a2a-kid"],
    issuer: h["x-openinst-a2a-issuer"],
  };
}

interface LocalKeyEntry {
  jwk: JsonWebKey;
  notBefore: number | null;
  notAfter: number | null;
  mailDomains: string[];
  acceptsA2A: boolean;
}


function parseLocalKeySet(env: Env): { keys: Map<string, LocalKeyEntry>; error?: string } {
  const out = new Map<string, LocalKeyEntry>();
  const raw = (env as { A2A_SIGNING_PUBLIC_JWKS_JSON?: string }).A2A_SIGNING_PUBLIC_JWKS_JSON;
  if (!raw) return { keys: out };
  let parsed: { issuers?: Record<string, { mailDomains?: string[]; acceptsA2A?: boolean; keys?: Record<string, { x: string; notBefore?: number; notAfter?: number }> }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { keys: out, error: "local_key_config_invalid_json" };
  }
  for (const [issuer, entry] of Object.entries(parsed.issuers ?? {})) {
    const domains = (entry.mailDomains ?? []).map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean);
    for (const [kid, k] of Object.entries(entry.keys ?? {})) {
      if (!k?.x) continue;
      out.set(`${issuer.toLowerCase()}|${kid}`, {
        jwk: { kty: "OKP", crv: "Ed25519", x: k.x, ext: true, key_ops: ["verify"] },
        notBefore: k.notBefore ?? null,
        notAfter: k.notAfter ?? null,
        mailDomains: domains,
        acceptsA2A: entry.acceptsA2A !== false,
      });
    }
  }
  return { keys: out };
}







export async function resolveIssuerKey(
  env: Env,
  opts: { issuer: string; kid: string; nowMs?: number; fetchFn?: typeof fetch },
): Promise<{ ok: true; key: ResolvedIssuerKey } | { ok: false; error: string }> {
  const issuer = String(opts.issuer ?? "").trim().toLowerCase();
  const kid = String(opts.kid ?? "").trim();
  const nowMs = opts.nowMs ?? Date.now();
  if (!issuer || !kid) return { ok: false, error: "bad_issuer" };
  if (!discoveryUrl(issuer)) return { ok: false, error: "bad_issuer" };

  const local = parseLocalKeySet(env);
  if (local.error) return { ok: false, error: local.error };
  const localHit = local.keys.get(`${issuer}|${kid}`);
  if (localHit) {
    if (localHit.mailDomains.length === 0) return { ok: false, error: "local_key_missing_mail_domains" };
    return {
      ok: true,
      key: {
        issuer,
        kid,
        jwk: localHit.jwk,
        mailDomains: localHit.mailDomains,
        acceptsA2A: localHit.acceptsA2A,
        notBefore: localHit.notBefore,
        notAfter: localHit.notAfter,
        source: "local",
      },
    };
  }

  const cached = await getCachedIssuerKey(env, issuer, kid, nowMs);
  if (cached) {
    return {
      ok: true,
      key: {
        issuer,
        kid,
        jwk: cached.jwk,
        mailDomains: cached.facts.mailDomains,
        acceptsA2A: cached.facts.acceptsA2A,
        notBefore: cached.notBefore,
        notAfter: cached.notAfter,
        source: "cache",
      },
    };
  }

  const fetched = await fetchDiscovery(issuer, opts.fetchFn ?? fetch);
  if (!fetched.ok || !fetched.doc) return { ok: false, error: fetched.error ?? "discovery_failed" };

  await storeDiscoveryKeys(env, fetched.doc, nowMs).catch(() => undefined);
  const fromDoc = fetched.doc.keys.find((k) => k.kid === kid);
  if (!fromDoc) return { ok: false, error: "unknown_kid" };
  const { jwkFromX } = await import("./sign");
  return {
    ok: true,
    key: {
      issuer,
      kid,
      jwk: jwkFromX(fromDoc.publicKey.x),
      mailDomains: (fetched.doc.mailDomains ?? []).map((d) => String(d).toLowerCase()),
      acceptsA2A: fetched.doc.acceptsA2A === true,
      notBefore: fromDoc.notBefore ?? null,
      notAfter: fromDoc.notAfter ?? null,
      source: "fetch",
    },
  };
}

export async function verifyA2aInbound(
  env: Env,
  opts: { headers: Record<string, string>; text: string; recipient: string; workspaceId: string; nowMs?: number; fetchFn?: typeof fetch },
): Promise<VerifyOk | VerifyFail> {
  const nowMs = opts.nowMs ?? Date.now();
  const parts = parseA2aHeaders(opts.headers);
  if (!parts.envelopeB64 || !parts.sigB64) return { ok: false, error: "missing_a2a_headers" };
  let envelopeRaw: unknown;
  try {
    const bin = Uint8Array.from(atob(parts.envelopeB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    envelopeRaw = JSON.parse(new TextDecoder().decode(bin));
  } catch {
    return { ok: false, error: "bad_envelope_encoding" };
  }
  const shaped = validateEnvelopeShape(envelopeRaw);
  if (!shaped.ok || !shaped.envelope) {

    return { ok: false, error: shaped.error ?? "bad_envelope" };
  }
  const envelope = shaped.envelope;
  const headerIssuer = String(parts.issuer ?? "").toLowerCase();
  if (!headerIssuer || headerIssuer !== envelope.issuer.toLowerCase()) return { ok: false, error: "issuer_header_mismatch" };
  if (!discoveryUrl(envelope.issuer)) return { ok: false, error: "bad_issuer" };
  const recipient = canonicalRecipient(opts.recipient);
  if (envelope.toAgent.toLowerCase() !== recipient) {
    return { ok: false, error: "to_mismatch" };
  }
  if (envelope.iat * 1000 > nowMs + CLOCK_SKEW_MS) return { ok: false, error: "iat_future" };
  if (envelope.exp * 1000 <= nowMs) return { ok: false, error: "expired" };

  const bodyDigest = await sha256HexString(opts.text ?? "");
  if (bodyDigest !== envelope.humanBodySha256) return { ok: false, error: "body_tamper" };


  let resolved: { ok: true; key: ResolvedIssuerKey } | { ok: false; error: string };
  try {
    resolved = await resolveIssuerKey(env, { issuer: envelope.issuer, kid: envelope.kid, nowMs, fetchFn: opts.fetchFn });
  } catch (e) {
    return { ok: false, error: `key_lookup_error:${String(e).slice(0, 60)}` };
  }
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const key = resolved.key;
  if (!key.acceptsA2A) return { ok: false, error: "issuer_not_accepting" };
  if (key.notBefore && nowMs / 1000 < key.notBefore) return { ok: false, error: "key_not_yet_valid" };
  if (key.notAfter && nowMs / 1000 > key.notAfter) return { ok: false, error: "key_expired" };


  const bound = assertFromAgentDomainBound(key, envelope.fromAgent);
  if (!bound.ok) return { ok: false, error: bound.error ?? "from_domain_not_bound" };

  const sigOk = await verifyEnvelopeSig(key.jwk, envelope, parts.sigB64).catch(() => false);
  if (!sigOk) return { ok: false, error: "bad_sig" };


  if (envelope.intent !== "coordinate.schedule") {
    return { ok: false, error: "unsupported_intent", schemaError: true };
  }


  const consent = await env.DB.prepare(`SELECT status FROM a2a_domain_consents WHERE workspace_id=? AND issuer=?`)
    .bind(opts.workspaceId, key.issuer)
    .first<{ status: string }>();
  if (!consent || consent.status !== "allowed") return { ok: false, error: "domain_consent_required" };

  const peerAddress = envelope.fromAgent.toLowerCase();
  const edge = await env.DB.prepare(`SELECT status, peer_agent, peer_issuer FROM trust_edges WHERE workspace_id=? AND peer_address=?`)
    .bind(opts.workspaceId, peerAddress)
    .first<{ status: string; peer_agent: string | null; peer_issuer: string | null }>();
  if (!edge || edge.status !== "active") return { ok: false, error: "no_active_trust_edge" };

  const edgeIssuer = String(edge.peer_issuer ?? "").trim().toLowerCase();
  if (!edgeIssuer) return { ok: false, error: "trust_edge_issuer_missing" };
  if (edgeIssuer !== key.issuer) return { ok: false, error: "trust_edge_issuer_mismatch" };
  const edgeAgent = String(edge.peer_agent ?? "").trim().toLowerCase();
  if (edgeAgent && edgeAgent !== peerAddress) return { ok: false, error: "trust_edge_agent_mismatch" };

  return {
    ok: true,
    envelope,
    issuer: key.issuer,
    kid: envelope.kid,
    peerAddress,
    protocolConvoId: envelope.convo,
    recipient,
    keySource: key.source,
    issuerMailDomains: key.mailDomains,
    verifiedAt: nowMs,
  };
}

function canonicalRecipient(recipient: string): string {
  const addr = String(recipient ?? "").trim().toLowerCase();
  const [local, domain] = addr.split("@");
  const bare = String(local ?? "").split("+")[0];
  return `${bare}@${domain ?? ""}`;
}
