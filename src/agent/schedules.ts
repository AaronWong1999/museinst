

export type ScheduleTimingKind = "once" | "interval" | "calendar";
export type CalendarFrequency = "daily" | "weekdays" | "weekly";
export type MissedRunPolicy = "run_latest" | "catch_up";

export interface ScheduleTimingOnce {
  kind: "once";
  at: string; // ISO datetime string with offset
}

export interface ScheduleTimingInterval {
  kind: "interval";
  anchoredAt: string; // ISO datetime string with offset
  everyMinutes: number;
}

export interface ScheduleTimingCalendar {
  kind: "calendar";
  timezone: string; // IANA timezone e.g. "Asia/Shanghai", "America/New_York"
  localTime: string; // HH:MM 24-hour format e.g. "09:00"
  frequency: CalendarFrequency;
  weekday?: number; // 0 (Sun) to 6 (Sat), required for weekly
}

export type ScheduleTiming =
  | ScheduleTimingOnce
  | ScheduleTimingInterval
  | ScheduleTimingCalendar;

export interface ScheduleJob {
  id: string;
  workspaceId: string;
  prompt: string;
  timing: ScheduleTiming;
  missedRunPolicy: MissedRunPolicy;
  channel: string;
  externalId: string;
  contextToken?: string;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
  enabled: boolean;
}

interface ZonedParts {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly second: number;
  readonly weekday: number;
  readonly year: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(at: number, timezone: string): ZonedParts {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    day: Number(value("day")),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    month: Number(value("month")),
    second: Number(value("second")),
    weekday: Math.max(0, weekdays.indexOf(value("weekday"))),
    year: Number(value("year")),
  };
}

function zoneOffset(at: number, timezone: string) {
  const parts = zonedParts(at, timezone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ) - at
  );
}

function fromWallClock(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstPass = naive - zoneOffset(naive, timezone);
  const resolved = naive - zoneOffset(firstPass, timezone);
  const readBack = zonedParts(resolved, timezone);
  if (readBack.hour === hour && readBack.minute === minute) return resolved;

  const shifted = Date.UTC(year, month - 1, day, hour + 1, minute);
  return (
    shifted - zoneOffset(shifted - zoneOffset(shifted, timezone), timezone)
  );
}


export function computeNextRun(
  timing: ScheduleTiming,
  after: Date
): Date | null {
  if (timing.kind === "once") {
    const at = new Date(timing.at);
    return at.getTime() > after.getTime() ? at : null;
  }

  if (timing.kind === "interval") {
    const anchor = Date.parse(timing.anchoredAt);
    const interval = timing.everyMinutes * 60_000;
    if (anchor > after.getTime()) return new Date(anchor);
    const elapsedIntervals = Math.floor((after.getTime() - anchor) / interval);
    return new Date(anchor + (elapsedIntervals + 1) * interval);
  }

  const [hourText, minuteText] = timing.localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const start = zonedParts(after.getTime(), timing.timezone);

  for (let offset = 0; offset <= 14; offset += 1) {
    const day = new Date(
      Date.UTC(start.year, start.month - 1, start.day) + offset * 86_400_000
    );
    const candidate = fromWallClock(
      timing.timezone,
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hour,
      minute
    );
    if (candidate <= after.getTime()) continue;
    const weekday = zonedParts(candidate, timing.timezone).weekday;
    if (timing.frequency === "weekdays" && (weekday === 0 || weekday === 6)) {
      continue;
    }
    if (timing.frequency === "weekly" && weekday !== timing.weekday) continue;
    return new Date(candidate);
  }
  return null;
}


export function computeLatestRun(
  timing: ScheduleTiming,
  at: Date
): Date | null {
  if (timing.kind === "once") {
    const occurrence = new Date(timing.at);
    return occurrence.getTime() <= at.getTime() ? occurrence : null;
  }

  if (timing.kind === "interval") {
    const anchor = Date.parse(timing.anchoredAt);
    if (anchor > at.getTime()) return null;
    const interval = timing.everyMinutes * 60_000;
    return new Date(
      anchor + Math.floor((at.getTime() - anchor) / interval) * interval
    );
  }

  const [hourText, minuteText] = timing.localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const start = zonedParts(at.getTime(), timing.timezone);

  for (let offset = 0; offset <= 14; offset += 1) {
    const day = new Date(
      Date.UTC(start.year, start.month - 1, start.day) - offset * 86_400_000
    );
    const candidate = fromWallClock(
      timing.timezone,
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hour,
      minute
    );
    if (candidate > at.getTime()) continue;
    const weekday = zonedParts(candidate, timing.timezone).weekday;
    if (timing.frequency === "weekdays" && (weekday === 0 || weekday === 6)) {
      continue;
    }
    if (timing.frequency === "weekly" && weekday !== timing.weekday) continue;
    return new Date(candidate);
  }
  return null;
}







export function computeFollowUpTime(
  baseTime: Date,
  timezone: string = "Asia/Shanghai",
  intervalHours: number = 18
): Date {
  const targetMs = baseTime.getTime() + intervalHours * 3600 * 1000;
  const parts = zonedParts(targetMs, timezone);
  const hour = parts.hour;
  const minute = parts.minute;


  const isNight = hour >= 22 || (hour === 21 && minute >= 30) || hour < 9;
  if (!isNight) {
    return new Date(targetMs);
  }


  const dayOffset = hour >= 21 ? 1 : 0;
  const candidate = fromWallClock(
    timezone,
    parts.year,
    parts.month,
    parts.day + dayOffset,
    9,
    30
  );
  return new Date(candidate);
}










export const MAX_SAFE_SDK_SCHEDULE_EPOCH_SECONDS = Math.floor(Date.UTC(2188, 0, 1, 0, 0, 0, 0) / 1000);

export const MAX_SAFE_AGENT_SCHEDULE_AT_MS = MAX_SAFE_SDK_SCHEDULE_EPOCH_SECONDS * 1000;


export function isImpossibleSdkScheduleTime(seconds: number): boolean {
  return !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SAFE_SDK_SCHEDULE_EPOCH_SECONDS;
}


export function assertSafeScheduleAtMs(atMs: number): void {
  if (!Number.isFinite(atMs) || atMs <= 0) throw new Error("invalid_schedule_time");
  if (atMs > MAX_SAFE_AGENT_SCHEDULE_AT_MS) throw new Error("schedule_time_out_of_range");
}






export function parseWhen(when: string): number {
  const t = Date.now();
  const rel = when.match(/in_(\d+)_(\w+)/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const mult: Record<string, number> = { minute: 60_000, minutes: 60_000, hour: 3600_000, hours: 3600_000, day: 86_400_000, days: 86_400_000 };
    if (mult[unit]) return t + n * mult[unit];
  }
  const parsed = Date.parse(when);
  return Number.isFinite(parsed) && parsed > t - 60_000 ? parsed : t + 3600_000;
}
