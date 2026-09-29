
//




import type { Env } from "../../../env";
import { validateDiscoveryShape, type A2aDiscoveryDoc } from "./schema";
import { jwkFromX } from "./sign";

export const DISCOVERY_TIMEOUT_MS = 5000;
export const DISCOVERY_MAX_BYTES = 32 * 1024;
export const DISCOVERY_CACHE_TTL_MS = 60 * 60_000;

export function discoveryUrl(issuer: string): string | null {
  const host = String(issuer ?? "").trim().toLowerCase();
  if (!host || host.length > 253) return null;
  if (/^\[.*\]$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  return `https://${host}/.well-known/openinst-agent`;
}

export async function fetchDiscovery(issuer: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; doc?: A2aDiscoveryDoc; error?: string }> {
  const url = discoveryUrl(issuer);
  if (!url) return { ok: false, error: "bad_issuer" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { redirect: "manual", signal: ctrl.signal, headers: { accept: "application/json" } });
    if (res.status >= 300 && res.status < 400) return { ok: false, error: "redirect_not_allowed" };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!/application\/json/i.test(ct)) return { ok: false, error: "bad_content_type" };
    const text = await res.text();
    if (text.length > DISCOVERY_MAX_BYTES) return { ok: false, error: "too_large" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "bad_json" };
    }
    const v = validateDiscoveryShape(parsed);
    if (!v.ok || !v.doc) return { ok: false, error: v.error ?? "bad_schema" };
    if (v.doc.issuer.toLowerCase() !== issuer.toLowerCase()) return { ok: false, error: "issuer_mismatch" };
    return { ok: true, doc: v.doc };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}


export interface CachedIssuerFacts {
  issuer: string;
  acceptsA2A: boolean;
  mailDomains: string[];
  fetchedAt: number;
  cacheExpiresAt: number;
}

export async function getIssuerFacts(env: Env, issuer: string, nowMs = Date.now()): Promise<CachedIssuerFacts | null> {
  const row = await env.DB.prepare(
    `SELECT issuer, accepts_a2a, mail_domains_json, fetched_at, cache_expires_at FROM a2a_discovery_issuers WHERE issuer=?`,
  )
    .bind(issuer.toLowerCase())
    .first<{ issuer: string; accepts_a2a: number; mail_domains_json: string; fetched_at: number; cache_expires_at: number }>();
  if (!row) return null;
  if ((row.cache_expires_at ?? 0) < nowMs) return null;
  let domains: unknown = [];
  try {
    domains = JSON.parse(row.mail_domains_json ?? "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(domains)) return null;
  return {
    issuer: row.issuer.toLowerCase(),
    acceptsA2A: row.accepts_a2a === 1,
    mailDomains: domains.filter((d): d is string => typeof d === "string").map((d) => d.toLowerCase()),
    fetchedAt: row.fetched_at,
    cacheExpiresAt: row.cache_expires_at,
  };
}


export async function getCachedIssuerKey(
  env: Env,
  issuer: string,
  kid: string,
  nowMs = Date.now(),
): Promise<{ facts: CachedIssuerFacts; jwk: JsonWebKey; notBefore: number | null; notAfter: number | null } | null> {
  const facts = await getIssuerFacts(env, issuer, nowMs);
  if (!facts) return null;
  const row = await env.DB.prepare(`SELECT public_key, not_before, not_after, cache_expires_at FROM a2a_domain_keys WHERE issuer=? AND kid=?`)
    .bind(issuer.toLowerCase(), kid)
    .first<{ public_key: string; not_before: number | null; not_after: number | null; cache_expires_at: number }>();
  if (!row) return null;
  if ((row.cache_expires_at ?? 0) < nowMs) return null;
  let x = row.public_key;
  try {
    const parsed = JSON.parse(row.public_key) as { x?: string };
    if (parsed?.x) x = parsed.x;
  } catch {
    /* raw x */
  }
  return { facts, jwk: jwkFromX(x), notBefore: row.not_before, notAfter: row.not_after };
}


export async function getCachedKey(
  env: Env,
  issuer: string,
  kid: string,
  nowMs = Date.now(),
): Promise<{ jwk: JsonWebKey; notBefore: number | null; notAfter: number | null } | null> {
  const hit = await getCachedIssuerKey(env, issuer, kid, nowMs);
  if (!hit) return null;
  return { jwk: hit.jwk, notBefore: hit.notBefore, notAfter: hit.notAfter };
}





export async function storeDiscoveryKeys(env: Env, doc: A2aDiscoveryDoc, nowMs = Date.now()): Promise<void> {
  const issuer = doc.issuer.toLowerCase();
  const expiresAt = nowMs + DISCOVERY_CACHE_TTL_MS;
  const facts = env.DB.prepare(
    `INSERT INTO a2a_discovery_issuers (issuer, accepts_a2a, mail_domains_json, fetched_at, cache_expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(issuer) DO UPDATE SET accepts_a2a=excluded.accepts_a2a, mail_domains_json=excluded.mail_domains_json,
       fetched_at=excluded.fetched_at, cache_expires_at=excluded.cache_expires_at`,
  ).bind(issuer, doc.acceptsA2A ? 1 : 0, JSON.stringify((doc.mailDomains ?? []).map((d) => String(d).toLowerCase())), nowMs, expiresAt);
  const keyStmts = doc.keys.map((k) =>
    env.DB.prepare(
      `INSERT INTO a2a_domain_keys (issuer, kid, public_key, not_before, not_after, fetched_at, cache_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issuer, kid) DO UPDATE SET public_key=excluded.public_key, not_before=excluded.not_before, not_after=excluded.not_after, fetched_at=excluded.fetched_at, cache_expires_at=excluded.cache_expires_at`,
    ).bind(issuer, k.kid, k.publicKey.x, k.notBefore ?? null, k.notAfter ?? null, nowMs, expiresAt),
  );
  await env.DB.batch([facts, ...keyStmts]);
}
