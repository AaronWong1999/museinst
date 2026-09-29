import { execFileSync } from "node:child_process";

const forbidden = [
  /^gateway\//,
  /^src\/channels\/wechat\/gateway-(?:api|do)\.ts$/,
  /^migrations\/0005_wechat_gateway_container\.sql$/,
];

const output = execFileSync(
  "git",
  ["log", "--all", "--name-only", "--pretty=format:"],
  { encoding: "utf8" },
);
const matches = [...new Set(
  output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => forbidden.some((pattern) => pattern.test(path))),
)];

if (matches.length > 0) {
  console.error("Public history still contains private or commercial paths:");
  for (const path of matches) console.error(` - ${path}`);
  process.exit(1);
}
console.log("Public history boundary check passed.");
