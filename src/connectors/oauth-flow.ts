


import type { Env } from "../env";
import { getProvider } from "./registry";
import { consumeOAuthState, normalizeRedirectTo } from "./oauth-state";
import { connectorSlotKey } from "./account-label";
import { releaseConnectorSlot, reserveConnectorSlot } from "./slots";
import { upsertConnectedAccount, resolveLabel, readConnectionRow } from "./token-store";
import { audit } from "./token-mark";
import { decryptField } from "../crypto";
import type { RevokeResult, RevokeTokens } from "./types";

/**
 * Base URL for connector OAuth redirect_uri values. CONNECTOR_OAUTH_BASE_URL pins the
 * callback to the host registered with each provider when the public host changes.
 */
export function connectorRedirectBase(env: Env): string {
  const configured = String((env as { CONNECTOR_OAUTH_BASE_URL?: string }).CONNECTOR_OAUTH_BASE_URL ?? "").trim();
  return (configured || env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

export type CallbackResult = { ok: true; provider: string; label: string; slotCreated: boolean; redirectTo: string | null } | { ok: false; error: string };

export async function handleOAuthCallback(env: Env, query: { state: string; code: string }, session: { workspaceId: string; userId: string }, opts: { maxAccounts: number | null; expectedProvider?: string }): Promise<CallbackResult> {
  const st = await consumeOAuthState(env, query.state);
  if (!st.ok) return { ok: false, error: st.error };
  const row = st.row;

  if (row.workspace_id !== session.workspaceId) return { ok: false, error: "workspace_mismatch" };
  if (row.user_id && row.user_id !== session.userId) return { ok: false, error: "user_mismatch" };
  if (!row.provider) return { ok: false, error: "state_incomplete" };

  if (opts.expectedProvider != null && opts.expectedProvider !== row.provider) return { ok: false, error: "provider_mismatch" };
  const def = getProvider(row.provider);
  if (!def) return { ok: false, error: "unknown_provider" };
  const redirectUri = connectorRedirectBase(env) + "/api/connectors/" + row.provider + "/callback";
  let tokens;
  try {
    tokens = await def.exchangeCode(env, query.code, redirectUri, row.code_verifier ? { codeVerifier: row.code_verifier } : undefined);
  } catch (e) { return { ok: false, error: "exchange_failed" }; }
  if ("error" in (tokens as any)) return { ok: false, error: (tokens as any).error };
  const tk = tokens as { accessToken: string; refreshToken?: string; accessExpiresAt?: number; refreshExpiresAt?: number; scope?: string };
  let identity;
  try { identity = await def.identifyAccount(env, tk.accessToken); } catch (e) { return { ok: false, error: "identify_failed" }; }
  const isReauth = row.reauth_label !== null && row.reauth_label !== undefined;
  if (isReauth && identity.label !== row.reauth_label) {
    const rv = await revokeGrant(env, row.provider, { accessToken: tk.accessToken, refreshToken: tk.refreshToken });
    await audit(env, session.workspaceId, row.provider, identity.label, "reauth_identity_mismatch", "expected=" + row.reauth_label + ";revoke=" + rv.outcome + (rv.detail ? ":" + rv.detail : ""));
    return { ok: false, error: "reauth_identity_mismatch" };
  }
  if (def.kind === "single" && !isReauth) {
    const existing = await env.DB.prepare("SELECT account_label FROM connections WHERE workspace_id=? AND provider=? LIMIT 2").bind(session.workspaceId, row.provider).all<{ account_label: string }>();
    const rows = existing.results ?? [];
    if (rows.length > 0 && !rows.some((r) => r.account_label === identity.label)) {

      await handleOrphanGrant(env, session.workspaceId, row.provider, { accessToken: tk.accessToken, refreshToken: tk.refreshToken }, identity.label);
      return { ok: false, error: "already_connected" };
    }
  }
  const slot = await reserveConnectorSlot(env, session.workspaceId, row.provider, identity.label, opts.maxAccounts);
  if (!slot.ok) {
    await handleOrphanGrant(env, session.workspaceId, row.provider, { accessToken: tk.accessToken, refreshToken: tk.refreshToken }, identity.label);
    return { ok: false, error: "quota_exceeded" };
  }
  try {
    await upsertConnectedAccount(env, session.workspaceId, row.provider, identity.label, tk, identity.displayName);
  } catch (e) {
    if (slot.created) await releaseConnectorSlot(env, session.workspaceId, slot.slotKey);
    await handleOrphanGrant(env, session.workspaceId, row.provider, { accessToken: tk.accessToken, refreshToken: tk.refreshToken }, identity.label);
    return { ok: false, error: "store_failed" };
  }
  if (isReauth && (def as any).isTestingMode?.(env)) {
    await audit(env, session.workspaceId, row.provider, identity.label, "reauth_ok_testing_mode", "refresh_7d_window");
  }
  const singleConflict = def.kind === "single";
  await audit(env, session.workspaceId, row.provider, identity.label, isReauth ? "reauth_ok" : "connect_ok", singleConflict ? "single_account" : undefined);

  return { ok: true, provider: row.provider, label: identity.label, slotCreated: slot.created, redirectTo: row.redirect_to ? normalizeRedirectTo(row.redirect_to) : null };
}

export interface DisconnectResult {
  ok: true;
  provider: string;
  accountLabel: string;

  revoked: boolean;
  revoke: "revoked" | "failed" | "unsupported";

  manualRevokeUrl?: string;

  remoteRevokePending: boolean;
}


export async function revokeGrant(env: Env, provider: string, tok: RevokeTokens): Promise<RevokeResult> {
  const def = getProvider(provider);
  if (!def || !def.supportsRevoke || !def.revoke) return { outcome: "unsupported" };
  try {
    return await def.revoke(env, tok);
  } catch (e) {
    return { outcome: "failed", detail: "exception" };
  }
}





export async function disconnectProvider(env: Env, ws: string, provider: string, accountLabel?: string): Promise<DisconnectResult | { ok: false; error: string }> {
  const def = getProvider(provider);
  const label = await resolveLabel(env, ws, provider, accountLabel);
  if (!label) return { ok: false, error: "not_connected" };
  let rv: RevokeResult = { outcome: "unsupported" };
  if (def?.supportsRevoke && def.revoke) {
    const row = await readConnectionRow(env, ws, provider, label);
    if (row) {
      const plain = await decryptField(env, "connection:" + provider, row.encrypted_token).catch(() => "");
      const refresh = row.refresh_token_enc ? await decryptField(env, "connection:" + provider, row.refresh_token_enc).catch(() => "") : "";
      if (plain || refresh) rv = await revokeGrant(env, provider, { accessToken: plain, refreshToken: refresh || undefined });
      else rv = { outcome: "failed", detail: "local_token_unreadable" };
    } else {
      rv = { outcome: "failed", detail: "connection_row_missing" };
    }
  }
  const slotKey = connectorSlotKey(provider, label);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM connections WHERE workspace_id=? AND provider=? AND account_label=?").bind(ws, provider, label),
    env.DB.prepare("DELETE FROM connector_slots WHERE workspace_id=? AND slot_key=?").bind(ws, slotKey),
  ]);
  const revoked = rv.outcome === "revoked";
  const manualRevokeUrl = revoked ? undefined : def?.manualRevokeUrl;
  const detail = revoked
    ? "revoked"
    : rv.outcome === "failed"
      ? "revoke_failed" + (rv.detail ? ":" + rv.detail : "") + (manualRevokeUrl ? ";manual=" + manualRevokeUrl : "")
      : "revoke_unsupported" + (manualRevokeUrl ? ";manual=" + manualRevokeUrl : "");
  await audit(env, ws, provider, label, "disconnect_ok", detail);
  if (!revoked) {

    await audit(env, ws, provider, label, "remote_revoke_pending", detail);
  }
  return { ok: true, provider, accountLabel: label, revoked, revoke: rv.outcome, manualRevokeUrl, remoteRevokePending: !revoked };
}


async function handleOrphanGrant(env: Env, ws: string, provider: string, tok: RevokeTokens, label: string): Promise<RevokeResult> {
  const rv = await revokeGrant(env, provider, tok);
  if (rv.outcome === "revoked") {
    await audit(env, ws, provider, label, "orphan_grant_revoked");
  } else if (rv.outcome === "failed") {
    const url = getProvider(provider)?.manualRevokeUrl;
    await audit(env, ws, provider, label, "orphan_grant_revoke_failed", (rv.detail ?? "failed") + (url ? ";manual=" + url : ""));
  } else {
    const url = getProvider(provider)?.manualRevokeUrl;
    await audit(env, ws, provider, label, "orphan_grant_unrevoked", url ? "manual=" + url : undefined);
  }
  return rv;
}
