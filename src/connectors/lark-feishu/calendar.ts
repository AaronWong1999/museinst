// calendar.ts — Semantic Calendar adapter for Lark & Feishu.
// V2 §10.1 / §13: calendar_list, calendar_freebusy, calendar_create, calendar_update, calendar_delete.
// With real External Truth, read-back verification, and structured failure kinds.

import type { Env } from "../../env";
import { ConnectorCallError } from "../types";
import { larkFeishuUserRequest } from "./client";
import type { LarkFeishuEvent, LarkFeishuFreebusyItem, LarkFeishuProvider } from "./types";

function toSecondsTimestamp(isoOrSec: string): string {
  if (/^\d{10}$/.test(isoOrSec)) return isoOrSec;
  if (/^\d{13}$/.test(isoOrSec)) return String(Math.floor(Number(isoOrSec) / 1000));
  const ms = new Date(isoOrSec).getTime();
  if (isNaN(ms)) throw new ConnectorCallError("provider_error", `invalid_datetime_format: ${isoOrSec}`);
  return String(Math.floor(ms / 1000));
}

function toRfc3339(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new ConnectorCallError("provider_error", `invalid_datetime_format: ${iso}`);
  return d.toISOString();
}

function mapEvent(e: any): LarkFeishuEvent {
  const startSec = e.start_time?.timestamp ? Number(e.start_time.timestamp) : undefined;
  const endSec = e.end_time?.timestamp ? Number(e.end_time.timestamp) : undefined;
  return {
    id: String(e.event_id || e.id || ""),
    summary: String(e.summary ?? "(无标题)"),
    description: e.description ? String(e.description) : undefined,
    startIso: startSec ? new Date(startSec * 1000).toISOString() : (e.start_time?.date || undefined),
    endIso: endSec ? new Date(endSec * 1000).toISOString() : (e.end_time?.date || undefined),
    location: e.location?.name ? String(e.location.name) : undefined,
    attendees: Array.isArray(e.attendees) ? e.attendees.map((a: any) => a.third_party_email || a.email || a.user_id || a.open_id || a.chat_id || a.room_id || a.display_name).filter(Boolean) : undefined,
    htmlLink: e.app_link ? String(e.app_link) : undefined,
  };
}

function attendeePayload(value: string): Record<string, unknown> {
  const attendee = value.trim();
  if (!attendee) throw new ConnectorCallError("provider_error", "calendar_attendee_empty");
  if (attendee.startsWith("ou_")) return { type: "user", user_id: attendee };
  if (attendee.startsWith("oc_")) return { type: "chat", chat_id: attendee };
  if (attendee.startsWith("omm_")) return { type: "resource", room_id: attendee };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendee)) return { type: "third_party", third_party_email: attendee };
  throw new ConnectorCallError("provider_error", `unsupported_calendar_attendee: ${attendee}`);
}

function attendeeIdentity(item: any): string {
  return String(item?.third_party_email || item?.user_id || item?.open_id || item?.chat_id || item?.room_id || "").trim().toLowerCase();
}

async function listEventAttendees(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  eventId: string,
): Promise<any[]> {
  const p = new URLSearchParams({ page_size: "100", user_id_type: "open_id" });
  const res = await larkFeishuUserRequest(
    env,
    provider,
    userToken,
    `/calendar/v4/calendars/primary/events/${encodeURIComponent(eventId)}/attendees?${p}`,
  );
  return Array.isArray((res as any)?.items) ? (res as any).items : [];
}

