
//




//

//   build kernel + hosted catalog → host same-name override / semantic binding
//   → source/security filter → scheduledAllowed filter → feature flag filter
//   → build searchable hidden catalog → expose core + active dynamic tools
//


import type { Env } from "../env";
import type { TaskContext } from "../hooks";
import type { Tool } from "./tool-types";
import {
  effectiveNamespace,
  isEffectivelyHidden,
  type ToolCatalogEntry,
  type ToolNamespace,
} from "./tool-catalog";

export interface ToolSessionState {
  coreNames: Set<string>;
  activeNames: Set<string>;
  activeNamespaces: Set<ToolNamespace>;
  lastUsedAt: Map<string, number>;
}

export interface SessionFilterContext {
  env?: Env;
  taskCtx?: TaskContext & { scheduled?: boolean };

  externalNoTools?: boolean;
  agentMailAllowed?: boolean;
}

export function createToolSession(coreNames: Iterable<string>): ToolSessionState {
  return {
    coreNames: new Set(coreNames),
    activeNames: new Set(coreNames),
    activeNamespaces: new Set(),
    lastUsedAt: new Map(),
  };
}

/**
 * Hosted GitHub App has a richer, differently-authenticated surface than the kernel OAuth
 * primitives. Presence of a Hosted-only tool is the structural signal that the App surface is
 * installed; in that case do not expose the kernel `code_*` wrappers, which would execute via the
 * wrong OAuth path. This checks catalog structure only — never user language.
 */
function hostedGitHubSurfacePresent(entries: ToolCatalogEntry[]): boolean {
  return entries.some((e) => e.tool.name === "github_repo_read" || e.tool.name === "github_action_run_read");
}

export function isModelSurfaceCandidate(entry: ToolCatalogEntry, entries: ToolCatalogEntry[]): boolean {
  if (isEffectivelyHidden(entry)) return false;
  if (hostedGitHubSurfacePresent(entries) && /^code_/i.test(entry.tool.name)) return false;
  return true;
}

export function activateNamespace(
  session: ToolSessionState,
  namespace: ToolNamespace,
  entries: ToolCatalogEntry[],
  filter: (e: ToolCatalogEntry) => boolean = () => true,
): string[] {


  if (!session.activeNamespaces.has(namespace) && session.activeNamespaces.size >= MAX_DYNAMIC_NAMESPACES) {
    return [];
  }
  const added: string[] = [];
  for (const e of entries) {
    if (effectiveNamespace(e) !== namespace) continue;
    if (!isModelSurfaceCandidate(e, entries)) continue;
    if (!filter(e)) continue;
    if (session.activeNames.has(e.tool.name)) continue;
    if (dynamicToolCount(session, entries) >= MAX_DYNAMIC_TOOLS) break;
    added.push(e.tool.name);
    session.activeNames.add(e.tool.name);
    session.lastUsedAt.set(e.tool.name, Date.now());
  }
  if (added.length > 0) session.activeNamespaces.add(namespace);
  return added;
}


export const MAX_DYNAMIC_NAMESPACES = 3;
export const MAX_DYNAMIC_TOOLS = 40;

function dynamicToolCount(session: ToolSessionState, catalog: ToolCatalogEntry[]): number {
  const byName = new Map(catalog.map((e) => [e.tool.name, e]));
  let n = 0;
  for (const name of session.activeNames) {
    if (session.coreNames.has(name)) continue;
    if (byName.has(name)) n++;
  }
  return n;
}

export function activateTools(
  session: ToolSessionState,
  names: Iterable<string>,
  namespace?: ToolNamespace,
): void {
  for (const n of names) {
    session.activeNames.add(n);
    session.lastUsedAt.set(n, Date.now());
  }
  if (namespace) session.activeNamespaces.add(namespace);
}





export function cleanupStaleNamespaces(
  session: ToolSessionState,
  catalog: ToolCatalogEntry[],
  opts: { maxAgeMs?: number; keepNamespaces?: Set<ToolNamespace> } = {},
): string[] {
  const maxAgeMs = opts.maxAgeMs ?? 30 * 60_000;
  const keep = opts.keepNamespaces ?? new Set<ToolNamespace>();
  const cutoff = Date.now() - maxAgeMs;
  const removed: string[] = [];
  const byName = new Map(catalog.map((e) => [e.tool.name, e]));
  for (const name of [...session.activeNames]) {
    if (session.coreNames.has(name)) continue;
    const entry = byName.get(name);
    if (!entry) continue;
    if (keep.has(effectiveNamespace(entry))) continue;
    if ((session.lastUsedAt.get(name) ?? 0) > cutoff) continue;
    session.activeNames.delete(name);
    removed.push(name);
  }
  const stillActive = new Set<ToolNamespace>();
  for (const name of session.activeNames) {
    const entry = byName.get(name);
    if (entry && !session.coreNames.has(name)) stillActive.add(effectiveNamespace(entry));
  }
  session.activeNamespaces = stillActive;
  return removed;
}


export function activeDefsForSession(
  catalog: ToolCatalogEntry[],
  session: ToolSessionState,
  ctx: SessionFilterContext = {},
): Tool[] {
  if (ctx.externalNoTools) return [];
  let entries = catalog;
  if (ctx.taskCtx?.scheduled) {
    entries = entries.filter((e) => e.scheduledAllowed
      && e.tool.name !== "browser_task"
      && e.tool.name !== "schedule_create"
      && e.tool.name !== "schedule_reminder"
      && !e.tool.name.startsWith("slack_")
      && !e.tool.name.startsWith("linear_"));
  } else {
    entries = entries.filter((e) => !e.tool.name.startsWith("slack_") && !e.tool.name.startsWith("linear_"));
  }
  if (ctx.agentMailAllowed === false) {
    entries = entries.filter((e) => !e.tool.name.startsWith("agent_mail_") && !e.tool.name.startsWith("trusted_people_"));
  }
  const visible = new Map<string, Tool>();
  for (const e of entries) {
    if (!isModelSurfaceCandidate(e, catalog)) continue;
    if (session.activeNames.has(e.tool.name)) visible.set(e.tool.name, e.tool);
  }
  return [...visible.values()];
}


export function sessionTelemetry(
  catalog: ToolCatalogEntry[],
  session: ToolSessionState,
  toolSearchCount: number,
): { core_count: number; active_dynamic_count: number; total_tool_count: number; active_namespaces: string[]; tool_search_count: number } {
  const byName = new Map(catalog.map((e) => [e.tool.name, e]));
  let dynamic = 0;
  for (const name of session.activeNames) {
    if (session.coreNames.has(name)) continue;
    if (byName.has(name)) dynamic++;
  }
  const activeNamespaces = new Set<string>();
  for (const name of session.activeNames) {
    if (session.coreNames.has(name)) continue;
    const entry = byName.get(name);
    if (entry) activeNamespaces.add(effectiveNamespace(entry));
  }
  return {
    core_count: session.coreNames.size,
    active_dynamic_count: dynamic,
    total_tool_count: session.activeNames.size,
    active_namespaces: [...activeNamespaces],
    tool_search_count: toolSearchCount,
  };
}
