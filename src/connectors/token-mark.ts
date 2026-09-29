// token-mark.ts — mark/audit/withConnectorCall (V3 S6.4)

import type { Env } from "../env";
import { decryptField } from "../crypto";
import { newId, now } from "../util";
import { normalizeAccountLabel } from "./account-label";
import { tokenBrokerId } from "./token-broker";
import { getProvider } from "./registry";
import { ConnectorCallError, type AccessTokenResult } from "./types";
import { refreshAndStore } from "./token-refresh";
import { ACCESS_SKEW_MS, readConnectionRow, resolveLabel } from "./token-store";
import { externalCodeFromConnectorReason, type ExternalEvidence, type ExternalFailure } from "../external/result";


export async function markOk(env: Env, ws: string, provider: string, label: string): Promise<void> {
  await env.DB.prepare("UPDATE connections SET last_ok_at=?, last_error=NULL WHERE workspace_id=? AND provider=? AND account_label=?").bind(now(), ws, provider, normalizeAccountLabel(provider, label)).run().catch(() => {});
}



export async function markNeedsReauth(env: Env, ws: string, provider: string, label: string, err: string): Promise<void> {
  await env.DB.prepare("UPDATE connections SET needs_reauth=1, last_error=?, updated_at=? WHERE workspace_id=? AND provider=? AND account_label=?").bind(String(err).slice(0, 300), now(), ws, provider, normalizeAccountLabel(provider, label)).run();
}
export async function audit(env: Env, ws: string, provider: string, label: string, action: string, detail?: string, taskId?: string): Promise<void> {
  await env.DB.prepare("INSERT INTO connector_audit(id, workspace_id, provider, account_label, action, detail, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(newId("ca"), ws, provider, label, action, detail?.slice(0, 1000) ?? null, taskId ?? null, now()).run().catch(() => {});
}
export function reauthHint(provider: string): string { return "/settings?connect=" + provider + "_reauth_required"; }
export async function getAccessToken(env: Env, ws: string, provider: string, requested?: string): Promise<AccessTokenResult> {
  const label = await resolveLabel(env, ws, provider, requested);
  if (!label) return { ok: false, reason: "not_connected" };
  const row = await readConnectionRow(env, ws, provider, label);
  if (!row) return { ok: false, reason: "not_connected" };
  if (row.needs_reauth === 1) return { ok: false, reason: "reauth_required", accountLabel: label };
  if (row.refresh_expires_at != null && row.refresh_expires_at <= now()) { await markNeedsReauth(env, ws, provider, label, "refresh_grant_expired"); return { ok: false, reason: "reauth_required", accountLabel: label }; }
  const access = await decryptField(env, "connection:" + provider, row.encrypted_token);
  if (access) {
    if (row.expires_at == null) {

      if (getProvider(provider)?.allowsNonExpiringAccessToken === true) return { ok: true, token: access, accountLabel: label };
    } else if (row.expires_at - ACCESS_SKEW_MS > now()) {
      return { ok: true, token: access, accountLabel: label };
    }
  }
  const broker = (env as any).TOKEN_BROKER as DurableObjectNamespace | undefined;
  if (broker) {


    try {
      const stub = broker.get(broker.idFromName(tokenBrokerId(ws, provider, label)));
      const res = await stub.fetch("https://broker/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: ws, provider, accountLabel: label }) });
      if (!res.ok) return { ok: false, reason: "internal_error", accountLabel: label, retryable: true };
      const j = (await res.json()) as AccessTokenResult;
      if (!j || typeof j !== "object" || typeof (j as any).ok !== "boolean") return { ok: false, reason: "internal_error", accountLabel: label, retryable: true };
      return j;
    } catch {
      return { ok: false, reason: "internal_error", accountLabel: label, retryable: true };
    }
  }
  return refreshAndStore(env, ws, provider, label);
}

export interface ConnectorCallFailure { ok: false; reason: string; hint?: string; retryable?: boolean; evidence?: ExternalFailure }

export type ConnectorCallResult<T> =
  | { ok: true; data: T; accountLabel: string; evidence: ExternalEvidence }
  | ConnectorCallFailure;


export function connectorFailureToExternal(provider: string, r: ConnectorCallFailure): ExternalFailure {
  const normalized = externalCodeFromConnectorReason(r.reason);
  const resumable = normalized.code === "not_connected" || normalized.code === "reauth_required" || normalized.code === "approval_required";
  return {
    code: normalized.code,
    message: connectorFailureText(provider, r),
    provider,
    retryable: r.retryable ?? normalized.retryable,
    resumable,
    connectUrl: resumable ? reauthHint(provider) : undefined,
  };
}


export function connectorFailureText(provider: string, r: ConnectorCallFailure): string {
  switch (r.reason) {
    case "reauth_required": return `（${provider} 授权已失效或被撤销，需要用户重新连接：${r.hint ?? reauthHint(provider)}）`;
    case "permission_denied": return `（${provider} 拒绝访问：权限不足（403），需要重新授权并确认勾选所需权限${r.hint ? "：" + r.hint : ""}）`;
    case "rate_limited": return `（${provider} 触发限流（429），请稍后重试，不要当作没有数据）`;
    case "internal_error": return "（内部故障：token 刷新服务暂不可用，可重试）";
    case "result_unknown": return "（结果未知：写操作可能已生效，绝不能自动重试；请先人工核对）";
    case "transient_error": return `（${provider} 暂时不可用，可重试）`;
    case "not_found": return `（${provider} 中不存在该对象）`;
    case "not_connected": return `（${provider} 未连接，让用户去控制台 Workspace 页点 Connect）`;
    default: return `（${provider} 调用失败：${r.reason}）`;
  }
}





export async function withConnectorCall<T>(env: Env, opts: { workspaceId: string; provider: string; accountLabel?: string; taskId?: string }, _effect: string, toolName: string, fn: (token: string, accountLabel: string) => Promise<T>): Promise<{ ok: true; data: T; accountLabel: string; evidence: ExternalEvidence } | ConnectorCallFailure> {
  const tok = await getAccessToken(env, opts.workspaceId, opts.provider, opts.accountLabel);
  if (!tok.ok) {
    return { ok: false, reason: tok.reason, hint: tok.reason === "reauth_required" ? reauthHint(opts.provider) : undefined, retryable: tok.retryable };
  }
  const writeEffect = _effect === "write" || _effect === "external_send" || _effect === "destructive";
  try {
    const data = await fn(tok.token, tok.accountLabel);
    await markOk(env, opts.workspaceId, opts.provider, tok.accountLabel);
    await audit(env, opts.workspaceId, opts.provider, tok.accountLabel, toolName, "ok", opts.taskId);
    return {
      ok: true,
      data,
      accountLabel: tok.accountLabel,
      evidence: { provider: opts.provider, account: tok.accountLabel, fetchedAt: Date.now() },
    };
  } catch (e) {
    if (e instanceof ConnectorCallError) {
      if (e.kind === "auth") {


        let stateNote = "";
        try { await markNeedsReauth(env, opts.workspaceId, opts.provider, tok.accountLabel, e.message); }
        catch { stateNote = ";state_write_failed"; }
        await audit(env, opts.workspaceId, opts.provider, tok.accountLabel, toolName + "_reauth_required", (e.code ?? e.message) + stateNote, opts.taskId);
        return { ok: false, reason: "reauth_required", hint: reauthHint(opts.provider) };
      }
      if (e.kind === "permission") { await audit(env, opts.workspaceId, opts.provider, tok.accountLabel, toolName + "_permission_denied", e.code ?? e.message, opts.taskId); return { ok: false, reason: "permission_denied", hint: e.code }; }
      if (e.kind === "rate_limit") { await audit(env, opts.workspaceId, opts.provider, tok.accountLabel, toolName + "_rate_limited", e.code ?? e.message, opts.taskId); return { ok: false, reason: "rate_limited" }; }
      if (e.kind === "not_found") return { ok: false, reason: "not_found" };
      if (e.kind === "transient") { await audit(env, opts.workspaceId, opts.provider, tok.accountLabel, toolName + "_transient_error", e.code ?? e.message, opts.taskId); return { ok: false, reason: "transient_error" }; }
      return { ok: false, reason: e.code ?? "provider_error" };
    }

    await audit(env, opts.workspaceId, opts.provider, tok.accountLabel, toolName + (writeEffect ? "_result_unknown" : "_transient_error"), "network_error", opts.taskId);
    return { ok: false, reason: writeEffect ? "result_unknown" : "transient_error", retryable: !writeEffect };
  }
}
