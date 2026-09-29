import assert from "node:assert/strict";
import {
  GOOGLE_HOSTED_SCOPE_DENYLIST,
  GOOGLE_SCOPES,
  GOOGLE_SELF_HOSTED_FULL_SCOPES,
  googleDef,
  googleScopesFor,
} from "../src/connectors/registry";
import { GOOGLE_SCOPES as LEGACY_GOOGLE_SCOPES } from "../src/connectors/google";

const scopeSet = new Set(GOOGLE_SCOPES);

assert.deepEqual(GOOGLE_SCOPES, [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/drive.file",
], "Hosted Workspace request scope set must be exactly the canonical six scopes");

for (const restricted of GOOGLE_HOSTED_SCOPE_DENYLIST) {
  assert.equal(scopeSet.has(restricted), false, `restricted Google scope must never be requested by Hosted: ${restricted}`);
}

for (const required of [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/drive.file",
]) {
  assert.equal(scopeSet.has(required), true, `missing Google no-CASA scope: ${required}`);
}
assert.equal(scopeSet.has("https://www.googleapis.com/auth/userinfo.profile"), false);

// Login identity uses the explicit OIDC userinfo scope URLs, not the bare email/profile aliases,
// so the connector request is unambiguous about which identity API it depends on.
for (const alias of ["email", "profile"]) {
  assert.equal(scopeSet.has(alias), false, `userinfo scope must use the full URL form, not the alias: ${alias}`);
}

assert.deepEqual(new Set(LEGACY_GOOGLE_SCOPES), scopeSet, "legacy google.ts scope export must mirror the Hosted no-CASA policy");
assert.deepEqual(new Set(googleScopesFor({} as any)), scopeSet, "unset scope profile must fail safe to no_casa");

const env = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_OAUTH_SCOPE_PROFILE: "no_casa",
} as any;
const url = new URL(googleDef().authorizeUrl(env, "https://openinst.com/api/connectors/google/callback", "state"));
const authScopes = new Set((url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean));
assert.deepEqual(authScopes, scopeSet, "Hosted authorizeUrl must request exactly the no-CASA policy scope set");
assert.equal(url.searchParams.get("access_type"), "offline");
assert.equal(url.searchParams.get("include_granted_scopes"), "true");
// Normal connection must not force a fresh consent screen every time.
assert.equal(url.searchParams.get("prompt"), null);

const selectAccountUrl = new URL(googleDef().authorizeUrl(env, "https://openinst.com/api/connectors/google/callback", "state", { selectAccount: true }));
assert.equal(selectAccountUrl.searchParams.get("prompt"), "select_account");

const reauthUrl = new URL(googleDef().authorizeUrl(env, "https://openinst.com/api/connectors/google/callback", "state", {
  forceConsent: true,
  loginHint: "user@example.com",
}));
assert.equal(reauthUrl.searchParams.get("prompt"), "consent");
assert.equal(reauthUrl.searchParams.get("login_hint"), "user@example.com");


assert.deepEqual(googleScopesFor({ GOOGLE_OAUTH_SCOPE_PROFILE: "no_casa" } as any), GOOGLE_SCOPES,
  "no_casa profile must request the canonical no-CASA scope set");
assert.deepEqual(googleScopesFor({} as any), GOOGLE_SCOPES,
  "unset profile must default to the no-CASA scope set");
assert.deepEqual(googleScopesFor({ GOOGLE_OAUTH_SCOPE_PROFILE: "self_hosted_full" } as any), GOOGLE_SELF_HOSTED_FULL_SCOPES,
  "self-hosted BYO may still opt in explicitly");

for (const env of [
  { GOOGLE_OAUTH_SCOPE_PROFILE: "no_casa", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" },
  { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" },
] as any[]) {
  const u = new URL(googleDef().authorizeUrl(env, "https://openinst.com/api/connectors/google/callback", "state"));
  const scopes = (u.searchParams.get("scope") ?? "").split(/\s+/);
  for (const denied of GOOGLE_HOSTED_SCOPE_DENYLIST) {
    assert.equal(scopes.includes(denied), false, `no-CASA authorizeUrl must never request ${denied}`);
  }
}

// Guard the architectural reason for this test: Hosted Gmail is IMAP, not Google Restricted OAuth.
assert.equal([...authScopes].some((s) => s.includes("gmail.") || s === "https://mail.google.com/"), false);
assert.equal([...authScopes].some((s) => s === "https://www.googleapis.com/auth/drive" || s === "https://www.googleapis.com/auth/drive.readonly"), false);

// The open-source BYO edition deliberately keeps an opt-in full profile; it must never be selected
// by Hosted, but preserving it avoids silently removing capabilities from self-hosted users.
const selfHosted = new Set(googleScopesFor({ GOOGLE_OAUTH_SCOPE_PROFILE: "self_hosted_full" } as any));
assert.deepEqual(selfHosted, new Set(GOOGLE_SELF_HOSTED_FULL_SCOPES));
assert.equal(selfHosted.has("https://www.googleapis.com/auth/gmail.modify"), true);
assert.equal(selfHosted.has("https://www.googleapis.com/auth/drive"), true);

console.log("google-no-casa-scopes: ok");
