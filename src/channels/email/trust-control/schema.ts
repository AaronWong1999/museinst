// channels/email/trust-control/schema.ts — Signed trust-control protocol envelope and types.

export type TrustControlKind =
  | "trust.invite"
  | "trust.accept"
  | "trust.decline"
  | "trust.revoke";

export const TRUST_CONTROL_KINDS: ReadonlySet<TrustControlKind> = new Set([
  "trust.invite",
  "trust.accept",
  "trust.decline",
  "trust.revoke",
]);

export interface TrustControlEnvelope {
  v: 1;
  kind: TrustControlKind;
  issuer: string;
  kid: string;
  fromAgent: string;
  toAgent: string;
  requestId: string;
  iat: number;
  exp: number;
  nonce: string;
  displayName?: string;
  relation?: string;
}

export function isTrustControlKind(val: unknown): val is TrustControlKind {
  return typeof val === "string" && TRUST_CONTROL_KINDS.has(val as TrustControlKind);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validDomain(d: unknown): boolean {
  if (typeof d !== "string") return false;
  let s = d.trim().toLowerCase();
  if (s.startsWith("https://")) s = s.slice(8);
  if (s.startsWith("http://")) s = s.slice(7);
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (!s || s.length > 253) return false;
  if (s.includes("@") || s.includes("/") || s.includes(" ")) return false;
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s);
}

export function normalizeIssuerDomain(d: string): string {
  let s = d.trim().toLowerCase();
  if (s.startsWith("https://")) s = s.slice(8);
  if (s.startsWith("http://")) s = s.slice(7);
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

export function validateTrustControlEnvelope(raw: unknown): { ok: true; envelope: TrustControlEnvelope } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_envelope_shape" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return { ok: false, error: "unsupported_version" };
  if (!isTrustControlKind(obj.kind)) return { ok: false, error: "invalid_kind" };

  const rawIssuer = String(obj.issuer ?? "").trim();
  if (!rawIssuer || rawIssuer.length > 256 || !validDomain(rawIssuer)) return { ok: false, error: "invalid_issuer" };
  const issuer = normalizeIssuerDomain(rawIssuer);

  const kid = String(obj.kid ?? "").trim();
  if (!kid || kid.length > 128) return { ok: false, error: "invalid_kid" };

  const fromAgent = String(obj.fromAgent ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(fromAgent) || fromAgent.length > 256) return { ok: false, error: "invalid_from_agent" };

  const toAgent = String(obj.toAgent ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(toAgent) || toAgent.length > 256) return { ok: false, error: "invalid_to_agent" };

  const requestId = String(obj.requestId ?? "").trim();
  if (!requestId || requestId.length > 128) return { ok: false, error: "invalid_request_id" };

  const nonce = String(obj.nonce ?? "").trim();
  if (!nonce || nonce.length > 128) return { ok: false, error: "invalid_nonce" };

  const iat = Number(obj.iat);
  if (!Number.isFinite(iat) || iat <= 0) return { ok: false, error: "invalid_iat" };

  const exp = Number(obj.exp);
  if (!Number.isFinite(exp) || exp <= 0 || exp <= iat) return { ok: false, error: "invalid_exp" };

  let displayName: string | undefined;
  if (obj.displayName !== undefined) {
    displayName = String(obj.displayName).slice(0, 100);
  }

  let relation: string | undefined;
  if (obj.relation !== undefined) {
    relation = String(obj.relation).slice(0, 50);
  }

  return {
    ok: true,
    envelope: {
      v: 1,
      kind: obj.kind,
      issuer,
      kid,
      fromAgent,
      toAgent,
      requestId,
      iat,
      exp,
      nonce,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(relation !== undefined ? { relation } : {}),
    },
  };
}
