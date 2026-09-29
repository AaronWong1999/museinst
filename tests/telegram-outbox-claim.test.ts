





import assert from "node:assert/strict";
import { stageOutbox, drainTelegramOutbox, type OutboxStaging } from "../src/channels/outbox";
import { setHostHooks, resetHostHooks } from "../src/hooks";
import { createTestD1, d1All, envOf, type TestD1 } from "./helpers/d1";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ Telegram outbox send claim (A17)");

let mock: TgMock | null = null;
process.on("exit", () => {
  mock?.restore();
  resetHostHooks();
});

const STAGING: OutboxStaging = { inboxId: "ci_claim_1", channel: "telegram", destinationId: "77", replyToMessageId: "77:9" };

function sendCount(): number {
  return mock ? mock.calls.filter((c) => c.url.includes("/sendMessage")).length : 0;
}

function withFaultyRun(d1: TestD1, matcher: (sql: string) => boolean, times = 1): { fired: () => number } {
  const state = { n: 0 };
  const orig = d1.prepare.bind(d1);
  (d1 as any).prepare = (sql: string) => {
    const stmt = orig(sql);
    const origBind = stmt.bind.bind(stmt);
    return {
      bind: (...args: unknown[]) => {
        const bound = origBind(...args);
        const origRun = bound.run.bind(bound);
        return {
          first: bound.first.bind(bound),
          all: bound.all.bind(bound),
          run: async () => {
            if (state.n < times && matcher(sql)) {
              state.n++;
              throw new Error("injected_db_fault");
            }
            return origRun();
          },
        };
      },
    };
  };
  return { fired: () => state.n };
}


{
  const d1 = createTestD1();
  const env = envOf(d1);
  await stageOutbox(env, STAGING, ["only once"]);
  let providerCalls = 0;
  mock = mockTelegramFetch(() => {
    providerCalls++;
    return { json: { ok: true, result: { message_id: providerCalls } } };
  });
  const results = await Promise.all(Array.from({ length: 20 }, () => drainTelegramOutbox(env, STAGING.inboxId)));
  assert.equal(providerCalls, 1, "20 concurrent drains must call sendMessage exactly once");
  const row = (await d1All<any>(d1, `SELECT status FROM channel_outbox`))[0];
  assert.equal(row.status, "sent");
  assert.ok(results.some((r) => r.outcome === "all_sent"));
  mock.restore();
  mock = null;
  console.log("  ✅ 20 concurrent drains → exactly one send");
}


{
  const d1 = createTestD1();
  const env = envOf(d1);
  await stageOutbox(env, { ...STAGING, inboxId: "ci_claim_2" }, ["accepted but not persisted"]);
  let providerCalls = 0;
  mock = mockTelegramFetch(() => {
    providerCalls++;
    return { json: { ok: true, result: { message_id: 5 } } };
  });
  const fault = withFaultyRun(d1, (sql) => sql.includes("status='sent'"), 5);
  await assert.rejects(() => drainTelegramOutbox(env, "ci_claim_2"), /outbox_sent_persist_failed/);
  assert.equal(providerCalls, 1, "provider called once");
  assert.ok(fault.fired() >= 3, "persist retried before giving up");
  const mid = (await d1All<any>(d1, `SELECT status FROM channel_outbox`))[0];
  assert.equal(mid.status, "sending", "stays sending until lease expires (unknown result)");


  const res = await drainTelegramOutbox(env, "ci_claim_2");
  assert.equal(providerCalls, 1, "no auto resend while lease is valid");
  assert.equal(res.outcome, "has_retryable");
  d1.db.prepare(`UPDATE channel_outbox SET last_error='claim:stale-token:1'`).run();
  const swept = await drainTelegramOutbox(env, "ci_claim_2");
  assert.equal(providerCalls, 1, "expired sending must never be resent");
  assert.equal(swept.outcome, "has_uncertain");
  const row = (await d1All<any>(d1, `SELECT status, uncertain_at FROM channel_outbox`))[0];
  assert.equal(row.status, "uncertain");
  assert.ok(row.uncertain_at, "uncertain_at recorded");
  mock.restore();
  mock = null;
  console.log("  ✅ provider-accepted + persist fault → no resend, expires into uncertain");
}


{
  const d1 = createTestD1();
  const env = envOf(d1);
  await stageOutbox(env, { ...STAGING, inboxId: "ci_claim_3" }, ["already unknown"]);
  d1.db.prepare(`UPDATE channel_outbox SET status='uncertain', uncertain_at=1`).run();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  const res = await drainTelegramOutbox(env, "ci_claim_3");
  assert.equal(res.outcome, "has_uncertain", "existing uncertain rows must be surfaced, not reported all_sent");
  assert.equal(sendCount(), 0);
  mock.restore();
  mock = null;
  console.log("  ✅ existing uncertain rows are accounted as uncertain");
}


{
  const d1 = createTestD1();
  const env = envOf(d1);
  await stageOutbox(env, { ...STAGING, inboxId: "ci_claim_4" }, ["part1", "part2"]);
  d1.db.prepare(`UPDATE channel_outbox SET status='sending', last_error=? WHERE chunk_index=0`).run(`claim:other-worker:${Date.now() + 60000}`);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  const res = await drainTelegramOutbox(env, "ci_claim_4");
  assert.equal(res.outcome, "has_retryable");
  assert.equal(res.inflight, 1);
  assert.equal(sendCount(), 0, "must not send later chunks out of order while chunk0 is in-flight");
  mock.restore();
  mock = null;
  console.log("  ✅ in-flight head chunk blocks later chunks (no reordering)");
}


{
  const d1 = createTestD1();
  const env = envOf(d1);
  await stageOutbox(env, { ...STAGING, inboxId: "ci_claim_5" }, ["policy blocked"]);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  setHostHooks({ beforeOutboundSend: async () => ({ allow: false, reason: "suspended" }) });
  const denied = await drainTelegramOutbox(env, "ci_claim_5");
  assert.equal(sendCount(), 0, "host deny must block the send");
  assert.equal(denied.outcome, "has_permanent");
  const row = (await d1All<any>(d1, `SELECT status, last_error FROM channel_outbox`))[0];
  assert.equal(row.status, "permanent_failed");
  assert.ok(String(row.last_error).includes("outbound_blocked:suspended"));
  mock.restore();
  mock = null;


  const d1b = createTestD1();
  const envB = envOf(d1b);
  await stageOutbox(envB, { ...STAGING, inboxId: "ci_claim_6" }, ["gate error but owner"]);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  setHostHooks({ beforeOutboundSend: async () => { throw new Error("host db down"); } });
  const res = await drainTelegramOutbox(envB, "ci_claim_6");
  assert.equal(res.outcome, "all_sent", "owner channel keeps availability when host gate errors");
  assert.equal(sendCount(), 1);
  resetHostHooks();
  mock.restore();
  mock = null;
  console.log("  ✅ host policy deny blocks; host gate error keeps owner availability");
}

console.log("✅ telegram-outbox-claim.test.ts passed");
