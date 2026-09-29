import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

console.log("▶ Approval resume evidence/transcript contract");
const src = readFileSync(new URL("../src/agent/personal-agent.ts", import.meta.url), "utf8");
assert.ok(!src.includes('content: "USER_APPROVED'), "approval must not be serialized as a duplicate provider tool result");
assert.match(src, /externalLedger\?: ExternalLedger;/, "parked turns must carry external evidence");
assert.match(src, /approvedExternalRecord = recordFromToolResult\(tool\.name/, "approved tool results must enter the evidence ledger");
assert.match(src, /const externalLedger: ExternalLedger = \[\.\.\.\(parked\.externalLedger \?\? \[\]\)\];/, "resume loop must seed carried evidence");
assert.match(src, /\{ messages, taskId, externalLedger \}/, "main loop must pass accumulated evidence into approval parks");
assert.match(src, /\{ messages, taskId: parked\.taskId, externalLedger \}/, "resume loop must preserve evidence across a later approval");
console.log("✔ approval resume evidence/transcript contract passed");
