import assert from "node:assert/strict";
import { callModel, normalizeToolTranscript, type ModelMessage } from "../src/model/call";

console.log("▶ Testing model-call resilience...");

// Approval-resume regression: one assistant tool call must reach providers with exactly one
// authoritative tool result. If a stale/synthetic result exists, keep only the last result.
const transcript: ModelMessage[] = [
  { role: "system", content: "system" },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_calendar", type: "function", function: { name: "google_calendar_create_event", arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: "call_calendar", name: "google_calendar_create_event", content: "USER_APPROVED" },
  { role: "tool", tool_call_id: "call_calendar", name: "google_calendar_create_event", content: "{\"ok\":true,\"id\":\"evt_1\"}" },
];
const normalized = normalizeToolTranscript(transcript);
const toolResults = normalized.filter((m) => m.role === "tool" && m.tool_call_id === "call_calendar");
assert.equal(toolResults.length, 1, "duplicate tool results for one tool_call_id must be removed");
assert.match(String(toolResults[0].content), /evt_1/, "the last authoritative tool result must win");

// Timeout regression: a hung Workers AI attempt must not consume the whole retry loop.
// Use a tiny explicit timeout so the test stays fast.
let attempts = 0;
const env: any = {
  AI: {
    run: async () => {
      attempts += 1;
      if (attempts === 1) return await new Promise(() => {});
      return { response: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  },
  MODEL_PROVIDER: "workers-ai",
  MODEL_ROOT: "@cf/test/model",
  MODEL_WORKER: "@cf/test/model",
};
const result = await callModel(env, "root", [{ role: "user", content: "ping" }], {
  timeoutMs: 15,
  modelConfig: { provider: "workers-ai", model: "@cf/test/model" },
});
assert.equal(result.text, "ok");
assert.equal(attempts, 2, "a timed-out first attempt must retry instead of exhausting the total deadline");

console.log("✔ model-call resilience tests passed!");
