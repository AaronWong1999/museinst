
import type { Env, Channel } from "../../env";
import { newId } from "../../util";
import { sendOutbound } from "../outbound";

export const NOTIFY_LEASE_MS = 60 * 1000;
export const MAX_NOTIFY_ATTEMPTS = 5;




export function shouldNotifyOwner(reason: string): boolean {
  switch (reason) {
    case "stored_empty_body":
    case "empty_body":
    case "stored_stranger_autoreply_off":
    case "stranger_autoreply_off":
    case "global_off":
    case "stranger_global_off":
    case "daily_cap":
    case "stored_stranger_daily_cap":
    case "total_cap_exceeded":
    case "peer_cap_exceeded":
    case "stored_quota_exceeded":
    case "inbound_cap":
    case "billing_hold":
    case "stored_gated":
    case "stored_policy_revoked":
    case "policy_revoked":
    case "host_policy_revoked":
    case "suspension_active":
    case "abuse_suspended":
    case "model_admission_invalid":
    case "processed":
    case "stored_dispatch_exhausted":
    case "dispatch_exhausted":
      return true;


    case "unparseable":
    case "stored_unparseable":
    case "blocked":
    case "stored_blocked":
    case "auto_submitted":
    case "stored_auto_submitted":
    case "address_verification":
    case "transient_dispatch_failed":
    case "dispatch_failed":
    default:
      return false;
  }
}

export interface EnsureNotificationOptions {
  workspaceId: string;
  rowId: string;
  reason: string;
  nowMs?: number;
}





export async function ensureOwnerEmailNotification(
  env: Env,
  opts: EnsureNotificationOptions,
): Promise<string | null> {
  if (!shouldNotifyOwner(opts.reason)) return null;

  const now = opts.nowMs ?? Date.now();
  const id = `notif_${newId("").replace(/^_/, "")}`;

  const r = await env.DB.prepare(
    `INSERT INTO email_owner_notifications (id, workspace_id, email_row_id, kind, reason, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, 'inbound_email', ?, 'queued', 0, ?, ?)
     ON CONFLICT(email_row_id, kind) DO NOTHING`,
  )
    .bind(id, opts.workspaceId, opts.rowId, opts.reason, now, now)
    .run()
    .catch((e) => {
      console.error("[notifications] failed to enqueue owner notification", opts.rowId, e);
      return null;
    });

  if ((r?.meta?.changes ?? 0) === 1) return id;

  const existing = await env.DB.prepare(
    `SELECT id FROM email_owner_notifications WHERE email_row_id=? AND kind='inbound_email'`,
  )
    .bind(opts.rowId)
    .first<{ id: string }>()
    .catch(() => null);

  return existing?.id ?? null;
}

export interface DriveNotificationsResult {
  sent: number;
  retried: number;
  failed: number;
}


export async function recoverExpiredOwnerNotificationLeases(
  env: Env,
  nowMs = Date.now(),
): Promise<{ retried: number; failed: number }> {
  const failedRes = await env.DB.prepare(
    `UPDATE email_owner_notifications
     SET status='permanent_failed',
         last_error=COALESCE(last_error, 'notification_lease_expired'),
         lease_token=NULL,
         lease_until=NULL,
         next_attempt_at=NULL
     WHERE status='sending'
       AND lease_until IS NOT NULL
       AND lease_until < ?
       AND attempts >= ?`,
  )
    .bind(nowMs, MAX_NOTIFY_ATTEMPTS)
    .run()
    .catch((e) => {
      console.error("[notifications] failed to expire exhausted leases", e);
      return null;
    });

  const retryRes = await env.DB.prepare(
    `UPDATE email_owner_notifications
     SET status='retry_wait',
         next_attempt_at=?,
         last_error=COALESCE(last_error, 'notification_lease_expired'),
         lease_token=NULL,
         lease_until=NULL
     WHERE status='sending'
       AND lease_until IS NOT NULL
       AND lease_until < ?
       AND attempts < ?`,
  )
    .bind(nowMs, nowMs, MAX_NOTIFY_ATTEMPTS)
    .run()
    .catch((e) => {
      console.error("[notifications] failed to recover expired leases", e);
      return null;
    });

  return {
    retried: retryRes?.meta?.changes ?? 0,
    failed: failedRes?.meta?.changes ?? 0,
  };
}





