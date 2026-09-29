


import type { Env } from "../env";
import type { ApprovalRoute } from "./context";

export async function resolveOwnerApprovalRoute(
  env: Env,
  workspaceId: string,
): Promise<ApprovalRoute | null> {
  const { results } = await env.DB.prepare(
    `SELECT channel, external_id FROM channel_identities WHERE workspace_id=? AND channel IN ('wechat','telegram') ORDER BY last_seen_at DESC LIMIT 1`,
  )
    .bind(workspaceId)
    .all<{ channel: string; external_id: string }>()
    .catch(() => ({ results: [] as Array<{ channel: string; external_id: string }> }));
  const row = (results ?? [])[0];
  if (row && (row.channel === "wechat" || row.channel === "telegram")) {
    return { channel: row.channel, externalId: row.external_id };
  }
  return { channel: "web" };
}

export interface ApprovalBinding {
  workspaceId: string;
  taskId: string;
  toolCallId: string;
  scopeKey: string;
  routeChannel: string;
  expiresAt: number;
  singleUseNonce: string;
}


export function verifyApprovalDecision(opts: {
  approval: { workspace_id: string; task_id: string; decision: string | null; created_at: number };
  binding: ApprovalBinding;
  authenticatedOwner: boolean;
  workspaceId: string;
  routeChannel: string;
  nowMs?: number;
}): { ok: boolean; error?: string } {
  const nowMs = opts.nowMs ?? Date.now();
  if (!opts.authenticatedOwner) return { ok: false, error: "not_authenticated_owner" };
  if (opts.binding.workspaceId !== opts.workspaceId) return { ok: false, error: "workspace_mismatch" };
  if (opts.binding.routeChannel !== opts.routeChannel) return { ok: false, error: "route_mismatch" };
  if (opts.approval.decision) return { ok: false, error: "already_decided" };
  if (opts.binding.expiresAt < nowMs) return { ok: false, error: "expired" };
  if (opts.approval.task_id !== opts.binding.taskId) return { ok: false, error: "task_mismatch" };
  return { ok: true };
}
