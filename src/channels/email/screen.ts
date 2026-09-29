


export type ProtocolKind = "ordinary" | "maybe_a2a" | "maybe_trust" | "valid_a2a";

export interface Classified {
  kind: ProtocolKind;
  a2aHeaders: Record<string, string>;
  trustHeaders?: Record<string, string>;
}

const A2A_HEADER_PREFIX = "x-openinst-a2a-";
const TRUST_HEADER_PREFIX = "x-openinst-trust-";

export function classifyProtocol(headers: Record<string, string>): Classified {
  const a2aHeaders: Record<string, string> = {};
  const trustHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lk = k.toLowerCase();
    if (lk.startsWith(A2A_HEADER_PREFIX)) a2aHeaders[lk] = String(v ?? "");
    if (lk.startsWith(TRUST_HEADER_PREFIX)) trustHeaders[lk] = String(v ?? "");
  }
  if (trustHeaders["x-openinst-trust-envelope"] && trustHeaders["x-openinst-trust-sig"]) {
    return { kind: "maybe_trust", a2aHeaders, trustHeaders };
  }
  if (Object.keys(a2aHeaders).length > 0) return { kind: "maybe_a2a", a2aHeaders, trustHeaders };
  return { kind: "ordinary", a2aHeaders, trustHeaders };
}

export interface OrdinaryScreenDecision {
  action: "process" | "store_only" | "drop";
  reason: string;
}

const AUTO_SUBMITTED_RE = /auto-(generated|replied|submitted)/i;






export function screenOrdinary(opts: {
  headers: Record<string, string>;
  from: string;
  textLength: number;
  contactClass: "unknown" | "known" | "blocked";
}): OrdinaryScreenDecision {
  if (opts.contactClass === "blocked") return { action: "drop", reason: "contact_blocked" };
  const auto = String(opts.headers["auto-submitted"] ?? "");
  if (AUTO_SUBMITTED_RE.test(auto) && auto.toLowerCase() !== "no") {
    return { action: "store_only", reason: "auto_submitted" };
  }
  const precedence = String(opts.headers["precedence"] ?? "").toLowerCase();
  if (precedence === "bulk" || precedence === "junk" || precedence === "list") {
    return { action: "store_only", reason: `precedence_${precedence}` };
  }
  if (!opts.from || opts.from.includes("mailer-daemon") || opts.from.includes("postmaster")) {
    return { action: "store_only", reason: "null_sender_or_daemon" };
  }
  if (opts.textLength <= 0) return { action: "store_only", reason: "empty_body" };
  return { action: "process", reason: "ok" };
}
