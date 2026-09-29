import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const configPath = process.env.OPENINST_CONFIG || "config/openinst.config.json";
const script = process.env.OPENINST_CONFIG || existsSync(configPath)
  ? "scripts/deploy.mjs"
  : "scripts/deploy-button.mjs";
const result = spawnSync(process.execPath, [script], { stdio: "inherit", shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
