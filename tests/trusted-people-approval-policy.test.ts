import assert from "node:assert/strict";
import { buildFullCatalog } from "../src/agent/tools";

console.log("▶ Trusted People approval policy tests...");

const catalog = buildFullCatalog({ TRUSTED_PEOPLE_ENABLED: "1", A2A_ENABLED: "1" } as any, {
  workspaceId: "ws_trusted_approval",
  channel: "telegram",
} as any);
const byName = new Map(catalog.map((entry) => [entry.tool.name, entry.tool]));

for (const name of ["trusted_people_invite", "trusted_people_respond", "trusted_people_schedule"]) {
  assert.equal(byName.get(name)?.effect, "external_send", `${name} communicates externally and must require approval`);
}
for (const name of ["trusted_people_remove", "trusted_people_block"]) {
  assert.equal(byName.get(name)?.effect, "destructive", `${name} changes a trust boundary and must require approval`);
}
assert.equal(byName.get("trusted_people_unblock")?.effect, "write", "unblock is local and must not silently restore trust");
assert.equal(byName.get("trusted_people_list")?.effect, "read");
assert.equal(byName.get("trusted_people_requests")?.effect, "read");
assert.equal(byName.has("trusted_people_introduce"), false, "fake introduction must stay off the model-visible catalog");

console.log("✔ Trusted People approval policy tests passed!");
