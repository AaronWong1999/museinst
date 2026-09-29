
//





//



import type { Tool } from "./tool-types";
import { effectiveNamespace, type ToolCatalogEntry, type ToolNamespace } from "./tool-catalog";
import { activateNamespace, isModelSurfaceCandidate } from "./tool-session";
import type { ToolSessionState } from "./tool-session";

export interface NamespaceManifestItem {
  namespace: ToolNamespace;
  blurb: string;
}

export const ADVANCED_CAPABILITY_MANIFEST: NamespaceManifestItem[] = [
  { namespace: "mail", blurb: "用户邮箱的长尾操作：阅读、发送等" },
  { namespace: "agent_mail", blurb: "MuseInst Agent 自己的邮箱" },
  { namespace: "database", blurb: "Lark Base / 飞书多维表格等结构化数据库" },
  { namespace: "location", blurb: "位置、地点、地理触发" },
  { namespace: "finance", blurb: "行情、K线、公司信息、新闻" },
];

export function manifestText(): string {
  return ADVANCED_CAPABILITY_MANIFEST.map((m) => `${m.namespace}：${m.blurb}`).join("\n");
}

export function toolSearchDescription(): string {
  return [
    "按需发现并激活高级能力工具（Search + Activate 一次完成）。",
    "不知道用哪个能力时用 query 自然语言描述；已知能力名时直接传 namespace。",
    "调用成功后，下一次模型迭代即可直接使用新激活的真实工具。",
    "",
    "Advanced capabilities available on demand:",
    manifestText(),
  ].join("\n");
}

export function toolSearchParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      namespace: {
        type: "string",
        enum: ADVANCED_CAPABILITY_MANIFEST.map((m) => m.namespace),
        description: "已知要用哪个高级能力时直接指定。\n" + manifestText(),
      },
      query: {
        type: "string",
        description: "不知道 namespace 时，用自然语言描述想完成的能力（中英文均可）。",
      },
    },
  };
}

const TOKEN_SPLIT = /[^a-z0-9\u4e00-\u9fff]+/iu;

function parameterNames(entry: ToolCatalogEntry): string {
  const p = entry.tool.parameters as { properties?: Record<string, unknown> } | undefined;
  return Object.keys(p?.properties ?? {}).join(" ");
}


export function scoreEntry(entry: ToolCatalogEntry, queryTokens: string[], queryRaw: string): number {
  // Host-only entries may have been merged after the kernel catalog was built, so their stored
  // searchText can be only the tool name. Rebuild the searchable text from public metadata here.
  const ns = effectiveNamespace(entry);
  const hay = [
    entry.searchText,
    ns,
    entry.tool.name,
    entry.tool.description,
    parameterNames(entry),
    (entry.aliases ?? []).join(" "),
    (entry.providers ?? []).join(" "),
  ].join(" ").toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    if (!tok) continue;
    if (hay.includes(tok)) score += tok.length >= 4 ? 3 : 2;
  }

  const qChars = queryRaw.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/giu, "");
  if (qChars.length >= 2) {
    for (let i = 0; i + 2 <= qChars.length; i++) {
      const bi = qChars.slice(i, i + 2);
      if (bi.length === 2 && hay.includes(bi)) score += 1;
    }
  }
  const q = queryRaw.toLowerCase();
  if (q && ns !== "core" && q.includes(ns)) score += 5;
  for (const alias of entry.aliases ?? []) {
    if (q && alias && q.includes(alias.toLowerCase())) score += 4;
  }
  return score;
}

export function searchNamespaces(
  catalog: ToolCatalogEntry[],
  query: string,
  opts: { limitNamespaces?: number; filter?: (e: ToolCatalogEntry) => boolean } = {},
): ToolNamespace[] {
  const tokens = query.toLowerCase().split(TOKEN_SPLIT).filter(Boolean);
  const byNs = new Map<ToolNamespace, number>();
  const filter = opts.filter ?? (() => true);
  for (const e of catalog) {
    const ns = effectiveNamespace(e);
    if (ns === "core") continue;
    if (!isModelSurfaceCandidate(e, catalog)) continue;
    if (!filter(e)) continue;
    const s = scoreEntry(e, tokens, query);
    byNs.set(ns, Math.max(byNs.get(ns) ?? 0, s));
  }
  return [...byNs.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, opts.limitNamespaces ?? 2)
    .map(([ns]) => ns);
}

