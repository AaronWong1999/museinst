import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(path, "utf8");

const pkg = JSON.parse(read("package.json"));
if (pkg.license !== "Apache-2.0") fail(`package.json license must be Apache-2.0, got ${pkg.license}`);
if (!/Apache License\s+Version 2\.0/i.test(read("LICENSE"))) fail("LICENSE is not Apache-2.0 text");

for (const path of ["src/billing", "src/wechat-gateway", "src/enterprise", "gateway"]) {
  if (existsSync(path)) fail(`enterprise-only path must not exist in public repository: ${path}`);
}

for (const dep of ["better-auth", "stripe", "@stripe/stripe-js"]) {
  if (pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]) fail(`enterprise-only dependency present: ${dep}`);
}

const coreIndex = read("src/core/index.ts");
if (/WeChatPoller/.test(coreIndex)) fail("openinst/core must not export the self-hosted WeChatPoller");

const coreRouter = read("src/core/router.ts");
for (const [pattern, label] of [
  [/REQUIRE_INVITE/, "commercial invite policy in shared router"],
  [/MODEL_TIER/, "commercial model tier in shared router"],
  [/\/api\/receipts\/public/, "public receipt wall in shared router"],
  [/DELETE\s+FROM\s+(?:["']session["']|session)(?:\s|$)/i, "Better Auth session table mutation in shared router"],
  [/UPDATE \"user\"/, "Better Auth user table mutation in shared router"],
  [/estimateUsd/, "hard-coded commercial price estimate in shared usage API"],
]) {
  if (pattern.test(coreRouter)) fail(label);
}

const env = read("src/env.ts");
for (const token of ["REQUIRE_INVITE", "EDITION", "GATEWAY_RUNTIME", "MODEL_TIER", "EMAIL_TRANSPORT_BILLING"]) {
  if (env.includes(token)) fail(`enterprise/adapter policy leaked into shared Env: ${token}`);
}

const copySource = read("src/copy.ts");
for (const term of [
  "landingCopy",
  "waitlistCopy",
  "compareTableCopy",
  "advantagesCopy",
  "securityFlowCopy",
  "securityChecksCopy",
  "capacityCopy",
  "faqCopy",
  "welcomeHosted",
  "freeExhausted",
  "paidExhausted",
]) {
  if (copySource.includes(term)) fail(`Hosted commercial copy leaked into core src/copy.ts: ${term}`);
}

const migrationFiles = execFileSync("git", ["ls-files", "migrations/*.sql"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const enterpriseSchemaPatterns = [
  /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+invites\b/i,
  /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+waitlist\b/i,
  /\bfounding_number\b/i,
  /\binvite_credits\b/i,
  /\bgateway_instances\b/i,
  /\bgateway_owner\b/i,
  /\bgateway_generation\b/i,
  /\bstripe_(?:customer|subscription|payment|price|product)/i,
];
for (const file of migrationFiles) {
  const sql = read(file);
  for (const pattern of enterpriseSchemaPatterns) {
    if (pattern.test(sql)) fail(`enterprise-only schema found in ${file}: ${pattern}`);
  }
}

const example = JSON.parse(read("config/openinst.config.example.json"));
const expectedEmpty = [
  ["model.apiKey", example.model?.apiKey],
  ["channels.telegram.botToken", example.channels?.telegram?.botToken],
  ["channels.telegram.webhookSecret", example.channels?.telegram?.webhookSecret],
  ["connectors.google.clientSecret", example.connectors?.google?.clientSecret],
  ["connectors.feishu.appSecret", example.connectors?.feishu?.appSecret],
  ["connectors.lark.appSecret", example.connectors?.lark?.appSecret],
  ["connectors.github.clientSecret", example.connectors?.github?.clientSecret],
  ["secrets.openinstSecret", example.secrets?.openinstSecret],
  ["secrets.vaultMasterKey", example.secrets?.vaultMasterKey],
  ["secrets.wechatTokenKey", example.secrets?.wechatTokenKey],
  ["secrets.adminKey", example.secrets?.adminKey],
];
for (const [name, value] of expectedEmpty) {
  if (String(value ?? "").length !== 0) fail(`public example must not contain a real secret: ${name}`);
}

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const secretPatterns = [
  /\bsk_live_[A-Za-z0-9]{16,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\b\d{6,}:[A-Za-z0-9_-]{25,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g,
];
for (const file of tracked) {
  if (/^(?:\.env(?:\.|$)|\.dev\.vars(?:\.|$)|config\/openinst\.config\.json$|\.generated\/)/.test(file) && !file.endsWith(".example")) {
    fail(`private configuration must not be committed: ${file}`);
  }
  let text;
  try { text = read(file); } catch { continue; }
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) fail(`possible committed credential in ${file}: ${pattern}`);
  }
}

if (!existsSync("config/openinst.config.example.json")) fail("single-file public config example is missing");
if (!read(".gitignore").includes("config/openinst.config.json")) fail("local config must be gitignored");
if (!read(".gitignore").includes(".generated/")) fail("generated deployment artifacts must be gitignored");

if (failures.length > 0) {
  console.error("Public release boundary audit failed:");
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}
console.log("Public release boundary audit passed.");
