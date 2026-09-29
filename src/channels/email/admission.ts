
import type { Env } from "../../env";
import { todayQuotaDay } from "./mailbox";

export interface ReserveModelAdmissionOptions {
  workspaceId: string;
  rowId: string;
  peerHash: string;
  totalCap: number;
  peerCap: number;
  nowMs?: number;
}

export interface ModelAdmissionResult {
  allowed: boolean;
  reason: string;
  day: string;
}








export async function reserveEmailModelAdmission(
  env: Env,
  opts: ReserveModelAdmissionOptions,
): Promise<ModelAdmissionResult> {
  const now = opts.nowMs ?? Date.now();
  const day = todayQuotaDay(now);
  const totalLimit = Math.floor(Number(opts.totalCap));
  const peerLimit = Math.floor(Number(opts.peerCap));

  if (!Number.isFinite(totalLimit) || totalLimit <= 0) {
    return { allowed: false, reason: "total_cap_exceeded", day };
  }
  if (!Number.isFinite(peerLimit) || peerLimit <= 0) {
    return { allowed: false, reason: "peer_cap_exceeded", day };
  }

  const peerScope = `inbound_model_peer:${opts.peerHash.slice(0, 16)}`;


  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO email_counters (workspace_id, day, scope, count, updated_at)
       VALUES (?, ?, 'inbound_model', 0, ?)
       ON CONFLICT(workspace_id, day, scope) DO NOTHING`,
    ).bind(opts.workspaceId, day, now),
    env.DB.prepare(
      `INSERT INTO email_counters (workspace_id, day, scope, count, updated_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(workspace_id, day, scope) DO NOTHING`,
    ).bind(opts.workspaceId, day, peerScope, now),
  ]);


  const existing = await env.DB.prepare(
    `SELECT status, day FROM email_model_admissions WHERE workspace_id=? AND email_row_id=?`,
  )
    .bind(opts.workspaceId, opts.rowId)
    .first<{ status: string; day: string }>();

  if (existing) {
    if (existing.status === "reserved" || existing.status === "consumed") {
      return { allowed: true, reason: existing.status, day: existing.day };
    }
    return { allowed: false, reason: "already_released", day: existing.day };
  }


  const transitionToken = crypto.randomUUID();
  const insertAdmission = env.DB.prepare(
    `INSERT OR IGNORE INTO email_model_admissions
       (workspace_id, email_row_id, day, peer_scope, status, created_at, transition_token)
     SELECT ?, ?, ?, ?, 'reserved', ?, ?
     WHERE (
       SELECT count FROM email_counters
       WHERE workspace_id=? AND day=? AND scope='inbound_model'
     ) < ?
     AND (
       SELECT count FROM email_counters
       WHERE workspace_id=? AND day=? AND scope=?
     ) < ?`,
  ).bind(
    opts.workspaceId, opts.rowId, day, peerScope, now, transitionToken,
    opts.workspaceId, day, totalLimit,
    opts.workspaceId, day, peerScope, peerLimit,
  );

  const updateTotal = env.DB.prepare(
    `UPDATE email_counters
     SET count = count + 1, updated_at = ?
     WHERE workspace_id=? AND day=? AND scope='inbound_model'
       AND EXISTS (
         SELECT 1 FROM email_model_admissions
         WHERE workspace_id=? AND email_row_id=? AND status='reserved' AND transition_token=?
       )`,
  ).bind(now, opts.workspaceId, day, opts.workspaceId, opts.rowId, transitionToken);

  const updatePeer = env.DB.prepare(
    `UPDATE email_counters
     SET count = count + 1, updated_at = ?
     WHERE workspace_id=? AND day=? AND scope=?
       AND EXISTS (
         SELECT 1 FROM email_model_admissions
         WHERE workspace_id=? AND email_row_id=? AND status='reserved' AND transition_token=?
       )`,
  ).bind(now, opts.workspaceId, day, peerScope, opts.workspaceId, opts.rowId, transitionToken);

  const batchResults = await env.DB.batch([insertAdmission, updateTotal, updatePeer]);
  const insertChanges = (batchResults[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0;

  if (insertChanges === 1) {
    return { allowed: true, reason: "reserved", day };
  }


  const recheck = await env.DB.prepare(
    `SELECT status, day FROM email_model_admissions WHERE workspace_id=? AND email_row_id=?`,
  )
    .bind(opts.workspaceId, opts.rowId)
    .first<{ status: string; day: string }>();

  if (recheck && (recheck.status === "reserved" || recheck.status === "consumed")) {
    return { allowed: true, reason: recheck.status, day: recheck.day };
  }
  if (recheck?.status === "released") {
    return { allowed: false, reason: "already_released", day: recheck.day };
  }



  const [totalRow, peerRow] = await Promise.all([
    env.DB.prepare(`SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope='inbound_model'`)
      .bind(opts.workspaceId, day)
      .first<{ count: number }>(),
    env.DB.prepare(`SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope=?`)
      .bind(opts.workspaceId, day, peerScope)
      .first<{ count: number }>(),
  ]);

  const totalCount = Number(totalRow?.count ?? 0);
  const peerCount = Number(peerRow?.count ?? 0);

  if (totalCount >= totalLimit) {
    return { allowed: false, reason: "total_cap_exceeded", day };
  }
  if (peerCount >= peerLimit) {
    return { allowed: false, reason: "peer_cap_exceeded", day };
  }

  return { allowed: false, reason: "admission_race_lost", day };
}





export async function consumeEmailModelAdmission(
  env: Env,
  workspaceId: string,
  rowId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE email_model_admissions
     SET status = 'consumed', consumed_at = ?, transition_token = NULL
     WHERE workspace_id = ? AND email_row_id = ? AND status = 'reserved'`,
  )
    .bind(nowMs, workspaceId, rowId)
    .run();

  if ((r.meta?.changes ?? 0) === 1) return true;

  const row = await env.DB.prepare(
    `SELECT status FROM email_model_admissions WHERE workspace_id = ? AND email_row_id = ?`,
  )
    .bind(workspaceId, rowId)
    .first<{ status: string }>();

  return row?.status === "consumed";
}








