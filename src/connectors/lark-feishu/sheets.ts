// sheets.ts — Semantic Spreadsheet adapter for Lark & Feishu Sheets.
// V2 §10.6 / §13: spreadsheet_create, spreadsheet_get, spreadsheet_read, spreadsheet_append_rows.

import type { Env } from "../../env";
import { ConnectorCallError } from "../types";
import { larkFeishuUserRequest } from "./client";
import type { LarkFeishuProvider, LarkFeishuSpreadsheet, LarkFeishuSpreadsheetValues } from "./types";

function valuesEqual(expected: unknown[][], actual: unknown[][]): boolean {
  if (actual.length !== expected.length) return false;
  for (let r = 0; r < expected.length; r++) {
    const a = actual[r] ?? [];
    const e = expected[r] ?? [];
    if (a.length !== e.length) return false;
    for (let c = 0; c < e.length; c++) {
      // Sheets may normalize primitive values (for example number/string forms).
      // String comparison is strict enough to catch missing/wrong cells without
      // declaring a false failure solely because of JSON numeric representation.
      if (String(a[c] ?? "") !== String(e[c] ?? "")) return false;
    }
  }
  return true;
}

export async function larkFeishuSpreadsheetCreate(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  title: string,
): Promise<LarkFeishuSpreadsheet> {
  const res = await larkFeishuUserRequest(env, provider, userToken, `/sheets/v3/spreadsheets`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });

  const sheet = (res as any)?.spreadsheet ?? res;
  const token = String(sheet?.spreadsheet_token ?? "");
  if (!token) throw new ConnectorCallError("provider_error", `${provider}_spreadsheet_create: missing_token`);

  const back = await larkFeishuSpreadsheetGet(env, provider, userToken, token);
  if (!back) throw new ConnectorCallError("provider_error", `${provider}_spreadsheet_create: read_back_not_found`);
  if (back.title.trim() !== title.trim()) {
    throw new ConnectorCallError("provider_error", `${provider}_spreadsheet_create: title_mismatch`);
  }

  return {
    token,
    title: back.title,
    url: back.url ?? (sheet?.url ? String(sheet.url) : undefined),
  };
}

export async function larkFeishuSpreadsheetGet(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  spreadsheetToken: string,
): Promise<LarkFeishuSpreadsheet | null> {
  try {
    const res = await larkFeishuUserRequest(env, provider, userToken, `/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}`);
    const s = (res as any)?.spreadsheet ?? res;
    if (!s) return null;
    return {
      token: spreadsheetToken,
      title: String(s.title ?? "Spreadsheet"),
      url: s.url ? String(s.url) : undefined,
    };
  } catch (e) {
    if (e instanceof ConnectorCallError && e.kind === "not_found") return null;
    throw e;
  }
}

export async function larkFeishuSpreadsheetRead(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  spreadsheetToken: string,
  range: string,
): Promise<LarkFeishuSpreadsheetValues> {
  const res = await larkFeishuUserRequest(
    env,
    provider,
    userToken,
    `/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`,
  );

  const vr = (res as any)?.valueRange;
  return {
    range: String(vr?.range ?? range),
    values: Array.isArray(vr?.values) ? vr.values : [],
  };
}

export async function larkFeishuSpreadsheetAppend(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  spreadsheetToken: string,
  range: string,
  values: unknown[][],
): Promise<{ updatedRange: string; updatedRows: number }> {
  const res = await larkFeishuUserRequest(
    env,
    provider,
    userToken,
    `/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_append`,
    {
      method: "POST",
      body: JSON.stringify({ valueRange: { range, values } }),
    },
  );

  const updates = (res as any)?.updates;
  const updatedRange = String(updates?.updatedRange ?? "").trim();
  const updatedRows = Number(updates?.updatedRows ?? values.length);
  if (!updatedRange) {
    throw new ConnectorCallError("provider_error", `${provider}_spreadsheet_append: missing_updated_range`);
  }

  // Read back the exact provider-reported range. Do not stamp verifiedAt on an
  // append merely because the write endpoint returned 2xx.
  const back = await larkFeishuSpreadsheetRead(env, provider, userToken, spreadsheetToken, updatedRange);
  if (!valuesEqual(values, back.values)) {
    throw new ConnectorCallError("provider_error", `${provider}_spreadsheet_append: read_back_mismatch`);
  }

  return { updatedRange, updatedRows };
}

export const larkFeishuSpreadsheetAppendRows = larkFeishuSpreadsheetAppend;
