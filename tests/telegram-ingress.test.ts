
import assert from "node:assert/strict";
import { handleTelegramWebhook, setupTelegramBot } from "../src/channels/telegram";
import { mockTelegramFetch, type TgMock } from "./helpers/telegram-mock";

console.log("▶ Telegram ingress & setup primitives");

const SECRET = "hooksecret0123456789hooksecret0123";


function mockDB() {
  const settings = new Map<string, string>();
  return {
    __settings: settings,
    prepare: (_sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => (settings.has(String(args[0])) ? { value: settings.get(String(args[0])) } : null),
        run: async () => {
          settings.set(String(args[0]), String(args[1]));
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
}

function makeEnv(queueSend: (e: any) => Promise<void>) {
  const sent: any[] = [];
  const db = mockDB();
  db.__settings.set("telegram_bot_id", "42");
  return {
    env: {
      DB: db,
      TELEGRAM_ENABLED: "1",
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      PUBLIC_BASE_URL: "https://example.com",
      INBOUND_QUEUE: {
        send: async (e: any) => {
          sent.push(e);
          await queueSend(e);
        },
      },
    } as any,
    sent,
  };
}

function req(secret: string | null, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set("x-telegram-bot-api-secret-token", secret);
  return new Request("https://example.com/telegram/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

let mock: TgMock | null = null;
process.on("exit", () => mock?.restore());


{
  const { env, sent } = makeEnv(async () => {});
  const r1 = await handleTelegramWebhook(env, req(null, { update_id: 1 }));
  const r2 = await handleTelegramWebhook(env, req("wrong", { update_id: 1 }));
  assert.equal(r1.status, 401);
  assert.equal(r2.status, 401);
  assert.equal(sent.length, 0, "invalid secret must not enqueue");
  console.log("  ✅ invalid secret → 401, no enqueue");
}


{
  const { env, sent } = makeEnv(async () => {});
  const res = await handleTelegramWebhook(env, req(SECRET, { update_id: 100, message: { message_id: 5, from: { id: 7 }, chat: { id: 7, type: "private" }, text: "hi" } }));
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].v, 1);
  assert.equal(sent[0].channel, "telegram");
  assert.equal(sent[0].botId, "42");
  assert.equal(sent[0].externalKey, "100");
  assert.equal(sent[0].payload.update_id, 100);
  console.log("  ✅ valid update → 200 + envelope");
}


{
  const { env } = makeEnv(async () => {
    throw new Error("queue down");
  });
  const res = await handleTelegramWebhook(env, req(SECRET, { update_id: 101 }));
  assert.equal(res.status, 503);
  console.log("  ✅ enqueue failure → 503");
}


{
  const { env, sent } = makeEnv(async () => {});
  const bad = new Request("https://example.com/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    body: "not json",
  });
  assert.equal((await handleTelegramWebhook(env, bad)).status, 200);
  assert.equal((await handleTelegramWebhook(env, req(SECRET, { foo: 1 }))).status, 200);
  assert.equal(sent.length, 0, "malformed updates must be dropped with 200");
  console.log("  ✅ malformed update → 200 drop");
}


{
  mock = mockTelegramFetch((url) => {
    if (url.includes("/getMe")) {
      return { json: { ok: true, result: { id: 999, username: "some_other_bot" } } };
    }
    return { json: { ok: true, result: {} } };
  });
  const env: any = { DB: mockDB(), PUBLIC_BASE_URL: "https://example.com" };
  const r = await setupTelegramBot(env, "123:AAA", { expectedUsername: "openinstbot" });
  assert.equal(r.ok, false);
  assert.equal((r as any).error, "wrong_hosted_bot");
  console.log("  ✅ setup rejects wrong hosted bot");
  mock.restore();

  mock = mockTelegramFetch((url) => {
    if (url.includes("/getMe")) return { json: { ok: true, result: { id: 888, username: "openinstbot" } } };
    return { json: { ok: true, result: {} } };
  });
  const env2: any = { DB: mockDB(), PUBLIC_BASE_URL: "https://example.com", OPENINST_SECRET: "test-secret-0123456789abcdef" };
  const r2 = await setupTelegramBot(env2, "123:BBB", { expectedUsername: "openinstbot" });
  assert.equal(r2.ok, true);
  assert.equal(r2.id, "888");
  assert.equal(r2.webhook, "https://example.com/telegram/webhook");
  const settings = (env2.DB as any).__settings as Map<string, string>;
  assert.equal(settings.get("telegram_bot_id"), "888");
  assert.equal(settings.get("telegram_bot_username"), "openinstbot");
  assert.ok(settings.get("telegram_bot_token_enc")?.startsWith("enc:v1:"), "token must be stored encrypted");
  const profileCalls = mock.calls.filter((c) => /\/setMy(Name|Description|ShortDescription|Commands)$/.test(c.url));
  assert.equal(profileCalls.length, 8, "default and zh bot profiles must both be configured");
  const defaultName = profileCalls.find((c) => c.url.includes("/setMyName") && c.body?.language_code === undefined);
  assert.equal(defaultName?.body?.name, "MuseInst");
  const defaultCommands = profileCalls.find((c) => c.url.includes("/setMyCommands") && c.body?.language_code === undefined);
  assert.equal(defaultCommands?.body?.commands?.[0]?.description, "Start or connect MuseInst");
  const zhCommands = profileCalls.find((c) => c.url.includes("/setMyCommands") && c.body?.language_code === "zh");
  assert.equal(zhCommands?.body?.commands?.[0]?.description, "开始或连接 MuseInst");
  const hook = mock.calls.find((c) => c.url.includes("/setWebhook"));
  assert.ok(hook, "setWebhook must be called");
  assert.equal(hook.body.allowed_updates[0], "message");
  assert.equal(hook.body.drop_pending_updates, false, "drop_pending_updates defaults to false");
  console.log("  ✅ setup saves id/username/token and registers webhook");
  mock.restore();
  mock = null;
}

console.log("✅ telegram-ingress.test.ts passed");
