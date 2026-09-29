

import assert from "node:assert/strict";
import { telegramSend, telegramTyping, sendOutbound } from "../src/channels/outbound";
import { transcribeVoice, setWebhook } from "../src/channels/telegram";
import { setTelegramToken, ensureTelegramWebhookSecret, getTelegramWebhookSecret, getTelegramToken } from "../src/channels/config";
import { createTestD1, type TestD1 } from "./helpers/d1";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ Telegram self-hosted D1-only token");

let mock: TgMock | null = null;
process.on("exit", () => mock?.restore());

const TOKEN = "12345:selfhost-token";

async function seedToken(d1: TestD1): Promise<Env> {
  const env: any = { DB: d1, OPENINST_SECRET: "selfhost-secret-0123456789", PUBLIC_BASE_URL: "https://self.example.com", TELEGRAM_ENABLED: "1", AI: { run: async () => ({ text: "voice words" }) } };
  await setTelegramToken(env, TOKEN);
  assert.ok(await getTelegramToken(env), "token round-trips through D1 encrypted storage");
  return env;
}


{
  const d1 = createTestD1();
  const env = await seedToken(d1);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  const r = await telegramSend(env, "777", "hello", { replyToMessageId: "777:5" });
  assert.equal(r.ok, true);
  const call = mock.calls.find((c) => c.url.includes("/sendMessage"))!;
  assert.ok(call.url.includes(`bot${TOKEN}`), "uses D1-stored token");
  console.log("  ✅ sendMessage works with D1-only token");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  const env = await seedToken(d1);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  await telegramTyping(env, "777");
  assert.ok(mock.calls.some((c) => c.url.includes("/sendChatAction")), "typing uses stored token");
  console.log("  ✅ typing works with D1-only token");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  const env = await seedToken(d1);
  mock = mockTelegramFetch((url) => {
    if (url.includes("/getFile")) return { json: { ok: true, result: { file_path: "voice/x.oga" } } };
    if (url.includes("/file/bot")) return { raw: new Response(new Uint8Array([9, 9, 9]), { status: 200 }) };
    return { json: { ok: true, result: {} } };
  });
  const text = await transcribeVoice(env, "file1");
  assert.equal(text, "voice words", "voice transcription works with D1-only token");
  assert.ok(mock.calls.some((c) => c.url.includes(`bot${TOKEN}/getFile`)), "getFile uses stored token");
  console.log("  ✅ voice transcription works with D1-only token");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  const env = await seedToken(d1);
  await ensureTelegramWebhookSecret(env);
  const storedSecret = await getTelegramWebhookSecret(env);
  assert.ok(storedSecret, "webhook secret provisioned in D1");
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  const r = await setWebhook(env, env.PUBLIC_BASE_URL);
  assert.equal(r.ok, true, `setWebhook must succeed: ${r.error}`);
  const call = mock.calls.find((c) => c.url.includes("/setWebhook"))!;
  assert.ok(call.url.includes(`bot${TOKEN}`));
  assert.equal(call.body.secret_token, storedSecret);
  assert.equal(call.body.drop_pending_updates, false);
  console.log("  ✅ setWebhook works with D1-only token+secret");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  const env = await seedToken(d1);
  mock = mockTelegramFetch(() => ({ json: { ok: true, result: {} } }));
  const r = await sendOutbound(env, "telegram", "888", "proactive hello");
  assert.equal(r.ok, true);
  console.log("  ✅ outbound works with D1-only token");
  mock.restore();
  mock = null;
}


{
  const d1 = createTestD1();
  const env: any = { DB: d1, OPENINST_SECRET: "selfhost-secret-0123456789", PUBLIC_BASE_URL: "https://self.example.com" };
  const r = await telegramSend(env, "1", "x");
  assert.equal(r.ok, false);
  assert.equal(r.error, "telegram_not_configured");
  assert.equal(await ensureTelegramWebhookSecret(env).then((s) => s.length > 0), true, "webhook secret can still be provisioned");
  console.log("  ✅ missing token → explicit not_configured");
}

console.log("✅ telegram-selfhost.test.ts passed");
