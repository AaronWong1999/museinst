import assert from "node:assert/strict";
import {
  computeLatestRun,
  computeNextRun,
  type ScheduleTimingCalendar,
  type ScheduleTimingInterval,
  type ScheduleTimingOnce,
} from "../src/agent/schedules";

console.log("▶ Testing Schedules Engine (Recurrence, DST & Timezones)...");

// 1. Once Timing
const futureOnce: ScheduleTimingOnce = {
  kind: "once",
  at: "2026-10-01T12:00:00.000Z",
};
const pastOnce: ScheduleTimingOnce = {
  kind: "once",
  at: "2026-01-01T12:00:00.000Z",
};

assert.equal(
  computeNextRun(futureOnce, new Date("2026-09-01T00:00:00.000Z"))?.toISOString(),
  "2026-10-01T12:00:00.000Z"
);
assert.equal(
  computeNextRun(pastOnce, new Date("2026-09-01T00:00:00.000Z")),
  null,
  "Once in the past should return null"
);

// 2. Interval Timing
const interval: ScheduleTimingInterval = {
  kind: "interval",
  anchoredAt: "2026-09-01T00:00:00.000Z",
  everyMinutes: 15,
};
assert.equal(
  computeNextRun(interval, new Date("2026-09-01T00:05:00.000Z"))?.toISOString(),
  "2026-09-01T00:15:00.000Z"
);
assert.equal(
  computeNextRun(interval, new Date("2026-09-01T00:15:00.000Z"))?.toISOString(),
  "2026-09-01T00:30:00.000Z"
);

// 3. Calendar Daily (Asia/Shanghai, UTC+8)
const dailyShanghai: ScheduleTimingCalendar = {
  kind: "calendar",
  timezone: "Asia/Shanghai",
  localTime: "09:30",
  frequency: "daily",
};
// When it's 2026-09-07 08:00:00 CST (00:00 UTC), next should be today at 09:30 CST (01:30 UTC)
const morning = new Date("2026-09-07T00:00:00.000Z");
assert.equal(
  computeNextRun(dailyShanghai, morning)?.toISOString(),
  "2026-09-07T01:30:00.000Z"
);

// When it's 2026-09-07 10:00:00 CST (02:00 UTC), next should be tomorrow 2026-09-08 09:30 CST (01:30 UTC)
const afternoon = new Date("2026-09-07T02:00:00.000Z");
assert.equal(
  computeNextRun(dailyShanghai, afternoon)?.toISOString(),
  "2026-09-08T01:30:00.000Z"
);

// 4. Calendar Weekdays
const weekdaysShanghai: ScheduleTimingCalendar = {
  kind: "calendar",
  timezone: "Asia/Shanghai",
  localTime: "09:00",
  frequency: "weekdays",
};
// 2026-09-11 is a Friday. At 18:00 CST (10:00 UTC), next should be Monday 2026-09-14 09:00 CST (01:00 UTC)
const fridayEvening = new Date("2026-09-11T10:00:00.000Z");
const nextWeekday = computeNextRun(weekdaysShanghai, fridayEvening);
assert.equal(nextWeekday?.toISOString(), "2026-09-14T01:00:00.000Z");

// 5. Calendar Weekly (Wednesday = 3)
const weeklyWed: ScheduleTimingCalendar = {
  kind: "calendar",
  timezone: "Asia/Shanghai",
  localTime: "10:00",
  frequency: "weekly",
  weekday: 3,
};
// 2026-09-10 is Thursday. Next Wed is 2026-09-16 10:00 CST (02:00 UTC)
const thursday = new Date("2026-09-10T02:00:00.000Z");
assert.equal(
  computeNextRun(weeklyWed, thursday)?.toISOString(),
  "2026-09-16T02:00:00.000Z"
);

// 6. Timezone & DST (America/New_York)
// March 2026 DST begins: 2026-03-08.
// Before DST (UTC-5): 09:00 EDT = 14:00 UTC
// After DST (UTC-4): 09:00 EDT = 13:00 UTC
const nyDaily: ScheduleTimingCalendar = {
  kind: "calendar",
  timezone: "America/New_York",
  localTime: "09:00",
  frequency: "daily",
};
const beforeDst = new Date("2026-03-05T12:00:00.000Z"); // 07:00 EST
const afterDst = new Date("2026-03-10T12:00:00.000Z"); // 08:00 EDT

assert.equal(
  computeNextRun(nyDaily, beforeDst)?.toISOString(),
  "2026-03-05T14:00:00.000Z", // 09:00 EST is 14:00 UTC
  "Before DST transition offset should be UTC-5"
);
assert.equal(
  computeNextRun(nyDaily, afterDst)?.toISOString(),
  "2026-03-10T13:00:00.000Z", // 09:00 EDT is 13:00 UTC
  "After DST transition offset should be UTC-4"
);

// 7. computeLatestRun
assert.equal(
  computeLatestRun(futureOnce, new Date("2026-09-01T00:00:00.000Z")),
  null
);
assert.equal(
  computeLatestRun(pastOnce, new Date("2026-09-01T00:00:00.000Z"))?.toISOString(),
  "2026-01-01T12:00:00.000Z"
);

console.log("✔ Schedules & timezone recurrence tests passed!");
