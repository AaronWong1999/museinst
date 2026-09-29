import assert from "node:assert/strict";
import { coreApiApp } from "../src/core/router";

const receipt = {
  title: "OI-R3 public receipt route",
  steps: ["Observed the unique release marker"],
  evidence: [{ type: "marker", value: "OI-R3-RECEIPT-PAGE" }],
  durationMs: 1200,
  channel: "web",
  taskClass: "conversation",
};

const env: any = {
  PUBLIC_BASE_URL: "https://example.test",
  DB: {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => sql.includes("redacted_json") && args[0] === "known"
              ? { redacted_json: JSON.stringify(receipt) }
              : null,
          };
        },
      };
    },
  },
};
const ctx: any = { waitUntil() {}, passThroughOnException() {} };

{
  const response = await coreApiApp.fetch(new Request("https://example.test/r/known"), env, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  const html = await response.text();
  assert.match(html, /OI-R3 public receipt route/);
  assert.match(html, /OI-R3-RECEIPT-PAGE/);
}

{
  const response = await coreApiApp.fetch(new Request("https://example.test/r/missing"), env, ctx);
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
}

console.log("✅ public-receipt-routes: Core API app serves public receipt HTML and 404");
