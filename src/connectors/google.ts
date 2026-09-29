// google.ts — Google Workspace pure API helpers (token-in).
// Token management lives in token-store/token-refresh; OAuth policy lives in registry.ts.
//
// 2026-09 Hosted policy: no Google Restricted scopes / no CASA. Gmail message access is
// handled by Email / IMAP. Drive uses drive.file rather than broad drive/drive.readonly.
// Compatibility export; registry.ts is authoritative.
export { GOOGLE_SCOPES } from "./registry";
import { DEADLINE_BUDGETS_MS, fetchWithDeadline } from "../util/deadlines";


function gfetch(input: string, init?: RequestInit, operation = "google"): Promise<Response> {
  return fetchWithDeadline(input, init, { operation, budgetMs: DEADLINE_BUDGETS_MS.modelRequest });
}

// ── Gmail ──
// Legacy API helpers are kept for compatibility/self-hosted migrations, but Hosted overrides
// the gmail_* tools and does not grant Gmail OAuth scopes. Hosted users connect Gmail by IMAP.

export interface GmailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

function parseHeaders(msg: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of msg?.payload?.headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}


function extractBody(msg: any): string {
  const walk = (node: any): string => {
    if (!node) return "";
    if (node.mimeType === "text/plain" && node.body?.data) {
      return base64UrlDecode(node.body.data);
    }
    for (const part of node.parts ?? []) {
      const r = walk(part);
      if (r) return r;
    }
    if (node.mimeType === "text/html" && node.body?.data) {
      return base64UrlDecode(node.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    }
    return "";
  };
  return walk(msg.payload) || msg.snippet || "";
}

function base64UrlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function base64UrlEncode(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}


function assertOk(r: Response, code: string): void {
  if (!r.ok) throw new ConnectorCallError(httpStatusToKind(r.status), code + ": http_" + r.status, r.status, code);
}

export async function gmailSearch(
  token: string,
  q: string,
  max = 10,
): Promise<GmailSummary[]> {
  const listRes = await gfetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assertOk(listRes, "gmail_search");
  const list = (await listRes.json()) as any;
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
  const out: GmailSummary[] = [];
  for (const id of ids) {
    const r = await gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assertOk(r, "gmail_get");
    const msg = (await r.json()) as any;
    const h = parseHeaders(msg);
    out.push({
      id,
      threadId: msg.threadId,
      from: h.from ?? "",
      subject: h.subject ?? "(无主题)",
      date: h.date ?? "",
      snippet: msg.snippet ?? "",
    });
  }
  return out;
}

export async function gmailGet(token: string, id: string): Promise<{ from: string; subject: string; date: string; body: string } | null> {
  const r = await gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (r.status === 404) return null;
  assertOk(r, "gmail_read");
  const msg = (await r.json()) as any;
  const h = parseHeaders(msg);
  return { from: h.from ?? "", subject: h.subject ?? "", date: h.date ?? "", body: extractBody(msg) };
}


export async function gmailSend(
  token: string,
  opts: { to: string; subject: string; body: string },
): Promise<{ id: string }> {
  const mime = `To: ${opts.to}\r\nSubject: ${opts.subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${opts.body}`;
  const res = await gfetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: base64UrlEncode(mime) }),
  });
  assertOk(res, "gmail_send");
  const j = (await res.json()) as any;
  return { id: j.id };
}

export async function gmailDraft(
  token: string,
  opts: { to: string; subject: string; body: string },
): Promise<{ id: string }> {
  const mime = `To: ${opts.to}\r\nSubject: ${opts.subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${opts.body}`;
  const res = await gfetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { raw: base64UrlEncode(mime) } }),
  });
  assertOk(res, "gmail_draft");
  const j = (await res.json()) as any;
  return { id: j.id };
}





export async function gmailDraftGet(
  token: string,
  draftId: string,
): Promise<{ id: string; to: string; subject: string; isDraft: boolean } | null> {
  const r = await gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return null;
  assertOk(r, "gmail_draft_readback");
  const j = (await r.json()) as any;
  const h = parseHeaders(j?.message ?? {});
  const labels: string[] = j?.message?.labelIds ?? [];
  return {
    id: String(j.id ?? draftId),
    to: h.to ?? "",
    subject: h.subject ?? "",
    isDraft: labels.includes("DRAFT"),
  };
}

