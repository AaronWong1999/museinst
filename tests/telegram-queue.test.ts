
import assert from "node:assert/strict";
import { consumeInboundEnvelope } from "../src/channels/inbox";
import { resetHostHooks, setHostHooks } from "../src/hooks";
import { createTestD1, d1Get, type TestD1 } from "./helpers/d1";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ Telegram queue consumer");

let mock: TgMock | null = null;
process.on("exit", () => {
  mock?.restore();
  resetHostHooks();
});

function makeEnv(d1: TestD1, opts?: { agentReplies?: string[]; agentFail?: boolean }) {
  const agentCalls: any[] = [];
  return {
    env: {
      DB: d1,
      TELEGRAM_BOT_TOKEN: "42:test-token",
      TELEGRAM_ENABLED: "1",
      AGENT: {
        idFromName: (n: string) => ({ name: n }),
        get: () => ({
          fetch: async (_url: string, init?: any) => {
            const body = JSON.parse(init.body);
            agentCalls.push(body);
            if (opts?.agentFail) return new Response(JSON.stringify({ error: "agent_down" }), { status: 500 });
            return new Response(JSON.stringify({ replies: opts?.agentReplies ?? ["agent reply"] }), { status: 200 });
          },
        }),
      } as any,
      PUBLIC_BASE_URL: "https://example.com",
      AI: { run: async () => ({ text: "transcribed text" }) },
    } as any,
    agentCalls,
  };
}

function envelope(updateId: number, botId = "42", message?: any) {
  return {
    v: 1 as const,
    channel: "telegram" as const,
    botId,
    externalKey: String(updateId),
    payload: { update_id: updateId, message: message ?? { message_id: updateId, from: { id: 77, first_name: "T" }, chat: { id: 77, type: "private" }, text: "hello" } },
    receivedAt: Date.now(),
  };
}

async function seedBot(d1: TestD1) {
  await d1.db.prepare(`INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('__global', 'telegram_bot_id', '42')`).run();
  await d1.db.prepare(`INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('__global', 'telegram_bot_username', 'openinstbot')`).run();
  await d1.db.prepare(`INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('__global', 'telegram_webhook_secret_enc', 'x')`).run();
}




