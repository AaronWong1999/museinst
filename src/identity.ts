import type { Env } from "./env";
import { newId, now } from "./util";

export type BindResult =
  | { ok: true; workspaceId: string; created: boolean }
  | { ok: false; error: "duplicate_bind"; existingWorkspaceId: string }
  | { ok: false; error: "cooldown"; existingWorkspaceId: string; daysLeft: number };

export const DUPLICATE_BIND_COPY =
  "这个渠道已经绑定了另一个 MuseInst 账号。一个微信/Telegram 只能绑定一个账号。";

export const COOLDOWN_DAYS = 7;

async function readOwner(
  env: Env,
  channel: string,
  externalId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT workspace_id FROM channel_identities WHERE channel=? AND external_id=?`,
  )
    .bind(channel, externalId)
    .first<{ workspace_id: string }>();
  return row?.workspace_id ?? null;
}

/**
 * Atomically binds one external channel identity to a workspace.
 * Rebinding to the same workspace is idempotent and only updates last_seen_at.
 * Binding to a different workspace during the cooldown window is rejected.
 */
export async function bindChannelIdentity(
  env: Env,
  opts: {
    channel: string;
    externalId: string;
    workspaceId: string;
    displayName?: string;
  },
): Promise<BindResult> {
  const t = now();

  const cooldown = await env.DB.prepare(
    `SELECT workspace_id, unbound_at FROM unbind_cooldowns
      WHERE channel=? AND external_id=?`,
  )
    .bind(opts.channel, opts.externalId)
    .first<{ workspace_id: string; unbound_at: number }>();
  if (
    cooldown &&
    cooldown.workspace_id !== opts.workspaceId &&
    t - cooldown.unbound_at < COOLDOWN_DAYS * 24 * 3600 * 1000
  ) {
    const daysLeft = Math.max(
      1,
      Math.ceil(
        (COOLDOWN_DAYS * 24 * 3600 * 1000 - (t - cooldown.unbound_at)) /
          (24 * 3600 * 1000),
      ),
    );
    return {
      ok: false,
      error: "cooldown",
      existingWorkspaceId: cooldown.workspace_id,
      daysLeft,
    };
  }

  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO channel_identities
       (channel, external_id, workspace_id, display_name, first_bound_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.channel,
      opts.externalId,
      opts.workspaceId,
      opts.displayName ?? "",
      t,
      t,
    )
    .run();

  if ((res.meta?.changes ?? 0) === 1) {
    await env.DB.prepare(
      `DELETE FROM unbind_cooldowns WHERE channel=? AND external_id=?`,
    )
      .bind(opts.channel, opts.externalId)
      .run();
    return { ok: true, workspaceId: opts.workspaceId, created: true };
  }

  const owner = await readOwner(env, opts.channel, opts.externalId);
  if (owner === opts.workspaceId) {
    await env.DB.prepare(
      `UPDATE channel_identities SET last_seen_at=? WHERE channel=? AND external_id=?`,
    )
      .bind(t, opts.channel, opts.externalId)
      .run();
    return { ok: true, workspaceId: opts.workspaceId, created: false };
  }
  return {
    ok: false,
    error: "duplicate_bind",
    existingWorkspaceId: owner ?? "",
  };
}

export async function unbindChannelIdentity(
  env: Env,
  channel: string,
  externalId: string,
): Promise<void> {
  const t = now();
  const row = await env.DB.prepare(
    `SELECT workspace_id FROM channel_identities WHERE channel=? AND external_id=?`,
  )
    .bind(channel, externalId)
    .first<{ workspace_id: string }>();
  if (!row) return;

  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM channel_identities WHERE channel=? AND external_id=?`,
    ).bind(channel, externalId),
    env.DB.prepare(
      `INSERT OR REPLACE INTO unbind_cooldowns (channel, external_id, workspace_id, unbound_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(channel, externalId, row.workspace_id, t),
  ]);
}

/** Creates an owner/user workspace. Admission belongs to the calling adapter. */
export async function createWorkspace(
  env: Env,
  opts: { displayName?: string; isAdmin?: boolean } = {},
): Promise<{ userId: string; workspaceId: string }> {
  const t = now();
  const userId = newId("u");
  const workspaceId = newId("w");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, created_at, display_name, is_admin) VALUES (?, ?, ?, ?)`,
    ).bind(userId, t, opts.displayName ?? "", opts.isAdmin ? 1 : 0),
    env.DB.prepare(
      `INSERT INTO workspaces (id, owner_user_id, created_at) VALUES (?, ?, ?)`,
    ).bind(workspaceId, userId, t),
  ]);
  return { userId, workspaceId };
}