export async function gmailProfile(token: string): Promise<{ emailAddress: string }> {
  const r = await gfetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${token}` },
  });
  assertOk(r, "gmail_profile");
  return (await r.json()) as { emailAddress: string };
}

// ── Calendar ──

export interface CalEvent {
  id: string;
  summary: string;
  start?: string;
  end?: string;
  attendees?: string[];
  location?: string;
  hangoutLink?: string;
}

export async function calendarList(
  token: string,
  timeMinIso: string,
  timeMaxIso: string,
  max = 15,
): Promise<CalEvent[]> {
  const p = new URLSearchParams({ timeMin: timeMinIso, timeMax: timeMaxIso, singleEvents: "true", orderBy: "startTime", maxResults: String(max) });
  const r = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${p}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assertOk(r, "calendar_list");
  const j = (await r.json()) as any;
  return (j.items ?? []).map((e: any) => ({
    id: e.id,
    summary: e.summary ?? "(无标题)",
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    attendees: (e.attendees ?? []).map((a: any) => a.email),
    location: e.location,
    hangoutLink: e.hangoutLink,
  }));
}


export async function calendarCreate(
  token: string,
  ev: { summary: string; startIso: string; endIso: string; description?: string; location?: string; attendees?: string[] },
): Promise<{ id: string; htmlLink: string }> {
  const body: any = {
    summary: ev.summary,
    start: { dateTime: ev.startIso },
    end: { dateTime: ev.endIso },
    description: ev.description,
    location: ev.location,
  };
  if (ev.attendees?.length) body.attendees = ev.attendees.map((email) => ({ email }));
  const r = await gfetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assertOk(r, "calendar_create");
  const j = (await r.json()) as any;
  return { id: j.id, htmlLink: j.htmlLink };
}





export async function calendarGetEvent(
  token: string,
  eventId: string,
): Promise<{ id: string; summary: string; start?: string; end?: string; attendees: string[]; htmlLink?: string } | null> {
  const r = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return null;
  assertOk(r, "calendar_readback");
  const j = (await r.json()) as any;
  return {
    id: String(j.id ?? eventId),
    summary: j.summary ?? "",
    start: j.start?.dateTime ?? j.start?.date,
    end: j.end?.dateTime ?? j.end?.date,
    attendees: (j.attendees ?? []).map((a: any) => a.email),
    htmlLink: j.htmlLink,
  };
}

export async function calendarDelete(token: string, eventId: string): Promise<{ ok: boolean }> {
  const r = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.ok || r.status === 410) return { ok: true };
  throw new ConnectorCallError(httpStatusToKind(r.status), "calendar_delete: http_" + r.status, r.status, "calendar_delete");
}



export async function tasksList(token: string, max = 20): Promise<Array<{ id: string; title: string; due?: string; done: boolean }>> {
  const r = await gfetch(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?maxResults=${max}&showCompleted=false`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assertOk(r, "tasks_list");
  const j = (await r.json()) as any;
  return (j.items ?? []).map((t: any) => ({ id: t.id, title: t.title ?? "", due: t.due, done: t.status === "completed" }));
}

export async function tasksInsert(token: string, title: string, dueIso?: string): Promise<{ id: string }> {
  const r = await gfetch("https://tasks.googleapis.com/tasks/v1/lists/@default/tasks", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ title, ...(dueIso ? { due: dueIso } : {}) }),
  });
  assertOk(r, "tasks_add");
  const j = (await r.json()) as any;
  return { id: j.id };
}

// ── Google Contacts ──

export interface GoogleContact {
  name: string;
  emails: string[];
  phones: string[];
  organization?: string;
}

