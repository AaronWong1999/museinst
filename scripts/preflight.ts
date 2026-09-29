import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

function die(message: string): never {
  console.error(`\npreflight failed: ${message}\n`);
  process.exit(1);
}

if (!existsSync("config/openinst.config.json")) {
  die("config/openinst.config.json is missing. Run `npm run config:init`, edit the values, then retry.");
}

try {
  execFileSync(process.execPath, ["scripts/configure.mjs"], { stdio: "inherit" });
} catch {
  die("centralized configuration validation failed");
}

const generated = ".generated/wrangler.jsonc";
if (!existsSync(generated)) die("generated Wrangler config is missing after configuration validation");
const wrangler = JSON.parse(readFileSync(generated, "utf8"));
if (!wrangler.name || !Array.isArray(wrangler.d1_databases) || wrangler.d1_databases[0]?.binding !== "DB") {
  die("generated Cloudflare topology is incomplete");
}
if (wrangler.d1_databases[0]?.database_id || wrangler.kv_namespaces?.[0]?.id) {
  die("generated config must use draft bindings; account-specific resource IDs do not belong in user configuration");
}

try {
  execFileSync("npx", ["--yes", "wrangler@^4.45.0", "whoami"], { stdio: "inherit" });
} catch {
  die("Cloudflare authentication failed. Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN.");
}

console.log("preflight passed: centralized config is valid and Cloudflare authentication is available.");
