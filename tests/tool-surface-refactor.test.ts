
//



import assert from "node:assert/strict";
import {
  allTools,
  buildFullCatalog,
  defaultToolSession,
  toolDefsForSession,
  findTool,
  searchAndActivateTools,
  CORE_TOOL_NAMES,
  TOOL_tool_search_placeholder,
} from "../src/agent/tools";
import { toolSearchDescription, toolSearchParameters } from "../src/agent/tool-search";
import { cleanupStaleNamespaces, sessionTelemetry } from "../src/agent/tool-session";
import { isEffectivelyHidden } from "../src/agent/tool-catalog";
import { resolveProvider } from "../src/agent/provider-resolver";

console.log("▶ tool surface refactor (AUTHORITATIVE §19 DoD)");

// 1. Catalog completeness: every executable tool is classified.
{
  const catalog = buildFullCatalog({} as any, { workspaceId: "w", channel: "web" } as any);
  const names = new Set(catalog.map((e) => e.tool.name));
  for (const tool of allTools({} as any)) {
    assert.ok(names.has(tool.name), `catalog missing executable tool ${tool.name}`);
  }
  console.log("  ✅ catalog completeness");
}

// 2. Default surface remains compact and keeps the agreed Core tools.
{
  assert.ok(CORE_TOOL_NAMES.includes("react_to_message" as never), "react_to_message must remain Core");
  for (const name of ["mail_search", "mail_draft", "calendar_list"]) {
    assert.ok((CORE_TOOL_NAMES as readonly string[]).includes(name), `${name} must remain Core`);
  }
  assert.ok((CORE_TOOL_NAMES as readonly string[]).length >= 26 && (CORE_TOOL_NAMES as readonly string[]).length <= 34);
  const catalog = buildFullCatalog({} as any, { workspaceId: "w", channel: "web" } as any);
  const defs = toolDefsForSession(catalog, defaultToolSession(), {
    env: {} as any,
    taskCtx: { workspaceId: "w", channel: "web" } as any,
  });
  assert.ok(defs.length >= 26 && defs.length <= 34, `default surface should stay compact, actual=${defs.length}`);
  assert.ok(defs.some((d) => d.name === "tool_search"));
  assert.ok(defs.some((d) => d.name === "react_to_message"));
  assert.ok(!defs.some((d) => d.name === "gmail_search"));
  assert.ok(!defs.some((d) => d.name === "github_repos"));
  assert.ok(!defs.some((d) => d.name === "feishu_mail_list"));
  console.log(`  ✅ compact default surface (${defs.length})`);
}

// 3. One discovery tool; only genuinely on-demand namespaces stay in the manifest.
{
  const desc = toolSearchDescription();
  for (const ns of ["mail", "agent_mail", "database", "location", "finance"]) {
    assert.ok(desc.includes(ns), `manifest missing namespace ${ns}`);
  }
  for (const ns of ["calendar", "todo", "contacts", "files", "documents", "spreadsheet", "presentation", "code", "messaging"]) {
    assert.ok(!toolSearchDescription().includes(`${ns}：`), `${ns} is Core/reserved and must not be advertised as on-demand`);
  }
  const catalog = buildFullCatalog({} as any, { workspaceId: "w", channel: "web" } as any);
  assert.ok(!catalog.some((e) => e.tool.name.startsWith("use_")));
  assert.ok(!catalog.some((e) => e.tool.name === "activate_tools"));
  assert.ok(findTool("tool_search"));
  assert.equal(TOOL_tool_search_placeholder.scheduledAllowed, true);
  console.log("  ✅ single tool_search + truthful on-demand manifest");
}