export async function googleContactsSearch(
  token: string,
  query: string,
  pageSize = 10,
): Promise<GoogleContact[]> {
  const q = encodeURIComponent(query);
  const r = await gfetch(
    `https://people.googleapis.com/v1/people:searchContacts?query=${q}&pageSize=${pageSize}&readMask=names,emailAddresses,phoneNumbers,organizations`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  assertOk(r, "contacts_search");
  const j = (await r.json()) as any;
  const results = j.results ?? [];
  return results.map((item: any) => {
    const p = item.person ?? {};
    const name = p.names?.[0]?.displayName ?? p.names?.[0]?.unstructuredName ?? "(未命名)";
    const emails: string[] = (p.emailAddresses ?? []).map((e: any) => e.value).filter(Boolean);
    const phones: string[] = (p.phoneNumbers ?? []).map((ph: any) => ph.value).filter(Boolean);
    const org = p.organizations?.[0]?.name;
    return { name, emails, phones, ...(org ? { organization: org } : {}) };
  });
}



export interface GmailThreadMessage {
  id: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  snippet: string;
  body: string;
}

export async function gmailThreadGet(
  token: string,
  threadId: string,
): Promise<{ id: string; messages: GmailThreadMessage[] } | null> {
  const r = await gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return null;
  assertOk(r, "gmail_thread");
  const j = (await r.json()) as any;
  const messages: GmailThreadMessage[] = (j.messages ?? []).map((msg: any) => {
    const h = parseHeaders(msg);
    return {
      id: msg.id,
      from: h.from ?? "",
      to: h.to ?? "",
      date: h.date ?? "",
      subject: h.subject ?? "",
      snippet: msg.snippet ?? "",
      body: extractBody(msg),
    };
  });
  return { id: threadId, messages };
}

export type GmailAction = "archive" | "move_to_inbox" | "mark_read" | "mark_unread" | "star" | "unstar";

export async function gmailModify(
  token: string,
  messageId: string,
  action: GmailAction,
): Promise<{ ok: boolean }> {
  const addLabelIds: string[] = [];
  const removeLabelIds: string[] = [];

  switch (action) {
    case "archive":
      removeLabelIds.push("INBOX");
      break;
    case "move_to_inbox":
      addLabelIds.push("INBOX");
      break;
    case "mark_read":
      removeLabelIds.push("UNREAD");
      break;
    case "mark_unread":
      addLabelIds.push("UNREAD");
      break;
    case "star":
      addLabelIds.push("STARRED");
      break;
    case "unstar":
      removeLabelIds.push("STARRED");
      break;
  }

  const r = await gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
  assertOk(r, "gmail_update");
  return { ok: true };
}


import type { Env } from "../env";
import { upsertConnectedAccount } from "./token-store";
import { getAccessToken } from "./token-mark";
import { googleDef } from "./registry";
import { ConnectorCallError, httpStatusToKind } from "./types";
export function googleConfigured(env: Env): boolean { return googleDef().configured(env); }
export function googleAuthorizeUrl(env: Env, redirectUri: string, state: string): string { return googleDef().authorizeUrl(env, redirectUri, state); }
export async function googleExchangeCode(env: Env, code: string, redirectUri: string) {
  const r = await googleDef().exchangeCode(env, code, redirectUri);
  if ("error" in (r as any)) return r as { error: string };
  const t = r as { accessToken: string; refreshToken?: string; accessExpiresAt?: number; scope?: string };
  const { now } = await import("../util");
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.accessExpiresAt ?? now(), scope: t.scope ?? "" };
}
export async function googleStoreConnection(env: Env, workspaceId: string, accountLabel: string, tok: { accessToken: string; refreshToken?: string; expiresAt: number; scope: string }): Promise<void> {
  await upsertConnectedAccount(env, workspaceId, "google", accountLabel, { accessToken: tok.accessToken, refreshToken: tok.refreshToken, accessExpiresAt: tok.expiresAt, scope: tok.scope }, accountLabel);
}
export async function getGoogleToken(env: Env, workspaceId: string, accountLabel = ""): Promise<string | null> {
  const r = await getAccessToken(env, workspaceId, "google", accountLabel || undefined);
  return r.ok ? r.token : null;
}