export interface ToolSearchArgs {
  namespace?: string;
  query?: string;
}

export interface ToolSearchOutcome {
  ok: boolean;
  error?: string;
  activatedNamespaces?: ToolNamespace[];
  activatedTools?: string[];
}

function eligibleToolsForNamespace(
  catalog: ToolCatalogEntry[],
  namespace: ToolNamespace,
  filter: (e: ToolCatalogEntry) => boolean,
): ToolCatalogEntry[] {
  return catalog.filter((e) => effectiveNamespace(e) === namespace && isModelSurfaceCandidate(e, catalog) && filter(e));
}





export function executeToolSearch(
  session: ToolSessionState,
  catalog: ToolCatalogEntry[],
  args: ToolSearchArgs,
  filter: (e: ToolCatalogEntry) => boolean = () => true,
): ToolSearchOutcome {
  const nsRaw = typeof args.namespace === "string" ? args.namespace.trim().toLowerCase() : "";
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!nsRaw && !query) return { ok: false, error: "namespace 或 query 至少提供一个" };

  const manifestNamespaces = new Set<ToolNamespace>(ADVANCED_CAPABILITY_MANIFEST.map((m) => m.namespace));
  const catalogNamespaces = new Set<ToolNamespace>(catalog.map(effectiveNamespace));
  let targets: ToolNamespace[] = [];
  if (nsRaw) {
    if (!manifestNamespaces.has(nsRaw as ToolNamespace) && !catalogNamespaces.has(nsRaw as ToolNamespace)) {
      return { ok: false, error: `未知 namespace：${args.namespace}。可用：${ADVANCED_CAPABILITY_MANIFEST.map((m) => m.namespace).join(", ")}` };
    }
    targets = [nsRaw as ToolNamespace];
  } else {
    targets = searchNamespaces(catalog, query, { filter });
    if (targets.length === 0) {
      return { ok: false, error: "没有找到匹配的高级能力。请换一种说法描述，或直接指定 namespace。" };
    }
  }

  const unavailable = targets.filter((ns) => eligibleToolsForNamespace(catalog, ns, filter).length === 0);
  if (unavailable.length === targets.length) {
    return { ok: false, error: `能力当前不可用：${unavailable.join(", ")}。该 namespace 已被产品识别，但此部署没有可执行工具或被当前安全/调度策略过滤。` };
  }

  const activatedTools: string[] = [];
  const activatedNamespaces: ToolNamespace[] = [];
  const capped: ToolNamespace[] = [];
  for (const ns of targets) {
    if (eligibleToolsForNamespace(catalog, ns, filter).length === 0) continue;
    const before = new Set(session.activeNames);
    const added = activateNamespace(session, ns, catalog, filter);
    if (added.length === 0 && ![...before].every((n) => session.activeNames.has(n))) {

    }

    if (added.length === 0 && eligibleToolsForNamespace(catalog, ns, filter).some((e) => !session.activeNames.has(e.tool.name))) {
      capped.push(ns);
      continue;
    }
    activatedTools.push(...added);
    if (added.length > 0 || session.activeNamespaces.has(ns)) activatedNamespaces.push(ns);
  }
  if (capped.length > 0 && activatedNamespaces.length === 0) {
    return { ok: false, error: `dynamic namespace 已达上限（同时最多 3 个）：${capped.join(", ")} 未激活。请先完成当前任务、清理不相关能力后再试。` };
  }
  return { ok: true, activatedNamespaces, activatedTools };
}

export function buildToolSearchTool(
  run: (ctx: unknown, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>,
): Tool {
  return {
    name: "tool_search",
    effect: "read",
    scheduledAllowed: true,
    description: toolSearchDescription(),
    parameters: toolSearchParameters(),
    run: run as Tool["run"],
  };
}
