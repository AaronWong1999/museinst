


import type { Env } from "../../env";
import { isExplicitlyEnabled, newId } from "../../util";
import { getHostHooks } from "../../hooks";
import { findThreadByProviderMessageId } from "./outbox";

export interface MailboxRoute {
  workspaceId: string;
  localPart: string;
  domain: string;
  address: string;
}

export interface MailboxSettings extends MailboxRoute {
  status: string;
  dailyOutCap: number;
  dailyInCap: number;

  strangerAutoreply: boolean;
}


export async function resolveMailbox(env: Env, recipient: string): Promise<MailboxRoute | null> {
  const addr = String(recipient ?? "").trim().toLowerCase();
  const m = addr.match(/^([^@+]+)(?:\+[^@]*)?@([^@]+)$/);
  if (!m) return null;
  const bare = `${m[1]}@${m[2]}`;
  let row = await env.DB.prepare(
    `SELECT workspace_id, local_part, domain, address FROM agent_mailboxes WHERE address=? AND status='active'`,
  )
    .bind(bare)
    .first<{ workspace_id: string; local_part: string; domain: string; address: string }>();
  if (!row) {
    // A mailbox domain move keeps old addresses working: mail to any accepted
    // domain resolves by local part among mailboxes on the accepted domains.
    const accepted = acceptedMailboxDomains(env);
    if (accepted.length > 1 && accepted.includes(m[2])) {
      const placeholders = accepted.map(() => "?").join(",");
      row = await env.DB.prepare(
        `SELECT workspace_id, local_part, domain, address FROM agent_mailboxes
          WHERE local_part=? AND status='active' AND domain IN (${placeholders}) LIMIT 1`,
      )
        .bind(m[1], ...accepted)
        .first<{ workspace_id: string; local_part: string; domain: string; address: string }>();
    }
  }
  if (!row) return null;
  return { workspaceId: row.workspace_id, localPart: row.local_part, domain: row.domain, address: row.address };
}

/** Map an address on a legacy mailbox domain to the same local part on EMAIL_DOMAIN. */
export function currentMailboxAddress(env: Env, address: string): string {
  const addr = String(address ?? "").trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  const primary = String((env as { EMAIL_DOMAIN?: string }).EMAIL_DOMAIN ?? "").trim().toLowerCase();
  if (at <= 0 || !primary) return addr;
  const domain = addr.slice(at + 1);
  if (domain === primary || !acceptedMailboxDomains(env).includes(domain)) return addr;
  return `${addr.slice(0, at)}@${primary}`;
}

/** EMAIL_DOMAIN plus EMAIL_LEGACY_DOMAINS (comma-separated), lower-cased. */
export function acceptedMailboxDomains(env: Env): string[] {
  const primary = String((env as { EMAIL_DOMAIN?: string }).EMAIL_DOMAIN ?? "").trim().toLowerCase();
  const legacy = String((env as { EMAIL_LEGACY_DOMAINS?: string }).EMAIL_LEGACY_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([primary, ...legacy].filter(Boolean))];
}

export const KERNEL_RESERVED_LOCAL_PARTS = new Set([
  "postmaster", "abuse", "noreply", "no-reply", "openinst", "museinst", "security", "admin", "support", "help", "info",
]);

export interface RegisterMailboxOptions {
  strangerAutoreply?: number;
  notifyChannel?: string | null;
}

