


import assert from "node:assert/strict";
import { BrowserWorker } from "../src/agent/browser-worker";

console.log("▶ P0-03 navigation recovery (merged audit §5)");

const worker = new (BrowserWorker as any)(
  { storage: { sql: { exec: () => [] } }, id: { name: "w" }, blockConcurrencyWhile: async (fn: any) => await fn() },
  {},
);


{
  assert.equal(worker.isTransientNavError(new Error("Execution context was destroyed, most likely because of a navigation.")), true);
  assert.equal(worker.isTransientNavError(new Error("Frame was detached")), true);
  assert.equal(worker.isTransientNavError(new Error("Target closed")), true);
  assert.equal(worker.isTransientNavError(new Error("Cannot find context with specified id")), true);
  console.log("  ✅ transient context errors are recoverable");
}


{
  for (const msg of [
    "net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_CERT_AUTHORITY_INVALID",
    "navigation_failed: timeout",
    "launch_failed: no browser",
    "connection refused",
    "DNS lookup failed",
  ]) {
    assert.equal(worker.isTransientNavError(new Error(msg)), false, `${msg} 不得误判为可恢复`);
  }

  assert.equal(worker.isTransientNavError(new Error("some navigation thing happened")), false);
  console.log("  ✅ real network errors never misclassified");
}


{
  let calls = 0;
  const page: any = {
    evaluate: async () => {
      calls++;
      if (calls === 1) throw new Error("Execution context was destroyed");
      return { url: "https://example.com/", title: "Example", elements: [] };
    },
  };
  const r = await worker.perceive(page);
  assert.ok(r.text.includes("https://example.com/"));
  assert.equal(calls, 2, "一次失效后应恢复并重读");
  console.log("  ✅ single context loss recovers");
}


{
  const page: any = {
    evaluate: async () => { throw new Error("Execution context was destroyed"); },
  };
  let err: Error | null = null;
  try {
    await worker.perceive(page);
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err, "超过预算必须抛错");
  assert.ok(!String(err?.message ?? "").includes("Execution context was destroyed"), "不得向用户泄露原始错误");
  console.log("  ✅ budget exceeded fails gracefully");
}


{
  let n = 0;
  const page: any = {
    url: () => (n >= 2 ? "https://example.com/after" : "https://example.com/before"),
    title: async () => "t",
  };
  const origSleep = worker.sleep.bind(worker);
  worker.sleep = async () => { n++; };
  const r = await worker.waitForDocumentSettled(page, { beforeUrl: "https://example.com/before", beforeTitle: "t", deadlineMs: 5000, pollMs: 1, stableSamples: 1 });
  worker.sleep = origSleep;
  assert.equal(r.settled, true);
  assert.equal(r.url, "https://example.com/after");
  console.log("  ✅ settle detects navigation");
}

console.log("✅ merged-p0-03-navigation-recovery tests passed");