export interface ResolvedIdentity {
  workspaceId: string;
  userId: string;
  created: boolean;
}

/**
 * Resolves an already-bound external channel identity.
 * Unknown identities never create users or workspaces. Self-hosted ownership is established
 * only through the explicit owner bootstrap flow and short-lived pairing codes.
 */
export async function resolveIdentity(
  env: Env,
  channel: string,
  externalId: string,
  _displayName?: string,
): Promise<ResolvedIdentity | null> {
  const row = await env.DB.prepare(
    `SELECT ci.workspace_id, w.owner_user_id
       FROM channel_identities ci JOIN workspaces w ON w.id = ci.workspace_id
      WHERE ci.channel=? AND ci.external_id=?`,
  )
    .bind(channel, externalId)
    .first<{ workspace_id: string; owner_user_id: string }>();
  if (!row) return null;

  await env.DB.prepare(
    `UPDATE channel_identities SET last_seen_at=? WHERE channel=? AND external_id=?`,
  )
    .bind(now(), channel, externalId)
    .run();
  return {
    workspaceId: row.workspace_id,
    userId: row.owner_user_id,
    created: false,
  };
}

export const SELF_HOST_OWNER_USER_ID = "u_self_host_owner";
export const SELF_HOST_OWNER_WORKSPACE_ID = "w_self_host_owner";

/**
 * Returns the single self-hosted owner workspace. The deterministic bootstrap identifiers make
 * concurrent first-run requests idempotent: retries can only converge on the same user/workspace.
 * Channel ingress must never call this function.
 */
export async function ensureOwnerWorkspace(
  env: Env,
): Promise<{ workspaceId: string; userId: string; created: boolean }> {
  const existing = await env.DB.prepare(
    `SELECT id, owner_user_id FROM workspaces ORDER BY created_at ASC LIMIT 1`,
  ).first<{ id: string; owner_user_id: string }>();
  if (existing) {
    return {
      workspaceId: existing.id,
      userId: existing.owner_user_id,
      created: false,
    };
  }

  const t = now();
  const userInsert = await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, created_at, display_name, is_admin)
     VALUES (?, ?, 'Owner', 1)`,
  ).bind(SELF_HOST_OWNER_USER_ID, t).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at)
     VALUES (?, ?, ?)`,
  ).bind(SELF_HOST_OWNER_WORKSPACE_ID, SELF_HOST_OWNER_USER_ID, t).run();

  const owner = await env.DB.prepare(
    `SELECT id, owner_user_id FROM workspaces WHERE id=?`,
  ).bind(SELF_HOST_OWNER_WORKSPACE_ID).first<{ id: string; owner_user_id: string }>();
  if (!owner) throw new Error("self_host_owner_bootstrap_failed");

  return {
    workspaceId: owner.id,
    userId: owner.owner_user_id,
    created: (userInsert.meta?.changes ?? 0) === 1,
  };
}

export async function getWorkspaceOwner(
  env: Env,
  workspaceId: string,
): Promise<{ userId: string; displayName: string } | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.display_name FROM workspaces w JOIN users u ON u.id = w.owner_user_id
      WHERE w.id = ?`,
  )
    .bind(workspaceId)
    .first<{ id: string; display_name: string }>();
  return row
    ? { userId: row.id, displayName: row.display_name ?? "" }
    : null;
}

/** Returns all channel bindings for one workspace. */
export async function listBindings(
  env: Env,
  workspaceId: string,
): Promise<
  Array<{
    channel: string;
    external_id: string;
    display_name: string | null;
    first_bound_at: number;
  }>
> {
  const { results } = await env.DB.prepare(
    `SELECT channel, external_id, display_name, first_bound_at
       FROM channel_identities WHERE workspace_id=? ORDER BY first_bound_at`,
  )
    .bind(workspaceId)
    .all<{
      channel: string;
      external_id: string;
      display_name: string | null;
      first_bound_at: number;
    }>();
  return results ?? [];
}
