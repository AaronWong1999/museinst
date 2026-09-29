import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const configPath = "wrangler.jsonc";
const secretsPath = ".generated/button-secrets.json";
const wranglerArgs = ["--no-install", "wrangler"];

function fail(message) {
  console.error(`[deploy] ${message}`);
  process.exit(1);
}

function wrangler(args, { capture = false } = {}) {
  console.log(`> wrangler ${args.join(" ")}`);
  const result = spawnSync("npx", [...wranglerArgs, ...args], {
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr || result.stdout || "");
    fail(`wrangler ${args[0]} failed (exit ${result.status ?? "unknown"})`);
  }
  if (capture) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    return result.stdout || "";
  }
  return "";
}

if (!existsSync(configPath)) fail("wrangler.jsonc is missing");
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (!config.d1_databases?.some((item) => item.binding === "DB")) fail("DB binding is missing");
if (config.vars?.TELEGRAM_ENABLED !== "0" || config.vars?.AGENT_EMAIL_ENABLED !== "0") {
  fail("The Deploy button template requires Telegram and Agent Mail to be disabled until configured separately");
}

// The first deploy creates the Worker. Cloudflare's Deploy button provisions and
// patches the D1, KV and R2 bindings before this command runs.
const firstDeploy = wrangler(["deploy", "--config", configPath], { capture: true });
const urlFromDeploy = firstDeploy.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
const baseUrl = String(process.env.OPENINST_PUBLIC_BASE_URL || config.vars?.PUBLIC_BASE_URL || urlFromDeploy || "").replace(/\/$/, "");
if (!/^https:\/\/[a-z0-9.-]+(?:\:\d+)?$/i.test(baseUrl)) {
  fail("Set PUBLIC_BASE_URL in wrangler.jsonc to your Worker URL, or set OPENINST_PUBLIC_BASE_URL in the build environment");
}

const listed = wrangler(["secret", "list", "--format", "json", "--config", configPath], { capture: true });
let existing;
try {
  existing = new Set(JSON.parse(listed.trim()).map((item) => item.name));
} catch {
  fail("Could not read Cloudflare Worker secret list");
}
// Without ADMIN_KEY the instance is claimed in the browser: the first visit within
// the claim window becomes the owner and receives a recovery key.
const CLAIM_WINDOW_MS = 60 * 60 * 1000;
const claimUntil = existing.has("ADMIN_KEY") ? "" : new Date(Date.now() + CLAIM_WINDOW_MS).toISOString();

const generated = {};
for (const key of ["OPENINST_SECRET", "VAULT_MASTER_KEY", "WECHAT_TOKEN_KEY"]) {
  if (!existing.has(key)) generated[key] = randomBytes(32).toString("hex");
}
if (Object.keys(generated).length > 0) {
  mkdirSync(".generated", { recursive: true });
  try {
    writeFileSync(secretsPath, `${JSON.stringify(generated)}\n`, { mode: 0o600 });
    wrangler(["secret", "bulk", secretsPath, "--config", configPath]);
  } finally {
    rmSync(secretsPath, { force: true });
  }
}

wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", configPath]);

// PUBLIC_BASE_URL is resolved from the actual workers.dev URL. Keep the source
// template blank so each user's clone gets its own URL on every build.
const finalConfig = JSON.parse(readFileSync(configPath, "utf8"));
finalConfig.vars = { ...finalConfig.vars, PUBLIC_BASE_URL: baseUrl, SETUP_CLAIM_UNTIL: claimUntil };
writeFileSync(configPath, `${JSON.stringify(finalConfig, null, 2)}\n`);
wrangler(["deploy", "--config", configPath]);
console.log(claimUntil
  ? `[deploy] Open ${baseUrl} within the next hour and press "Claim" to make this agent yours`
  : `[deploy] Open ${baseUrl} and enter your ADMIN_KEY`);
