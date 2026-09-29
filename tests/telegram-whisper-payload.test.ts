import assert from "node:assert/strict";
import { resetHostHooks, setHostHooks } from "../src/hooks";
import { TELEGRAM_TRANSCRIPTION_MODEL, transcribeVoice } from "../src/channels/telegram";

console.log("▶ Telegram Whisper payload contract");

const originalFetch = globalThis.fetch;
const calls: string[] = [];
let aiBody: any = null;
let usage: any = null;

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  if (url.includes("/getFile?")) {
    return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/test.oga", file_size: 4 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/file/bot")) {
    return new Response(new Uint8Array([1, 2, 3, 255]), { status: 200 });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

try {
  setHostHooks({
    afterMediaUsage: async (_env, record) => {
      usage = record;
    },
  });
  const env: any = {
    TELEGRAM_BOT_TOKEN: "42:test-token",
    TELEGRAM_ENABLED: "1",
    AI: {
      run: async (model: string, body: any) => {
        assert.equal(model, "@cf/openai/whisper-large-v3-turbo");
        aiBody = body;
        return { text: "你好 world" };
      },
    },
  };

  const text = await transcribeVoice(env, "file-1", {
    durationSeconds: 4,
    usageRef: "voice:ws_test:file-1",
    costAttribution: "owner",
  });
  assert.equal(text, "你好 world");
  assert.equal(calls.length, 2, "metadata + file download only");
  assert.equal(TELEGRAM_TRANSCRIPTION_MODEL, "@cf/openai/whisper-large-v3-turbo");
  assert.equal(aiBody?.audio, "AQID/w==", "v3 turbo receives the official Base64 audio shape");
  assert.equal(aiBody?.task, "transcribe");
  assert.deepEqual(usage, {
    channel: "telegram",
    kind: "voice",
    fileId: "file-1",
    model: "@cf/openai/whisper-large-v3-turbo",
    durationSeconds: 4,
    usageRef: "voice:ws_test:file-1",
    costAttribution: "owner",
  });
} finally {
  resetHostHooks();
  globalThis.fetch = originalFetch;
}

console.log("  ✅ whisper-large-v3-turbo receives Base64 audio and emits media usage");
console.log("✅ telegram-whisper-payload.test.ts passed");
