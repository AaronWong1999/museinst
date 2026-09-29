import assert from "node:assert/strict";
import { capabilityRegistry } from "../src/core/capabilities";

async function runTests() {
  console.log("▶ CapabilityRegistry test suite (F19, A35)");

  const mockEnv: any = {
    BROWSER: {},
    AGENT_EMAIL_ENABLED: "1",
    A2A_ENABLED: "1",
    TRUSTED_PEOPLE_ENABLED: "1",
    DB: {
      prepare: () => {
        const stmt = {
          bind: () => stmt,
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return stmt;
      },
    },
  };

  const browser = await capabilityRegistry.resolve("browser", { env: mockEnv });
  assert.equal(browser.id, "browser");
  assert.equal(browser.available, true);
  assert.equal(browser.enabled, true);

  const mockEnvNoBrowser: any = { ...mockEnv, BROWSER: undefined };
  const noBrowser = await capabilityRegistry.resolve("browser", { env: mockEnvNoBrowser });
  assert.equal(noBrowser.available, false);
  assert.ok(noBrowser.reason);

  const customModels = await capabilityRegistry.resolve("customModels", { env: mockEnv });
  assert.equal(customModels.enabled, true);
  assert.equal(customModels.available, true);

  const all = await capabilityRegistry.list({ env: mockEnv });
  assert.ok(all.length >= 10, "Should list all standard capabilities");
  assert.ok(all.some((c) => c.id === "browser"));
  assert.ok(all.some((c) => c.id === "customModels"));
  assert.ok(all.some((c) => c.id === "agentMail"));

  console.log("  ✅ All CapabilityRegistry checks passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
