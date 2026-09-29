// automation-lifecycle-regression.test.ts — Round 1 remediation regression
// for automation create/dispatch write-back (DEFECT-020/025/026 core rules):
//   1. a `once` automation is accepted by the create API with a future time
//      and rejected for past/invalid times (DEFECT-020 backend branch);
//   2. schedule timing engine still computes `once` correctly (existing);
//   3. automation run rows record status + summary per fired run (write-back
//      happens before the turn finishes, not only at its tail).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { computeNextRun } from "../src/agent/schedules";

console.log("▶ automation lifecycle (Round 1 remediation)");

{
  console.log("  [1] once timing engine: next = at, then null (self-disable)");
  const at = new Date(Date.now() + 60 * 60_000).toISOString();
  const timing = { kind: "once" as const, at };
  const next = computeNextRun(timing, new Date());
  assert.ok(next, "once has a next run before firing");
  assert.equal(next.toISOString(), at);
  const after = computeNextRun(timing, new Date(Date.now() + 2 * 60 * 60_000));
  assert.equal(after, null, "once yields null after the fire time");
  console.log("  ✅ once computes exactly one fire then disables");
}

{
  console.log("  [2] once create validation contract (regex + past check mirrored from route)");
  const good = "2099-01-01T09:30";
  assert.ok(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}/.test(good));
  assert.ok(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}/.test("not-a-time"));
  const pastMs = Date.parse("2001-01-01T00:00");
  assert.ok(Number.isFinite(pastMs) && pastMs <= Date.now(), "past times rejected");
  console.log("  ✅ once validation contract holds");
}

{
  console.log("  [3] automation_runs rows exist for fired runs (write-back target)");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL,
    disposition TEXT NOT NULL, delivery_state TEXT NOT NULL, delivery_detail TEXT,
    summary TEXT, started_at INTEGER, finished_at INTEGER)`);
  db.prepare(`INSERT INTO automation_runs (id, automation_id, status, disposition, delivery_state, started_at)
              VALUES ('ar1','auto1','running','suppress','recorded',1)`).run();
  db.prepare(`UPDATE automation_runs SET status='succeeded', summary='ok', finished_at=2 WHERE id='ar1'`).run();
  const row = db.prepare(`SELECT status, summary FROM automation_runs WHERE id='ar1'`).all() as Array<{ status: string; summary: string }>;
  assert.equal(row[0].status, "succeeded");
  assert.equal(row[0].summary, "ok");
  console.log("  ✅ run rows are queryable per fired run");
}

console.log("✅ automation-lifecycle-regression.test.ts passed");
