import assert from "node:assert/strict";
import { allTools, toolDefs, findTool } from "../src/agent/tools";

console.log("▶ Testing Agent Tool Boundaries & Coordination Separation of Concerns...");

const tools = allTools();
const toolNames = new Set(tools.map((t) => t.name));

// 1. Verify New Web Search & Fetch Tools Registered in Root
assert.ok(toolNames.has("web_search"), "web_search must be present in root tools");
assert.ok(toolNames.has("web_fetch"), "web_fetch must be present in root tools");

// 2. Verify Workstream Memory Tools Registered in Root
assert.ok(toolNames.has("workstream_find"), "workstream_find must be present in root tools");
assert.ok(toolNames.has("workstream_read"), "workstream_read must be present in root tools");
assert.ok(toolNames.has("workstream_save"), "workstream_save must be present in root tools");
assert.ok(toolNames.has("workstream_forget"), "workstream_forget must be present in root tools");

// 3. Verify Task Coordination & Human Interaction Tools Registered in Root
assert.ok(toolNames.has("task_update"), "task_update must be present in root tools");
assert.ok(toolNames.has("task_cancel"), "task_cancel must be present in root tools");
assert.ok(toolNames.has("ask_question"), "ask_question must be present in root tools");

// 4. Verify Sensitive Execution Boundaries:
// Root tools must NOT expose raw browser DOM primitives (click, type, insertText) directly
assert.equal(toolNames.has("click"), false, "Root agent must not have raw DOM click tool");
assert.equal(toolNames.has("type"), false, "Root agent must not have raw DOM type tool");
assert.equal(toolNames.has("scroll"), false, "Root agent must not have raw DOM scroll tool");

// Root interacts with browser strictly through delegated browser_task
assert.ok(toolNames.has("browser_task"), "Root must delegate browser work via browser_task");

// 5. Schema generation sanity check
const defs = toolDefs();
assert.equal(defs.length, tools.length);
for (const def of defs) {
  assert.ok(def.name, "Every tool def must have a name");
  assert.ok(def.description, "Every tool def must have a description");
  assert.ok(def.parameters, "Every tool def must have parameters object");
}

console.log("✔ Agent Tool Boundaries tests passed!");
