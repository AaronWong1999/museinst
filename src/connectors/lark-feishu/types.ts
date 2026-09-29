// types.ts — Lark / Feishu shared connector family types.
// V2 §1.2: One capability family, two real independent providers: "lark" | "feishu".

export type LarkFeishuProvider = "lark" | "feishu";

export interface LarkFeishuPlatformConfig {
  provider: LarkFeishuProvider;
  apiOrigin: string;
  appId: string;
  appSecret: string;
}

export interface LarkFeishuUserInfo {
  openId: string;
  unionId?: string;
  tenantKey?: string;
  name: string;
  enName?: string;
  email?: string;
  mobile?: string;
  avatarUrl?: string;
}

// ── Calendar types ──

export interface LarkFeishuEvent {
  id: string;
  summary: string;
  description?: string;
  startIso?: string;
  endIso?: string;
  location?: string;
  attendees?: string[];
  htmlLink?: string;
}

export interface LarkFeishuFreebusyItem {
  startTime: string;
  endTime: string;
}

// ── Task / Todo types ──

export interface LarkFeishuTask {
  id: string;
  guid: string;
  summary: string;
  description?: string;
  dueIso?: string;
  completed: boolean;
  completedAt?: string;
  url?: string;
}

// ── Contact types ──

export interface LarkFeishuContact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  department?: string;
  avatarUrl?: string;
}

// ── Document types ──

export interface LarkFeishuDocument {
  documentId: string;
  title: string;
  content?: string;
  url?: string;
}

// ── Spreadsheet types ──

export interface LarkFeishuSpreadsheet {
  token: string;
  title: string;
  url?: string;
}

export interface LarkFeishuSpreadsheetValues {
  range: string;
  values: unknown[][];
}

// ── Database (Bitable) types ──

export interface LarkFeishuRecord {
  recordId: string;
  fields: Record<string, unknown>;
}
