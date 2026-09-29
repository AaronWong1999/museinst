// channels/email/trust-control/outbound.ts — Outbound signed trust-control message creation and outbox queuing.

import type { Env } from "../../../env";
import { newId } from "../../../util";
import { canonicalBytes } from "./canonical";
import { validateTrustControlEnvelope, type TrustControlEnvelope, type TrustControlKind } from "./schema";
import { signTrustControlEnvelope } from "./sign";
import { b64urlDecode, b64urlEncode } from "../a2a/codec";
import { resolveLocalSigningKey, type LocalSigningKey } from "../a2a/outbound";
import { enqueueOutbox, getOutboundMessageId } from "../outbox";

export const DEFAULT_TRUST_CONTROL_TTL_MS = 7 * 86_400_000;

export interface SendTrustControlOpts {
  workspaceId: string;
  kind: TrustControlKind;
  fromAgent: string;
  toAgent: string;
  requestId: string;
  displayName?: string;
  relation?: string;
  ttlMs?: number;
  nowMs?: number;
  signingKeyOverride?: LocalSigningKey;
}

export interface SendTrustControlResult {
  ok: boolean;
  envelope?: TrustControlEnvelope;
  signature?: string;
  outboxId?: string;
  created?: boolean;
  error?: string;
}

export function buildTrustControlSubject(kind: TrustControlKind, fromAgent: string, displayName?: string): string {
  const who = displayName ? `${displayName} (${fromAgent})` : fromAgent;
  switch (kind) {
    case "trust.invite":
      return `[Trust Request] ${who} wants to connect on MuseInst`;
    case "trust.accept":
      return `[Trust Accepted] ${who} accepted your trust request`;
    case "trust.decline":
      return `[Trust Declined] ${who} declined your trust request`;
    case "trust.revoke":
      return `[Trust Revoked] Trust relationship updated with ${who}`;
  }
}

export function buildTrustControlTextBody(envelope: TrustControlEnvelope): string {
  return [
    `MuseInst Trust Control Message: ${envelope.kind}`,
    `From: ${envelope.fromAgent}`,
    `To: ${envelope.toAgent}`,
    `Request ID: ${envelope.requestId}`,
    envelope.displayName ? `Display Name: ${envelope.displayName}` : null,
    envelope.relation ? `Relation: ${envelope.relation}` : null,
    `Expires At: ${new Date(envelope.exp * 1000).toISOString()}`,
    "",
    "This is an automated protocol message exchanged between MuseInst agents.",
  ]
    .filter(Boolean)
    .join("\n");
}

function decodeStoredEnvelope(headersJson: string): { envelope: TrustControlEnvelope; signature: string } | null {
  try {
    const raw = JSON.parse(headersJson || "{}") as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
    const encoded = headers["x-openinst-trust-envelope"];
    const signature = headers["x-openinst-trust-sig"];
    if (!encoded || !signature) return null;
    const json = new TextDecoder().decode(b64urlDecode(encoded));
    const validated = validateTrustControlEnvelope(JSON.parse(json));
    if (!validated.ok) return null;
    return { envelope: validated.envelope, signature };
  } catch {
    return null;
  }
}

export async function sendTrustControl(env: Env, opts: SendTrustControlOpts): Promise<SendTrustControlResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const fromAgent = opts.fromAgent.trim().toLowerCase();
  const toAgent = opts.toAgent.trim().toLowerCase();
  const requestId = opts.requestId.trim();
  const kindSub = opts.kind.replace("trust.", "");
  const logicalKey = `trust:${kindSub}:${requestId}`;

  // The first outbox row owns the immutable envelope, nonce, signature and application Message-ID.
  // A retry must return that exact persisted protocol message rather than manufacture a second
  // envelope under the same logical key (which could diverge from what transport will actually send).
  const existing = await env.DB.prepare(
    `SELECT id, from_addr, to_addr, headers_json FROM email_outbox WHERE workspace_id=? AND logical_key=?`,
  )
    .bind(opts.workspaceId, logicalKey)
    .first<{ id: string; from_addr: string; to_addr: string; headers_json: string }>();
  if (existing) {
    const stored = decodeStoredEnvelope(existing.headers_json);
    if (
      !stored ||
      stored.envelope.kind !== opts.kind ||
      stored.envelope.requestId !== requestId ||
      stored.envelope.fromAgent !== fromAgent ||
      stored.envelope.toAgent !== toAgent ||
      existing.from_addr.trim().toLowerCase() !== fromAgent ||
      existing.to_addr.trim().toLowerCase() !== toAgent
    ) {
      return { ok: false, error: "trust_outbox_conflict" };
    }
    return {
      ok: true,
      envelope: stored.envelope,
      signature: stored.signature,
      outboxId: existing.id,
      created: false,
    };
  }

  let signingKey: LocalSigningKey;
  if (opts.signingKeyOverride) {
    signingKey = opts.signingKeyOverride;
  } else {
    const resolved = resolveLocalSigningKey(env);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    signingKey = resolved.key;
  }

  const iat = Math.floor(nowMs / 1000);
  const ttlMs = opts.ttlMs ?? DEFAULT_TRUST_CONTROL_TTL_MS;
  const exp = Math.floor((nowMs + ttlMs) / 1000);
  const nonce = newId("tcn");

  const envelope: TrustControlEnvelope = {
    v: 1,
    kind: opts.kind,
    issuer: signingKey.issuer,
    kid: signingKey.kid,
    fromAgent,
    toAgent,
    requestId,
    iat,
    exp,
    nonce,
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    ...(opts.relation ? { relation: opts.relation } : {}),
  };

  const signature = await signTrustControlEnvelope(signingKey.privateJwk, envelope);
  const envelopeB64 = b64urlEncode(canonicalBytes(envelope));

  const headers: Record<string, string> = {
    "x-openinst-trust-envelope": envelopeB64,
    "x-openinst-trust-sig": signature,
    "x-openinst-trust-kid": envelope.kid,
    "x-openinst-trust-issuer": envelope.issuer,
    "auto-submitted": "auto-generated",
  };

  const subject = buildTrustControlSubject(opts.kind, fromAgent, opts.displayName);
  const textBody = buildTrustControlTextBody(envelope);
  const res = await enqueueOutbox(env, {
    workspaceId: opts.workspaceId,
    logicalKey,
    fromAddr: fromAgent,
    toAddr: toAgent,
    subject,
    textBody,
    headers,
    messageId: getOutboundMessageId(fromAgent),
    autoSubmitted: "auto-generated",
  });

  if (!res.created) {
    // Another worker won the insert between our pre-read and enqueue. Re-read the winner and
    // return its immutable envelope; never return our losing nonce/signature to a local fast-path.
    const winner = await env.DB.prepare(
      `SELECT id, from_addr, to_addr, headers_json FROM email_outbox WHERE workspace_id=? AND logical_key=?`,
    )
      .bind(opts.workspaceId, logicalKey)
      .first<{ id: string; from_addr: string; to_addr: string; headers_json: string }>();
    const stored = winner ? decodeStoredEnvelope(winner.headers_json) : null;
    if (!winner || !stored || stored.envelope.kind !== opts.kind || stored.envelope.requestId !== requestId || stored.envelope.fromAgent !== fromAgent || stored.envelope.toAgent !== toAgent) {
      return { ok: false, error: "trust_outbox_conflict" };
    }
    return { ok: true, envelope: stored.envelope, signature: stored.signature, outboxId: winner.id, created: false };
  }

  return { ok: true, envelope, signature, outboxId: res.id, created: true };
}
