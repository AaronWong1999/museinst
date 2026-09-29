import assert from "node:assert/strict";
import type { Tool } from "../src/agent/tool-types";
import type { ToolCatalogEntry } from "../src/agent/tool-catalog";
import { effectiveNamespace, isEffectivelyHidden } from "../src/agent/tool-catalog";
import { createToolSession, activeDefsForSession } from "../src/agent/tool-session";
import { executeToolSearch, toolSearchParameters } from "../src/agent/tool-search";

function tool(name: string, opts: Partial<Tool> = {}): Tool {
  return {
    name,
    effect: "read",
    scheduledAllowed: true,
    description: `${name} regression fixture`,
    parameters: { type: "object", properties: {} },
    run: async () => ({ ok: true }),
    ...opts,
  } as Tool;
}

function entry(t: Tool, namespace: ToolCatalogEntry["namespace"] = "core", extra: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry {
  return {
    tool: t,
    namespace,
    searchText: t.name.toLowerCase(),
    scheduledAllowed: t.scheduledAllowed === true,
    ...extra,
  };
}

// Hosted-only Google primitives still get the correct taxonomy, but provider/API names are now
// implementation-only: they must never be discoverable or enter model defs.
{
  const docs = entry(tool("google_docs_read", { description: "Read an authorized Google document" }));
  assert.equal(effectiveNamespace(docs), "documents");
  assert.equal(isEffectivelyHidden(docs), true);
  const session = createToolSession(["tool_search"]);
  const r = executeToolSearch(session, [docs], { namespace: "documents" });
  assert.equal(r.ok, false);
  assert.ok(!activeDefsForSession([docs], session).some((t) => t.name === "google_docs_read"));
}

// tool_search advertises only genuinely on-demand namespaces. Core domain facades such as
// documents/code/calendar are already present in the initial schema and must not be re-advertised.
{
  const p = toolSearchParameters() as any;
  assert.ok(Array.isArray(p.properties.namespace.enum));
  for (const ns of ["mail", "agent_mail", "database", "location", "finance"]) {
    assert.ok(p.properties.namespace.enum.includes(ns), `${ns} must remain on-demand`);
  }
  for (const ns of ["documents", "code", "calendar", "messaging"]) {
    assert.ok(!p.properties.namespace.enum.includes(ns), `${ns} must not be advertised as on-demand`);
  }
}

// Hosted Gmail guards remain hidden.
{
  const guard = entry(tool("gmail_search", { description: "Hosted 不通过 Google OAuth 访问 Gmail 邮件。不要调用此工具" }), "mail");
  assert.equal(isEffectivelyHidden(guard), true);
  const session = createToolSession(["tool_search"]);
  assert.equal(executeToolSearch(session, [guard], { namespace: "mail" }).ok, false);
}

// Generic mail read/draft/send remain valid provider-neutral model names until mail gets its own
// full domain facade.
{
  const read = entry(tool("mail_read"), "mail", { hidden: true });
  assert.equal(isEffectivelyHidden(read), false);
  const session = createToolSession(["tool_search"]);
  assert.equal(executeToolSearch(session, [read], { namespace: "mail" }).ok, true);
  assert.ok(activeDefsForSession([read], session).some((t) => t.name === "mail_read"));
}

// A provider-neutral facade is public; both old per-operation semantics and raw provider tools are internal.
{
  const facade = entry(tool("todo", { effect: "write" }), "todo");
  const semantic = entry(tool("todo_complete", { effect: "write" }), "todo");
  const provider = entry(tool("google_task_complete", { effect: "write" }));
  assert.equal(isEffectivelyHidden(facade), false);
  assert.equal(isEffectivelyHidden(semantic), true);
  assert.equal(isEffectivelyHidden(provider), true);
  const session = createToolSession(["todo", "tool_search"]);
  const names = activeDefsForSession([facade, semantic, provider], session).map((t) => t.name);
  assert.deepEqual(names, ["todo"]);
}

// Facade-covered semantic operations remain executable/classified internally but not model-visible.
for (const name of ["calendar_freebusy", "calendar_update", "contact_get", "document_read", "spreadsheet_read", "code_search", "code_issue_read"]) {
  const ns = name.startsWith("calendar") ? "calendar"
    : name.startsWith("contact") ? "contacts"
      : name.startsWith("document") ? "documents"
        : name.startsWith("spreadsheet") ? "spreadsheet" : "code";
  assert.equal(isEffectivelyHidden(entry(tool(name), ns as ToolCatalogEntry["namespace"])), true, `${name} must stay behind its facade`);
}

// Hosted GitHub App provider primitives are internal. The model-facing contract is one code facade.
{
  const facade = entry(tool("code", { effect: "write" }), "code");
  const hostedRepo = entry(tool("github_repo_read", { description: "Read GitHub App repository metadata" }));
  const hostedFile = entry(tool("github_file_read", { description: "Read repository source file" }));
  assert.equal(isEffectivelyHidden(hostedRepo), true);
  assert.equal(isEffectivelyHidden(hostedFile), true);
  const session = createToolSession(["code", "tool_search"]);
  const names = activeDefsForSession([facade, hostedRepo, hostedFile], session).map((t) => t.name);
  assert.deepEqual(names, ["code"]);
}

// An advertised long-tail namespace with no provider implementation must fail closed.
{
  const session = createToolSession(["tool_search"]);
  const r = executeToolSearch(session, [], { namespace: "database" });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /不可用/);
}

console.log("tool-surface-hosted-namespace-regression: ok");
