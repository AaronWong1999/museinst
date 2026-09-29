

import type { Env } from "../env";
import { putItem, type VaultItemMeta } from "./service";

export interface ChromePasswordEntry {
  name: string;
  url: string;
  origin?: string;
  username: string;
  password: string;
  note?: string;
}

export interface CsvImportResult {
  total: number;
  imported: number;
  skipped: number;
  items: VaultItemMeta[];
  errors: string[];
}


export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentCell.trim());
        currentCell = "";
      } else if (char === "\r") {
        if (nextChar === "\n") i++;
        currentRow.push(currentCell.trim());
        if (currentRow.some((c) => c.length > 0)) rows.push(currentRow);
        currentRow = [];
        currentCell = "";
      } else if (char === "\n") {
        currentRow.push(currentCell.trim());
        if (currentRow.some((c) => c.length > 0)) rows.push(currentRow);
        currentRow = [];
        currentCell = "";
      } else {
        currentCell += char;
      }
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((c) => c.length > 0)) rows.push(currentRow);
  }

  return rows;
}


export function extractOrigin(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  let target = rawUrl.trim();
  if (!/^https?:\/\//i.test(target)) {
    target = "https://" + target;
  }
  try {
    const u = new URL(target);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.origin;
    }
  } catch {}
  return undefined;
}


export function parseChromePasswordsCsv(csvText: string): ChromePasswordEntry[] {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const nameIdx = headers.findIndex((h) => h === "name" || h === "title" || h === "名称");
  const urlIdx = headers.findIndex((h) => h === "url" || h === "website" || h === "网址");
  const userIdx = headers.findIndex((h) => h === "username" || h === "login" || h === "user" || h === "用户名");
  const passIdx = headers.findIndex((h) => h === "password" || h === "密码");
  const noteIdx = headers.findIndex((h) => h === "note" || h === "notes" || h === "备注");

  if (passIdx === -1) {
    throw new Error("csv_missing_password_column");
  }

  const entries: ChromePasswordEntry[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const password = row[passIdx] ?? "";
    if (!password) continue;

    const rawUrl = urlIdx !== -1 ? (row[urlIdx] ?? "") : "";
    const username = userIdx !== -1 ? (row[userIdx] ?? "") : "";
    const rawName = nameIdx !== -1 ? (row[nameIdx] ?? "") : "";
    const note = noteIdx !== -1 ? (row[noteIdx] ?? "") : undefined;

    const origin = extractOrigin(rawUrl);
    const name = rawName || (origin ? new URL(origin).hostname : "") || "Login Credential";

    entries.push({
      name,
      url: rawUrl,
      origin,
      username,
      password,
      note,
    });
  }

  return entries;
}


export async function importChromePasswords(
  env: Env,
  workspaceId: string,
  csvText: string,
): Promise<CsvImportResult> {
  const entries = parseChromePasswordsCsv(csvText);
  const result: CsvImportResult = {
    total: entries.length,
    imported: 0,
    skipped: 0,
    items: [],
    errors: [],
  };

  for (const entry of entries) {
    try {
      const meta = await putItem(env, workspaceId, {
        kind: "login",
        label: entry.name,
        account: entry.username || entry.origin || "account",
        origin: entry.origin,
        fields: {
          identifier: entry.username,
          password: entry.password,
          ...(entry.note ? { note: entry.note } : {}),
          ...(entry.origin ? { origin: entry.origin } : {}),
        },
      });
      result.items.push(meta);
      result.imported++;
    } catch (e) {
      result.skipped++;
      result.errors.push(`Failed to import ${entry.name}: ${String(e)}`);
    }
  }

  return result;
}

export function chromeCsvToItems(csvText: string): Array<{
  kind: "login";
  label: string;
  account: string;
  origin?: string;
  fields: Record<string, string>;
}> {
  const entries = parseChromePasswordsCsv(csvText);
  return entries.map((e) => ({
    kind: "login",
    label: e.name,
    account: e.username || e.origin || "account",
    origin: e.origin,
    fields: {
      identifier: e.username,
      password: e.password,
      ...(e.note ? { note: e.note } : {}),
      ...(e.origin ? { origin: e.origin } : {}),
    },
  }));
}