{
  const d1 = createTestD1();
  await seedBot(d1);
  const { env } = makeEnv(d1);
  (env as any).REQUIRE_INVITE = "1";
  await d1.db.prepare(`INSERT INTO users (id, created_at) VALUES ('u_existing', 0)`).run();
  await d1.db.prepare(`INSERT INTO workspaces (id, owner_user_id, created_at) VALUES ('ws_existing', 'u_existing', 0)`).run();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  let gateCalls = 0;
  setHostHooks({
    beforeOutboundSend: async () => {
      gateCalls++;
      return { allow: false, reason: "should_not_gate_unbound_auto_reply" };
    },
  });

  const out = await consumeInboundEnvelope(env, envelope(1));
  assert.equal(out.kind, "ack");
  const row = await d1Get<any>(d1, `SELECT status, payload_json, result_json FROM channel_inbox WHERE external_key='1'`);
  assert.equal(row.status, "done");
  assert.equal(row.payload_json, null, "payload cleared after success");
  assert.ok(JSON.parse(row.result_json).replies.length > 0);
  const sent = await d1Get<any>(d1, `SELECT status FROM channel_outbox WHERE inbox_id LIKE 'ci_42_1'`);
  assert.equal(sent.status, "sent");
  assert.equal(gateCalls, 0, "unbound inbound auto replies have no workspace policy to consult");
  const identity = await d1Get<any>(d1, `SELECT workspace_id FROM channel_identities WHERE channel='telegram' AND external_id='77'`);
  assert.equal(identity, null, "hosted-like unbound sender must remain unbound");
  resetHostHooks();
  console.log("  ✅ hosted-like unbound inbound gets explicit guide without creating identity");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await seedBot(d1);
  const { env } = makeEnv(d1);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  await consumeInboundEnvelope(env, envelope(2));
  const after1 = (await d1.db.prepare(`SELECT COUNT(*) AS c FROM channel_outbox`).get() as any).c;
  await consumeInboundEnvelope(env, envelope(2));
  await consumeInboundEnvelope(env, envelope(2));
  const after3 = (await d1.db.prepare(`SELECT COUNT(*) AS c FROM channel_outbox`).get() as any).c;
  const rows = (await d1.db.prepare(`SELECT COUNT(*) AS c FROM channel_inbox`).get() as any).c;
  assert.equal(rows, 1);
  assert.equal(after1, after3, "replayed deliveries must not add outbox rows");
  console.log("  ✅ same update_id x3 processed once");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await seedBot(d1);
  const { env } = makeEnv(d1);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  await consumeInboundEnvelope(env, envelope(3));
  const r2 = await consumeInboundEnvelope(env, envelope(3, "43"));
  assert.equal(r2.kind, "ack");
  const rows = (await d1.db.prepare(`SELECT COUNT(*) AS c FROM channel_inbox`).get() as any).c;
  assert.equal(rows, 2, "different botId namespaces are independent");
  console.log("  ✅ bot id change creates new namespace");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await seedBot(d1);
  const { env, agentCalls } = makeEnv(d1, { agentReplies: ["hello from agent"] });
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  await d1.db.prepare(`INSERT INTO users (id, created_at) VALUES ('u1', 0)`).run();
  await d1.db.prepare(`INSERT INTO workspaces (id, owner_user_id, created_at) VALUES ('ws1', 'u1', 0)`).run();
  await d1.db.prepare(`INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '77', 'ws1', 0, 0)`).run();

  const gateRequests: any[] = [];
  setHostHooks({
    beforeOutboundSend: async (_env, req) => {
      gateRequests.push(req);
      return req.workspaceId ? { allow: true } : { allow: false, reason: "missing_workspace" };
    },
  });
  const out = await consumeInboundEnvelope(env, envelope(4));
  assert.equal(out.kind, "ack");
  assert.equal(agentCalls.length, 1);
  const result = JSON.parse((await d1Get<any>(d1, `SELECT result_json FROM channel_inbox WHERE external_key='4'`)).result_json);
  assert.deepEqual(result.replies, ["hello from agent"]);
  const sent = await d1Get<any>(d1, `SELECT status FROM channel_outbox WHERE inbox_id LIKE 'ci_42_4'`);
  assert.equal(sent.status, "sent", "outbound gate must receive the destination workspace");
  assert.equal(gateRequests.length, 1);
  assert.equal(gateRequests[0].workspaceId, "ws1");
  assert.equal(gateRequests[0].source, "auto_reply");
  assert.equal(gateRequests[0].inboxId, "ci_42_4");
  resetHostHooks();
  console.log("  ✅ bound user handled by agent");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await seedBot(d1);
  const { env, agentCalls } = makeEnv(d1);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  await d1.db.prepare(`INSERT INTO users (id, created_at) VALUES ('u_lang', 0)`).run();
  await d1.db.prepare(`INSERT INTO workspaces (id, owner_user_id, created_at) VALUES ('ws_lang', 'u_lang', 0)`).run();
  await d1.db.prepare(`INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '77', 'ws_lang', 0, 0)`).run();
  const englishClient = envelope(50, "42", {
    message_id: 50,
    from: { id: 77, first_name: "T", language_code: "zh" },
    chat: { id: 77, type: "private" },
    text: "What can you do?",
  });
  await consumeInboundEnvelope(env, englishClient);
  assert.equal(agentCalls[0].lang, "en", "Telegram client locale must not force Chinese replies");
  const chineseText = envelope(51, "42", {
    message_id: 51,
    from: { id: 77, first_name: "T", language_code: "en" },
    chat: { id: 77, type: "private" },
    text: "你能做什么？",
  });
  await consumeInboundEnvelope(env, chineseText);
  assert.equal(agentCalls[1].lang, "zh", "Chinese user text should select Chinese replies");
  console.log("  ✅ Telegram reply language follows message text");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await seedBot(d1);
  const { env, agentCalls } = makeEnv(d1);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  const groupEnv = envelope(5);
  (groupEnv.payload.message as any) = { message_id: 50, from: { id: 77 }, chat: { id: -100, type: "group" }, text: "hi group" };
  const out = await consumeInboundEnvelope(env, groupEnv);
  assert.equal(out.kind, "ack");
  assert.equal(agentCalls.length, 0, "group messages must never reach the agent");
  const groupReply = await d1Get<any>(d1, `SELECT text FROM channel_outbox WHERE inbox_id LIKE 'ci_42_5'`);
  assert.match(groupReply.text, /direct messages/i);
  assert.match(groupReply.text, /@openinstbot/);
  console.log("  ✅ group message → DM-only guide, no agent");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await seedBot(d1);
  const { env, agentCalls } = makeEnv(d1);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  const photoEnv = envelope(6, "42", { message_id: 60, from: { id: 77 }, chat: { id: 77, type: "private" }, photo: [{ file_id: "x" }] });
  const out = await consumeInboundEnvelope(env, photoEnv);
  assert.equal(out.kind, "ack");
  assert.equal(agentCalls.length, 0);
  const mediaReply = await d1Get<any>(d1, `SELECT text FROM channel_outbox WHERE inbox_id LIKE 'ci_42_6'`);
  assert.match(mediaReply.text, /supported yet/i);
  console.log("  ✅ unsupported media → explicit reply");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  await seedBot(d1);
  const { env } = makeEnv(d1, { agentFail: true });
  await d1.db.prepare(`INSERT INTO users (id, created_at) VALUES ('u1', 0)`).run();
  await d1.db.prepare(`INSERT INTO workspaces (id, owner_user_id, created_at) VALUES ('ws1', 'u1', 0)`).run();
  await d1.db.prepare(`INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '77', 'ws1', 0, 0)`).run();
  await assert.rejects(() => consumeInboundEnvelope(env, envelope(7)), /dispatch_failed/);
  const row = await d1Get<any>(d1, `SELECT status FROM channel_inbox WHERE external_key='7'`);
  assert.notEqual(row.status, "done", "must not reach terminal state on agent failure");
  console.log("  ✅ agent failure → error (queue retry), non-terminal");
}


