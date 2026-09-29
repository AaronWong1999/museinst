import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const useExample = process.argv.includes("--example");
const configPath = useExample
  ? "config/openinst.config.example.json"
  : (process.env.OPENINST_CONFIG || "config/openinst.config.json");
const generatedDir = ".generated";
const wranglerPath = `${generatedDir}/wrangler.jsonc`;
const secretsPath = `${generatedDir}/secrets.json`;

function fail(message) {
  console.error(`[config] ${message}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  fail(`cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
}

const deployment = config.deployment ?? {};
const model = config.model ?? {};
const browser = config.browser ?? {};
const runtime = config.runtime ?? {};
const channels = config.channels ?? {};
const connectors = config.connectors ?? {};
const agentEmail = config.agentEmail ?? {};
const secrets = config.secrets ?? {};

const slug = String(deployment.slug ?? "").trim();
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
  fail("deployment.slug must be a lowercase Cloudflare-safe name (letters, digits, hyphens, max 63 chars)");
}

let baseUrl;
try {
  baseUrl = new URL(String(deployment.baseUrl ?? ""));
} catch {
  fail("deployment.baseUrl must be an absolute URL");
}
if (!useExample && baseUrl.protocol !== "https:") fail("deployment.baseUrl must use https in a real deployment");
if (!useExample && /example\.(com|org|net)$/i.test(baseUrl.hostname)) fail("replace the example deployment.baseUrl before deploying");

const compatibilityDate = String(deployment.compatibilityDate || "2026-09-01");
if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) fail("deployment.compatibilityDate must be YYYY-MM-DD");

const provider = String(model.provider || "workers-ai");
if (!new Set(["workers-ai", "custom"]).has(provider)) fail("model.provider must be workers-ai or custom");
if (!String(model.root || "").trim()) fail("model.root is required");
if (!String(model.worker || "").trim()) fail("model.worker is required");
if (provider === "custom" && !String(model.baseUrl || "").trim()) fail("model.baseUrl is required for a custom provider");
if (!useExample && provider === "custom" && !String(model.apiKey || "").trim()) fail("model.apiKey is required for a custom provider");

// Optional per-workspace cap on simultaneous browser sessions; 0 = no cap.
const maxConcurrent = Number(browser.maxConcurrent ?? 0);
if (!Number.isInteger(maxConcurrent) || maxConcurrent < 0 || maxConcurrent > 100) {
  fail("browser.maxConcurrent must be an integer from 0 (no cap) to 100");
}
const liveView = browser.liveView ?? {};
const liveViewAccountId = String(liveView.accountId || "").trim();
const liveViewApiToken = String(liveView.apiToken || "").trim();
if (liveViewAccountId && !/^[a-f0-9]{32}$/i.test(liveViewAccountId)) {
  fail("browser.liveView.accountId must be a 32-character Cloudflare account id");
}
if (!useExample && Boolean(liveViewAccountId) !== Boolean(liveViewApiToken)) {
  fail("browser.liveView needs both accountId and apiToken to enable live view and takeover");
}
const queuesEnabled = runtime.queuesEnabled !== false;
const agentEmailEnabled = agentEmail.enabled === true;
const agentEmailDomain = String(agentEmail.domain || "").trim().toLowerCase();
if (agentEmailEnabled && !queuesEnabled) {
  fail("runtime.queuesEnabled must be true when Agent Mail is enabled");
}
if (agentEmailEnabled && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(agentEmailDomain)) {
  fail("agentEmail.domain must be a valid domain when Agent Mail is enabled");
}

const telegram = channels.telegram ?? {};
const wechat = channels.wechat ?? {};
if (!useExample && telegram.enabled && !String(telegram.botToken || "").trim()) {
  fail("channels.telegram.botToken is required when Telegram is enabled");
}
if (!useExample && telegram.enabled && !String(telegram.webhookSecret || "").trim()) {
  fail("channels.telegram.webhookSecret is required when Telegram is enabled");
}

for (const [key, min] of [["openinstSecret", 32], ["vaultMasterKey", 32], ["adminKey", 24]]) {
  const value = String(secrets[key] || "");
  if (!useExample && value.length < min) {
    fail(`secrets.${key} must be at least ${min} characters; run npm run config:init to generate it safely`);
  }
}
if (!useExample && wechat.enabled !== false && String(secrets.wechatTokenKey || "").length < 24) {
  fail("secrets.wechatTokenKey must be at least 24 characters when WeChat is enabled");
}

