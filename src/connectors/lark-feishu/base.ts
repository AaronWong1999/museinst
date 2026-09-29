
// V2 §10.7 / §13: database_query, database_create_record, database_update_record, database_delete_record.

import type { Env } from "../../env";
import { ConnectorCallError } from "../types";
import { larkFeishuUserRequest } from "./client";
import type { LarkFeishuProvider, LarkFeishuRecord } from "./types";

/**
 * Provider read-back may enrich structured fields (for example user/link cells)
 * with display metadata. Verify that the requested value is preserved instead
 * of demanding byte-for-byte JSON identity.
 */
function fieldMatches(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    return String(actual ?? "") === String(expected ?? "");
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((item) => actual.some((candidate) => fieldMatches(item, candidate)));
  }
  if (Array.isArray(actual) || actual === null || typeof actual !== "object") return false;
  const expectedObj = expected as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;
  return Object.entries(expectedObj).every(([key, value]) => key in actualObj && fieldMatches(value, actualObj[key]));
}

export async function larkFeishuDatabaseQuery(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  appToken: string,
  tableId: string,
  opts?: {
    pageSize?: number;
    pageToken?: string;
    fieldNames?: string[];
  },
): Promise<{ items: LarkFeishuRecord[]; total?: number; hasMore?: boolean; pageToken?: string }> {
  // SearchAppTableRecord defines pagination as query parameters; putting
  // page_size/page_token in the JSON body is silently ignored by the API.
  const query = new URLSearchParams({ user_id_type: "open_id" });
  if (opts?.pageSize) query.set("page_size", String(Math.max(1, Math.min(Math.trunc(opts.pageSize), 100))));
  if (opts?.pageToken) query.set("page_token", opts.pageToken);

  const body: Record<string, unknown> = {};
  if (opts?.fieldNames && opts.fieldNames.length > 0) body.field_names = opts.fieldNames;

  const res = await larkFeishuUserRequest(
    env,
    provider,
    userToken,
    `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search?${query}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

  const items = ((res as any)?.items ?? []).map((r: any) => ({
    recordId: String(r.record_id || r.id || ""),
    fields: r.fields || {},
  }));

  return {
    items,
    total: (res as any)?.total,
    hasMore: (res as any)?.has_more,
    pageToken: (res as any)?.page_token,
  };
}

export async function larkFeishuDatabaseGetRecord(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  appToken: string,
  tableId: string,
  recordId: string,
): Promise<LarkFeishuRecord | null> {
  try {
    const query = new URLSearchParams({ user_id_type: "open_id" });
    const res = await larkFeishuUserRequest(
      env,
      provider,
      userToken,
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}?${query}`,
    );
    const record = (res as any)?.record ?? res;
    const id = String(record?.record_id ?? record?.id ?? "");
    if (!id) return null;
    return { recordId: id, fields: record?.fields ?? {} };
  } catch (e) {
    if (e instanceof ConnectorCallError && e.kind === "not_found") return null;
    throw e;
  }
}

async function assertRecordFields(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  appToken: string,
  tableId: string,
  recordId: string,
  expectedFields: Record<string, unknown>,
  operation: "create" | "update",
): Promise<LarkFeishuRecord> {
  const back = await larkFeishuDatabaseGetRecord(env, provider, userToken, appToken, tableId, recordId);
  if (!back) throw new ConnectorCallError("provider_error", `${provider}_database_${operation}: read_back_not_found`);
  for (const [name, expected] of Object.entries(expectedFields)) {
    if (!(name in back.fields) || !fieldMatches(expected, back.fields[name])) {
      throw new ConnectorCallError("provider_error", `${provider}_database_${operation}: field_mismatch:${name}`);
    }
  }
  return back;
}

export async function larkFeishuDatabaseCreateRecord(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  appToken: string,
  tableId: string,
  fields: Record<string, unknown>,
): Promise<LarkFeishuRecord> {
  const res = await larkFeishuUserRequest(
    env,
    provider,
    userToken,
    `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
    {
      method: "POST",
      body: JSON.stringify({ fields }),
    },
  );

  const record = (res as any)?.record ?? res;
  const recordId = String(record?.record_id ?? "");
  if (!recordId) throw new ConnectorCallError("provider_error", `${provider}_database_create: missing_record_id`);

  return assertRecordFields(env, provider, userToken, appToken, tableId, recordId, fields, "create");
}

export async function larkFeishuDatabaseUpdateRecord(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  appToken: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<LarkFeishuRecord> {
  await larkFeishuUserRequest(
    env,
    provider,
    userToken,
    `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ fields }),
    },
  );

  return assertRecordFields(env, provider, userToken, appToken, tableId, recordId, fields, "update");
}

export async function larkFeishuDatabaseDeleteRecord(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  appToken: string,
  tableId: string,
  recordId: string,
): Promise<{ ok: true; recordId: string }> {
  await larkFeishuUserRequest(
    env,
    provider,
    userToken,
    `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
    { method: "DELETE" },
  );

  const back = await larkFeishuDatabaseGetRecord(env, provider, userToken, appToken, tableId, recordId);
  if (back) throw new ConnectorCallError("provider_error", `${provider}_database_delete: read_back_still_exists`);
  return { ok: true, recordId };
}
