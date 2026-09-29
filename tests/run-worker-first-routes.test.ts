import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

console.log("▶ Browser live view links reach the Worker on self-hosted deployments");

const wrangler = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
const configure = readFileSync("scripts/configure.mjs", "utf8");
for (const route of ["/b/*", "/browser/*"]) {
  assert.ok(wrangler.assets.run_worker_first.includes(route), `wrangler.jsonc run_worker_first must include ${route}`);
  assert.ok(configure.includes(`"${route}"`), `scripts/configure.mjs run_worker_first must include ${route}`);
}
console.log("  ✅ both deploy paths route /b/* and /browser/* to the Worker");