const queueTelegram = `${slug}-telegram-inbound`;
const queueEmail = `${slug}-agent-mail-dispatch`;
const vars = {
  QUEUE_ENABLED: queuesEnabled ? "1" : "0",
  TELEGRAM_ENABLED: telegram.enabled === true ? "1" : "0",
  WECHAT_ENABLED: wechat.enabled === false ? "0" : "1",
  MODEL_PROVIDER: provider === "custom" ? "openai" : "workers-ai",
  MODEL_ROOT: String(model.root),
  MODEL_WORKER: String(model.worker),
  BROWSER_PERCEPTION: String(browser.perception || "hybrid"),
  BROWSER_MAX_CONCURRENT: String(maxConcurrent),
  PUBLIC_BASE_URL: baseUrl.toString().replace(/\/$/, ""),
  GOOGLE_OAUTH_SCOPE_PROFILE: "self_hosted_full",
  AGENT_EMAIL_ENABLED: agentEmailEnabled ? "1" : "0",
  EMAIL_DOMAIN: agentEmailEnabled ? agentEmailDomain : "",
  AGENT_EMAIL_OUTBOUND_ENABLED: agentEmailEnabled && agentEmail.outboundEnabled === true ? "1" : "0",
  STRANGER_AUTOREPLY_GLOBAL: agentEmailEnabled && agentEmail.strangerAutoreply === true ? "1" : "0",
};
if (liveViewAccountId) vars.BROWSER_LIVE_VIEW_ACCOUNT_ID = liveViewAccountId;
if (model.baseUrl) vars.MODEL_BASE_URL = String(model.baseUrl);
if (model.maxContext !== null && model.maxContext !== undefined && String(model.maxContext) !== "") {
  const maxContext = Number(model.maxContext);
  if (!Number.isInteger(maxContext) || maxContext < 1024) {
    fail("model.maxContext must be null or an integer >= 1024");
  }
  vars.MODEL_MAX_CONTEXT = String(maxContext);
}

const wrangler = {
  $schema: "../node_modules/wrangler/config-schema.json",
  name: slug,
  main: "../src/worker.ts",
  compatibility_date: compatibilityDate,
  compatibility_flags: ["nodejs_compat"],
  assets: {
    directory: "../dist/client",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*", "/b/*", "/browser/*", "/bind/*", "/r/*", "/recipe/*", "/telegram/*", "/admin/*", "/healthz"],
  },
  ai: { binding: "AI" },
  browser: { binding: "BROWSER" },
  d1_databases: [{ binding: "DB", migrations_dir: "../migrations" }],
  r2_buckets: [{ binding: "ARTIFACTS" }],
  kv_namespaces: [{ binding: "KV" }],
  triggers: { crons: ["*/1 * * * *"] },
  durable_objects: {
    bindings: [
      { name: "AGENT", class_name: "PersonalAgent" },
      { name: "BROWSER_WORKER", class_name: "BrowserWorker" },
      { name: "WECHAT_POLLER", class_name: "WeChatPoller" },
      { name: "TOKEN_BROKER", class_name: "TokenBroker" },
    ],
  },
  migrations: [
    { tag: "v1", new_sqlite_classes: ["PersonalAgent", "BrowserWorker", "WeChatPoller"] },
    { tag: "v3", new_sqlite_classes: ["TokenBroker"] },
  ],
  observability: { enabled: true },
  vars,
};

if (agentEmailEnabled) {
  wrangler.send_email = [{ name: "SEND_EMAIL" }];
}

if (queuesEnabled && (telegram.enabled || agentEmailEnabled)) {
  const producers = [];
  const consumers = [];
  if (telegram.enabled) {
    producers.push({ binding: "INBOUND_QUEUE", queue: queueTelegram });
    consumers.push({
      queue: queueTelegram,
      max_batch_size: 1,
      max_batch_timeout: 1,
      max_retries: 5,
      retry_delay: 10,
      dead_letter_queue: `${queueTelegram}-dlq`,
      max_concurrency: 3,
    });
  }
  if (agentEmailEnabled) {
    producers.push({ binding: "EMAIL_DISPATCH_QUEUE", queue: queueEmail });
    consumers.push({
      queue: queueEmail,
      max_batch_size: 1,
      max_batch_timeout: 1,
      max_retries: 8,
      retry_delay: 20,
      dead_letter_queue: `${queueEmail}-dlq`,
      max_concurrency: 3,
    });
  }
  wrangler.queues = { producers, consumers };
}

const secretMap = {
  OPENINST_SECRET: secrets.openinstSecret,
  VAULT_MASTER_KEY: secrets.vaultMasterKey,
  WECHAT_TOKEN_KEY: wechat.enabled === false ? "" : secrets.wechatTokenKey,
  ADMIN_KEY: secrets.adminKey,
  BROWSER_API_TOKEN: liveViewApiToken,
  TELEGRAM_BOT_TOKEN: telegram.enabled ? telegram.botToken : "",
  TELEGRAM_WEBHOOK_SECRET: telegram.enabled ? telegram.webhookSecret : "",
  GOOGLE_CLIENT_ID: connectors.google?.clientId,
  GOOGLE_CLIENT_SECRET: connectors.google?.clientSecret,
  FEISHU_APP_ID: connectors.feishu?.appId,
  FEISHU_APP_SECRET: connectors.feishu?.appSecret,
  LARK_APP_ID: connectors.lark?.appId,
  LARK_APP_SECRET: connectors.lark?.appSecret,
  GITHUB_CLIENT_ID: connectors.github?.clientId,
  GITHUB_CLIENT_SECRET: connectors.github?.clientSecret,
  MODEL_API_KEY: provider === "custom" ? model.apiKey : "",
};
const secretPayload = Object.fromEntries(
  Object.entries(secretMap).filter(([, value]) => typeof value === "string" && value.length > 0),
);

mkdirSync(generatedDir, { recursive: true });
writeFileSync(wranglerPath, `${JSON.stringify(wrangler, null, 2)}\n`);
writeFileSync(secretsPath, `${JSON.stringify(secretPayload, null, 2)}\n`, { mode: 0o600 });
console.log(`[config] validated ${configPath}`);
console.log(`[config] generated ${wranglerPath}`);
if (!useExample) {
  console.log(`[config] generated ${secretsPath} with ${Object.keys(secretPayload).length} secret(s)`);
}
