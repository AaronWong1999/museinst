



import type { Env } from "../env";
import { now } from "../util";
import { connectorSlotKey, normalizeAccountLabel } from "./account-label";

export type SlotReserveResult =
  | { ok: true; created: boolean; slotKey: string }
  | { ok: false; reason: "quota_exceeded" };

export async function reserveConnectorSlot(
  env: Env,
  workspaceId: string,
  provider: string,
  accountLabel: string,
  maxAccounts: number | null | undefined,
): Promise<SlotReserveResult> {
  const label = normalizeAccountLabel(provider, accountLabel);
  const slotKey = connectorSlotKey(provider, label);
  const cap = maxAccounts == null ? 2147483647 : Math.max(0, Math.floor(maxAccounts));


  const res = await env.DB.prepare(`
    INSERT INTO connector_slots(workspace_id, slot_key, provider, account_label, created_at)
    SELECT ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM connector_slots WHERE workspace_id=?) < ?
    ON CONFLICT(workspace_id, slot_key) DO NOTHING
  `).bind(workspaceId, slotKey, provider, label, now(), workspaceId, cap).run();

  if ((res.meta?.changes ?? 0) === 1) return { ok: true, created: true, slotKey };


  const existing = await env.DB.prepare(
    `SELECT 1 FROM connector_slots WHERE workspace_id=? AND slot_key=?`,
  ).bind(workspaceId, slotKey).first();
  if (existing) return { ok: true, created: false, slotKey };
  return { ok: false, reason: "quota_exceeded" };
}

export async function releaseConnectorSlot(env: Env, workspaceId: string, slotKey: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM connector_slots WHERE workspace_id=? AND slot_key=?`)
    .bind(workspaceId, slotKey).run();
}

export async function countConnectorSlots(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM connector_slots WHERE workspace_id=?`,
  ).bind(workspaceId).first<{ c: number }>();
  return row?.c ?? 0;
}
