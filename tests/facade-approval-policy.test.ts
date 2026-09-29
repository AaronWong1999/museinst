import assert from "node:assert/strict";
import { buildFullCatalog } from "../src/agent/tools";

console.log("▶ facade approval policy");

const catalog = buildFullCatalog({} as any, { workspaceId: "w", channel: "web" } as any);
const calendar = catalog.find((e) => e.tool.name === "calendar")?.tool;
assert.ok(calendar, "calendar facade must exist");
assert.equal(typeof calendar!.requiresApproval, "function", "calendar facade must use argument-aware approval");

const approval = calendar!.requiresApproval as (args: Record<string, unknown>) => boolean;
assert.equal(approval({ action: "list" }), false);
assert.equal(approval({ action: "freebusy" }), false);
assert.equal(approval({ action: "create" }), true, "calendar create remains approval-gated");
assert.equal(approval({ action: "delete" }), true, "calendar delete remains approval-gated");
assert.equal(approval({ action: "update", summary: "new title" }), false, "ordinary metadata update keeps legacy approval granularity");
assert.equal(approval({ action: "update", attendees: [] }), false);
assert.equal(approval({ action: "update", attendees: ["person"] }), true, "attendee mutation is external-send-like and requires approval");

console.log("✅ facade approval policy passed");
