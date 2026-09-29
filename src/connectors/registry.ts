


import type { Env } from "../env";
import { now } from "../util";
import { ConnectorCallError, httpStatusToKind, redactSecretText, type OAuthTokens, type RevokeResult, type RevokeTokens } from "./types";
import {
  isLarkFeishuConfigured,
  larkFeishuAuthorizeUrl,
  larkFeishuExchangeCode,
  larkFeishuIdentifyAccount,
  getPlatformDefaultScopes,
  LARK_FEISHU_DEFAULT_SCOPES,
} from "./lark-feishu";




export type ProviderId = "google" | "github" | "feishu" | "lark";

export interface ProviderDef {
  id: ProviderId;
  kind: "multi" | "single";
  isProduction: () => boolean;
  configured: (env: Env) => boolean;
  authorizeUrl: (env: Env, redirectUri: string, state: string, opts?: { codeChallenge?: string; forceConsent?: boolean; selectAccount?: boolean; loginHint?: string }) => string;
  exchangeCode: (env: Env, code: string, redirectUri: string, opts?: { codeVerifier?: string }) => Promise<OAuthTokens | { error: string }>;
  identifyAccount: (env: Env, accessToken: string) => Promise<{ label: string; displayName: string }>;
  revoke?: (env: Env, tok: RevokeTokens) => Promise<RevokeResult>;
  supportsRevoke: boolean;
  manualRevokeUrl?: string;
  allowsNonExpiringAccessToken?: boolean;
  defaultScopes: string;
  isTestingMode?: (env: Env) => boolean;
}

/** Google Sign-In identity-only scopes. Workspace data is never requested at sign-in. */
export const GOOGLE_SIGN_IN_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

/**
 * Hosted production Workspace request scopes. This is the explicit second-stage request made
 * only after the user clicks Connect. `include_granted_scopes=true` may make Google's final
 * effective grant also contain identity scopes previously granted during sign-in.
 */
export const GOOGLE_WORKSPACE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

// Compatibility export: registry GOOGLE_SCOPES is the Hosted Workspace request set.
export const GOOGLE_SCOPES = [...GOOGLE_WORKSPACE_SCOPES];

/** Hosted must never request these obsolete/broad alternatives. */
export const GOOGLE_HOSTED_SCOPE_DENYLIST = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];

/**
 * Optional self-hosted BYO profile. This intentionally includes Restricted scopes and therefore
 * must never be used by MuseInst Hosted. It exists so the open-source edition does not lose the
 * user's own Gmail/full-Drive agent capability merely because the hosted SaaS avoids CASA.
 */
export const GOOGLE_SELF_HOSTED_FULL_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/tasks",
];

export const GOOGLE_RESTRICTED_SCOPES_DENYLIST = GOOGLE_HOSTED_SCOPE_DENYLIST;






export function googleScopesFor(env: Pick<Env, "GOOGLE_OAUTH_SCOPE_PROFILE">): string[] {
  return env.GOOGLE_OAUTH_SCOPE_PROFILE === "self_hosted_full" ? GOOGLE_SELF_HOSTED_FULL_SCOPES : GOOGLE_SCOPES;
}

export function googleDef(): ProviderDef {
  return {
    id: "google",
    kind: "multi",
    isProduction: () => true,
    configured: (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    authorizeUrl: (env, redirectUri, state, opts) => {
      const scopes = googleScopesFor(env);
      const p = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID!,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        access_type: "offline",
        include_granted_scopes: "true",
        state,
      });
      if (opts?.forceConsent) p.set("prompt", "consent");
      else if (opts?.selectAccount) p.set("prompt", "select_account");
      if (opts?.loginHint) p.set("login_hint", opts.loginHint);
      if (opts?.codeChallenge) { p.set("code_challenge", opts.codeChallenge); p.set("code_challenge_method", "S256"); }
      return "https://accounts.google.com/o/oauth2/v2/auth?" + p;
    },
    exchangeCode: async (env, code, redirectUri, opts) => {
      const scopes = googleScopesFor(env);
      const body = new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri, grant_type: "authorization_code" });
      if (opts?.codeVerifier) body.set("code_verifier", opts.codeVerifier);
      const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      const j = (await res.json().catch(() => ({}))) as any;
      if (!res.ok || !j.access_token) return { error: String(j.error_description ?? j.error ?? ("http_" + res.status)) };
      const testing = (j.refresh_token_expires_in ?? 0) === 604800;
      return { accessToken: j.access_token, refreshToken: j.refresh_token, accessExpiresAt: now() + Number(j.expires_in ?? 3600) * 1000, refreshExpiresAt: testing ? now() + 7 * 86400_000 : (j.refresh_token_expires_in ? now() + Number(j.refresh_token_expires_in) * 1000 : undefined), scope: String(j.scope ?? scopes.join(" ")) };
    },
    identifyAccount: async (_env, accessToken) => {
      const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: "Bearer " + accessToken } });
      if (!r.ok) throw new ConnectorCallError(httpStatusToKind(r.status), "google_identify: http_" + r.status, r.status);
      const j = (await r.json()) as any;
      const email = String(j.email ?? "").trim().toLowerCase();
      if (!email) throw new ConnectorCallError("provider_error", "google_identify: empty_email", r.status);
      const displayName = String(j.name ?? email).trim() || email;
      return { label: email, displayName };
    },
    revoke: async (_env, tok) => {
      const token = tok.refreshToken || tok.accessToken;
      try {
        const res = await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
        });
        if (!res.ok) return { outcome: "failed", detail: "http_" + res.status };
        return { outcome: "revoked" };
      } catch (e) {
        return { outcome: "failed", detail: "network_error: " + redactSecretText(e) };
      }
    },
    supportsRevoke: true,
    manualRevokeUrl: "https://myaccount.google.com/permissions",
    defaultScopes: "GOOGLE_SCOPE_PROFILE",
    isTestingMode: () => false,
  };
}