export async function releaseEmailModelAdmission(
  env: Env,
  workspaceId: string,
  rowId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT day, peer_scope, status FROM email_model_admissions WHERE workspace_id = ? AND email_row_id = ?`,
  )
    .bind(workspaceId, rowId)
    .first<{ day: string; peer_scope: string; status: string }>();

  if (!row || row.status !== "reserved") {
    return false;
  }

  const transitionToken = crypto.randomUUID();
  const updateAdmission = env.DB.prepare(
    `UPDATE email_model_admissions
     SET status = 'released', released_at = ?, transition_token = ?
     WHERE workspace_id = ? AND email_row_id = ? AND status = 'reserved'`,
  ).bind(nowMs, transitionToken, workspaceId, rowId);

  const refundTotal = env.DB.prepare(
    `UPDATE email_counters
     SET count = count - 1, updated_at = ?
     WHERE workspace_id = ? AND day = ? AND scope = 'inbound_model' AND count > 0
       AND EXISTS (
         SELECT 1 FROM email_model_admissions
         WHERE workspace_id=? AND email_row_id=? AND status='released' AND transition_token=?
       )`,
  ).bind(nowMs, workspaceId, row.day, workspaceId, rowId, transitionToken);

  const refundPeer = env.DB.prepare(
    `UPDATE email_counters
     SET count = count - 1, updated_at = ?
     WHERE workspace_id = ? AND day = ? AND scope = ? AND count > 0
       AND EXISTS (
         SELECT 1 FROM email_model_admissions
         WHERE workspace_id=? AND email_row_id=? AND status='released' AND transition_token=?
       )`,
  ).bind(nowMs, workspaceId, row.day, row.peer_scope, workspaceId, rowId, transitionToken);

  const results = await env.DB.batch([updateAdmission, refundTotal, refundPeer]);
  const changes = (results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0;
  return changes === 1;
}