export async function driveOwnerEmailNotifications(
  env: Env,
  limit = 20,
  nowMs = Date.now(),
): Promise<DriveNotificationsResult> {
  let sent = 0;
  let retried = 0;
  let failed = 0;

  const recovered = await recoverExpiredOwnerNotificationLeases(env, nowMs);
  retried += recovered.retried;
  failed += recovered.failed;

  const due = await env.DB.prepare(
    `SELECT id, workspace_id, email_row_id, reason, attempts
     FROM email_owner_notifications
     WHERE status IN ('queued', 'retry_wait')
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(nowMs, limit)
    .all<{
      id: string;
      workspace_id: string;
      email_row_id: string;
      reason: string;
      attempts: number;
    }>()
    .catch((e) => {
      console.error("[notifications] failed to fetch due notifications", e);
      return { results: [] };
    });

  for (const item of due.results ?? []) {
    const leaseToken = crypto.randomUUID();
    const leaseUntil = nowMs + NOTIFY_LEASE_MS;

    const cas = await env.DB.prepare(
      `UPDATE email_owner_notifications
       SET status='sending',
           lease_token=?,
           lease_until=?,
           attempts=attempts+1
       WHERE id=? AND status IN ('queued', 'retry_wait')`,
    )
      .bind(leaseToken, leaseUntil, item.id)
      .run()
      .catch(() => null);

    if ((cas?.meta?.changes ?? 0) !== 1) continue;

    const mail = await env.DB.prepare(
      `SELECT from_addr, to_addr, subject, thread_id FROM email_messages WHERE id=? AND workspace_id=?`,
    )
      .bind(item.email_row_id, item.workspace_id)
      .first<{ from_addr: string; to_addr: string; subject: string | null; thread_id: string }>()
      .catch(() => null);

    if (!mail) {
      await env.DB.prepare(
        `UPDATE email_owner_notifications
         SET status='permanent_failed', last_error='mail_missing', lease_token=NULL, lease_until=NULL
         WHERE id=? AND lease_token=?`,
      )
        .bind(item.id, leaseToken)
        .run()
        .catch(() => {});
      failed++;
      continue;
    }

    const replyKey = `reply:${item.email_row_id}:0`;
    const outboxRow = await env.DB.prepare(
      `SELECT status FROM email_outbox WHERE workspace_id=? AND logical_key=? LIMIT 1`,
    )
      .bind(item.workspace_id, replyKey)
      .first<{ status: string }>()
      .catch(() => null);

    const messageText = formatOwnerNotificationText(mail.to_addr, mail.from_addr, mail.subject, item.reason, outboxRow?.status ?? null);
    const route = await resolveOwnerNotificationChannel(env, item.workspace_id);

    if (route.channel === "web") {
      await markNotificationSuccess(env, item.id, item.email_row_id, leaseToken, nowMs);
      sent++;
      continue;
    }

    try {
      const sendRes = await sendOutbound(
        env,
        route.channel as Channel,
        route.externalId!,
        messageText,
      );

      const accepted = sendRes.ok || sendRes.error === "no_context_token_queued";

      if (accepted) {
        await markNotificationSuccess(env, item.id, item.email_row_id, leaseToken, nowMs);
        sent++;
      } else {
        const nextAttempts = item.attempts + 1;
        if (nextAttempts >= MAX_NOTIFY_ATTEMPTS) {
          await env.DB.prepare(
            `UPDATE email_owner_notifications
             SET status='permanent_failed',
                 last_error=?,
                 lease_token=NULL,
                 lease_until=NULL
             WHERE id=? AND lease_token=?`,
          )
            .bind(sendRes.error || "send_failed", item.id, leaseToken)
            .run()
            .catch(() => {});
          failed++;
        } else {
          const delayMs = 30_000 * nextAttempts;
          await env.DB.prepare(
            `UPDATE email_owner_notifications
             SET status='retry_wait',
                 next_attempt_at=?,
                 last_error=?,
                 lease_token=NULL,
                 lease_until=NULL
             WHERE id=? AND lease_token=?`,
          )
            .bind(nowMs + delayMs, sendRes.error || "send_failed", item.id, leaseToken)
            .run()
            .catch(() => {});
          retried++;
        }
      }
    } catch (err) {
      console.error("[notifications] outbound dispatch error", item.id, err);
      const nextAttempts = item.attempts + 1;
      if (nextAttempts >= MAX_NOTIFY_ATTEMPTS) {
        await env.DB.prepare(
          `UPDATE email_owner_notifications
           SET status='permanent_failed',
               last_error=?,
               lease_token=NULL,
               lease_until=NULL
           WHERE id=? AND lease_token=?`,
        )
          .bind(String(err).slice(0, 200), item.id, leaseToken)
          .run()
          .catch(() => {});
        failed++;
      } else {
        await env.DB.prepare(
          `UPDATE email_owner_notifications
           SET status='retry_wait',
               next_attempt_at=?,
               last_error=?,
               lease_token=NULL,
               lease_until=NULL
           WHERE id=? AND lease_token=?`,
        )
          .bind(nowMs + 30_000 * nextAttempts, String(err).slice(0, 200), item.id, leaseToken)
          .run()
          .catch(() => {});
        retried++;
      }
    }
  }

  return { sent, retried, failed };
}


async function markNotificationSuccess(
  env: Env,
  notifId: string,
  emailRowId: string,
  leaseToken: string,
  nowMs: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_owner_notifications
       SET status='sent',
           sent_at=?,
           lease_token=NULL,
           lease_until=NULL
       WHERE id=? AND lease_token=?`,
    ).bind(nowMs, notifId, leaseToken),
    env.DB.prepare(
      `UPDATE email_messages
       SET notified_at=COALESCE(notified_at, ?)
       WHERE id=?
         AND EXISTS (
           SELECT 1 FROM email_owner_notifications
           WHERE id=? AND status='sent'
         )`,
    ).bind(nowMs, emailRowId, notifId),
  ]).catch((e) => console.error("[notifications] mark success batch failed", notifId, e));
}




