import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const deployScript = resolve("scripts/deploy-button.mjs");
const mock = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args[2];
const statePath = "mock-state.json";
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.calls.push(command === "d1" ? "migrate" : command === "secret" ? args[3] : command);
if (command === "deploy") {
  console.log("Deployed https://openinst.demo.workers.dev");
} else if (command === "secret" && args[3] === "list") {
  console.log(JSON.stringify(state.secretNames.map(name => ({name}))));
} else if (command === "secret" && args[3] === "bulk") {
  const generated = JSON.parse(fs.readFileSync(args[4], "utf8"));
  state.generated.push(Object.keys(generated).sort());
  state.secretNames.push(...Object.keys(generated));
}
fs.writeFileSync(statePath, JSON.stringify(state));
`;

function fixture(adminKey = true) {
  const root = mkdtempSync(join(tmpdir(), "openinst-deploy-"));
  mkdirSync(join(root, "bin"));
  const binary = join(root, "bin", "npx");
  writeFileSync(binary, mock);
  chmodSync(binary, 0o755);
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({
    name: "openinst",
    d1_databases: [{ binding: "DB", database_id: "provisioned" }],
    vars: { TELEGRAM_ENABLED: "0", AGENT_EMAIL_ENABLED: "0", PUBLIC_BASE_URL: "" },
  }));
  writeFileSync(join(root, "mock-state.json"), JSON.stringify({
    calls: [], generated: [], secretNames: adminKey ? ["ADMIN_KEY"] : [],
  }));
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [deployScript], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
  });
}

test("button deployment migrates before final publish and never rotates existing keys", () => {
  const root = fixture();
  try {
    const first = run(root);
    assert.equal(first.status, 0, first.stderr);
    const state = JSON.parse(readFileSync(join(root, "mock-state.json"), "utf8"));
    assert.deepEqual(state.calls, ["deploy", "list", "bulk", "migrate", "deploy"]);
    assert.deepEqual(state.generated, [["OPENINST_SECRET", "VAULT_MASTER_KEY", "WECHAT_TOKEN_KEY"].sort()]);
    assert.equal(JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8")).vars.PUBLIC_BASE_URL, "https://openinst.demo.workers.dev");
    assert.equal(JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8")).vars.SETUP_CLAIM_UNTIL, "");

    const second = run(root);
    assert.equal(second.status, 0, second.stderr);
    const after = JSON.parse(readFileSync(join(root, "mock-state.json"), "utf8"));
    assert.equal(after.generated.length, 1);
    assert.deepEqual(after.calls.slice(-4), ["deploy", "list", "migrate", "deploy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("button deployment without ADMIN_KEY opens a browser claim window", () => {
  const root = fixture(false);
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(readFileSync(join(root, "mock-state.json"), "utf8"));
    assert.deepEqual(state.calls, ["deploy", "list", "bulk", "migrate", "deploy"]);
    const until = Date.parse(JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8")).vars.SETUP_CLAIM_UNTIL);
    assert.ok(until > Date.now() && until <= Date.now() + 60 * 60 * 1000);
    assert.match(result.stdout, /Claim/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