export async function larkFeishuCalendarList(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<LarkFeishuEvent[]> {
  const p = new URLSearchParams({
    start_time: toSecondsTimestamp(timeMinIso),
    end_time: toSecondsTimestamp(timeMaxIso),
    page_size: "50",
  });
  const res = await larkFeishuUserRequest(env, provider, userToken, `/calendar/v4/calendars/primary/events?${p}`);
  const items = (res as any)?.items ?? [];
  return items.map(mapEvent);
}

export async function larkFeishuCalendarFreebusy(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<LarkFeishuFreebusyItem[]> {
  const body = {
    time_min: toRfc3339(timeMinIso),
    time_max: toRfc3339(timeMaxIso),
  };
  const res = await larkFeishuUserRequest(env, provider, userToken, `/calendar/v4/freebusy/list`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const freebusyList = (res as any)?.freebusy_list ?? [];
  return freebusyList.map((item: any) => ({
    startTime: item.start_time ? new Date(Number(item.start_time) * 1000).toISOString() : "",
    endTime: item.end_time ? new Date(Number(item.end_time) * 1000).toISOString() : "",
  }));
}

export async function larkFeishuCalendarGetEvent(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  eventId: string,
): Promise<LarkFeishuEvent | null> {
  try {
    const res = await larkFeishuUserRequest(env, provider, userToken, `/calendar/v4/calendars/primary/events/${encodeURIComponent(eventId)}`);
    const ev = (res as any)?.event ?? res;
    return ev?.event_id ? mapEvent(ev) : null;
  } catch (e) {
    if (e instanceof ConnectorCallError && e.kind === "not_found") return null;
    throw e;
  }
}

export async function larkFeishuCalendarCreate(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  event: {
    summary: string;
    startIso: string;
    endIso: string;
    description?: string;
    location?: string;
    attendees?: string[];
  },
): Promise<{ id: string; htmlLink?: string }> {
  const body: Record<string, unknown> = {
    summary: event.summary,
    start_time: { timestamp: toSecondsTimestamp(event.startIso) },
    end_time: { timestamp: toSecondsTimestamp(event.endIso) },
  };
  if (event.description) body.description = event.description;
  if (event.location) body.location = { name: event.location };

  // Calendar v4 creates the event and attendees through separate endpoints.
  // Sending an attendees field in the event-create payload is not equivalent
  // to inviting participants and can produce a false-success. Create first,
  // then add attendees; if that second step fails, roll the empty event back.
  const res = await larkFeishuUserRequest(env, provider, userToken, `/calendar/v4/calendars/primary/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const createdId = String((res as any)?.event?.event_id ?? (res as any)?.event_id ?? "");
  if (!createdId) throw new ConnectorCallError("provider_error", `${provider}_calendar_create: missing_event_id`);

  const requestedAttendees = (event.attendees ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (requestedAttendees.length > 0) {
    const attendees = requestedAttendees.map(attendeePayload);
    try {
      await larkFeishuUserRequest(
        env,
        provider,
        userToken,
        `/calendar/v4/calendars/primary/events/${encodeURIComponent(createdId)}/attendees?user_id_type=open_id`,
        {
          method: "POST",
          body: JSON.stringify({ attendees, need_notification: true }),
        },
      );
    } catch (e) {
      // Avoid leaving a partially-created event that the Agent would later
      // describe as a successful invited meeting.
      await larkFeishuUserRequest(
        env,
        provider,
        userToken,
        `/calendar/v4/calendars/primary/events/${encodeURIComponent(createdId)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
      throw e;
    }
  }

  // Read-back verification of the event itself.
  const back = await larkFeishuCalendarGetEvent(env, provider, userToken, createdId);
  if (!back) {
    throw new ConnectorCallError("provider_error", `${provider}_calendar_create: read_back_not_found`);
  }
  if (back.summary.trim() !== event.summary.trim()) {
    throw new ConnectorCallError("provider_error", `${provider}_calendar_create: summary_mismatch`);
  }

  // Attendee membership is verified through the attendee endpoint because the
  // event-get response is not guaranteed to embed the full attendee list.
  if (requestedAttendees.length > 0) {
    const actual = new Set((await listEventAttendees(env, provider, userToken, createdId)).map(attendeeIdentity).filter(Boolean));
    const missing = requestedAttendees.filter((a) => !actual.has(a.toLowerCase()));
    if (missing.length > 0) {
      throw new ConnectorCallError("provider_error", `${provider}_calendar_create: attendee_mismatch:${missing.join(",")}`);
    }
  }

  return { id: createdId, htmlLink: back.htmlLink };
}

export async function larkFeishuCalendarUpdate(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  eventId: string,
  patch: {
    summary?: string;
    startIso?: string;
    endIso?: string;
    description?: string;
    location?: string;
  },
): Promise<{ id: string; htmlLink?: string }> {
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.startIso !== undefined) body.start_time = { timestamp: toSecondsTimestamp(patch.startIso) };
  if (patch.endIso !== undefined) body.end_time = { timestamp: toSecondsTimestamp(patch.endIso) };
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = { name: patch.location };

  const res = await larkFeishuUserRequest(env, provider, userToken, `/calendar/v4/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

  const updatedId = String((res as any)?.event?.event_id ?? (res as any)?.event_id ?? eventId);

  // Read-back verification
  const back = await larkFeishuCalendarGetEvent(env, provider, userToken, updatedId);
  if (!back) {
    throw new ConnectorCallError("provider_error", `${provider}_calendar_update: read_back_not_found`);
  }

  return { id: updatedId, htmlLink: back.htmlLink };
}

export async function larkFeishuCalendarDelete(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  eventId: string,
): Promise<{ ok: true; id: string }> {
  await larkFeishuUserRequest(env, provider, userToken, `/calendar/v4/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
  return { ok: true, id: eventId };
}
