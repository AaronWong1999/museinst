


export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  scope?: string;
}

export type AccessTokenResult =
  | { ok: true; token: string; accountLabel: string }
  | {
      ok: false;
      reason: "not_connected" | "reauth_required" | "refresh_failed" | "internal_error";
      accountLabel?: string;

      retryable?: boolean;
    };

export interface ConnectorIdentity {
  label: string;
  displayName: string;
}

export type ConnectorCallKind =
  | "auth"
  | "permission"
  | "rate_limit"
  | "not_found"
  | "transient"
  | "provider_error";

export class ConnectorCallError extends Error {
  constructor(
    public kind: ConnectorCallKind,
    message: string,
    public status?: number,
    public code?: string,
  ) { super(message); }
}


export function httpStatusToKind(status: number): ConnectorCallKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 429) return "rate_limit";
  if (status === 404) return "not_found";
  if (status >= 500) return "transient";
  return "provider_error";
}


export function redactSecretText(s: unknown): string {
  const raw = String(s ?? "");
  return raw
    .replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "***")
    .slice(0, 160);
}

export function throwForHttpStatus(status: number, _body?: string, code?: string): never {

  throw new ConnectorCallError(httpStatusToKind(status), `http_${status}${code ? ": " + code : ""}`, status, code);
}


export function oauthTokenErrorKind(errorCode: string): ConnectorCallKind {
  if (errorCode === "invalid_grant") return "auth";
  if (errorCode === "rate_limited" || errorCode === "temporarily_unavailable") return "rate_limit";
  return "transient";
}



export type RevokeOutcome = "revoked" | "failed" | "unsupported";

export interface RevokeResult {
  outcome: RevokeOutcome;

  detail?: string;
}

export interface RevokeTokens {
  accessToken: string;
  refreshToken?: string;
}
