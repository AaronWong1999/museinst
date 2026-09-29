


//


import { WorkerEntrypoint } from "cloudflare:workers";
import { imapAppendDraft, imapList, imapCount, imapGet, imapGetByUid, smtpSend, smtpVerify, validateCustomEndpoint } from "./imap";
import { getItemFields } from "../vault/service";

interface ExecutorEnv {
  DB?: D1Database;
  VAULT_MASTER_KEY?: string;
}


export type IdempotencyStatus =
  | "in_progress"
  | "sent"
  | "succeeded"
  | "failed_pre_send"
  | "failed_pre_effect"
  | "unknown"
  | "unknown_effect"
  | "applied_unverified";

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IdempotencyDecision {
  proceed: boolean;
  existing?: { status: IdempotencyStatus; payload_hash: string };
}



export async function smtpIdempotencyBegin(
  db: D1Database,
  requestId: string,
  workspaceId: string,
  payloadHash: string,
): Promise<
  | { ok: true }
  | {
      ok: false;
      deduped?: boolean;
      error: string;
      storedResult?: {
        external_id?: string;
        result_json?: string;
        verified_at?: number;
      };
    }
> {
  const t = Date.now();
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO imap_send_idempotency(request_id, workspace_id, payload_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'in_progress', ?, ?)`,
    )
    .bind(requestId, workspaceId, payloadHash, t, t)
    .run();
  if ((ins.meta?.changes ?? 0) === 1) return { ok: true };

  const existing = await db
    .prepare(`SELECT status, payload_hash, external_id, result_json, verified_at FROM imap_send_idempotency WHERE request_id=?`)
    .bind(requestId)
    .first<{
      status: IdempotencyStatus;
      payload_hash: string;
      external_id?: string | null;
      result_json?: string | null;
      verified_at?: number | null;
    }>();
  if (!existing) return { ok: false, error: "idempotency_state_lost" };
  if (existing.payload_hash !== payloadHash) {
    return { ok: false, error: "idempotency_key_reused_with_different_payload" };
  }
  if (existing.status === "sent" || existing.status === "succeeded") {
    return {
      ok: false,
      deduped: true,
      error: "deduped",
      storedResult: {
        external_id: existing.external_id ?? undefined,
        result_json: existing.result_json ?? undefined,
        verified_at: existing.verified_at ?? undefined,
      },
    };
  }
  if (
    existing.status === "in_progress" ||
    existing.status === "unknown" ||
    existing.status === "unknown_effect" ||
    existing.status === "applied_unverified"
  ) {
    return { ok: false, error: "delivery_status_unknown_do_not_auto_retry" };
  }
  const claim = await db
    .prepare(
      `UPDATE imap_send_idempotency SET status='in_progress', updated_at=?
       WHERE request_id=? AND status IN ('failed_pre_send', 'failed_pre_effect')`,
    )
    .bind(t, requestId)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return { ok: false, error: "delivery_status_unknown_do_not_auto_retry" };
  return { ok: true };
}

export async function smtpIdempotencyFinish(
  db: D1Database,
  requestId: string,
  status: IdempotencyStatus,
  errorOrOpts?:
    | string
    | {
        lastError?: string;
        externalId?: string;
        resultJson?: string;
        verifiedAt?: number;
      },
  opts?: {
    externalId?: string;
    resultJson?: string;
    verifiedAt?: number;
  },
): Promise<void> {
  let lastError: string | null = null;
  let externalId: string | null = null;
  let resultJson: string | null = null;
  let verifiedAt: number | null = null;

  if (typeof errorOrOpts === "string") {
    lastError = errorOrOpts.slice(0, 300);
    if (opts) {
      externalId = opts.externalId ?? null;
      resultJson = opts.resultJson ?? null;
      verifiedAt = opts.verifiedAt ?? null;
    }
  } else if (errorOrOpts && typeof errorOrOpts === "object") {
    lastError = errorOrOpts.lastError?.slice(0, 300) ?? null;
    externalId = errorOrOpts.externalId ?? null;
    resultJson = errorOrOpts.resultJson ?? null;
    verifiedAt = errorOrOpts.verifiedAt ?? null;
  }

  await db
    .prepare(
      `UPDATE imap_send_idempotency
       SET status=?, last_error=?, external_id=?, result_json=?, verified_at=?, updated_at=?
       WHERE request_id=?`,
    )
    .bind(status, lastError, externalId, resultJson, verifiedAt, Date.now(), requestId)
    .run();
}

export class ImapExecutor extends WorkerEntrypoint {
  declare env: ExecutorEnv;

  async health(): Promise<{ ok: boolean; db: boolean; vaultKey: boolean }> {
    const env = this.env as ExecutorEnv & Record<string, unknown>;
    return {
      ok: !!env.DB && !!env.VAULT_MASTER_KEY,
      db: !!env.DB,
      vaultKey: !!env.VAULT_MASTER_KEY,
    };
  }

  async testConnection(req: {
    provider: string;
    email: string;
    authCode: string;
    imapHost: string;
    imapPort: number;
    sendId: boolean;
    smtpHost?: string;
    smtpPort?: number;
    smtpStarttls?: boolean;
    username?: string;
    smtpUsername?: string;
    smtpPassword?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const v = validateCustomEndpoint(req.imapHost, req.imapPort, "imap");
      if (!v.ok && !KNOWN_HOSTS.has(req.imapHost)) return { ok: false, error: v.error };
      const user = (req.username ?? "").trim() || req.email;
      await imapList(
        { host: req.imapHost, port: req.imapPort, user, pass: req.authCode, sendId: req.sendId },
        "ALL",
        1,
      );
      const smtpHost = (req.smtpHost ?? "").trim();
      if (smtpHost) {
        const smtpPort = Number(req.smtpPort ?? 465);
        const sv = validateCustomEndpoint(smtpHost, smtpPort, "smtp");
        if (!sv.ok && !KNOWN_SMTP_HOSTS.has(smtpHost)) return { ok: false, error: sv.error };
        const r = await smtpVerify({
          host: smtpHost,
          port: smtpPort,
          user: (req.smtpUsername ?? "").trim() || user,
          pass: (req.smtpPassword ?? "").trim() || req.authCode,
          starttls: !!req.smtpStarttls,
        });
        if (!r.ok) return { ok: false, error: r.error };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    }
  }

  private async resolveAccount(env: ExecutorEnv & { DB: D1Database; VAULT_MASTER_KEY: string }, workspaceId: string, email: string) {
    const safeEmail = String(email ?? "").replace(/[\r\n]/g, "").trim().toLowerCase();
    const row = await env.DB.prepare(
      `SELECT imap_host, imap_port, smtp_host, smtp_port, smtp_starttls, send_id, username, vault_item_id
         FROM mailbox_accounts WHERE workspace_id=? AND email=?`,
    ).bind(workspaceId, safeEmail).first<{
      imap_host: string; imap_port: number; smtp_host: string; smtp_port: number;
      smtp_starttls: number; send_id: number; username: string | null; vault_item_id: string;
    }>();
    if (!row) throw new Error("mailbox_not_connected");
    const fields = await getItemFields(env as unknown as Parameters<typeof getItemFields>[0], workspaceId, row.vault_item_id);
    const authCode = fields?.authCode;
    if (!authCode) throw new Error("mailbox_credential_unreadable");
    const user = (row.username ?? "").trim() || safeEmail;
    return {
      imap: { host: row.imap_host, port: row.imap_port, user, pass: authCode, sendId: row.send_id === 1 },
      smtp: {
        host: row.smtp_host, port: row.smtp_port,
        user: String(fields?.smtpUsername ?? "").trim() || user,
        pass: String(fields?.smtpPassword ?? "").trim() || authCode,
        starttls: row.smtp_starttls === 1,
      },
      email: safeEmail,
    };
  }

  async listMail(req: { workspaceId: string; account: string; search?: string; max?: number; folder?: string }): Promise<{ ok: boolean; mails?: unknown[]; error?: string }> {
    const env = this.env as ExecutorEnv & { DB: D1Database; VAULT_MASTER_KEY: string };
    if (!env.DB) return { ok: false, error: "executor_db_missing" };
    if (!env.VAULT_MASTER_KEY) return { ok: false, error: "executor_vault_key_missing" };
    try {
      const box = await this.resolveAccount(env, req.workspaceId, req.account);
      const mails = await imapList(box.imap, req.search ? String(req.search) : "", Number(req.max ?? 8), req.folder ? String(req.folder) : "INBOX");
      return { ok: true, mails };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    }
  }

  // Count-only RPC (DEFECT-024): SELECT + SEARCH COUNT, never FETCH.
  async countMail(req: { workspaceId: string; account: string; search?: string; folder?: string }): Promise<{ ok: boolean; count?: number; folder?: string; error?: string }> {
    const env = this.env as ExecutorEnv & { DB: D1Database; VAULT_MASTER_KEY: string };
    if (!env.DB) return { ok: false, error: "executor_db_missing" };
    if (!env.VAULT_MASTER_KEY) return { ok: false, error: "executor_vault_key_missing" };
    try {
      const box = await this.resolveAccount(env, req.workspaceId, req.account);
      const r = await imapCount(box.imap, req.search ? String(req.search) : "", req.folder ? String(req.folder) : "INBOX");
      return { ok: true, folder: r.folder, count: r.count };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    }
  }

  async readMail(req: { workspaceId: string; account: string; seq: number; uid?: number }): Promise<{ ok: boolean; mail?: unknown; error?: string }> {
    const env = this.env as ExecutorEnv & { DB: D1Database; VAULT_MASTER_KEY: string };
    if (!env.DB) return { ok: false, error: "executor_db_missing" };
    if (!env.VAULT_MASTER_KEY) return { ok: false, error: "executor_vault_key_missing" };
    try {
      const box = await this.resolveAccount(env, req.workspaceId, req.account);

      const mail = typeof req.uid === "number" && Number.isFinite(req.uid) && req.uid > 0
        ? await imapGetByUid(box.imap, Number(req.uid))
        : await imapGet(box.imap, Number(req.seq));
      return { ok: true, mail };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    }
  }





  async draftMail(req: {
    workspaceId: string;
    requestId: string;
    account: string;
    mail: { to: string; subject: string; body: string };
  }): Promise<{
    ok: boolean;
    deduped?: boolean;
    uid?: number;
    folder?: string;
    to?: string;
    subject?: string;
    isDraft?: boolean;
    messageId?: string;
    verifiedAt?: number;
    error?: string;
  }> {
    const env = this.env as ExecutorEnv & { DB: D1Database; VAULT_MASTER_KEY: string };
    const db = env.DB;
    if (!db) return { ok: false, error: "executor_db_missing" };
    if (!env.VAULT_MASTER_KEY) return { ok: false, error: "executor_vault_key_missing" };
    let box: { imap: { host: string; port: number; user: string; pass: string; sendId: boolean }; email: string };
    try {
      box = await this.resolveAccount(env, req.workspaceId, req.account);
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 120) };
    }
    const mail = { to: req.mail.to, subject: req.mail.subject, body: req.mail.body, from: box.email };
    const payloadHash = await sha256Hex(JSON.stringify({ account: req.account, ...mail, kind: "draft" }));
    const gate = await smtpIdempotencyBegin(db, req.requestId, req.workspaceId, payloadHash);
    if (!gate.ok) {
      if (gate.deduped) {
        if (!gate.storedResult?.result_json || !gate.storedResult.verified_at || !gate.storedResult.external_id) {
          return { ok: false, error: "dedupe_result_unverifiable" };
        }
        try {
          const parsed = JSON.parse(gate.storedResult.result_json) as {
            uid?: number; folder?: string; to?: string; subject?: string; isDraft?: boolean; messageId?: string;
          };
          if (!parsed.uid || !parsed.folder || parsed.isDraft !== true || !parsed.messageId) {
            return { ok: false, error: "dedupe_result_unverifiable" };
          }
          return {
            ok: true,
            deduped: true,
            uid: parsed.uid,
            folder: parsed.folder,
            to: parsed.to,
            subject: parsed.subject,
            isDraft: true,
            messageId: parsed.messageId,
            verifiedAt: gate.storedResult.verified_at,
          };
        } catch {
          return { ok: false, error: "dedupe_result_unverifiable" };
        }
      }
      return { ok: false, error: gate.error };
    }
    try {
      const r = await imapAppendDraft(box.imap, mail);
      if (!r.ok) {
        if (r.appendAccepted) {
          await smtpIdempotencyFinish(db, req.requestId, "applied_unverified", {
            lastError: r.error,
            externalId: r.uid ? `${r.folder ?? "Drafts"}:uid=${r.uid}` : undefined,
          });
          return { ok: false, error: r.error };
        }
        await smtpIdempotencyFinish(db, req.requestId, "failed_pre_effect", { lastError: r.error });
        return { ok: false, error: r.error };
      }
      if (!r.isDraft || !r.uid || !r.folder || !r.messageId || !r.verifiedAt) {
        await smtpIdempotencyFinish(db, req.requestId, "applied_unverified", {
          lastError: "draft_verification_evidence_incomplete",
          externalId: r.uid ? `${r.folder ?? "Drafts"}:uid=${r.uid}` : undefined,
        });
        return { ok: false, error: "draft_verification_evidence_incomplete" };
      }
      const verifiedAt = r.verifiedAt;
      const stored = {
        uid: r.uid,
        folder: r.folder,
        to: r.to,
        subject: r.subject,
        messageId: r.messageId,
        isDraft: true,
      };
      await smtpIdempotencyFinish(db, req.requestId, "succeeded", {
        externalId: `${r.folder}:uid=${r.uid}`,
        resultJson: JSON.stringify(stored),
        verifiedAt,
      });
      return {
        ok: true,
        uid: r.uid,
        folder: r.folder,
        to: r.to,
        subject: r.subject,
        isDraft: true,
        messageId: r.messageId,
        verifiedAt,
      };
    } catch (e) {
      await smtpIdempotencyFinish(db, req.requestId, "unknown_effect", { lastError: String(e) });
      return { ok: false, error: "draft_status_unknown" };
    }
  }

  async send(req: {
    workspaceId: string;
    requestId: string;
    account: string;
    mail: { to: string; subject: string; body: string; from?: string };
  }): Promise<{ ok: boolean; deduped?: boolean; error?: string; deliveryUnknown?: boolean; queueLine?: string }> {
    const env = this.env as ExecutorEnv & { DB: D1Database };
    const db = env.DB;
    if (!db) return { ok: false, error: "executor_db_missing" };
    if (!env.VAULT_MASTER_KEY) return { ok: false, error: "executor_vault_key_missing" };
    let box: { smtp: { host: string; port: number; user: string; pass: string; starttls?: boolean }; email: string };
    try {
      box = await this.resolveAccount(env as ExecutorEnv & { DB: D1Database; VAULT_MASTER_KEY: string }, req.workspaceId, req.account);
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 120) };
    }
    const mail = { to: req.mail.to, subject: req.mail.subject, body: req.mail.body, from: box.email };
    const v = validateCustomEndpoint(box.smtp.host, box.smtp.port, "smtp");
    if (!v.ok && !KNOWN_SMTP_HOSTS.has(box.smtp.host)) return { ok: false, error: v.error };
    const payloadHash = await sha256Hex(JSON.stringify(mail));
    const gate = await smtpIdempotencyBegin(db, req.requestId, req.workspaceId, payloadHash);
    if (!gate.ok) {
      if (gate.deduped) return { ok: true, deduped: true };
      return { ok: false, error: gate.error, deliveryUnknown: gate.error.includes("unknown") };
    }
    let r;
    try {
      r = await smtpSend(box.smtp, mail);
    } catch (e) {
      await smtpIdempotencyFinish(db, req.requestId, "unknown", String(e));
      return { ok: false, deliveryUnknown: true, error: "delivery_status_unknown" };
    }
    if (r.phase === "sent") {
      await smtpIdempotencyFinish(db, req.requestId, "sent");
      return { ok: true, queueLine: r.queueLine };
    }
    if (r.phase === "pre_send") {
      await smtpIdempotencyFinish(db, req.requestId, "failed_pre_send", r.error);
      return { ok: false, error: r.error };
    }
    await smtpIdempotencyFinish(db, req.requestId, "unknown", r.error);
    return { ok: false, deliveryUnknown: true, error: "delivery_status_unknown" };
  }
}

const KNOWN_HOSTS = new Set([
  "imap.qq.com",
  "imap.163.com",
  "imap.126.com",
  "imap.mail.me.com",
  "imap.gmail.com",
  "imap.exmail.qq.com",
  "imap.mail.yahoo.com",
]);
const KNOWN_SMTP_HOSTS = new Set([
  "smtp.qq.com",
  "smtp.163.com",
  "smtp.126.com",
  "smtp.mail.me.com",
  "smtp.gmail.com",
  "smtp.exmail.qq.com",
  "smtp.mail.yahoo.com",
]);

export default ImapExecutor;
