import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(__dirname).filter((f) => f.endsWith(".test.ts"));

console.log(`========================================`);
console.log(`🚀 Running ${files.length} OpenInstinct Ported Test Suites`);
console.log(`========================================\n`);

let passed = 0;
let failed = 0;

for (const file of files) {
  const filePath = join(__dirname, file);

  const res = spawnSync("npx", ["tsx", filePath], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import ./tests/register.mjs"].filter(Boolean).join(" ") },
  });

  if (res.status === 0) {
    passed++;
  } else {
    failed++;
  }
}

console.log(`\n========================================`);
console.log(`🏁 Test Summary: ${passed} passed, ${failed} failed`);
console.log(`========================================`);

if (failed > 0) {
  process.exit(1);
}
