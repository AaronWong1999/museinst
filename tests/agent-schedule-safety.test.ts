


import assert from "node:assert/strict";
import {
  MAX_SAFE_AGENT_SCHEDULE_AT_MS,
  MAX_SAFE_SDK_SCHEDULE_EPOCH_SECONDS,
  assertSafeScheduleAtMs,
  isImpossibleSdkScheduleTime,
  parseWhen,
} from "../src/agent/schedules";

console.log("▶ Agent schedule safety (unit contract after 2026-09-12 incident)");


{
  const before = Date.now();
  const at = parseWhen("in_10_minutes");
  const after = Date.now();
  assert.ok(at >= before + 600_000 && at <= after + 600_000, `in_10_minutes should be ~now+600s in ms, got ${at}`);
}


{
  const iso = "2030-01-01T00:00:00.000Z";
  const at = parseWhen(iso);
  assert.equal(at, Date.parse(iso));
  assert.ok(at < 2_000_000_000_000, "absolute ISO must stay in ordinary epoch-ms magnitude");
}


{
  const before = Date.now();
  const at = parseWhen("2020-01-01T00:00:00.000Z");
  const after = Date.now();
  assert.ok(at >= before + 3_600_000 && at <= after + 3_600_000, "past ISO falls back to now+1h");
}


{


  assert.doesNotThrow(() => assertSafeScheduleAtMs(Date.now()));

  assert.throws(() => assertSafeScheduleAtMs(Date.UTC(2190, 0, 1)), /schedule_time_out_of_range/);
  assert.throws(() => assertSafeScheduleAtMs(MAX_SAFE_AGENT_SCHEDULE_AT_MS + 1), /schedule_time_out_of_range/);
  assert.throws(() => assertSafeScheduleAtMs(Number.NaN), /invalid_schedule_time/);
  assert.throws(() => assertSafeScheduleAtMs(0), /invalid_schedule_time/);
  assert.throws(() => assertSafeScheduleAtMs(-5_000), /invalid_schedule_time/);

  const now = Date.now();
  assert.doesNotThrow(() => assertSafeScheduleAtMs(now + 600_000));
  assert.doesNotThrow(() => assertSafeScheduleAtMs(now + 365 * 86_400_000));
}


{

  assert.equal(MAX_SAFE_AGENT_SCHEDULE_AT_MS, MAX_SAFE_SDK_SCHEDULE_EPOCH_SECONDS * 1000);

  assert.ok(MAX_SAFE_SDK_SCHEDULE_EPOCH_SECONDS > 6e9 && MAX_SAFE_SDK_SCHEDULE_EPOCH_SECONDS < 7e9);


  assert.equal(isImpossibleSdkScheduleTime(Math.floor(Date.now() / 1000)), false);

  assert.equal(isImpossibleSdkScheduleTime(MAX_SAFE_SDK_SCHEDULE_EPOCH_SECONDS), false);
  assert.equal(isImpossibleSdkScheduleTime(MAX_SAFE_SDK_SCHEDULE_EPOCH_SECONDS + 1), true);

  assert.equal(isImpossibleSdkScheduleTime(-1), true);

  assert.equal(isImpossibleSdkScheduleTime(1.789e12), true);
  assert.equal(isImpossibleSdkScheduleTime(Number.NaN), true);
}




{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/agent/personal-agent.ts", import.meta.url), "utf8");



  const sdkCalls = [...src.matchAll(/this\.schedule[<(]/g)].length;
  assert.equal(sdkCalls, 1, `SDK this.schedule must only be called inside scheduleAtMs, found ${sdkCalls}`);
  const wrapper = src.match(/private async scheduleAtMs[\s\S]*?\n  \}/);
  assert.ok(wrapper, "scheduleAtMs wrapper must exist");
  assert.match(wrapper[0], /assertSafeScheduleAtMs\(atMs\)/, "wrapper must assert the time range");
  assert.match(wrapper[0], /this\.schedule</, "wrapper must be the single SDK entry");
  assert.match(wrapper[0], /new Date\(atMs\)/, "wrapper must convert ms to Date (SDK Date branch)");


  const callSites = [...src.matchAll(/this\.scheduleAtMs\(/g)].length;
  assert.ok(callSites >= 6, `all absolute schedule call sites must use scheduleAtMs (found ${callSites})`);
}

console.log("✅ agent-schedule-safety passed");