{
  const d1 = createTestD1();
  await seedBot(d1);
  const { env, agentCalls } = makeEnv(d1);
  mock = mockTelegramFetch((url) => {
    if (url.includes("/getFile")) return { json: { ok: true, result: { file_path: "voice/oga" } } };
    if (url.includes("/file/bot")) return { raw: new Response(new Uint8Array([1, 2, 3]), { status: 200 }) };
    return { json: { ok: true, result: { message_id: 1 } } };
  });
  await d1.db.prepare(`INSERT INTO users (id, created_at) VALUES ('u1', 0)`).run();
  await d1.db.prepare(`INSERT INTO workspaces (id, owner_user_id, created_at) VALUES ('ws1', 'u1', 0)`).run();
  await d1.db.prepare(`INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '77', 'ws1', 0, 0)`).run();
  const voiceEnv = envelope(8, "42", { message_id: 80, from: { id: 77 }, chat: { id: 77, type: "private" }, voice: { file_id: "f1", duration: 2 } });
  const out = await consumeInboundEnvelope(env, voiceEnv);
  assert.equal(out.kind, "ack");
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].event.text, "transcribed text");
  console.log("  ✅ voice transcribed → text event to agent");
  mock.restore();
  mock = null;
}

console.log("✅ telegram-queue.test.ts passed");