export async function resolveOwnerNotificationChannel(
  env: Env,
  workspaceId: string,
): Promise<{ channel: "wechat" | "telegram" | "web"; externalId?: string }> {
  const mailbox = await env.DB.prepare(
    `SELECT notify_channel FROM agent_mailboxes WHERE workspace_id=? AND status='active'`,
  )
    .bind(workspaceId)
    .first<{ notify_channel: string | null }>()
    .catch(() => null);

  const preferred = mailbox?.notify_channel;
  if (preferred === "wechat" || preferred === "telegram") {
    const ident = await env.DB.prepare(
      `SELECT external_id FROM channel_identities WHERE workspace_id=? AND channel=? ORDER BY last_seen_at DESC LIMIT 1`,
    )
      .bind(workspaceId, preferred)
      .first<{ external_id: string }>()
      .catch(() => null);

    if (ident?.external_id) {
      return { channel: preferred, externalId: ident.external_id };
    }
  }

  const wechat = await env.DB.prepare(
    `SELECT external_id FROM channel_identities WHERE workspace_id=? AND channel='wechat' ORDER BY last_seen_at DESC LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ external_id: string }>()
    .catch(() => null);

  if (wechat?.external_id) {
    return { channel: "wechat", externalId: wechat.external_id };
  }

  const tg = await env.DB.prepare(
    `SELECT external_id FROM channel_identities WHERE workspace_id=? AND channel='telegram' ORDER BY last_seen_at DESC LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ external_id: string }>()
    .catch(() => null);

  if (tg?.external_id) {
    return { channel: "telegram", externalId: tg.external_id };
  }

  return { channel: "web" };
}




export function formatOwnerNotificationText(
  agentAddress: string,
  fromAddr: string,
  subject: string | null,
  reason: string,
  outboxStatus: string | null,
): string {
  const sub = (subject ?? "无主题").trim().slice(0, 80);
  let replyDesc = "已收下，未自动回复。";

  if (outboxStatus === "accepted") {
    replyDesc = "已自动回复。";
  } else if (outboxStatus === "accepted_pending_commit") {
    replyDesc = "邮件服务已接受，正在确认状态。";
  } else if (outboxStatus === "queued" || outboxStatus === "sending" || outboxStatus === "retry_wait") {
    replyDesc = "已生成自动回复，正在投递。";
  } else if (outboxStatus === "delivery_unknown") {
    replyDesc = "已生成自动回复，但投递结果未知。";
  } else if (outboxStatus === "permanent_failed") {
    replyDesc = "自动回复投递失败。";
  } else if (reason === "stored_empty_body" || reason === "empty_body") {
    replyDesc = "邮件正文为空，未自动回复。";
  } else if (reason.includes("stranger_autoreply_off")) {
    replyDesc = "已收录该邮件，陌生人自动回复已关闭。";
  } else if (reason.includes("quota_exceeded") || reason.includes("cap")) {
    replyDesc = "已收录该邮件，今日收件模型额度已满。";
  } else if (reason.includes("exhausted")) {
    replyDesc = "邮件已收到，但自动处理失败，请在工作台查看。";
  } else if (reason.includes("revoked") || reason.includes("gated") || reason.includes("admission_invalid")) {
    replyDesc = "已收录该邮件，未触发自动回复。";
  } else if (reason === "processed") {
    replyDesc = "已收下，未自动回复。";
  }

  return `有人给 ${agentAddress} 写信：${fromAddr} / “${sub}”。\n${replyDesc}\n对我说“看邮件”或打开工作台可查看。`;
}
