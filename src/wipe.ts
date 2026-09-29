import type { Env } from "./env";

export function wipeWorkspaceStatements(env: Env, workspaceId: string, userId?: string) {
  return [
    // Telegram inbox/outbox rows carry the chat id, not the workspace; a private
    // chat id equals the bound Telegram user id. These run before identities go.
    env.DB.prepare(
      `DELETE FROM channel_outbox WHERE channel='telegram' AND destination_id IN (SELECT external_id FROM channel_identities WHERE workspace_id=? AND channel='telegram')`,
    ).bind(workspaceId),
    env.DB.prepare(
      `DELETE FROM channel_inbox WHERE channel='telegram' AND CAST(COALESCE(
         json_extract(payload_json, '$.message.chat.id'),
         json_extract(payload_json, '$.edited_message.chat.id'),
         json_extract(payload_json, '$.callback_query.message.chat.id')) AS TEXT) IN (SELECT external_id FROM channel_identities WHERE workspace_id=? AND channel='telegram')`,
    ).bind(workspaceId),
    env.DB.prepare(`DELETE FROM channel_identities WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM sessions WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM unbind_cooldowns WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM connections WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM mailbox_accounts WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM google_file_grants WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM connector_slots WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM connector_audit WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM imap_send_idempotency WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM vault_items WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM encrypted_secrets WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM email_outbox WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM email_messages WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM email_contacts WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM email_thread_capabilities WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM email_counters WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM agent_mailboxes WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM trust_control_seen WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM trust_requests WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM trust_invites WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM trust_edges WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM a2a_initiations WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM a2a_messages WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM a2a_convos WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM a2a_seq_reservations WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM a2a_domain_consents WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM a2a_optouts WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM task_goal_revisions WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=?)`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM browser_sessions WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM browser_access_grants WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM browser_control_leases WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM goal_milestones WHERE goal_id IN (SELECT id FROM goals WHERE workspace_id=?)`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM goals WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM ideas WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM a2a_outbound_intents WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM a2a_outbound_commit_asserts WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM email_owner_notifications WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM email_model_admissions WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM artifacts WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM recipes WHERE author_workspace=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM wechat_bots WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM task_receipts WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=?)`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM task_evidence WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=?)`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=?)`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM tasks WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM approvals WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM location_points WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM saved_places WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM location_triggers WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM settings WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM usage_daily WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM bind_nonces WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM oauth_states WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM wechat_outbox WHERE workspace_id=?`).bind(workspaceId),
    env.DB.prepare(`DELETE FROM workspaces WHERE id=?`).bind(workspaceId),
    ...(userId ? [env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(userId)] : []),
    // When the last workspace is gone, release the self-host claim so the next
    // owner starts clean instead of inheriting the previous claim lock.
    env.DB.prepare(
      `DELETE FROM settings WHERE workspace_id='__global' AND key IN ('owner_claimed_at', 'owner_recovery_key_sha256')
         AND NOT EXISTS (SELECT 1 FROM workspaces)`,
    ),
  ];
}

/** Clears Durable Object state that D1 deletes cannot reach: WeChat poller tokens and the browser worker. */
export async function wipeWorkspaceDurableState(env: Env, workspaceId: string): Promise<void> {
  const bots = await env.DB.prepare(`SELECT id FROM wechat_bots WHERE workspace_id=?`)
    .bind(workspaceId).all<{ id: string }>();
  if (env.WECHAT_POLLER) {
    for (const bot of bots.results ?? []) {
      const stub = env.WECHAT_POLLER.get(env.WECHAT_POLLER.idFromName(bot.id));
      const res = await stub.fetch("https://poller/unregister", { method: "POST" });
      if (!res.ok) throw new Error(`wechat_poller_unregister_http_${res.status}`);
    }
  }
  if (env.BROWSER_WORKER) {
    const stub = env.BROWSER_WORKER.get(env.BROWSER_WORKER.idFromName(workspaceId));
    const res = await stub.fetch("https://browser/wipe", { method: "POST" });
    if (!res.ok) throw new Error(`browser_worker_wipe_http_${res.status}`);
  }
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const listed = await bucket.list({ prefix, cursor });
    for (const object of listed.objects ?? []) {
      await bucket.delete(object.key);
    }
    if (!listed.truncated || !listed.cursor) return;
    cursor = listed.cursor;
  }
  throw new Error(`R2 deletion exceeded page limit for prefix ${prefix}`);
}

export async function wipeWorkspaceArtifacts(env: Env, workspaceId: string): Promise<void> {
  const receipts = await env.DB.prepare(
    `SELECT tr.share_slug
       FROM task_receipts tr
       JOIN tasks t ON t.id=tr.task_id
      WHERE t.workspace_id=? AND tr.share_slug IS NOT NULL`,
  ).bind(workspaceId).all<{ share_slug: string }>();
  for (const row of receipts.results ?? []) {
    if (row.share_slug) await env.ARTIFACTS.delete(`receipts/${row.share_slug}.jpg`);
  }

  const mailObjects = await env.DB.prepare(
    `SELECT r2_key FROM email_messages WHERE workspace_id=? AND r2_key IS NOT NULL`,
  ).bind(workspaceId).all<{ r2_key: string }>();
  for (const row of mailObjects.results ?? []) {
    if (row.r2_key) await env.ARTIFACTS.delete(row.r2_key);
  }

  await deletePrefix(env.ARTIFACTS, `${workspaceId}/`);
  await deletePrefix(env.ARTIFACTS, `email/raw/${workspaceId}/`);
}

export function disconnectProviderStatements(env: Env, workspaceId: string, provider: string) {
  return [
    env.DB.prepare(`DELETE FROM connections WHERE workspace_id=? AND provider=?`).bind(workspaceId, provider),
    env.DB.prepare(`DELETE FROM vault_items WHERE workspace_id=? AND kind='token' AND label=?`).bind(workspaceId, provider),
    ...(provider === "google"
      ? [env.DB.prepare(`DELETE FROM google_file_grants WHERE workspace_id=?`).bind(workspaceId)]
      : []),
    env.DB.prepare(`DELETE FROM connector_slots WHERE workspace_id=? AND slot_key LIKE ?`).bind(workspaceId, `oauth:${provider}:%`),
  ];
}
