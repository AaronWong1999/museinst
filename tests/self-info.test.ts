import assert from "node:assert/strict";
import { TOOL_get_self_info } from "../src/agent/self-info";
import { findTool } from "../src/agent/tools";
import { CLOUDFLARE_PRESETS, DEFAULT_MODEL_CONFIG } from "../src/model/config";

console.log("▶ Testing Self-Hosted get_self_info & Knowledge Boundary...");

// 1. Tool Registration & Name
const registered = findTool("get_self_info");
assert.ok(registered, "get_self_info must be registered in allTools");
assert.equal(registered.name, "get_self_info");

// 2. Invariant 1: Open source schema must NOT know commercial concepts
const schemaStr = JSON.stringify(TOOL_get_self_info).toLowerCase();
const forbiddenTerms = [
  "plan",
  "points",
  "credits",
  "stripe",
  "logos",
  "nous",
  "billing",
  "subscription",
  "debt",
  "hold",
  "purchase",
];

for (const term of forbiddenTerms) {
  assert.equal(
    schemaStr.includes(term),
    false,
    `CRITICAL: Open-source get_self_info schema must NOT contain commercial keyword '${term}'`,
  );
}

// 2.1 Built-in model presets identify models; provider/model owns capacity by default.
assert.equal(DEFAULT_MODEL_CONFIG.limitsMode, "auto");
assert.equal(DEFAULT_MODEL_CONFIG.maxContext, undefined);
assert.equal(DEFAULT_MODEL_CONFIG.maxTokens, undefined);
for (const preset of CLOUDFLARE_PRESETS) {
  assert.equal("maxContext" in preset, false, `${preset.id} must not duplicate provider context limits`);
  assert.equal("maxTokens" in preset, false, `${preset.id} must not duplicate provider output limits`);
}

// 3. Execution & Result Shape
async function runExecutionTests() {
  const mockEnv: any = {
    MODEL_ROOT: "@cf/zai-org/glm-5.3-flash",
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({
            results: [
              { channel: "telegram", external_id: "tg-123456", display_name: "Aaron", last_seen_at: 1000 },
              { channel: "wechat", external_id: "wx-999999", display_name: "AaronW", last_seen_at: 2000 },
            ],
          }),
        }),
      }),
    },
  };

  const mockCtx: any = {
    env: mockEnv,
    workspaceId: "ws-test-1",
    userId: "user-test-1",
    channel: "wechat",
    lang: "zh",
    say: async () => {},
    hasActiveBrowserTask: () => false,
  };

  // 3.1 all aspect
  const resAll = await TOOL_get_self_info.run(mockCtx, { aspect: "all" });
  assert.equal(resAll.ok, true);
  const dataAll: any = resAll.data;

  assert.equal(dataAll.edition?.type, "self_hosted");
  assert.equal(dataAll.model?.id, "@cf/zai-org/glm-5.3-flash");
  assert.equal(dataAll.model?.limits_mode, "provider_managed");
  assert.equal(dataAll.model?.max_context_tokens, null);
  assert.equal(dataAll.model?.max_output_tokens, null);
  assert.equal(dataAll.channels?.current_channel, "wechat");
  assert.equal(dataAll.channels?.bindings?.length, 2);

  // Invariant: external_id MUST NOT be exposed
  for (const b of dataAll.channels.bindings) {
    assert.equal(b.external_id, undefined, "external_id must not be exposed in bindings");
  }

  // Invariant: result must NOT contain commercial keys
  const resultStr = JSON.stringify(dataAll).toLowerCase();
  for (const term of forbiddenTerms) {
    assert.equal(
      resultStr.includes(`"${term}"`),
      false,
      `CRITICAL: Open-source get_self_info return data must NOT contain commercial key '${term}'`,
    );
  }

  // 3.2 aspect filtering
  const resModel = await TOOL_get_self_info.run(mockCtx, { aspect: "model" });
  assert.equal(resModel.ok, true);
  assert.ok((resModel.data as any).model);
  assert.equal((resModel.data as any).edition, undefined);

  const resChannels = await TOOL_get_self_info.run(mockCtx, { aspect: "channels" });
  assert.equal(resChannels.ok, true);
  assert.ok((resChannels.data as any).channels);
  assert.equal((resChannels.data as any).model, undefined);

  console.log("✔ Self-Hosted get_self_info tests passed!");
}

runExecutionTests().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
