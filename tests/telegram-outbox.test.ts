
import assert from "node:assert/strict";
import { stageOutbox, drainTelegramOutbox } from "../src/channels/outbox";
import { createTestD1, d1All, envOf, type TestD1 } from "./helpers/d1";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ Telegram outbox checkpoint");

let mock: TgMock | null = null;
process.on("exit", () => mock?.restore());

const STAGING = { inboxId: "ci_test_1", channel: "telegram", destinationId: "77", replyToMessageId: "77:9" };

function sentChunks(): string[] {
  return mock!.calls.filter((c) => c.url.includes("/sendMessage")).map((c) => c.body.text);
}


{
  const d1 = createTestD1();
  const long = "a".repeat(6000);
  await stageOutbox(envOf(d1), STAGING, [long]);
  const rows1 = await d1All<any>(d1, `SELECT chunk_index, text FROM channel_outbox ORDER BY chunk_index`);
  assert.ok(rows1.length >= 2, `expected >=2 chunks, got ${rows1.length}`);
  assert.equal(rows1.map((r) => r.text).join(""), long, "chunks must reassemble exactly");
  await stageOutbox(envOf(d1), STAGING, [long]);
  const rows2 = await d1All<any>(d1, `SELECT chunk_index FROM channel_outbox`);
  assert.equal(rows1.length, rows2.length, "restaging must not duplicate chunks");
  console.log(`  ✅ long reply → ${rows1.length} chunks, staging idempotent`);
}


{
  const d1 = createTestD1();
  await stageOutbox(envOf(d1), STAGING, ["part1", "part2"]);
  let callCount = 0;
  mock = mockTelegramFetch((url, body) => {
    if (!url.includes("/sendMessage")) return { json: { ok: true, result: {} } };
    callCount++;
    if (body.text === "part1") return { json: { ok: true, result: { message_id: 11 } } };
    return { status: 429, json: { ok: false, description: "Too Many Requests", parameters: { retry_after: 2 } } };
  });
  const drain1 = await drainTelegramOutbox(envOf(d1), STAGING.inboxId);
  assert.equal(drain1.outcome, "has_retryable");
  assert.equal(drain1.retryAfterSeconds, 2);
  assert.deepEqual(sentChunks(), ["part1", "part2"], "chunk1 sent, chunk2 attempted once then stops");
  const statuses = Object.fromEntries((await d1All<any>(d1, `SELECT text, status FROM channel_outbox`)).map((r) => [r.text, r.status]));
  assert.equal(statuses["part1"], "sent");
  assert.equal(statuses["part2"], "retryable");

  callCount = 0;

  mock.restore();
  mock = mockTelegramFetch((url, body) => {
    if (!url.includes("/sendMessage")) return { json: { ok: true, result: {} } };
    assert.equal(body.text, "part2", "retry must send only the unsent chunk");
    return { json: { ok: true, result: { message_id: 12 } } };
  });
  const drain2 = await drainTelegramOutbox(envOf(d1), STAGING.inboxId);
  assert.equal(drain2.outcome, "all_sent");
  assert.equal(await countSent(d1), 2);
  console.log("  ✅ 429 → retryable + retry_after; retry sends only chunk 2");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await stageOutbox(envOf(d1), { ...STAGING, inboxId: "ci_test_2" }, ["forbidden"]);
  mock = mockTelegramFetch((url) => (url.includes("/sendMessage") ? { status: 403, json: { ok: false, description: "Forbidden: bot was blocked" } } : { json: { ok: true, result: {} } }));
  const drain = await drainTelegramOutbox(envOf(d1), "ci_test_2");
  assert.equal(drain.outcome, "has_permanent");
  mock.restore();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  await drainTelegramOutbox(envOf(d1), "ci_test_2");
  assert.equal(sentChunks().length, 0, "permanent_failed chunks are never retried");
  console.log("  ✅ 403 → permanent, no blind retry");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await stageOutbox(envOf(d1), { ...STAGING, inboxId: "ci_test_3" }, ["ambiguous"]);
  mock = mockTelegramFetch(() => "network_error");
  const drain = await drainTelegramOutbox(envOf(d1), "ci_test_3");
  assert.equal(drain.outcome, "has_uncertain");
  const row = (await d1All<any>(d1, `SELECT status FROM channel_outbox`))[0];
  assert.equal(row.status, "uncertain");
  mock.restore();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  await drainTelegramOutbox(envOf(d1), "ci_test_3");
  assert.equal(sentChunks().length, 0, "uncertain chunks must not be re-sent automatically");
  console.log("  ✅ transport ambiguity → uncertain, no auto resend");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await stageOutbox(envOf(d1), { ...STAGING, inboxId: "ci_test_4" }, ["<b>raw</b> & text"]);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  await drainTelegramOutbox(envOf(d1), "ci_test_4");
  const call = mock.calls.find((c) => c.url.includes("/sendMessage"))!;
  assert.equal(call.body.parse_mode, undefined, "no parse_mode in v1");
  assert.equal(call.body.text, "<b>raw</b> & text");
  assert.deepEqual(call.body.link_preview_options, { is_disabled: true });
  console.log("  ✅ plain-text send (no parse_mode)");
  mock.restore();
  mock = null;
}

async function countSent(d1: TestD1): Promise<number> {
  return (await d1.db.prepare(`SELECT COUNT(*) AS c FROM channel_outbox WHERE status='sent'`).get() as any).c;
}

console.log("✅ telegram-outbox.test.ts passed");