export function githubDef(): ProviderDef {
  return {
    id: "github",
    kind: "single",
    isProduction: () => true,
    configured: (env) => !!((env as any).GITHUB_CLIENT_ID && (env as any).GITHUB_CLIENT_SECRET),
    authorizeUrl: (env, redirectUri, state) => {
      const p = new URLSearchParams({ client_id: (env as any).GITHUB_CLIENT_ID!, redirect_uri: redirectUri, scope: "repo read:user", state });
      return "https://github.com/login/oauth/authorize?" + p;
    },
    exchangeCode: async (env, code) => {
      const res = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_id: (env as any).GITHUB_CLIENT_ID, client_secret: (env as any).GITHUB_CLIENT_SECRET, code }) });
      const j = (await res.json().catch(() => ({}))) as any;
      if (!j.access_token) return { error: String(j.error_description ?? "exchange_failed") };
      return { accessToken: j.access_token, refreshToken: j.refresh_token, accessExpiresAt: j.expires_in ? now() + Number(j.expires_in) * 1000 : undefined, refreshExpiresAt: j.refresh_token_expires_in ? now() + Number(j.refresh_token_expires_in) * 1000 : undefined } as OAuthTokens;
    },
    identifyAccount: async (_env, accessToken) => {
      const r = await fetch("https://api.github.com/user", { headers: { authorization: "Bearer " + accessToken, accept: "application/vnd.github+json", "user-agent": "openinst" } });
      if (!r.ok) {
        const code = r.status === 401 ? "github_token_invalid" : "github_user_" + r.status;
        throw new ConnectorCallError(httpStatusToKind(r.status), "github_identify: http_" + r.status, r.status, code);
      }
      const j = (await r.json().catch(() => ({}))) as any;
      const login = String(j.login ?? "").trim().toLowerCase();
      if (!login) throw new ConnectorCallError("provider_error", "github_identify: empty_login", r.status, "github_user");
      return { label: login, displayName: login };
    },
    supportsRevoke: false,
    manualRevokeUrl: "https://github.com/settings/applications",
    allowsNonExpiringAccessToken: true,
    defaultScopes: "repo,read:user",
  };
}

export function feishuDef(): ProviderDef {
  return {
    id: "feishu",
    // The Hosted UI and connector-slot model both support Add account. Keep
    // Feishu grants isolated by stable open_id instead of rejecting a second
    // legitimate account as an orphan grant.
    kind: "multi",
    isProduction: () => true,
    configured: (env) => isLarkFeishuConfigured(env, "feishu"),
    authorizeUrl: (env, redirectUri, state, opts) => larkFeishuAuthorizeUrl(env, "feishu", redirectUri, state, opts),
    exchangeCode: async (env, code, redirectUri) => larkFeishuExchangeCode(env, "feishu", code, redirectUri),
    identifyAccount: async (env, accessToken) => larkFeishuIdentifyAccount(env, "feishu", accessToken),
    supportsRevoke: false,
    manualRevokeUrl: "https://open.feishu.cn",
    defaultScopes: getPlatformDefaultScopes("feishu").join(" "),
  };
}

export function larkDef(): ProviderDef {
  return {
    id: "lark",
    // Lark is independent from Feishu and may also have multiple connected
    // user identities; quota is enforced by connector_slots, not by replacing
    // the provider's first account.
    kind: "multi",
    isProduction: () => true,
    configured: (env) => isLarkFeishuConfigured(env, "lark"),
    authorizeUrl: (env, redirectUri, state, opts) => larkFeishuAuthorizeUrl(env, "lark", redirectUri, state, opts),
    exchangeCode: async (env, code, redirectUri) => larkFeishuExchangeCode(env, "lark", code, redirectUri),
    identifyAccount: async (env, accessToken) => larkFeishuIdentifyAccount(env, "lark", accessToken),
    supportsRevoke: false,
    manualRevokeUrl: "https://open.larksuite.com",
    defaultScopes: getPlatformDefaultScopes("lark").join(" "),
  };
}

export const REGISTRY: Record<ProviderId, () => ProviderDef> = {
  google: googleDef,
  github: githubDef,
  feishu: feishuDef,
  lark: larkDef,
};

export function getProvider(id: string): ProviderDef | null {
  const f = (REGISTRY as Record<string, () => ProviderDef>)[id];
  return f ? f() : null;
}

export function providers(): ProviderDef[] {
  return [googleDef(), githubDef(), feishuDef(), larkDef()];
}
