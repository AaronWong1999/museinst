
//


//







import { newId } from "../../util";
import { sha256hex } from "../../crypto";
import type { Env } from "../../env";
import { enqueueOutbox, getOutboundMessageId } from "./outbox";


export const MAX_LOCAL_PART_BYTES = 64;

export const MAX_MAILBOX_LOCAL_BYTES = 32;
export const CAPABILITY_TOKEN_BYTES = 16; // 128 bit
export const CAPABILITY_TOKEN_LENGTH = 22; // base64url(16 bytes)
export const THREAD_CAPABILITY_TTL_MS = 30 * 86_400_000;
export const VERIFICATION_TTL_MS = 3_600_000;

export type CapabilityKind = "thread" | "verify";

const TAG_BY_KIND: Record<CapabilityKind, string> = { thread: "r", verify: "v" };
const KIND_BY_TAG: Record<string, CapabilityKind> = { r: "thread", v: "verify" };
const TOKEN_RE = /[A-Za-z0-9_-]+/;

export interface ThreadCapabilityPayload {
  v: 2;
  capability: "reply_to_thread";
  capId: string;
  workspaceId: string;
  threadId: string;

  peerAddress: string;
  localPart: string;
  iat: number;
  exp: number;
}

export interface CapabilityEnv {
  DB: D1Database;
}


export function generateCapabilityToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CAPABILITY_TOKEN_BYTES));
  return b64urlEncode(bytes);
}

