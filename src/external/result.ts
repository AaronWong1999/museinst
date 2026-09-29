
//






//




export type ExternalEvidence = {
  provider: string;

  account?: string;

  workspaceId?: string;

  externalId?: string;

  externalUrl?: string;

  resourceType?: string;

  fetchedAt?: number;

  verifiedAt?: number;

  idempotencyKey?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type ExternalErrorCode =
  | "not_connected"
  | "reauth_required"
  | "permission_missing"
  | "account_not_found"
  | "account_required"
  | "resource_not_found"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "provider_error"
  | "approval_required"
  | "unknown_delivery_state"
  | "verification_failed"
  | "invalid_input";

export type ExternalFailure = {
  code: ExternalErrorCode;
  message: string;
  provider?: string;
  retryable: boolean;

  resumable?: boolean;

  connectUrl?: string;
};

export type ExternalToolResult<T> =
  | { ok: true; data: T; evidence: ExternalEvidence }
  | { ok: false; error: ExternalFailure };



export function externalCodeFromConnectorReason(reason: string): { code: ExternalErrorCode; retryable: boolean; resumable: boolean } {
  switch (reason) {
    case "not_connected": return { code: "not_connected", retryable: false, resumable: true };
    case "reauth_required": return { code: "reauth_required", retryable: false, resumable: true };
    case "permission_denied": return { code: "permission_missing", retryable: false, resumable: false };
    case "rate_limited": return { code: "rate_limited", retryable: true, resumable: false };
    case "result_unknown": return { code: "unknown_delivery_state", retryable: false, resumable: false };
    case "transient_error": return { code: "provider_unavailable", retryable: true, resumable: false };
    case "internal_error": return { code: "provider_unavailable", retryable: true, resumable: false };
    case "not_found": return { code: "resource_not_found", retryable: false, resumable: false };
    case "invalid_input": return { code: "invalid_input", retryable: false, resumable: false };
    case "verification_failed": return { code: "verification_failed", retryable: false, resumable: false };
    case "timeout": return { code: "timeout", retryable: true, resumable: false };
    default: return { code: "provider_error", retryable: false, resumable: false };
  }
}


export function externalFailure(provider: string, code: ExternalErrorCode, message: string, opts?: { retryable?: boolean; resumable?: boolean; connectUrl?: string }): { ok: false; error: ExternalFailure } {
  const retryableDefault = code === "rate_limited" || code === "provider_unavailable" || code === "timeout";
  return {
    ok: false,
    error: {
      code,
      message,
      provider,
      retryable: opts?.retryable ?? retryableDefault,
      resumable: opts?.resumable ?? (code === "not_connected" || code === "reauth_required" || code === "approval_required"),
      connectUrl: opts?.connectUrl,
    },
  };
}


export function notConnected(provider: string, connectUrl?: string): { ok: false; error: ExternalFailure } {
  return externalFailure(provider, "not_connected", `（${provider} 未连接）`, { connectUrl });
}


export function externalSuccess<T>(data: T, evidence: Omit<ExternalEvidence, "fetchedAt"> & { fetchedAt?: number }): { ok: true; data: T; evidence: ExternalEvidence } {
  return { ok: true, data, evidence: { ...evidence, fetchedAt: evidence.fetchedAt ?? Date.now() } };
}





export function evidenceFromConnector(provider: string, accountLabel: string, extra?: Partial<ExternalEvidence>): ExternalEvidence {
  return {
    provider,
    account: accountLabel || undefined,
    fetchedAt: Date.now(),
    ...extra,
  };
}





export type ToolExternalAttachment =
  | { ok: true; evidence: ExternalEvidence; operation: ExternalOperation }
  | { ok: false; error: ExternalFailure; operation?: ExternalOperation };

export type ExternalOperation = "read" | "create" | "update" | "delete" | "send" | "login" | "browse";


export function serializeEvidenceForLog(evidence: ExternalEvidence): Record<string, unknown> {
  return {
    provider: evidence.provider,
    account: evidence.account,
    externalId: evidence.externalId,
    externalUrl: evidence.externalUrl,
    resourceType: evidence.resourceType,
    fetchedAt: evidence.fetchedAt,
    verifiedAt: evidence.verifiedAt,
    idempotencyKey: evidence.idempotencyKey,
  };
}
