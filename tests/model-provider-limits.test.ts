import assert from "node:assert/strict";
import { callModel, callOpenAICompatible, callAnthropicMessages, maxContextTokens } from "../src/model/call";

console.log("▶ Provider-managed model limits");

// No deployment override means OpenInst must not invent a context window.
assert.equal(maxContextTokens({} as any), Number.POSITIVE_INFINITY);
assert.equal(maxContextTokens({ MODEL_MAX_CONTEXT: "262144" } as any), 262144);

// Workers AI: auto mode omits max_tokens entirely.
{
  let captured: any = null;
  const env: any = {
    AI: {
      run: async (_model: string, body: any) => {
        captured = body;
        return { response: "ok" };
      },
    },
  };
  await callModel(env, "root", [{ role: "user", content: "hello" }], {
    modelConfig: { provider: "workers-ai", model: "@cf/example/future-model", limitsMode: "auto" },
  });
  assert.ok(captured);
  assert.equal(Object.prototype.hasOwnProperty.call(captured, "max_tokens"), false);
}

// OpenAI-compatible BYO: auto mode likewise leaves the provider/model in control.
{
  const originalFetch = globalThis.fetch;
  let captured: any = null;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await callOpenAICompatible(
      {} as any,
      "provider/future-model",
      [{ role: "user", content: "hello" }],
      {},
      { baseUrl: "https://example.invalid/v1", apiKey: "test" },
    );
    assert.ok(captured);
    assert.equal(Object.prototype.hasOwnProperty.call(captured, "max_tokens"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Anthropic Messages requires max_tokens by protocol. Fail explicitly rather than inventing one.
await assert.rejects(
  () => callAnthropicMessages(
    "https://example.invalid",
    "test",
    "model",
    [{ role: "user", content: "hello" }],
    {},
  ),
  /anthropic_max_tokens_required/,
);

// Hosted always supplies a resolved modelConfig. A transient provider failure on that
// path must use the same retry loop as the default model path (regression for AiError 3046).
{
  let calls = 0;
  const env: any = {
    AI: {
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("AiError 3046: Request timeout");
        return { response: "recovered" };
      },
    },
  };
  const result = await callModel(env, "root", [{ role: "user", content: "hello" }], {
    modelConfig: { provider: "workers-ai", model: "@cf/example/future-model" },
  });
  assert.equal(result.text, "recovered");
  assert.equal(calls, 2, "configured provider path must retry transient failures");
}

// Request/configuration errors must not be retried blindly.
{
  let calls = 0;
  const env: any = {
    AI: {
      run: async () => {
        calls++;
        throw new Error("AiError 1004: invalid request");
      },
    },
  };
  await assert.rejects(
    () => callModel(env, "root", [{ role: "user", content: "hello" }], {
      modelConfig: { provider: "workers-ai", model: "@cf/example/future-model" },
    }),
    /AiError 1004: invalid request/,
  );
  assert.equal(calls, 1, "non-transient provider errors must not retry");
}

// AiError 3046 can also arrive wrapped in an HTTP 200 body ({success:false}).
// assertWorkersAiBodyOk must classify it as retryable so the outer loop retries it.
{
  let calls = 0;
  const env: any = {
    AI: {
      run: async () => {
        calls++;
        if (calls === 1) return { success: false, errors: [{ code: 3046, message: "Request timeout" }] };
        return { response: "recovered" };
      },
    },
  };
  const result = await callModel(env, "root", [{ role: "user", content: "hello" }], {
    modelConfig: { provider: "workers-ai", model: "@cf/example/future-model" },
  });
  assert.equal(result.text, "recovered");
  assert.equal(calls, 2, "body-embedded transient provider errors must retry");
}

// A body error classified non-retryable stays non-retryable even if its message
// contains a keyword like "network" — the provider-body flag is authoritative.
{
  let calls = 0;
  const env: any = {
    AI: {
      run: async () => {
        calls++;
        return { success: false, errors: [{ code: 7000, message: "network routing failed for these credentials" }] };
      },
    },
  };
  await assert.rejects(
    () => callModel(env, "root", [{ role: "user", content: "hello" }], {
      modelConfig: { provider: "workers-ai", model: "@cf/example/future-model" },
    }),
    /AiError 7000/,
  );
  assert.equal(calls, 1, "flagged non-retryable body errors must not fall through to message matching");
}

console.log("  ✅ no guessed context window without an operator override");
console.log("  ✅ Workers AI/OpenAI-compatible requests omit product-side output caps in auto mode");
console.log("  ✅ protocols that require a cap fail explicitly instead of silently guessing");
console.log("  ✅ configured model paths retry transient provider failures and stop on hard errors");
console.log("  ✅ body-embedded errors honour the retryable flag instead of re-matching messages");
console.log("✅ model-provider-limits.test.ts passed");