export async function registerMailbox(
  env: Env,
  workspaceId: string,
  localPart: string,
  domain: string,
  nowMs = Date.now(),
  options?: RegisterMailboxOptions,
): Promise<{ ok: boolean; address?: string; error?: string }> {
  const local = String(localPart ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,30}[a-z0-9]$/.test(local)) return { ok: false, error: "invalid_local_part" };
  if (KERNEL_RESERVED_LOCAL_PARTS.has(local)) return { ok: false, error: "reserved" };
  const address = `${local}@${domain}`;
  const strangerAutoreply = options?.strangerAutoreply ?? 0;
  const notifyChannel = options?.notifyChannel ?? null;
  const r = await env.DB.prepare(
    `INSERT INTO agent_mailboxes (workspace_id, local_part, domain, address, status, stranger_autoreply, notify_channel, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(workspaceId, local, domain, address, strangerAutoreply, notifyChannel, nowMs, nowMs)
    .run()
    .catch(() => null);
  if ((r?.meta?.changes ?? 0) !== 1) {
    const existing = await env.DB.prepare(`SELECT workspace_id FROM agent_mailboxes WHERE address=?`)
      .bind(address)
      .first<{ workspace_id: string }>()
      .catch(() => null);
    if (existing?.workspace_id === workspaceId) return { ok: true, address };
    return { ok: false, error: "taken" };
  }
  return { ok: true, address };
}





export async function normalizeThread(
  env: Env,
  opts: { workspaceId: string; inReplyTo: string | null; references: string[] },
): Promise<string> {
  const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();
  const irt = norm(opts.inReplyTo);
  if (irt) {
    const hit = await findThreadByMessageId(env, opts.workspaceId, irt);
    if (hit) return hit;
  }
  const refs = (opts.references ?? []).map(norm).filter(Boolean).reverse();
  for (const ref of refs) {
    const hit = await findThreadByMessageId(env, opts.workspaceId, ref);
    if (hit) return hit;
  }
  return `th_${newId("").replace(/^_/, "")}`;
}





async function findThreadByMessageId(env: Env, workspaceId: string, messageId: string): Promise<string | null> {
  const a = await env.DB.prepare(`SELECT thread_id FROM email_messages WHERE workspace_id=? AND message_id=? LIMIT 1`)
    .bind(workspaceId, messageId)
    .first<{ thread_id: string }>()
    .catch(() => null);
  if (a?.thread_id) return a.thread_id;

  const provider = await findThreadByProviderMessageId(env, workspaceId, messageId);
  if (provider) return provider;
  const b = await env.DB.prepare(`SELECT thread_id FROM email_outbox WHERE workspace_id=? AND message_id=? LIMIT 1`)
    .bind(workspaceId, messageId)
    .first<{ thread_id: string | null }>()
    .catch(() => null);
  return b?.thread_id ?? null;
}



export async function getMailboxSettings(env: Env, workspaceId: string): Promise<MailboxSettings | null> {
  const row = await env.DB.prepare(
    `SELECT workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply
       FROM agent_mailboxes WHERE workspace_id=?`,
  )
    .bind(workspaceId)
    .first<{
      workspace_id: string; local_part: string; domain: string; address: string;
      status: string; daily_out_cap: number; daily_in_cap: number; stranger_autoreply: number;
    }>();
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    localPart: row.local_part,
    domain: row.domain,
    address: row.address,
    status: row.status,
    dailyOutCap: Number(row.daily_out_cap ?? 0),
    dailyInCap: Number(row.daily_in_cap ?? 0),
    strangerAutoreply: Number(row.stranger_autoreply ?? 0) === 1,
  };
}



const RAW_MIME_PREFIX = "email/raw";

export function rawMimeKey(workspaceId: string, messageRowId: string): string {
  return `${RAW_MIME_PREFIX}/${workspaceId}/${messageRowId}`;
}





export async function putRawMime(env: Env, workspaceId: string, messageRowId: string, raw: ArrayBuffer): Promise<string | null> {
  const r2 = env.ARTIFACTS as R2Bucket | undefined;
  if (!r2 || typeof r2.put !== "function") return null;
  const key = rawMimeKey(workspaceId, messageRowId);
  try {
    await r2.put(key, raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { workspaceId, messageRowId, createdAt: String(Date.now()) },
    });
    return key;
  } catch (e) {
    console.error("[email] raw MIME put failed", messageRowId, String(e));
    return null;
  }
}


export async function getRawMime(env: Env, workspaceId: string, key: string | null): Promise<ArrayBuffer | null> {
  const r2 = env.ARTIFACTS as R2Bucket | undefined;
  if (!r2 || typeof r2.get !== "function" || !key) return null;
  if (!String(key).startsWith(`${RAW_MIME_PREFIX}/${workspaceId}/`)) return null;
  const obj = await r2.get(String(key));
  if (!obj) return null;
  return await obj.arrayBuffer();
}



export type EmailQuotaScope = "outbound_send" | "inbound_model";

export interface EmailQuotaReservation {
  allowed: boolean;
  reason: "reserved" | "cap_exceeded";
  count: number;
  cap: number;
}







export async function reserveEmailQuota(
  env: Env,
  workspaceId: string,
  day: string,
  scope: EmailQuotaScope,
  cap: number,
): Promise<EmailQuotaReservation> {
  const limit = Math.floor(Number(cap));
  if (!Number.isFinite(limit) || limit <= 0) return { allowed: false, reason: "cap_exceeded", count: 0, cap: 0 };
  const t = Date.now();
  await env.DB.prepare(
    `INSERT INTO email_counters (workspace_id, day, scope, count, updated_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(workspace_id, day, scope) DO NOTHING`,
  )
    .bind(workspaceId, day, scope, t)
    .run();
  const cas = await env.DB.prepare(
    `UPDATE email_counters SET count = count + 1, updated_at = ?
      WHERE workspace_id=? AND day=? AND scope=? AND count < ?`,
  )
    .bind(t, workspaceId, day, scope, limit)
    .run();
  if ((cas.meta?.changes ?? 0) === 1) return { allowed: true, reason: "reserved", count: -1, cap: limit };
  const row = await env.DB.prepare(`SELECT count FROM email_counters WHERE workspace_id=? AND day=? AND scope=?`)
    .bind(workspaceId, day, scope)
    .first<{ count: number }>()
    .catch(() => null);
  return { allowed: false, reason: "cap_exceeded", count: Number(row?.count ?? limit), cap: limit };
}





export async function refundEmailQuota(env: Env, workspaceId: string, day: string, scope: EmailQuotaScope): Promise<void> {
  await env.DB.prepare(
    `UPDATE email_counters SET count = count - 1, updated_at = ?
      WHERE workspace_id=? AND day=? AND scope=? AND count > 0`,
  )
    .bind(Date.now(), workspaceId, day, scope)
    .run();
}



export interface EmailOutboundDecision {
  allow: boolean;
  reason: string;
}








export async function emailOutboundAllowed(env: Env, workspaceId: string): Promise<EmailOutboundDecision> {
  if (!isExplicitlyEnabled(env.AGENT_EMAIL_OUTBOUND_ENABLED)) return { allow: false, reason: "outbound_disabled" };
  const box = await getMailboxSettings(env, workspaceId);
  if (!box) return { allow: false, reason: "mailbox_missing" };
  if (box.status !== "active") return { allow: false, reason: `mailbox_${box.status}` };
  const hook = getHostHooks().beforeOutboundSend;
  if (hook) {
    try {
      const decision = await hook(env, { channel: "email", workspaceId, source: "cron_outbox" });
      if (!decision?.allow) return { allow: false, reason: decision?.reason ?? "host_blocked" };
    } catch (e) {
      console.error("[email] outbound host gate failed; fail closed", workspaceId, String(e));
      return { allow: false, reason: "host_gate_error" };
    }
  }
  return { allow: true, reason: "ok" };
}


export function emailQuotaDay(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
export const todayQuotaDay = emailQuotaDay;



export interface EmailMessageFull {
  id: string;
  workspaceId: string;
  direction: string;
  threadId: string;
  fromAddr: string;
  toAddr: string;
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{ filename: string | null; mimeType: string; size: number }>;
  messageAuth: string;
  createdAt: number;

  bodyAvailable: boolean;
}





export async function readEmailMessage(env: Env, workspaceId: string, id: string): Promise<EmailMessageFull | null> {
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, direction, thread_id, from_addr, to_addr, subject, snippet,
            body_text, body_html, attachments_json, message_auth, created_at
       FROM email_messages WHERE id=? AND workspace_id=?`,
  )
    .bind(String(id ?? ""), workspaceId)
    .first<{
      id: string; workspace_id: string; direction: string; thread_id: string; from_addr: string; to_addr: string;
      subject: string | null; snippet: string | null; body_text: string | null; body_html: string | null;
      attachments_json: string | null; message_auth: string; created_at: number;
    }>();
  if (!row) return null;
  let attachments: EmailMessageFull["attachments"] = [];
  if (row.attachments_json) {
    try {
      const parsed = JSON.parse(row.attachments_json);
      if (Array.isArray(parsed)) attachments = parsed.slice(0, 100);
    } catch {
      attachments = [];
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    direction: row.direction,
    threadId: row.thread_id,
    fromAddr: row.from_addr,
    toAddr: row.to_addr,
    subject: row.subject,
    snippet: row.snippet,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments,
    messageAuth: row.message_auth,
    createdAt: row.created_at,
    bodyAvailable: typeof row.body_text === "string" && row.body_text.length > 0,
  };
}
