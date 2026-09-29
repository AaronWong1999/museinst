import assert from "node:assert/strict";
import { feishuDef, larkDef } from "../src/connectors/registry";

for (const def of [feishuDef(), larkDef()]) {
  assert.equal(def.kind, "multi", `${def.id} must match Hosted Add account UX and connector-slot quota semantics`);
  const scopes = new Set(def.defaultScopes.split(/\s+/).filter(Boolean));
  assert.ok(scopes.has("contact:user:search"), `${def.id} OAuth must request Contact v3 search scope`);
  assert.ok(scopes.has("search:docs:read"), `${def.id} OAuth must request Search v2 document scope`);
  assert.ok(scopes.has("calendar:calendar"));
  assert.ok(scopes.has("task:task:read"));
  assert.ok(scopes.has("task:task:write"));
  assert.ok(scopes.has("docx:document"));
  assert.ok(scopes.has("sheets:spreadsheet"));
  assert.ok(scopes.has("bitable:app"));
}

console.log("lark-feishu-registry-contract: ok");
