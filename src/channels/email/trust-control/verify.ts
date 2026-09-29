// channels/email/trust-control/verify.ts — Inbound signed trust-control verification.

import type { Env } from "../../../env";
import { validateTrustControlEnvelope, type TrustControlEnvelope } from "./schema";
import { verifyTrustControlEnvelopeSig } from "./sign";
import { canonicalize } from "./canonical";
import { resolveIssuerKey, assertFromAgentDomainBound, CLOCK_SKEW_MS } from "../a2a/verify";
import { b64urlDecode, sha256HexString } from "../a2a/codec";

export interface VerifiedTrustControl {
  ok: true;
  envelope: TrustControlEnvelope;
  issuer: string;
  kid: string;
  peerAddress: string;
  recipient: string;
  keySource: string;
  issuerMailDomains: string[];
  envelopeSha256: string;
  verifiedAt: number;
}

export interface VerifyTrustControlFail {
  ok: false;
  error: string;
}

export type VerifyTrustControlResult = VerifiedTrustControl | VerifyTrustControlFail;


export async function trustControlEnvelopeSha256(envelope: TrustControlEnvelope): Promise<string> {
  return sha256HexString(canonicalize(envelope));
}

export function parseTrustControlHeaders(headers: Record<string, string>): {
  envelopeB64?: string;
  sigB64?: string;
  kid?: string;
  issuer?: string;
} {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    h[k.toLowerCase()] = String(v ?? "");
  }
  return {
    envelopeB64: h["x-openinst-trust-envelope"],
    sigB64: h["x-openinst-trust-sig"],
    kid: h["x-openinst-trust-kid"],
    issuer: h["x-openinst-trust-issuer"],
  };
}

export function isMaybeTrustControl(headers: Record<string, string>): boolean {
  const parsed = parseTrustControlHeaders(headers);
  return Boolean(parsed.envelopeB64 && parsed.sigB64);
}

export async function verifyTrustControl(
  env: Env,
  opts: {
    headers: Record<string, string>;
    recipient: string;
    workspaceId: string;
    nowMs?: number;
    fetchFn?: typeof fetch;
  },
): Promise<VerifyTrustControlResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const parsedHeaders = parseTrustControlHeaders(opts.headers);

  // All four protocol headers are part of the transport binding. Accepting a missing issuer/kid
  // makes the signed envelope and the MIME protocol metadata disagree silently.
  if (!parsedHeaders.envelopeB64 || !parsedHeaders.sigB64 || !parsedHeaders.issuer || !parsedHeaders.kid) {
    return { ok: false, error: "missing_trust_headers" };
  }

  let rawEnvelope: unknown;
  try {
    const bytes = b64urlDecode(parsedHeaders.envelopeB64);
    const json = new TextDecoder().decode(bytes);
    rawEnvelope = JSON.parse(json);
  } catch {
    return { ok: false, error: "invalid_envelope_json" };
  }

  const validated = validateTrustControlEnvelope(rawEnvelope);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const envelope = validated.envelope;

  const headerIssuer = parsedHeaders.issuer.trim().toLowerCase();
  if (headerIssuer !== envelope.issuer.toLowerCase()) {
    return { ok: false, error: "issuer_mismatch" };
  }

  const headerKid = parsedHeaders.kid.trim();
  if (headerKid !== envelope.kid) {
    return { ok: false, error: "kid_mismatch" };
  }

  const recipient = opts.recipient.trim().toLowerCase();
  if (!recipient || envelope.toAgent.toLowerCase() !== recipient) {
    return { ok: false, error: "to_agent_mismatch" };
  }

  const nowSec = Math.floor(nowMs / 1000);
  const skewSec = Math.floor(CLOCK_SKEW_MS / 1000);

  if (envelope.iat > nowSec + skewSec) {
    return { ok: false, error: "iat_in_future" };
  }
  if (envelope.exp < nowSec - skewSec) {
    return { ok: false, error: "expired" };
  }

  const resolved = await resolveIssuerKey(env, {
    issuer: envelope.issuer,
    kid: envelope.kid,
    nowMs,
    fetchFn: opts.fetchFn,
  });
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  const key = resolved.key;

  if (key.notBefore && nowMs / 1000 < key.notBefore) {
    return { ok: false, error: "key_not_yet_valid" };
  }
  if (key.notAfter && nowMs / 1000 > key.notAfter) {
    return { ok: false, error: "key_expired" };
  }

  const boundCheck = assertFromAgentDomainBound(key, envelope.fromAgent);
  if (!boundCheck.ok) {
    return { ok: false, error: boundCheck.error ?? "from_agent_domain_not_bound" };
  }

  const sigOk = await verifyTrustControlEnvelopeSig(key.jwk, envelope, parsedHeaders.sigB64);
  if (!sigOk) {
    return { ok: false, error: "invalid_signature" };
  }

  const envelopeSha256 = await sha256HexString(canonicalize(envelope));

  return {
    ok: true,
    envelope,
    issuer: key.issuer,
    kid: envelope.kid,
    peerAddress: envelope.fromAgent,
    recipient: envelope.toAgent,
    keySource: key.source,
    issuerMailDomains: key.mailDomains,
    envelopeSha256,
    verifiedAt: nowMs,
  };
}
