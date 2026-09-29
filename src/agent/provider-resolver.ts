
//







//


//




export type KnownProvider = "google" | "lark" | "feishu" | "github" | "mailbox" | "web" | "browser" | "local";

export interface ProviderResolutionInput {

  explicitProvider?: string;

  resourceRef?: string;

  sessionAffinity?: string;

  userDefault?: string;

  connectedCapableProviders: string[];

  accountLabel?: string;
}

export type ProviderResolution =
  | { ok: true; provider: string }
  | { ok: false; error: "provider_ambiguous"; choices: string[] }
  | { ok: false; error: "provider_unavailable"; choices: string[] };

function normalizeProvider(p: string): string {
  return p.trim().toLowerCase();
}


export function providerFromResourceRef(ref: string): string | null {
  const r = ref.toLowerCase();
  if (/github\.com|^github:|^gh:|[0-9a-f]{40}/.test(r) && r.includes("github")) return "github";
  if (/docs\.google\.com|drive\.google\.com|sheets\.google|slides\.google|calendar\.google/.test(r)) return "google";
  if (/feishu\.cn|open\.feishu/.test(r)) return "feishu";
  if (/lark\.suite|open\.larksuite|larksuite\.com/.test(r)) return "lark";
  return null;
}

export function resolveProvider(input: ProviderResolutionInput): ProviderResolution {
  const connected = [...new Set(input.connectedCapableProviders.map(normalizeProvider).filter(Boolean))];
  const available = (provider: string): ProviderResolution => {
    const p = normalizeProvider(provider);
    return connected.includes(p)
      ? { ok: true, provider: p }
      : { ok: false, error: "provider_unavailable", choices: connected };
  };

  // Product support / model choice is never authorization: even an explicit provider must be in
  // the authoritative connected-capable set for this capability.
  if (input.explicitProvider) return available(input.explicitProvider);

  if (input.resourceRef) {
    const owned = providerFromResourceRef(input.resourceRef);
    if (owned) return available(owned);
  }

  if (input.sessionAffinity && normalizeProvider(input.sessionAffinity)) {
    const affinity = normalizeProvider(input.sessionAffinity);
    if (connected.includes(affinity)) return { ok: true, provider: affinity };
  }

  if (input.userDefault && normalizeProvider(input.userDefault)) {
    const def = normalizeProvider(input.userDefault);
    if (connected.includes(def)) return { ok: true, provider: def };
  }

  if (connected.length === 1) return { ok: true, provider: connected[0] };
  if (connected.length === 0) return { ok: false, error: "provider_unavailable", choices: [] };
  return { ok: false, error: "provider_ambiguous", choices: connected };
}


export const LARK_FEISHU_FAMILY = "lark_feishu";

export function familyOf(provider: string): string {
  const p = normalizeProvider(provider);
  if (p === "lark" || p === "feishu") return LARK_FEISHU_FAMILY;
  return p;
}
