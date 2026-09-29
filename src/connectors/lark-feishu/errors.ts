// errors.ts — Error parsing and mapping for Lark & Feishu APIs.
// V2 §8.2 / §13: Map platform error codes to typed ConnectorCallError.
// 403 / permission_missing must NOT be converted to empty lists or fake success.
// 401 / auth errors must trigger needs_reauth.

import { ConnectorCallError, type ConnectorCallKind, redactSecretText } from "../types";

export function larkFeishuCodeToKind(code: number, httpStatus?: number): ConnectorCallKind {
  // Auth errors (invalid or expired tokens)
  if ([99991663, 99991664, 99991668, 99991669, 20005, 20014].includes(code) || httpStatus === 401) {
    return "auth";
  }
  // Scope / permission missing
  if ([99991672, 99991677, 99991679].includes(code) || httpStatus === 403) {
    return "permission";
  }
  // Rate limits
  if (code === 99991400 || httpStatus === 429) {
    return "rate_limit";
  }
  // Resource not found
  if (httpStatus === 404) {
    return "not_found";
  }
  // Server transient errors
  if ((httpStatus && httpStatus >= 500) || [99991404, 99991405].includes(code)) {
    return "transient";
  }
  return "provider_error";
}

export function assertLarkFeishuOk(
  j: any,
  operation: string,
  httpStatus?: number,
): void {
  if (!j || typeof j !== "object") {
    throw new ConnectorCallError("provider_error", `${operation}: invalid_json_response`, httpStatus);
  }
  if (j.code !== undefined && j.code !== 0) {
    const code = Number(j.code);
    const kind = larkFeishuCodeToKind(code, httpStatus);
    const msg = j.msg || j.message || `error_${code}`;
    throw new ConnectorCallError(kind, `${operation}: ${redactSecretText(msg)} (code ${code})`, httpStatus, String(code));
  }
  if (httpStatus && (httpStatus < 200 || httpStatus >= 300)) {
    const kind = larkFeishuCodeToKind(0, httpStatus);
    throw new ConnectorCallError(kind, `${operation}: http_${httpStatus}`, httpStatus);
  }
}