// 4. Domain facades are the model-facing contract; lower-level semantic/provider tools stay internal.
{
  const catalog = buildFullCatalog({} as any, { workspaceId: "w", channel: "web" } as any);
  const byName = new Map(catalog.map((e) => [e.tool.name, e]));
  for (const name of ["calendar", "todo", "contacts", "files", "documents", "spreadsheet", "presentation", "code"]) {
    const entry = byName.get(name);
    assert.ok(entry, `${name} facade must exist`);
    assert.equal(isEffectivelyHidden(entry!), false, `${name} facade must be public`);
  }
  for (const name of [
    "calendar_create", "calendar_update", "calendar_delete", "calendar_freebusy",
    "todo_list", "todo_get", "todo_create", "todo_update", "todo_complete", "todo_delete",
    "contact_search", "contact_get", "document_search", "document_read", "document_create", "document_append",
    "spreadsheet_create", "spreadsheet_get", "spreadsheet_read", "spreadsheet_append_rows",
    "code_repo_list", "code_search", "code_issue_read", "code_issue_create", "code_comment",
  ]) {
    const entry = byName.get(name);
    assert.ok(entry, `${name} implementation must remain executable/classified`);
    assert.equal(isEffectivelyHidden(entry!), true, `${name} must be internal behind its domain facade`);
  }
  console.log("  ✅ provider-neutral facades public; implementation tools internal");
}

// 5. Default model surface contains the compact domain facades and no raw provider primitives.
{
  const catalog = buildFullCatalog({} as any, { workspaceId: "w", channel: "web" } as any);
  const defs = toolDefsForSession(catalog, defaultToolSession(), { env: {} as any, taskCtx: { workspaceId: "w", channel: "web" } as any });
  for (const name of ["calendar", "todo", "contacts", "files", "documents", "spreadsheet", "presentation", "code"]) {
    assert.ok(defs.some((d) => d.name === name), `${name} facade must be Core-visible`);
  }
  assert.ok(!defs.some((d) => /^google_/i.test(d.name)));
  assert.ok(!defs.some((d) => /^github_/i.test(d.name)));
  assert.ok(!defs.some((d) => d.name === "calendar_create"));
  assert.ok(defs.some((d) => d.name === "calendar_list"), "calendar_list stays as the scheduled-safe/common read shortcut");
  console.log(`  ✅ compact facade-first default surface (${defs.length})`);
}

// 6. Long-tail dynamic namespaces remain bounded; Core facades are never evicted.
{
  const catalog = buildFullCatalog({} as any, { workspaceId: "w", channel: "web" } as any);
  const session = defaultToolSession();
  searchAndActivateTools(session, catalog, { namespace: "mail" });
  searchAndActivateTools(session, catalog, { namespace: "database" });
  searchAndActivateTools(session, catalog, { namespace: "finance" });
  assert.ok(session.activeNamespaces.size <= 3);
  const fourth = searchAndActivateTools(session, catalog, { namespace: "location" });
  assert.ok(fourth.ok === false || !(fourth.activatedNamespaces ?? []).includes("location"), "fourth dynamic namespace must be bounded");
  for (const k of [...session.lastUsedAt.keys()]) session.lastUsedAt.set(k, Date.now() - 60 * 60_000);
  session.lastUsedAt.set("tool_search", Date.now());
  const removed = cleanupStaleNamespaces(session, catalog, { maxAgeMs: 30 * 60_000 });
  assert.ok(removed.length > 0);
  assert.ok(session.activeNames.has("react_to_message"));
  assert.ok(session.activeNames.has("calendar"), "Core calendar facade must never be evicted");
  const tele = sessionTelemetry(catalog, session, 8);
  assert.equal(tele.tool_search_count, 8);
  console.log("  ✅ dynamic lifecycle bounded; Core facades preserved");
}

// 7. Provider resolution is based on structured connection facts, not natural-language routing.
{
  const explicit = resolveProvider({ explicitProvider: "feishu", connectedCapableProviders: ["google", "feishu"] });
  assert.deepEqual(explicit, { ok: true, provider: "feishu" });

  const single = resolveProvider({ connectedCapableProviders: ["lark"] });
  assert.deepEqual(single, { ok: true, provider: "lark" });

  const ambiguous = resolveProvider({ connectedCapableProviders: ["feishu", "lark"] });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.error, "provider_ambiguous");

  const none = resolveProvider({ connectedCapableProviders: [] });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.error, "provider_unavailable");

  const explicitButDisconnected = resolveProvider({ explicitProvider: "feishu", connectedCapableProviders: [] });
  assert.equal(explicitButDisconnected.ok, false, "explicit provider must not bypass real connection state");
  console.log("  ✅ structured provider resolution");
}

console.log("✅ tool surface refactor acceptance passed");