export async function capabilityTokenHash(token: string): Promise<string> {
  return sha256hex(`thread_cap:${token.trim()}`);
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

function canonical(addr: string): string {
  return String(addr ?? "").trim().toLowerCase();
}

function normalizeKind(kind: unknown): CapabilityKind {
  return kind === "verify" ? "verify" : "thread";
}


export function assertLocalPartFits(localPart: string): string | null {
  const bytes = utf8Len(String(localPart ?? ""));
  if (bytes === 0) return "empty_local_part";
  if (bytes > MAX_LOCAL_PART_BYTES) return "local_part_too_long";
  return null;
}


export function buildCapabilityReplyTo(localPart: string, domain: string, token: string): string {
  const local = `${localPart}+${TAG_BY_KIND.thread}.${token}`;
  const bad = assertLocalPartFits(local);
  if (bad) throw new Error(`capability_reply_to_${bad}`);
  return `${local}@${domain}`;
}

export function buildVerificationReplyTo(localPart: string, domain: string, token: string): string {
  const local = `${localPart}+${TAG_BY_KIND.verify}.${token}`;
  const bad = assertLocalPartFits(local);
  if (bad) throw new Error(`verification_reply_to_${bad}`);
  return `${local}@${domain}`;
}


export function extractCapabilityRef(recipient: string): { kind: CapabilityKind; token: string } | null {
  const local = String(recipient ?? "").split("@")[0] ?? "";
  const m = local.match(/^(.*)\+([rv])\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const kind = KIND_BY_TAG[m[2]];
  const token = m[3];
  if (!kind) return null;
  if (token.length !== CAPABILITY_TOKEN_LENGTH || !TOKEN_RE.test(token)) return null;
  return { kind, token };
}

export function extractCapabilityToken(recipient: string): string | null {
  return extractCapabilityRef(recipient)?.token ?? null;
}

// ── mint / verify ────────────────────────────────────────────────────────────

export interface MintThreadCapabilityOpts {
  workspaceId: string;
  threadId: string;

  peerAddress?: string;

  localPart?: string;
  domain?: string;
  ttlMs?: number;
  nowMs?: number;
  kind?: CapabilityKind;

  peerHash?: string;
  iat?: number;
  exp?: number;
}

export interface MintedThreadCapability {
  token: string;
  capabilityId: string;
  threadId: string;
  expiresAt: number;
  replyTo: string | null;
  localPart: string;
}

export async function mintThreadCapability(
  env: CapabilityEnv | string,
  opts: MintThreadCapabilityOpts,
): Promise<MintedThreadCapability> {
  if (typeof env === "string" || !env || typeof env !== "object" || !env.DB) {

    throw new Error("thread_capability_requires_db");
  }
  const workspaceId = String(opts.workspaceId ?? "");
  const threadId = String(opts.threadId ?? "");
  if (!workspaceId || !threadId) throw new Error("thread_capability_bad_scope");
  const nowMs = opts.nowMs ?? Date.now();
  const expiresAt = nowMs + (opts.ttlMs ?? THREAD_CAPABILITY_TTL_MS);
  const token = generateCapabilityToken();
  const hash = await capabilityTokenHash(token);
  const capabilityId = newId("etc");
  const localPart = String(opts.localPart ?? "");
  await env.DB.prepare(
    `INSERT INTO email_thread_capabilities (id, token_hash, workspace_id, thread_id, peer_address, local_part, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(capabilityId, hash, workspaceId, threadId, canonical(opts.peerAddress ?? ""), localPart, nowMs, expiresAt)
    .run();
  let replyTo: string | null = null;
  if (opts.localPart && opts.domain) {
    replyTo =
      normalizeKind(opts.kind) === "verify"
        ? buildVerificationReplyTo(opts.localPart, opts.domain, token)
        : buildCapabilityReplyTo(opts.localPart, opts.domain, token);
  }
  return { token, capabilityId, threadId, expiresAt, replyTo, localPart };
}

export interface VerifyThreadCapabilityOpts {
  workspaceId: string;

  peerAddress: string;

  threadId?: string | null;
  nowMs?: number;
  kind?: CapabilityKind;
}

export interface VerifiedThreadCapability {
  ok: boolean;
  payload?: ThreadCapabilityPayload;
  error?: string;
}

export async function verifyThreadCapability(
  env: CapabilityEnv | string,
  token: string,
  opts: VerifyThreadCapabilityOpts,
): Promise<VerifiedThreadCapability> {
  if (typeof env === "string" || !env || typeof env !== "object" || !env.DB) {
    return { ok: false, error: "thread_capability_requires_db" };
  }
  const raw = String(token ?? "").trim();
  if (raw.length !== CAPABILITY_TOKEN_LENGTH || !TOKEN_RE.test(raw)) return { ok: false, error: "bad_format" };
  const hash = await capabilityTokenHash(raw);
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, thread_id, peer_address, local_part, created_at, expires_at, revoked_at FROM email_thread_capabilities WHERE token_hash=?`,
  )
    .bind(hash)
    .first<{
      id: string;
      workspace_id: string;
      thread_id: string;
      peer_address: string;
      local_part: string;
      created_at: number;
      expires_at: number;
      revoked_at: number | null;
    }>();
  if (!row) return { ok: false, error: "unknown_capability" };
  if (row.revoked_at) return { ok: false, error: "revoked" };
  const nowMs = opts.nowMs ?? Date.now();
  if (row.expires_at <= nowMs) return { ok: false, error: "expired" };
  if (row.workspace_id !== opts.workspaceId) return { ok: false, error: "workspace_mismatch" };
  const peer = canonical(opts.peerAddress);
  if (!row.peer_address || row.peer_address !== peer) return { ok: false, error: "peer_mismatch" };
  const kind = normalizeKind(opts.kind ?? (row.thread_id.startsWith("verify:") ? "verify" : "thread"));
  if (kind === "thread" && (!row.thread_id || row.thread_id.startsWith("verify:"))) return { ok: false, error: "kind_mismatch" };
  if (kind === "verify" && !row.thread_id.startsWith("verify:")) return { ok: false, error: "kind_mismatch" };

  if (kind === "thread" && opts.threadId && opts.threadId !== row.thread_id) {
    return { ok: false, error: "thread_mismatch" };
  }

  await env.DB.prepare(`UPDATE email_thread_capabilities SET last_used_at=? WHERE id=?`)
    .bind(nowMs, row.id)
    .run()
    .catch(() => undefined);
  return {
    ok: true,
    payload: {
      v: 2,
      capability: "reply_to_thread",
      capId: row.id,
      workspaceId: row.workspace_id,
      threadId: row.thread_id,
      peerAddress: row.peer_address,
      localPart: row.local_part,
      iat: Math.floor(row.created_at / 1000),
      exp: Math.floor(row.expires_at / 1000),
    },
  };
}

export async function revokeThreadCapability(
  env: CapabilityEnv,
  opts: { workspaceId: string; capabilityId?: string; threadId?: string; peerAddress?: string; nowMs?: number },
): Promise<number> {
  const nowMs = opts.nowMs ?? Date.now();
  if (opts.capabilityId) {
    const r = await env.DB.prepare(
      `UPDATE email_thread_capabilities SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL`,
    )
      .bind(nowMs, opts.capabilityId, opts.workspaceId)
      .run();
    return r.meta?.changes ?? 0;
  }
  if (!opts.threadId) return 0;
  const r = await env.DB.prepare(
    `UPDATE email_thread_capabilities SET revoked_at=? WHERE workspace_id=? AND thread_id=? AND peer_address=? AND revoked_at IS NULL`,
  )
    .bind(nowMs, opts.workspaceId, opts.threadId, canonical(opts.peerAddress ?? ""))
    .run();
  return r.meta?.changes ?? 0;
}





export async function rotateThreadCapabilityReplyTo(
  env: CapabilityEnv,
  opts: {
    workspaceId: string;
    threadId: string;
    peerAddress: string;
    localPart: string;
    domain: string;
    ttlMs?: number;
    nowMs?: number;
  },
): Promise<{ ok: true; replyTo: string; capabilityId: string; expiresAt: number } | { ok: false; error: string }> {
  const bad = assertLocalPartFits(`${opts.localPart}+${TAG_BY_KIND.thread}.${"x".repeat(CAPABILITY_TOKEN_LENGTH)}`);
  if (bad) return { ok: false, error: bad };
  await revokeThreadCapability(env, {
    workspaceId: opts.workspaceId,
    threadId: opts.threadId,
    peerAddress: opts.peerAddress,
    nowMs: opts.nowMs,
  });
  const minted = await mintThreadCapability(env, {
    workspaceId: opts.workspaceId,
    threadId: opts.threadId,
    peerAddress: opts.peerAddress,
    localPart: opts.localPart,
    domain: opts.domain,
    kind: "thread",
    ttlMs: opts.ttlMs,
    nowMs: opts.nowMs,
  });
  if (!minted.replyTo) return { ok: false, error: "reply_to_build_failed" };
  return { ok: true, replyTo: minted.replyTo, capabilityId: minted.capabilityId, expiresAt: minted.expiresAt };
}



const VERIFY_THREAD_PREFIX = "verify:";

export async function createAddressVerificationChallenge(
  env: CapabilityEnv,
  opts: { workspaceId: string; address: string; localPart: string; domain: string; ttlMs?: number; nowMs?: number },
): Promise<{ ok: true; challengeId: string; token: string; replyTo: string; expiresAt: number } | { ok: false; error: string }> {
  const address = canonical(opts.address);
  if (!address.includes("@")) return { ok: false, error: "invalid_address" };
  const nowMs = opts.nowMs ?? Date.now();
  const expiresAt = nowMs + (opts.ttlMs ?? VERIFICATION_TTL_MS);
  const token = generateCapabilityToken();
  const hash = await capabilityTokenHash(token);
  const challengeId = newId("evc");
  let replyTo: string;
  try {
    replyTo = buildVerificationReplyTo(opts.localPart, opts.domain, token);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  await env.DB.prepare(
    `INSERT INTO email_thread_capabilities (id, token_hash, workspace_id, thread_id, peer_address, local_part, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(challengeId, hash, opts.workspaceId, `${VERIFY_THREAD_PREFIX}${challengeId}`, address, opts.localPart, nowMs, expiresAt)
    .run();
  return { ok: true, challengeId, token, replyTo, expiresAt };
}





export async function completeAddressVerification(
  env: CapabilityEnv,
  opts: { token: string; workspaceId: string; peerAddress: string; nowMs?: number },
): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const raw = String(opts.token ?? "").trim();
  if (raw.length !== CAPABILITY_TOKEN_LENGTH || !TOKEN_RE.test(raw)) return { ok: false, error: "bad_format" };
  const hash = await capabilityTokenHash(raw);
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, thread_id, peer_address, expires_at, revoked_at FROM email_thread_capabilities WHERE token_hash=?`,
  )
    .bind(hash)
    .first<{ id: string; workspace_id: string; thread_id: string; peer_address: string; expires_at: number; revoked_at: number | null }>();
  if (!row) return { ok: false, error: "unknown_capability" };
  if (!row.thread_id.startsWith(VERIFY_THREAD_PREFIX)) return { ok: false, error: "kind_mismatch" };
  if (row.workspace_id !== opts.workspaceId) return { ok: false, error: "workspace_mismatch" };
  const peer = canonical(opts.peerAddress);
  if (!row.peer_address || row.peer_address !== peer) return { ok: false, error: "peer_mismatch" };
  if (row.expires_at <= nowMs) return { ok: false, error: "expired" };

  const consumed = await env.DB.prepare(
    `UPDATE email_thread_capabilities SET revoked_at=?, last_used_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>?`,
  )
    .bind(nowMs, nowMs, row.id, nowMs)
    .run();
  if ((consumed.meta?.changes ?? 0) !== 1) return { ok: false, error: "already_used" };
  await env.DB.prepare(
    `INSERT INTO email_contacts (workspace_id, address, contact_class, address_verified_by_owner, verified_at, first_seen_at, last_seen_at, msg_count)
     VALUES (?, ?, 'known', 1, ?, ?, ?, 0)
     ON CONFLICT(workspace_id, address) DO UPDATE SET address_verified_by_owner=1, verified_at=excluded.verified_at, last_seen_at=excluded.last_seen_at`,
  )
    .bind(opts.workspaceId, peer, nowMs, nowMs, nowMs)
    .run();
  return { ok: true, address: peer };
}


export async function sendAddressVerificationEmail(
  env: Env,
  opts: { workspaceId: string; address: string; subject?: string; nowMs?: number },
): Promise<{ ok: true; challengeId: string; outboxId: string; expiresAt: number } | { ok: false; error: string }> {
  const mailbox = await env.DB.prepare(`SELECT address, local_part, domain FROM agent_mailboxes WHERE workspace_id=? AND status='active'`)
    .bind(opts.workspaceId)
    .first<{ address: string; local_part: string; domain: string }>();
  if (!mailbox) return { ok: false, error: "no_active_mailbox" };
  const challenge = await createAddressVerificationChallenge(env, {
    workspaceId: opts.workspaceId,
    address: opts.address,
    localPart: mailbox.local_part,
    domain: mailbox.domain,
    nowMs: opts.nowMs,
  });
  if (!challenge.ok) return challenge;
  const textBody = [
    "请直接回复本邮件，以验证这个邮箱属于你（MuseInst Agent 地址归属验证）。",
    "",
    "回复后你会看到确认结果；若不是你本人发起的，请忽略本邮件。",
  ].join("\n");
  const enq = await enqueueOutbox(env, {
    workspaceId: opts.workspaceId,
    logicalKey: `addr_verify:${challenge.challengeId}`,
    fromAddr: mailbox.address,
    toAddr: canonical(opts.address),
    subject: opts.subject ?? "验证你的邮箱 / Verify your email",
    textBody,
    replyTo: challenge.replyTo,
    messageId: getOutboundMessageId(mailbox.address),
  });
  return { ok: true, challengeId: challenge.challengeId, outboxId: enq.id, expiresAt: challenge.expiresAt };
}
