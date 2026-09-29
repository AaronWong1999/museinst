





import assert from "node:assert/strict";
import { consumeInboundEnvelope } from "../src/channels/inbox";
import { setHostHooks, resetHostHooks } from "../src/hooks";
import { createTestD1, d1Get, type TestD1 } from "./helpers/d1";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ Telegram voice admission & transcription reuse");

let mock: TgMock | null = null;
process.on("exit", () => {
  mock?.restore();
  resetHostHooks();
});

function makeEnv(d1: TestD1) {
  const aiCalls: any[] = [];
  const agentCalls: any[] = [];
  const env: any = {
    DB: d1,
    TELEGRAM_BOT_TOKEN: "42:test-token",
    TELEGRAM_ENABLED: "1",
    PUBLIC_BASE_URL: "https://example.com",
    AI: { run: async (_m: string, body: any) => { aiCalls.push(body); return { text: "voice words" }; } },
    AGENT: {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({
        fetch: async (_url: string, init?: any) => {
          agentCalls.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ replies: ["ok"], taskId: "t1" }), { status: 200 });
        },
      }),
    },
  };
  return { env, aiCalls, agentCalls };
}

function voiceEnvelope(updateId: number, voice: any = { file_id: "file-1", duration: 12, mime_type: "audio/ogg" }) {
  return {
    v: 1 as const,
    channel: "telegram" as const,
    botId: "42",
    externalKey: String(updateId),
    payload: { update_id: updateId, message: { message_id: updateId, from: { id: 77, first_name: "T" }, chat: { id: 77, type: "private" }, voice } },
    receivedAt: Date.now(),
  };
}

async function seedBoundUser(d1: TestD1): Promise<void> {
  d1.db.prepare(`INSERT OR REPLACE INTO users (id, created_at) VALUES ('u_v', 0)`).run();
  d1.db.prepare(`INSERT OR REPLACE INTO workspaces (id, owner_user_id, created_at) VALUES ('ws_v', 'u_v', 0)`).run();
  d1.db.prepare(`INSERT OR REPLACE INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '77', 'ws_v', 0, 0)`).run();
  d1.db.prepare(`INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('__global', 'telegram_bot_id', '42')`).run();
}

function telegramFileCalls(): number {
  return mock ? mock.calls.filter((c) => c.url.includes("/getFile") || c.url.includes("/file/bot")).length : 0;
}


{
  const d1 = createTestD1();
  await seedBoundUser(d1);
  const { env, aiCalls, agentCalls } = makeEnv(d1);
  const purchasePrompt = "You currently have no available points. Subscribe to a plan or purchase points to continue: 👉 https://example.com/usage";
  setHostHooks({ beforeMediaAdmission: async () => ({ allow: false, reason: "no_balance", userMessage: purchasePrompt }) });
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  const out = await consumeInboundEnvelope(env, voiceEnvelope(21));
  assert.equal(out.kind, "ack");
  assert.equal(telegramFileCalls(), 0, "no Telegram file download before admission");
  assert.equal(aiCalls.length, 0, "no paid transcription for rejected voice");
  assert.equal(agentCalls.length, 0, "no model dispatch for rejected voice");
  const row = await d1Get<any>(d1, `SELECT status, last_error FROM channel_inbox WHERE id='ci_42_21'`);
  assert.equal(row.status, "done");
  assert.ok(String(row.last_error).includes("voice_gated"), `note records gate reason, got ${row.last_error}`);
  const outbox = d1.db.prepare(`SELECT COUNT(*) AS c FROM channel_outbox WHERE status='sent'`).get()!["c"];
  assert.equal(Number(outbox), 1, "user gets a fallback notice");
  const sent = await d1Get<any>(d1, `SELECT text FROM channel_outbox WHERE status='sent' LIMIT 1`);
  assert.equal(sent.text, purchasePrompt, "host-provided billing guidance must reach Telegram");
  mock.restore();
  mock = null;
  console.log("  ✅ unbound/denied voice → no download, no AI");
}


{
  const d1 = createTestD1();
  await seedBoundUser(d1);
  const { env, aiCalls } = makeEnv(d1);
  setHostHooks({ beforeMediaAdmission: async () => { throw new Error("quota db down"); } });
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  await consumeInboundEnvelope(env, voiceEnvelope(22));
  assert.equal(telegramFileCalls(), 0);
  assert.equal(aiCalls.length, 0, "admission error must not spend on transcription");
  resetHostHooks();
  mock.restore();
  mock = null;
  console.log("  ✅ admission hook error fails closed");
}


