



//   sha256hex("trust_action:" + token)

import type { Env } from "../../../env";
import { newId } from "../../../util";
import { sha256hex } from "../../../crypto";
import { enqueueOutbox, getOutboundMessageId } from "../outbox";

export const TRUST_INVITE_TTL_MS = 7 * 86_400_000;

export async function trustInviteTokenHash(token: string): Promise<string> {
  return sha256hex(`trust_action:${token}`);
}

export interface CreateTrustInviteOpts {
  workspaceId: string;

  peerAddress: string;
  peerAgent?: string;
  peerIssuer?: string;
  relation?: string;
  displayName?: string;
  disclosure?: Record<string, unknown>;
  ttlMs?: number;
  publicBaseUrl?: string;

  send?: boolean;
  nowMs?: number;
}

export interface CreateTrustInviteResult {
  ok: boolean;
  edgeId?: string;
  inviteId?: string;
  token?: string;
  actionUrl?: string;
  expiresAt?: number;
  outboxId?: string;
  error?: string;
}





export async function createTrustInvite(env: Env, opts: CreateTrustInviteOpts): Promise<CreateTrustInviteResult> {
  const peer = String(opts.peerAddress ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(peer)) return { ok: false, error: "invalid_peer_address" };
  const nowMs = opts.nowMs ?? Date.now();
  const expiresAt = nowMs + (opts.ttlMs ?? TRUST_INVITE_TTL_MS);

  const existing = await env.DB.prepare(`SELECT id, status FROM trust_edges WHERE workspace_id=? AND peer_address=?`)
    .bind(opts.workspaceId, peer)
    .first<{ id: string; status: string }>();
  let edgeId = existing?.id ?? "";
  if (existing) {
    if (existing.status === "blocked" || existing.status === "revoked" || existing.status === "declined") {
      return { ok: false, error: `edge_${existing.status}` };
    }
    await env.DB.prepare(
      `UPDATE trust_edges SET peer_agent=COALESCE(?, peer_agent), peer_issuer=COALESCE(?, peer_issuer),
         display_name=COALESCE(?, display_name), relation=COALESCE(?, relation) WHERE id=?`,
    )
      .bind(opts.peerAgent?.toLowerCase() ?? null, opts.peerIssuer?.toLowerCase() ?? null, opts.displayName ?? null, opts.relation ?? null, edgeId)
      .run();
  } else {
    edgeId = newId("te");
    const disclosure = JSON.stringify(opts.disclosure ?? {});
    await env.DB.prepare(
      `INSERT INTO trust_edges (id, workspace_id, peer_address, peer_agent, peer_issuer, display_name, relation, status, disclosure_json, auto_accept, invited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)
       ON CONFLICT(workspace_id, peer_address) DO NOTHING`,
    )
      .bind(
        edgeId,
        opts.workspaceId,
        peer,
        opts.peerAgent?.toLowerCase() ?? null,
        opts.peerIssuer?.toLowerCase() ?? null,
        opts.displayName ?? null,
        opts.relation ?? "assistant",
        disclosure,
        nowMs,
      )
      .run();
    const row = await env.DB.prepare(`SELECT id FROM trust_edges WHERE workspace_id=? AND peer_address=?`)
      .bind(opts.workspaceId, peer)
      .first<{ id: string }>();
    if (!row) return { ok: false, error: "edge_create_failed" };
    edgeId = row.id;
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16)); // 128-bit
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await trustInviteTokenHash(token);
  const inviteId = newId("ti");
  await env.DB.prepare(
    `INSERT INTO trust_invites (id, workspace_id, edge_id, recipient_address, token_hash, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(inviteId, opts.workspaceId, edgeId, peer, hash, expiresAt, nowMs)
    .run();

  const base = (opts.publicBaseUrl ?? env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const actionUrl = base ? `${base}/trust/action/${token}` : `/trust/action/${token}`;
  const result: CreateTrustInviteResult = { ok: true, edgeId, inviteId, token, actionUrl, expiresAt };
  if (opts.send === false) return result;

  const mailbox = await env.DB.prepare(`SELECT address FROM agent_mailboxes WHERE workspace_id=? AND status='active'`)
    .bind(opts.workspaceId)
    .first<{ address: string }>();
  if (!mailbox?.address) return { ...result, error: "no_active_mailbox" };
  const textBody = [
    "你的助理希望与对方助理建立信任关系（仅用于日程协调等授权范围，可随时停止）。",
    "",
    `确认链接：${actionUrl}`,
    "",
    "打开链接只会展示确认页；只有点击“接受”才会生效。若不是你发起的，请忽略本邮件。",
  ].join("\n");
  const enq = await enqueueOutbox(env, {
    workspaceId: opts.workspaceId,
    logicalKey: `trust_invite:${inviteId}`,
    fromAddr: mailbox.address,
    toAddr: peer,
    subject: "信任关系确认 / Trust confirmation",
    textBody,
    headers: { "Auto-Submitted": "auto-generated" },
    messageId: getOutboundMessageId(mailbox.address),
  });
  return { ...result, outboxId: enq.id };
}
