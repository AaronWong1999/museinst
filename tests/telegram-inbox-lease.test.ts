



import assert from "node:assert/strict";
import { consumeInboundEnvelope } from "../src/channels/inbox";
import { createTestD1, d1Get, type TestD1 } from "./helpers/d1";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ Telegram inbox lease & early-exit retry");

let mock: TgMock | null = null;
process.on("exit", () => mock?.restore());

function makeEnv(d1: TestD1, opts: { agentReplies?: string[] } = {}) {
  const agentCalls: any[] = [];
  const env: any = {
    DB: d1,
    TELEGRAM_BOT_TOKEN: "42:test-token",
    TELEGRAM_ENABLED: "1",
    AI: { run: async () => ({ text: "transcribed" }) },
    PUBLIC_BASE_URL: "https://example.com",
    AGENT: {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({
        fetch: async (_url: string, init?: any) => {
          agentCalls.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ replies: opts.agentReplies ?? ["agent reply"], taskId: "t1" }), { status: 200 });
        },
      }),
    },
  };
  return { env, agentCalls };
}

function envelope(updateId: number, message?: any) {
  return {
    v: 1 as const,
    channel: "telegram" as const,
    botId: "42",
    externalKey: String(updateId),
    payload: {
      update_id: updateId,
      message: message ?? { message_id: updateId, from: { id: 77, first_name: "T" }, chat: { id: 77, type: "private" }, text: "hello" },
    },
    receivedAt: Date.now(),
  };
}

async function seedBoundUser(d1: TestD1): Promise<void> {
  d1.db.prepare(`INSERT OR REPLACE INTO users (id, created_at) VALUES ('u_l', 0)`).run();
  d1.db.prepare(`INSERT OR REPLACE INTO workspaces (id, owner_user_id, created_at) VALUES ('ws_l', 'u_l', 0)`).run();
  d1.db.prepare(`INSERT OR REPLACE INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '77', 'ws_l', 0, 0)`).run();
  d1.db.prepare(`INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('__global', 'telegram_bot_id', '42')`).run();
}


{
  const d1 = createTestD1();
  await seedBoundUser(d1);
  const { env, agentCalls } = makeEnv(d1);
  const future = Date.now() + 10 * 60 * 1000;
  d1.db
    .prepare(
      `INSERT OR REPLACE INTO channel_inbox (id, channel, bot_id, external_key, payload_json, result_json, status, attempts, lease_token, lease_until, received_at)
       VALUES ('ci_42_11', 'telegram', '42', '11', ?, ?, 'result_ready', 1, 'other-instance', ?, ?)`,
    )
    .run(JSON.stringify(envelope(11).payload), JSON.stringify({ replies: ["cached reply"] }), future, Date.now());
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  const out = await consumeInboundEnvelope(env, envelope(11));
  assert.equal(out.kind, "retry", "valid lease must not be stolen");
  const row = await d1Get<any>(d1, `SELECT status, lease_token FROM channel_inbox WHERE id='ci_42_11'`);
  assert.equal(row.status, "result_ready");
  assert.equal(row.lease_token, "other-instance", "lease owner unchanged");
  assert.equal(agentCalls.length, 0, "no agent rerun while another instance holds the lease");
  assert.equal(mock.calls.filter((c) => c.url.includes("/sendMessage")).length, 0);
  mock.restore();
  mock = null;
  console.log("  ✅ valid lease cannot be stolen");
}


{
  const d1 = createTestD1();
  await seedBoundUser(d1);
  const { env } = makeEnv(d1);
  const past = Date.now() - 60 * 1000;
  d1.db
    .prepare(
      `INSERT OR REPLACE INTO channel_inbox (id, channel, bot_id, external_key, payload_json, status, attempts, lease_token, lease_until, received_at)
       VALUES ('ci_42_12', 'telegram', '42', '12', ?, 'processing', 1, 'dead-instance', ?, ?)`,
    )
    .run(JSON.stringify(envelope(12).payload), past, Date.now());
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  const out = await consumeInboundEnvelope(env, envelope(12));
  assert.equal(out.kind, "ack", "expired lease is reclaimable");
  const row = await d1Get<any>(d1, `SELECT status, lease_token FROM channel_inbox WHERE id='ci_42_12'`);
  assert.equal(row.status, "done");
  assert.equal(row.lease_token, null);

  const stale = d1.db
    .prepare(`UPDATE channel_inbox SET status='done', completed_at=1 WHERE id='ci_42_12' AND lease_token='dead-instance'`)
    .run();
  assert.equal(Number(stale.changes), 0, "stale instance cannot write terminal state");
  mock.restore();
  mock = null;
  console.log("  ✅ expired lease reclaimed; stale instance cannot finalize");
}


{
  const d1 = createTestD1();
  await seedBoundUser(d1);
  const longReply = "PART-ONE " + "x".repeat(4200);
  const { env, agentCalls } = makeEnv(d1, { agentReplies: [longReply] });
  let sends = 0;
  const sentTexts: string[] = [];
  mock = mockTelegramFetch((url, body) => {
    if (!url.includes("/sendMessage")) return { json: { ok: true, result: {} } };
    sends++;
    sentTexts.push(String(body.text));
    if (sends === 2) return { status: 429, json: { ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } } };
    return { json: { ok: true, result: { message_id: sends } } };
  });

  const first = await consumeInboundEnvelope(env, envelope(13));
  assert.equal(first.kind, "retry", "429 must surface as retry, not a silent ack");
  const mid = await d1Get<any>(d1, `SELECT status, lease_token, result_json FROM channel_inbox WHERE id='ci_42_13'`);
  assert.equal(mid.status, "sending", "not finalized while a chunk is retryable");
  assert.ok(mid.result_json, "replies persisted before sending");
  const midRows = d1.db.prepare(`SELECT chunk_index, status FROM channel_outbox ORDER BY chunk_index`).all() as any[];
  assert.equal(midRows[0].status, "sent");
  assert.equal(midRows[1].status, "retryable");

  const second = await consumeInboundEnvelope(env, envelope(13));
  assert.equal(second.kind, "ack");
  const row = await d1Get<any>(d1, `SELECT status FROM channel_inbox WHERE id='ci_42_13'`);
  assert.equal(row.status, "done");
  assert.equal(agentCalls.length, 1, "Queue redelivery must reuse result_json, not rerun the Agent");
  const finals = d1.db.prepare(`SELECT chunk_index, status, text FROM channel_outbox ORDER BY chunk_index`).all() as any[];
  assert.equal(finals.length, 2);
  assert.ok(finals.every((r) => r.status === "sent"));
  const firstChunkSends = sentTexts.filter((t) => t === finals[0].text).length;
  assert.equal(firstChunkSends, 1, "already-sent chunk must not be resent on recovery");
  const secondChunkSends = sentTexts.filter((t) => t === finals[1].text).length;
  assert.equal(secondChunkSends, 2, "retryable chunk: one 429 attempt + one successful retry");
  mock.restore();
  mock = null;
  console.log("  ✅ 429 recovery: failed chunk retried, finished chunk not resent, agent not rerun");
}

console.log("✅ telegram-inbox-lease.test.ts passed");
