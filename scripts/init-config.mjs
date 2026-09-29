import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const target = process.env.OPENINST_CONFIG || "config/openinst.config.json";
const example = "config/openinst.config.example.json";

if (existsSync(target)) {
  console.error(`${target} already exists; refusing to overwrite local deployment secrets.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(example, "utf8"));
const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");
config.secrets.openinstSecret = secret(48);
config.secrets.vaultMasterKey = secret(48);
config.secrets.wechatTokenKey = secret(32);
config.secrets.adminKey = secret(32);
config.channels.telegram.webhookSecret = secret(32);

mkdirSync("config", { recursive: true });
writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Created ${target} with generated internal secrets.`);
console.log("Edit deployment.baseUrl and any provider/channel credentials, then run npm run deploy.");
