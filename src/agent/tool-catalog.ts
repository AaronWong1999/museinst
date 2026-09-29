
//

//




//





import type { Env } from "../env";
import type { TaskContext } from "../hooks";
import type { Tool } from "./tool-types";

export type ToolNamespace =
  | "core"
  | "mail"
  | "calendar"
  | "todo"
  | "contacts"
  | "agent_mail"
  | "trusted_people"
  | "files"
  | "documents"
  | "spreadsheet"
  | "presentation"
  | "database"
  | "code"
  | "messaging"
  | "location"
  | "finance"
  | "schedule"
  | "workstream"
  | "vault"
  | "browser"
  | "task"
  | "memory"
  | "web";

export interface ToolCatalogEntry {
  tool: Tool;
  namespace: ToolNamespace;

  aliases?: string[];

  searchText: string;

  providers?: string[];

  requiresConnector?: boolean;
  scheduledAllowed: boolean;
  defaultVisible?: boolean;





  hidden?: boolean;
}

export interface CatalogFilter {
  workspaceId: string;
  channel: string;
  scheduled?: boolean;
  source?: string;
}

type ToolParameters = { type?: string; properties?: Record<string, unknown>; required?: string[] };

function withoutModelParams(tool: Tool, names: string[], description?: string): Tool {
  const parameters = tool.parameters as ToolParameters | undefined;
  if (!parameters?.properties) return description ? { ...tool, description } : tool;
  const blocked = new Set(names);
  const properties = Object.fromEntries(Object.entries(parameters.properties).filter(([name]) => !blocked.has(name)));
  const required = Array.isArray(parameters.required) ? parameters.required.filter((name) => !blocked.has(name)) : parameters.required;
  return {
    ...tool,
    ...(description ? { description } : {}),
    parameters: { ...parameters, properties, ...(required ? { required } : {}) },
  };
}

/**
 * Truth/security shim for model-visible schemas whose implementation is useful but narrower
 * than an older contract. It also upgrades side-effect classes when the underlying operation
 * communicates externally or changes a trust boundary, so approval cannot be bypassed merely
 * because an individual tool object was accidentally labelled as a generic write.
 */
function truthfulModelSurfaceTool(tool: Tool): Tool {
  switch (tool.name) {
    case "calendar_update":
      return withoutModelParams(
        tool,
        ["attendees"],
        "更新日程（标题/时间/地点/描述）。Lark / Feishu 真实支持。参会人更新暂不开放；创建日程时可指定 attendees。",
      );
    case "calendar_freebusy":
      return withoutModelParams(
        tool,
        ["timeZone"],
        "查询日历忙闲（free/busy，只读，权威可用性来源）。时间范围请使用带时区偏移的 ISO 时间。Lark / Feishu 真实支持；Google fail-closed 请用 calendar_list。",
      );
    case "document_create":
      return withoutModelParams(
        tool,
        ["folderToken"],
        "新建云文档（Lark / Feishu，当前创建在 provider 默认位置）。【写外部状态，读回确认】",
      );
    case "spreadsheet_create":
      return withoutModelParams(
        tool,
        ["folderToken"],
        "新建电子表格（Lark / Feishu，当前创建在 provider 默认位置）。【写外部状态，读回确认】",
      );
    case "database_query":
      return withoutModelParams(
        tool,
        ["filter"],
        "读取多维表格（Bitable / Base）记录（Lark / Feishu）。当前支持分页读取，不宣称尚未接入的服务端过滤表达式。",
      );
    case "trusted_people_invite":
    case "trusted_people_respond":
    case "trusted_people_schedule":
      return { ...tool, effect: "external_send" };
    case "trusted_people_remove":
    case "trusted_people_block":
      return { ...tool, effect: "destructive" };
    default:
      return tool;
  }
}

function searchTextFor(tool: Tool, namespace: string, aliases: string[] = [], providers: string[] = []): string {
  const params = tool.parameters && typeof tool.parameters === "object"
    ? Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}).join(" ")
    : "";
  return [namespace, tool.name, tool.description, params, aliases.join(" "), providers.join(" ")]
    .join(" ")
    .toLowerCase();
}

