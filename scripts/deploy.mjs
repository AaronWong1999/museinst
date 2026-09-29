import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const configPath = process.env.OPENINST_CONFIG || "config/openinst.config.json";
const generatedWrangler = ".generated/wrangler.jsonc";
const generatedSecrets = ".generated/secrets.json";
const WRANGLER = ["--no-install", "wrangler"];

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runBestEffort(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.error) console.warn(`[deploy] best-effort command failed: ${result.error.message}`);
  return result.status === 0;
}

function wrangler(args) {
  run("npx", [...WRANGLER, ...args]);
}

function wranglerBestEffort(args) {
  return runBestEffort("npx", [...WRANGLER, ...args]);
}

run(process.execPath, ["scripts/configure.mjs"]);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const baseUrl = String(config.deployment.baseUrl).replace(/\/$/, "");
const adminKey = String(config.secrets?.adminKey || "");
const telegram = config.channels?.telegram ?? {};
const wechat = config.channels?.wechat ?? {};

run("npm", ["run", "build"]);

console.log("[deploy] Initial deploy provisions missing D1/KV/R2/Queue resources through Wrangler.");
wrangler(["deploy", "--config", generatedWrangler]);

const secrets = JSON.parse(readFileSync(generatedSecrets, "utf8"));
if (Object.keys(secrets).length > 0) {
  wrangler(["secret", "bulk", generatedSecrets, "--config", generatedWrangler]);
}

// Managed channel secrets use declarative lifecycle semantics. Disabling a channel must
// not leave an old Cloudflare secret able to reactivate it on a later configuration change.
if (!telegram.enabled) {
  const staleToken = String(telegram.botToken || "").trim();
  if (staleToken) {
    await fetch(`https://api.telegram.org/bot${staleToken}/deleteWebhook`, { method: "POST" }).catch((error) => {
      console.warn("[deploy] Telegram webhook revocation failed; runtime remains disabled", String(error));
    });
  }
  wranglerBestEffort(["secret", "delete", "TELEGRAM_BOT_TOKEN", "--config", generatedWrangler]);
  wranglerBestEffort(["secret", "delete", "TELEGRAM_WEBHOOK_SECRET", "--config", generatedWrangler]);
}
if (wechat.enabled === false) {
  wranglerBestEffort(["secret", "delete", "WECHAT_TOKEN_KEY", "--config", generatedWrangler]);
}

wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", generatedWrangler]);
wrangler(["deploy", "--config", generatedWrangler]);

if (telegram.enabled) {
  const response = await fetch(`${baseUrl}/admin/telegram/repair`, {
    method: "POST",
    headers: { "x-admin-key": adminKey },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    console.error("[deploy] Telegram initialization failed", payload ?? response.status);
    process.exit(1);
  }
  console.log(`[deploy] Telegram @${payload.username ?? "bot"} initialized at ${baseUrl}/telegram/webhook`);
}

console.log(`[deploy] Complete: ${baseUrl}`);
