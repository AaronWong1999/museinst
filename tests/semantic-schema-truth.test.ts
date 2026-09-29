import assert from "node:assert/strict";
import { buildFullCatalog } from "../src/agent/tools";

const catalog = buildFullCatalog({} as any, { workspaceId: "w", channel: "web" } as any);
const byName = new Map(catalog.map((entry) => [entry.tool.name, entry.tool as any]));

function props(name: string): Record<string, unknown> {
  const tool = byName.get(name);
  assert.ok(tool, `${name} must exist`);
  return tool.parameters?.properties ?? {};
}

assert.ok(!("attendees" in props("calendar_update")), "calendar_update must not advertise ignored attendee mutation");
assert.ok(!("timeZone" in props("calendar_freebusy")), "calendar_freebusy must not advertise ignored timeZone");
assert.ok(!("folderToken" in props("document_create")), "document_create must not advertise ignored folderToken");
assert.ok(!("folderToken" in props("spreadsheet_create")), "spreadsheet_create must not advertise ignored folderToken");
assert.ok(!("filter" in props("database_query")), "database_query must not advertise an ignored filter expression");

console.log("semantic-schema-truth: ok");
