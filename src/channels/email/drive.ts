
import type { Env } from "../../env";
import { queueEmailDispatch } from "./dispatch-queue";
import { releaseEmailModelAdmission } from "./admission";
import { getHostHooks, type ExternalEventClaims } from "../../hooks";

export const DISPATCH_QUEUED_RETRY_DELAY_MS = 60 * 1000;
export const MAX_RECOVERY_ATTEMPTS = 5;

export interface SweepEmailDispatchResult {
  requeued: number;
  staleRecovered: number;
  exhausted: number;
}





export async function sweepEmailDispatchQueue(
  env: Env,
  limit = 50,
  nowMs = Date.now(),
): Promise<SweepEmailDispatchResult> {
  let requeued = 0;
  let staleRecovered = 0;
  let exhausted = 0;
  const handledIds = new Set<string>();


  const unconfirmedRows = await env.DB.prepare(
    `SELECT id, workspace_id, scope_key, thread_id, from_addr, capability_id
     FROM email_messages
     WHERE ingest_state = 'dispatch_queued'
       AND (dispatch_enqueued_at IS NULL OR dispatch_enqueued_at < ?)
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(nowMs - DISPATCH_QUEUED_RETRY_DELAY_MS, limit)
    .all<{
      id: string;
      workspace_id: string;
      scope_key: string;
      thread_id: string;
      from_addr: string;
      capability_id: string | null;
    }>()
    .catch((e) => {
      console.error("[sweep-email] failed to query unconfirmed dispatch_queued", e);
      return { results: [] };
    });

  for (const row of unconfirmedRows.results ?? []) {
    handledIds.add(row.id);
    try {
      await queueEmailDispatch(env, { rowId: row.id, workspaceId: row.workspace_id });
      requeued++;
    } catch (e) {
      console.warn("[sweep-email] failed to requeue unconfirmed row", row.id, e);
    }
  }


  const staleRows = await env.DB.prepare(
    `SELECT id, workspace_id, ingest_attempts, scope_key, thread_id, from_addr, capability_id
     FROM email_messages
     WHERE ingest_state = 'processing'
       AND ingest_lease_until IS NOT NULL
       AND ingest_lease_until < ?
     ORDER BY processing_started_at ASC
     LIMIT ?`,
  )
    .bind(nowMs, limit)
    .all<{
      id: string;
      workspace_id: string;
      ingest_attempts: number;
      scope_key: string;
      thread_id: string;
      from_addr: string;
      capability_id: string | null;
    }>()
    .catch((e) => {
      console.error("[sweep-email] failed to query stale processing rows", e);
      return { results: [] };
    });

  for (const row of staleRows.results ?? []) {
    handledIds.add(row.id);
    const cas = await env.DB.prepare(
      `UPDATE email_messages
       SET ingest_state = 'dispatch_failed',
           ingest_last_error = 'lease_expired',
           ingest_lease_token = NULL,
           ingest_lease_until = NULL
       WHERE id = ? AND ingest_state = 'processing' AND ingest_lease_until < ?`,
    )
      .bind(row.id, nowMs)
      .run()
      .catch(() => null);

    if ((cas?.meta?.changes ?? 0) === 1) {
      staleRecovered++;
      if (Number(row.ingest_attempts ?? 0) < MAX_RECOVERY_ATTEMPTS) {
        try {
          await queueEmailDispatch(env, { rowId: row.id, workspaceId: row.workspace_id });
          requeued++;
        } catch (e) {
          console.warn("[sweep-email] failed to requeue stale row", row.id, e);
        }
      } else {
        await markExhausted(env, row, nowMs);
        exhausted++;
      }
    }
  }


  const failedRows = await env.DB.prepare(
    `SELECT id, workspace_id, ingest_attempts, scope_key, thread_id, from_addr, capability_id
     FROM email_messages
     WHERE ingest_state = 'dispatch_failed'
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      workspace_id: string;
      ingest_attempts: number;
      scope_key: string;
      thread_id: string;
      from_addr: string;
      capability_id: string | null;
    }>()
    .catch((e) => {
      console.error("[sweep-email] failed to query dispatch_failed rows", e);
      return { results: [] };
    });

  for (const row of failedRows.results ?? []) {
    if (handledIds.has(row.id)) continue;
    handledIds.add(row.id);
    if (Number(row.ingest_attempts ?? 0) < MAX_RECOVERY_ATTEMPTS) {
      try {
        await queueEmailDispatch(env, { rowId: row.id, workspaceId: row.workspace_id });
        requeued++;
      } catch (e) {
        console.warn("[sweep-email] failed to requeue failed row", row.id, e);
      }
    } else {
      await markExhausted(env, row, nowMs);
      exhausted++;
    }
  }

  return { requeued, staleRecovered, exhausted };
}

async function markExhausted(
  env: Env,
  row: {
    id: string;
    workspace_id: string;
    scope_key: string;
    thread_id: string;
    from_addr: string;
    capability_id: string | null;
  },
  nowMs: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE email_messages
     SET ingest_state = 'stored_dispatch_exhausted',
         processing_finished_at = ?,
         ingest_lease_token = NULL,
         ingest_lease_until = NULL
     WHERE id = ? AND ingest_state IN ('dispatch_failed', 'processing')`,
  )
    .bind(nowMs, row.id)
    .run()
    .catch(() => {});

  await releaseEmailModelAdmission(env, row.workspace_id, row.id, nowMs).catch(() => false);

  const claims: ExternalEventClaims = {
    source: "email",
    workspaceId: row.workspace_id,
    scopeKey: row.scope_key,
    emailMessageRowId: row.id,
    threadId: row.thread_id,
    peerAddress: row.from_addr,
    capabilityId: row.capability_id ?? undefined,
  };
  await getHostHooks().releaseExternalEventAdmission?.(env, claims).catch(() => undefined);

  const { ensureOwnerEmailNotification } = await import("./notifications");
  await ensureOwnerEmailNotification(env, {
    workspaceId: row.workspace_id,
    rowId: row.id,
    reason: "stored_dispatch_exhausted",
    nowMs,
  }).catch(() => null);
}