{
  const d1 = createTestD1();
  await seedBoundUser(d1);
  const { env, aiCalls } = makeEnv(d1);
  mock = mockTelegramFetch((url) => {
    if (url.includes("/getFile")) return { json: { ok: true, result: { file_path: "voice/x.oga", file_size: 99 * 1024 * 1024 } } };
    return { json: { ok: true, result: {} } };
  });
  await consumeInboundEnvelope(env, voiceEnvelope(23, { file_id: "f-big", duration: 600 }));
  assert.equal(aiCalls.length, 0, "over-duration voice must not be transcribed");
  assert.equal(telegramFileCalls(), 0, "over-duration rejected before download");

  await consumeInboundEnvelope(env, voiceEnvelope(24, { file_id: "f-size", duration: 10 }));
  assert.equal(aiCalls.length, 0, "declared oversized file must not be transcribed");
  assert.equal(telegramFileCalls(), 1, "only the getFile metadata call, no download");
  mock.restore();
  mock = null;
  console.log("  ✅ over duration/size budget → no AI call");
}


{
  const d1 = createTestD1();
  await seedBoundUser(d1);
  const { env, aiCalls, agentCalls } = makeEnv(d1);
  setHostHooks({ beforeMediaAdmission: async () => ({ allow: true, reason: "reserved", costAttribution: "owner", usageRef: "tr_1" }) });
  mock = mockTelegramFetch((url) => {
    if (url.includes("/getFile")) return { json: { ok: true, result: { file_path: "voice/x.oga", file_size: 1024 } } };
    if (url.includes("/file/bot")) return { raw: new Response(new Uint8Array([1, 2, 3]), { status: 200 }) };
    return { json: { ok: true, result: { message_id: 9 } } };
  });
  await consumeInboundEnvelope(env, voiceEnvelope(25));
  assert.equal(aiCalls.length, 1, "exactly one transcription");
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].event.text, "voice words", "transcript is dispatched as text");
  const row = await d1Get<any>(d1, `SELECT result_json FROM channel_inbox WHERE id='ci_42_25'`);
  const persisted = JSON.parse(row.result_json);
  assert.equal(persisted.voiceText, "voice words", "transcript persisted for reuse");
  assert.equal(persisted.mediaAdmission.usageRef, "tr_1", "usageRef persisted for reconciliation");
  mock.restore();
  mock = null;
  console.log("  ✅ eligible voice transcribed once, transcript persisted");
}


{
  const d1 = createTestD1();
  await seedBoundUser(d1);
  const { env, aiCalls, agentCalls } = makeEnv(d1);
  setHostHooks({ beforeMediaAdmission: async () => ({ allow: true, reason: "reserved" }) });
  d1.db
    .prepare(
      `INSERT OR REPLACE INTO channel_inbox (id, channel, bot_id, external_key, payload_json, result_json, status, attempts, received_at)
       VALUES ('ci_42_26', 'telegram', '42', '26', ?, ?, 'queued', 1, ?)`,
    )
    .run(JSON.stringify(voiceEnvelope(26).payload), JSON.stringify({ voiceText: "cached transcript" }), Date.now());
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 3 } } }));
  const out = await consumeInboundEnvelope(env, voiceEnvelope(26));
  assert.equal(out.kind, "ack");
  assert.equal(aiCalls.length, 0, "existing transcript must not be re-billed");
  assert.equal(telegramFileCalls(), 0, "no re-download when result exists");
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].event.text, "cached transcript");
  assert.equal(agentCalls[0].event.kind, "text");
  mock.restore();
  mock = null;
  console.log("  ✅ existing transcript reused, never re-transcribed");
}


{
  const d1 = createTestD1();
  await seedBoundUser(d1);
  const { env } = makeEnv(d1);
  setHostHooks({ beforeMediaAdmission: async () => ({ allow: false, reason: "no_media_for_new_users" }) });
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  const out = await consumeInboundEnvelope(env, { ...voiceEnvelope(27), payload: { update_id: 27, message: { message_id: 27, from: { id: 99, first_name: "N" }, chat: { id: 99, type: "private" }, text: "/start" } } });
  assert.equal(out.kind, "ack");
  resetHostHooks();
  mock.restore();
  mock = null;
  console.log("  ✅ text /start still works with media admission gated");
}

console.log("✅ telegram-voice-admission.test.ts passed");
