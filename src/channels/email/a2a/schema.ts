

export const A2A_PROTOCOL_VERSION = 1;

export type A2aMessageType =
  | "propose"
  | "counter"
  | "accept"
  | "decline"
  | "cancel"
  | "confirm"
  | "error";

export type A2aIntent = "coordinate.schedule";

export interface A2aEnvelope {
  v: 1;
  issuer: string;
  kid: string;
  fromAgent: string;
  toAgent: string;
  type: A2aMessageType;
  convo: string;
  seq: number;
  intent: A2aIntent;
  iat: number;
  exp: number;
  nonce: string;
  payload: Record<string, unknown>;
  humanBodySha256: string;
  sig?: string;
}

export interface A2aDiscoveryDoc {
  v: 1;
  issuer: string;
  acceptsA2A: boolean;
  mailDomains: string[];
  keys: Array<{
    kid: string;
    publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
    notBefore: number;
    notAfter: number;
  }>;
}






export function validateEnvelopeShape(e: unknown): { ok: boolean; error?: string; envelope?: A2aEnvelope } {
  const v = e as Partial<A2aEnvelope>;
  if (!v || typeof v !== "object") return { ok: false, error: "not_object" };
  if (v.v !== 1) return { ok: false, error: "bad_version" };
  const types: A2aMessageType[] = ["propose", "counter", "accept", "decline", "cancel", "confirm", "error"];
  if (!v.type || !types.includes(v.type)) return { ok: false, error: "bad_type" };
  if (!v.issuer || typeof v.issuer !== "string") return { ok: false, error: "bad_issuer" };
  if (!v.kid || typeof v.kid !== "string") return { ok: false, error: "bad_kid" };
  if (!v.fromAgent || typeof v.fromAgent !== "string" || !v.fromAgent.includes("@")) return { ok: false, error: "bad_from" };
  if (!v.toAgent || typeof v.toAgent !== "string" || !v.toAgent.includes("@")) return { ok: false, error: "bad_to" };
  if (!v.convo || typeof v.convo !== "string") return { ok: false, error: "bad_convo" };
  if (!Number.isInteger(v.seq) || (v.seq as number) < 1) return { ok: false, error: "bad_seq" };
  if (!v.intent || typeof v.intent !== "string") return { ok: false, error: "bad_intent" };
  if (!Number.isInteger(v.iat) || !Number.isInteger(v.exp) || (v.exp as number) <= (v.iat as number)) {
    return { ok: false, error: "bad_time" };
  }
  if (!v.nonce || typeof v.nonce !== "string") return { ok: false, error: "bad_nonce" };
  if (!v.payload || typeof v.payload !== "object") return { ok: false, error: "bad_payload" };
  if (!v.humanBodySha256 || typeof v.humanBodySha256 !== "string") return { ok: false, error: "bad_body_digest" };
  return { ok: true, envelope: v as A2aEnvelope };
}

function validDomain(d: unknown): boolean {
  if (typeof d !== "string") return false;
  const s = d.trim().toLowerCase();
  if (!s || s.length > 253) return false;
  if (s.includes("@") || s.includes("/") || s.includes(" ")) return false;
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s);
}






export function validateDiscoveryShape(d: unknown): { ok: boolean; error?: string; doc?: A2aDiscoveryDoc } {
  const v = d as Partial<A2aDiscoveryDoc>;
  if (!v || typeof v !== "object") return { ok: false, error: "not_object" };
  if (v.v !== 1) return { ok: false, error: "bad_version" };
  if (!v.issuer || typeof v.issuer !== "string") return { ok: false, error: "bad_issuer" };
  if (typeof v.acceptsA2A !== "boolean") return { ok: false, error: "bad_accepts" };
  if (!Array.isArray(v.mailDomains)) return { ok: false, error: "bad_mail_domains" };
  if (!Array.isArray(v.keys)) return { ok: false, error: "no_keys" };
  if (v.acceptsA2A) {
    if (v.mailDomains.length === 0 || !v.mailDomains.every(validDomain)) return { ok: false, error: "bad_mail_domains" };
    if (v.keys.length === 0) return { ok: false, error: "no_keys" };
  }
  const kids = new Set<string>();
  for (const k of v.keys) {
    if (!k?.kid || typeof k.kid !== "string") return { ok: false, error: "bad_key" };
    if (kids.has(k.kid)) return { ok: false, error: "duplicate_kid" };
    kids.add(k.kid);
    if (k.publicKey?.kty !== "OKP" || k.publicKey?.crv !== "Ed25519" || !k.publicKey?.x) {
      return { ok: false, error: "bad_key" };
    }
    if (typeof k.publicKey.x !== "string" || k.publicKey.x.length < 40 || k.publicKey.x.length > 64) {
      return { ok: false, error: "bad_key" };
    }
  }
  return { ok: true, doc: v as A2aDiscoveryDoc };
}
