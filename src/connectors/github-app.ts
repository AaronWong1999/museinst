
//



//





import { now } from "../util";
import { ConnectorCallError, httpStatusToKind } from "./types";
import { DEADLINE_BUDGETS_MS, fetchWithDeadline } from "../util/deadlines";


function appFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetchWithDeadline(input, init, { operation: "github_app", budgetMs: DEADLINE_BUDGETS_MS.modelRequest });
}

export interface GitHubAppEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

export function githubAppConfigured(env: GitHubAppEnv): boolean {
  return !!(env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY);
}

function base64Url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(obj: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

function normalizePem(pem: string): string {

  return pem.replace(/\\n/g, "\n").trim();
}


function pemToDerBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}


export async function createGitHubAppJwt(env: GitHubAppEnv): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) throw new ConnectorCallError("provider_error", "github_app_not_configured");
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: Math.floor(now() / 1000) - 30, exp: Math.floor(now() / 1000) + 600, iss: env.GITHUB_APP_ID });
  const signingInput = `${header}.${payload}`;
  const keyData = pemToDerBytes(normalizePem(env.GITHUB_PRIVATE_KEY));
  // Web Crypto's TypeScript definitions require an ArrayBuffer whose backing
  // store is not shared. Copy the exact DER slice before importing the key.
  const keyDataBuffer = keyData.buffer.slice(keyData.byteOffset, keyData.byteOffset + keyData.byteLength) as ArrayBuffer;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", keyDataBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new ConnectorCallError("provider_error", "github_app_private_key_invalid");
  }
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(sig))}`;
}

async function appApi<T>(env: GitHubAppEnv, path: string): Promise<T> {
  const jwt = await createGitHubAppJwt(env);
  const res = await appFetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "openinst" },
  });
  if (!res.ok) throw new ConnectorCallError(httpStatusToKind(res.status), `github_app_http_${res.status}`, res.status, `github_app_http_${res.status}`);
  return (await res.json()) as T;
}

export interface GitHubInstallationInfo {
  id: number;
  account: { login: string; type: string };
  repository_selection: string;
  permissions: Record<string, string>;
  suspended_at: string | null;
  app_slug: string;
}


export async function getGitHubInstallation(env: GitHubAppEnv, installationId: number): Promise<GitHubInstallationInfo | null> {
  const j = await appApi<GitHubInstallationInfo>(env, `/app/installations/${installationId}`);
  if (!j || typeof j.id !== "number") return null;
  return j;
}


const tokenCache = new Map<number, { token: string; expiresAt: number }>();
const TOKEN_TTL_MS = 50 * 60_000;

export async function createInstallationAccessToken(env: GitHubAppEnv, installationId: number): Promise<string> {
  const hit = tokenCache.get(installationId);
  if (hit && hit.expiresAt - 60_000 > now()) return hit.token;
  const jwt = await createGitHubAppJwt(env);
  const res = await appFetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "openinst" },
  });
  if (!res.ok) throw new ConnectorCallError(httpStatusToKind(res.status), `github_installation_token_http_${res.status}`, res.status, `github_installation_token_http_${res.status}`);
  const j = (await res.json()) as { token?: string; expires_at?: string };
  if (!j.token) throw new ConnectorCallError("provider_error", "github_installation_token_missing");
  const expiresAt = j.expires_at ? Date.parse(j.expires_at) : now() + TOKEN_TTL_MS;

  tokenCache.set(installationId, { token: j.token, expiresAt: Math.min(expiresAt, now() + TOKEN_TTL_MS) });
  return j.token;
}


export function clearInstallationTokenCache(): void {
  tokenCache.clear();
}





export async function githubInstallationFetch(
  env: GitHubAppEnv,
  installationId: number,
  path: string,
  init?: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
  const token = await createInstallationAccessToken(env, installationId);
  const res = await appFetch(path.startsWith("http") ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "openinst",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new ConnectorCallError(httpStatusToKind(res.status), `github_http_${res.status}`, res.status, `github_http_${res.status}`);
  return res;
}

export async function githubInstallationJson<T = any>(env: GitHubAppEnv, installationId: number, path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<T> {
  const res = await githubInstallationFetch(env, installationId, path, init);
  return (await res.json()) as T;
}


export async function listUserInstallationsWithToken(userAccessToken: string): Promise<Array<{ id: number; account: { login: string; type: string }; repository_selection: string; permissions?: Record<string, string>; suspended_at?: string | null }>> {
  const res = await appFetch("https://api.github.com/user/installations?per_page=100", {
    headers: { authorization: `Bearer ${userAccessToken}`, accept: "application/vnd.github+json", "user-agent": "openinst" },
  });
  if (!res.ok) throw new ConnectorCallError(httpStatusToKind(res.status), `github_user_installations_http_${res.status}`, res.status, `github_user_installations_http_${res.status}`);
  const j = (await res.json()) as any;
  return (j.installations ?? []) as any[];
}
