
import assert from "node:assert/strict";
import { telegramSend, telegramSetReaction, splitText, withTelegramTyping } from "../src/channels/outbound";
import { setTelegramToken } from "../src/channels/config";
import { createTestD1 } from "./helpers/d1";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ Telegram send primitives");

let mock: TgMock | null = null;
process.on("exit", () => mock?.restore());

async function envWithToken(): Promise<Env> {
  const d1 = createTestD1();
  const env: any = { DB: d1, OPENINST_SECRET: "send-test-secret-0123456", TELEGRAM_ENABLED: "1" };
  await setTelegramToken(env, "42:send-token");
  return env;
}


{
  const env = await envWithToken();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  await telegramSend(env as any, "1", "<b>bold</b> & \"quotes\"");
  const call = mock.calls.find((c) => c.url.includes("/sendMessage"))!;
  assert.equal(call.body.parse_mode, undefined);
  assert.equal(call.body.text, '<b>bold</b> & "quotes"');
  console.log("  ✅ no parse_mode (plain text)");
  mock.restore();
  mock = null;
}


{
  const env = await envWithToken();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  const chunks = splitText("x".repeat(8000), 3900);
  assert.ok(chunks.length >= 3);
  await telegramSend(env as any, "1", "y".repeat(8000), { replyToMessageId: "1:20" });
  const calls = mock.calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(calls.length, chunks.length);
  assert.ok(calls[0].body.reply_parameters, "first chunk replies");
  assert.equal(calls[1].body.reply_parameters, undefined, "later chunks do not reply");
  console.log(`  ✅ ${calls.length} chunks, reply on first only`);
  mock.restore();
  mock = null;
}


{
  const env = await envWithToken();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  const r = await telegramSetReaction(env as any, "1", "10", "👍");
  assert.equal(r.ok, true);
  const call = mock.calls.find((c) => c.url.includes("/setMessageReaction"))!;
  assert.deepEqual(call.body.reaction, [{ type: "emoji", emoji: "👍" }]);
  console.log("  ✅ reaction works");
  mock.restore();
  mock = null;
}


{
  const env = await envWithToken();
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  await withTelegramTyping(env as any, "1", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1150));
    return true;
  }, 1000);
  const typingCalls = mock.calls.filter((c) => c.url.includes("/sendChatAction"));
  assert.ok(typingCalls.length >= 2, `expected heartbeat refresh, got ${typingCalls.length}`);
  const stoppedAt = typingCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(mock.calls.filter((c) => c.url.includes("/sendChatAction")).length, stoppedAt, "typing must stop after work completes");
  console.log(`  ✅ typing heartbeat stays alive (${stoppedAt} pulses) and stops with work`);
  mock.restore();
  mock = null;
}

console.log("✅ telegram-send.test.ts passed");