export function catalogEntry(
  tool: Tool,
  namespace: ToolNamespace,
  opts: { aliases?: string[]; providers?: string[]; requiresConnector?: boolean; defaultVisible?: boolean; hidden?: boolean } = {},
): ToolCatalogEntry {
  const visibleTool = truthfulModelSurfaceTool(tool);
  return {
    tool: visibleTool,
    namespace,
    aliases: opts.aliases,
    searchText: searchTextFor(visibleTool, namespace, opts.aliases ?? [], opts.providers ?? []),
    providers: opts.providers,
    requiresConnector: opts.requiresConnector,
    scheduledAllowed: (visibleTool as { scheduledAllowed?: boolean }).scheduledAllowed === true,
    defaultVisible: opts.defaultVisible,
    hidden: opts.hidden,
  };
}

/**
 * Hosted-only tools are merged by getAdditionalTools() in tools.ts. For names that do not exist
 * in the kernel catalog, the generic host merge cannot know their namespace and historically
 * fell back to `core`. Keep the kernel independent from hosted modules by deriving only the
 * provider-neutral capability family from the stable tool name here.
 *
 * This is taxonomy, not an intent router: no user text is inspected and execution is untouched.
 */
export function inferredNamespaceForToolName(name: string): ToolNamespace | null {
  if (/^google_drive_/i.test(name)) return "files";
  if (/^google_docs_/i.test(name)) return "documents";
  if (/^google_sheets_/i.test(name)) return "spreadsheet";
  if (/^google_slides_/i.test(name)) return "presentation";
  if (/^google_calendar_/i.test(name)) return "calendar";
  if (/^google_(?:task|tasks|tasklist|tasklists)/i.test(name)) return "todo";
  if (/^google_contact/i.test(name)) return "contacts";
  if (/^github_/i.test(name)) return "code";
  return null;
}

export function effectiveNamespace(entry: ToolCatalogEntry): ToolNamespace {
  if (entry.namespace !== "core") return entry.namespace;
  return inferredNamespaceForToolName(entry.tool.name) ?? entry.namespace;
}

const PROMOTED_GENERIC_TOOLS = new Set([
  // calendar_list stays as a scheduled-safe read fallback; normal owner turns prefer the calendar facade.
  "calendar_list",
  "mail_count", "mail_read", "mail_draft", "mail_send",
]);

/** Semantic wrappers that still have no truthful provider operation remain hidden. */
const INCOMPLETE_SEMANTIC_TOOLS = new Set([
  "contact_create", "contact_update", "contact_delete",
  "mail_thread", "mail_update",
  "code_search", "code_issue_read",
]);

const DUPLICATE_GOOGLE_PRIMITIVES = new Set([
  "google_calendar_list_events", "google_calendar_create_event", "google_calendar_delete_event",
  "google_tasks_list",
  "google_contacts_search",
]);

const DOMAIN_FACADE_INTERNAL_TOOLS = new Set([
  "calendar_create", "calendar_update", "calendar_delete", "calendar_freebusy",
  "todo_list", "todo_get", "todo_create", "todo_update", "todo_complete", "todo_delete",
  "contact_search", "contact_get",
  "document_search", "document_read", "document_create", "document_append",
  "spreadsheet_create", "spreadsheet_get", "spreadsheet_read", "spreadsheet_append_rows",
  "code_repo_list", "code_search", "code_issue_read", "code_issue_create", "code_comment",
]);

export function isEffectivelyHidden(entry: ToolCatalogEntry): boolean {
  const name = entry.tool.name;
  // Provider/API primitives remain executable internally but never enter model defs/search.
  if (/^(?:google_|github_)/i.test(name)) return true;
  if (DOMAIN_FACADE_INTERNAL_TOOLS.has(name)) return true;
  if (INCOMPLETE_SEMANTIC_TOOLS.has(name)) return true;
  if (PROMOTED_GENERIC_TOOLS.has(name)) return false;
  if (/^gmail_/i.test(name)) return true;
  if (DUPLICATE_GOOGLE_PRIMITIVES.has(name)) return true;
  return entry.hidden === true;
}

export function buildCatalogEntries(
  items: Array<{ tool: Tool; namespace: ToolNamespace; aliases?: string[]; providers?: string[]; requiresConnector?: boolean; defaultVisible?: boolean }>,
): ToolCatalogEntry[] {
  return items.map((i) => catalogEntry(i.tool, i.namespace, i));
}

export type { Env, TaskContext };
