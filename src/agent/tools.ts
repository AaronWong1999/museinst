


import type { Env } from "../env";
import { clampText, now } from "../util";
import {
  gmailSearch, gmailGet, gmailSend, gmailDraft, gmailDraftGet, gmailProfile,
  calendarList, calendarCreate, calendarGetEvent, calendarDelete, tasksList, tasksInsert,
  googleContactsSearch, gmailThreadGet, gmailModify, type GmailAction,
} from "../connectors/google";
import { type ScheduleTiming, computeNextRun } from "./schedules";
import { sendReaction, REACTION_EMOJI_MAP } from "../channels/outbound";
import { feishuMailList, feishuMailGet, feishuCalendarList, feishuCalendarCreate } from "../connectors/feishu";
import {
  withLarkFeishuCall,
  larkFeishuCalendarList,
  larkFeishuCalendarFreebusy,
  larkFeishuCalendarCreate,
  larkFeishuCalendarUpdate,
  larkFeishuCalendarDelete,
  larkFeishuTodoList,
  larkFeishuTodoGet,
  larkFeishuTodoCreate,
  larkFeishuTodoUpdate,
  larkFeishuTodoComplete,
  larkFeishuTodoDelete,
  larkFeishuContactSearch,
  larkFeishuContactGet,
  larkFeishuDocumentSearch,
  larkFeishuDocumentRead,
  larkFeishuDocumentCreate,
  larkFeishuDocumentAppend,
  larkFeishuSpreadsheetCreate,
  larkFeishuSpreadsheetGet,
  larkFeishuSpreadsheetRead,
  larkFeishuSpreadsheetAppendRows,
  larkFeishuDatabaseQuery,
  larkFeishuDatabaseCreateRecord,
  larkFeishuDatabaseUpdateRecord,
  larkFeishuDatabaseDeleteRecord,
  type LarkFeishuProvider,
} from "../connectors/lark-feishu";
import {
  githubListRepos, githubSearchIssues, githubCreateIssue, githubCommentIssue,
} from "../connectors/github";
import { resolveMailbox } from "../imap/mailbox";
import { imapList, imapCount, imapGet, imapAppendDraft, smtpSend } from "../imap/imap";
import { sha256Hex } from "../imap/executor";
import { initUpload, putContent, completeUpload, listArtifacts } from "../files/service";
import { listItems } from "../vault/service";
import { addEvidence, addStep, completeTask, createReceipt, startTask } from "../tasks/tasks";
import {
  lastKnown, recentPoints, computeVisits, labelVisits, listPlaces, savePlace, deletePlace,
  listTriggers, createTrigger, deleteTrigger, geocode, reverseGeocode, nearbySearch,
} from "../location";
import { linearIssues, linearCreateIssue } from "../connectors/linear";
import { slackSearch, slackPost } from "../connectors/slack";
import { withConnectorCall, connectorFailureText, connectorFailureToExternal, type ConnectorCallFailure } from "../connectors/token-mark";
import type { ExternalErrorCode, ExternalEvidence, ExternalOperation } from "../external/result";
import { externalFailure } from "../external/result";
import { executeWebSearch } from "./web-search";
import { executeWebFetch } from "./web-fetch";
import { getQuotes, getKline, getStockProfile, getNews } from "./finance";
import { TOOL_get_self_info } from "./self-info";
import { AGENT_MAIL_TOOLS } from "./tools-agent-mail";
import { TRUSTED_PEOPLE_TOOLS } from "./tools-trusted-people";
import { getHostHooks, type TaskContext } from "../hooks";
import { catalogEntry, isEffectivelyHidden, type ToolCatalogEntry, type ToolNamespace } from "./tool-catalog";
import { createToolSession, activeDefsForSession, type ToolSessionState } from "./tool-session";
import { executeToolSearch, toolSearchDescription, toolSearchParameters, type ToolSearchArgs } from "./tool-search";
import { buildDomainFacadeTools, DOMAIN_FACADE_NAMES } from "./facades";

export type { ToolCatalogEntry, ToolNamespace };

export type { ToolContext, ToolResult, Tool } from "./tool-types";
import type { Tool, ToolContext, ToolResult } from "./tool-types";

const str = (desc: string, required = true) => ({ type: "string", description: desc, ...(required ? { } : { }) });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

const DOMAIN_FACADE_TOOLS = buildDomainFacadeTools((name, ctx) => findTool(name, ctx.env, {
  workspaceId: ctx.workspaceId, userId: ctx.userId, channel: ctx.channel, taskId: ctx.taskId, lang: ctx.lang,
}));



export const TOOL_memory_save: Tool = {
  name: "memory_save",
  effect: "local",
  description: "保存一条长期偏好/事实（跨渠道永久有效）。例：'飞机尽量靠窗'、'汇报用中文'。",
  parameters: obj({ key: str("短键名，如 seat_preference"), value: str("内容") }, ["key", "value"]),
  run: async (ctx, a) => {

    return { ok: false, error: "internal_reroute" };
  },
};

export const TOOL_personal_info_update: Tool = {
  name: "personal_info_update",
  effect: "local",
  description: "更新用户结构化信息：name/email/phone/timezone/address 之一。",
  parameters: obj({ field: str("字段名"), value: str("值") }, ["field", "value"]),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

// ── Web ──

export const TOOL_web_search: Tool = {
  name: "web_search",
  effect: "read",
  scheduledAllowed: true,
  description: "搜索公开网页。整合多源权威结果、RRF 排序与去重。适合查事实、价格、资讯。返回的每条结果都带真实 URL——研究性结论必须引用这些 URL。",
  parameters: obj({ query: str("搜索词"), max: { type: "integer", description: "结果数，默认5，上限10" } }, ["query"]),
  run: async (ctx, a) => {
    const query = String(a.query ?? "").trim();
    if (!query) return { ok: false, error: "query cannot be empty" };
    try {
      const res = await executeWebSearch(query, { max: Number(a.max ?? 5), lang: ctx.lang });
      if (res.status === "ok" && res.results.length > 0) {

        const results = res.results.map((r) => ({ title: r.title, url: r.url, source: r.engine, snippet: r.snippet, searchedAt: Date.now() }));
        return { ok: true, data: results, external: { ok: true, evidence: { provider: "web", fetchedAt: Date.now(), resourceType: "web_search", metadata: { query: query.slice(0, 120), count: results.length } }, operation: "read" } };
      }
      if (res.status === "degraded_all_blocked") {

        const f = externalFailure("web", "provider_unavailable", "（公共搜索目前受限/被拦截：本次搜索未完成，不能声称已找到资料。可改用 web_fetch 直接访问已知网页，或稍后重试。）", { retryable: true });
        return { ok: false, error: f.error.message, external: { ok: false, error: f.error, operation: "read" } };
      }
      return { ok: true, data: "（未找到相关公开网页结果）", external: { ok: true, evidence: { provider: "web", fetchedAt: Date.now(), resourceType: "web_search", metadata: { query: query.slice(0, 120), count: 0 } }, operation: "read" } };
    } catch (e) {
      const f = externalFailure("web", "provider_unavailable", `（搜索失败：${String(e).slice(0, 120)}。不能声称已完成检索。）`, { retryable: true });
      return { ok: false, error: f.error.message, external: { ok: false, error: f.error, operation: "read" } };
    }
  },
};

export const TOOL_web_fetch: Tool = {
  name: "web_fetch",
  effect: "read",
  scheduledAllowed: true,
  description: "抓取公开网页的正文文本（默认窗口 12000 字符）。具备 SSRF 安全过滤、重定向逐跳校验、正文洗涤与主内容区（article/main）优先提取。返回带 truncated 与 nextOffset：内容超长时用 offset=<nextOffset> 继续读同一页面，不要凭前几段下结论。读公开网页首选本工具，不要为读公开内容开云浏览器；需要登录/交互，或本工具因页面需要渲染/被拦截/内容为空而失败时，才用 browser_task。",
  parameters: obj({ url: str("完整 URL"), maxChars: { type: "integer", description: "返回正文窗口大小，默认 12000，上限 50000" }, offset: { type: "integer", description: "从上一次返回的 nextOffset 继续读取同一页面，默认 0（从头读）" } }, ["url"]),
  run: async (_ctx, a) => {
    const urlStr = String(a.url ?? "").trim();
    if (!urlStr) return { ok: false, error: "url cannot be empty" };
    try {
      const rawOffset = Number(a.offset);
      const res = await executeWebFetch(urlStr, {
        maxChars: Number(a.maxChars ?? 12000),
        offset: Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0,
      });
      if (res.status >= 400) {
        const code: ExternalErrorCode = res.status === 404 || res.status === 410 ? "resource_not_found" : res.status === 403 || res.status === 401 ? "permission_missing" : "provider_unavailable";
        const f = externalFailure("web", code, `（网页抓取失败：http_${res.status}。blocked/失败必须如实报告，不能编造页面内容。）`, { retryable: false });
        return { ok: false, error: f.error.message, external: { ok: false, error: f.error, operation: "read" } };
      }
      // DEFECT-014: surface truncation in the model-visible text, not only in
      // evidence metadata, so the model knows it can (and should) continue.
      const truncated = !!res.truncated;
      const resultText = truncated && res.nextOffset !== undefined
        ? `${res.text}\n[truncated=true; call web_fetch again with offset=${res.nextOffset} to continue reading this page]`
        : res.text;
      return {
        ok: true,
        data: { ...res, text: resultText },
        external: { ok: true, evidence: { provider: "web", fetchedAt: res.fetchedAt ?? Date.now(), externalUrl: res.finalUrl, resourceType: "web_page", metadata: { requestedUrl: urlStr.slice(0, 300), httpStatus: res.status, truncated, ...(res.nextOffset !== undefined ? { nextOffset: res.nextOffset } : {}) } }, operation: "read" },
      };
    } catch (e) {
      const f = externalFailure("web", "provider_unavailable", `（抓取失败：${String(e).slice(0, 120)}。blocked/失败必须如实报告。）`, { retryable: true });
      return { ok: false, error: f.error.message, external: { ok: false, error: f.error, operation: "read" } };
    }
  },
};



export const TOOL_workstream_find: Tool = {
  name: "workstream_find",
  effect: "local",
  description: "检索长期项目工作流（Workstreams）。支持按关键词和状态（active, waiting, completed, cancelled）过滤。",
  parameters: obj({ query: { type: "string", description: "搜索关键词" }, status: { type: "string", description: "状态" }, limit: { type: "integer", description: "条数上限" } }),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_workstream_read: Tool = {
  name: "workstream_read",
  effect: "local",
  description: "读取特定长期工作流的全部细节（目标、笔记、下一步计划与事实依据）。修改前必须先 read。",
  parameters: obj({ id: str("工作流 ID (kebab-case)") }, ["id"]),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_workstream_save: Tool = {
  name: "workstream_save",
  effect: "local",
  description: "保存或更新长期工作流。严格要求 expectedRevision 乐观锁（新建传 0，更新前必须先 read 获取当前版本）。",
  parameters: obj({
    id: str("工作流 ID (kebab-case)"),
    expectedRevision: { type: "integer", description: "期望版本号（新建必须传 0，更新必须匹配当前 revision）" },
    title: str("任务标题"),
    objective: str("最终目标"),
    status: { type: "string", description: "active | waiting | completed | cancelled" },
    notes: { type: "string", description: "核心决策与约束笔记" },
    nextStep: { type: "string", description: "当下明确的下一步" },
    sources: { type: "array", description: "事实来源依据列表", items: { type: "object", properties: { reference: { type: "string" }, observation: { type: "string" } }, required: ["reference", "observation"] } },
  }, ["id", "expectedRevision", "title", "objective"]),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_workstream_forget: Tool = {
  name: "workstream_forget",
  effect: "local",
  description: "归档/遗忘长期工作流。写入 tombstone 墓碑，需要匹配 expectedRevision。",
  parameters: obj({ id: str("工作流 ID"), expectedRevision: { type: "integer", description: "当前版本号" } }, ["id", "expectedRevision"]),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};



export const TOOL_task_update: Tool = {
  name: "task_update",
  effect: "local",
  description: "向用户即时汇报多步长线任务的当前进度阶段。",
  parameters: obj({ progress: str("当前步骤进展描述") }, ["progress"]),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_task_cancel: Tool = {
  name: "task_cancel",
  effect: "destructive",
  description: "取消当前执行、取消等待中的待办，或注销定时提醒。",
  parameters: obj({ target: str("current | schedule | pending"), targetId: { type: "string", description: "目标 ID（取消 schedule 或 pending 时提供）" }, reason: { type: "string", description: "取消原因" } }, ["target"]),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_ask_question: Tool = {
  name: "ask_question",
  effect: "local",
  description: "在自主检索无果、或需要用户做出关键选择/提供敏感授权时，向用户发起结构化提问并暂停等待回复。",
  parameters: obj({ question: str("提问内容"), options: { type: "array", items: { type: "string" }, description: "可选选项列表" } }, ["question"]),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function decodeDdUrl(u: string): string {
  const m = u.match(/uddg=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : u;
}

// ── Vault ──

export const TOOL_vault_list: Tool = {
  name: "vault_list",
  effect: "read",
  scheduledAllowed: true,
  description: "列出 Vault 候选（id/类型/标签/站点）。你看不到密码明文。浏览器任务里用 candidateId 引用。",
  parameters: obj({}),
  run: async (ctx) => {
    const items = await listItems(ctx.env, ctx.workspaceId);
    if (items.length === 0) return { ok: true, data: "（Vault 为空。用户要存密码时用 request_vault_setup）" };
    return {
      ok: true,
      data: items.map((i) => ({ candidateId: i.id, kind: i.kind, label: i.label, originMatch: i.origin ?? "" })),
    };
  },
};

export const TOOL_request_vault_setup: Tool = {
  name: "request_vault_setup",
  effect: "local",
  description: "让用户去控制台设置 Vault（存密码/卡）。绝不直接在聊天里要密码。terminal：返回设置链接。",
  parameters: obj({ reason: str("为什么要设置，如 '要在携程订票需要你的账号'") }),
  run: async (ctx, a) => {
    return {
      ok: true,
      userNotice: `🔐 ${a.reason ?? "需要你的账号信息"}\n请在控制台添加（加密存在你自己的 Cloudflare 账号里，我看不到明文）：\n${ctx.env.PUBLIC_BASE_URL}/vault`,
    };
  },
};

export const TOOL_request_vault_import: Tool = {
  name: "request_vault_import",
  effect: "local",
  description: "让用户从 Chrome 或 Google 密码管理器批量导入密码。生成安全导入链接。绝不让用户在聊天里发送 CSV 或密码明文。",
  parameters: obj({ reason: str("原因说明，如 '批量导入你已保存的站点密码'", false) }),
  run: async (ctx, a) => {
    return {
      ok: true,
      userNotice: `🔐 ${a.reason ?? "批量导入密码"}\n请在控制台批量导入（支持 Chrome / 密码管理器 CSV 批量导入，端到端加密，我看不到明文）：\n${ctx.env.PUBLIC_BASE_URL}/vault?import=chrome`,
    };
  },
};

// ── Gmail ──





function operationForEffect(effect: string): ExternalOperation {
  if (effect === "external_send") return "send";
  if (effect === "destructive") return "delete";
  if (effect === "write") return "create";
  return "read";
}

function connectorFail(provider: string, r: ConnectorCallFailure): ToolResult {
  return { ok: false, error: connectorFailureText(provider, r), external: { ok: false, error: connectorFailureToExternal(provider, r) } };
}

function externalOk(r: { ok: true; data: unknown; accountLabel: string; evidence: ExternalEvidence }, effect: string, extra?: { externalId?: string; externalUrl?: string; resourceType?: string; verifiedAt?: number; operation?: ExternalOperation; metadata?: Record<string, string | number | boolean | null> }): ExternalToolResultBox {
  return {
    ok: true,
    evidence: {
      ...r.evidence,
      externalId: extra?.externalId,
      externalUrl: extra?.externalUrl,
      resourceType: extra?.resourceType,
      verifiedAt: extra?.verifiedAt,
      metadata: extra?.metadata,
    },
    operation: extra?.operation ?? operationForEffect(effect),
  };
}


type ExternalToolResultBox = NonNullable<ToolResult["external"]>;


function addressesMatch(actual: string, expected: string): boolean {
  const norm = (s: string) => s.toLowerCase().split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean).sort().join(",");
  const a = norm(actual), b = norm(expected);
  if (!b) return true;
  if (a === b) return true;

  const bare = (s: string) => norm((s.match(/<[^>]+>/g) ?? []).join(",") || s);
  return bare(actual) === bare(expected) || a.includes(b) || bare(actual).includes(b);
}

function normalizeSubject(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function googleTool<T>(
  ctx: ToolContext,
  effect: string,
  toolName: string,
  account: unknown,
  fn: (token: string, accountLabel: string) => Promise<T>,
): Promise<ToolResult> {
  const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "google", accountLabel: account ? String(account) : undefined, taskId: ctx.taskId }, effect, toolName, fn);
  if (!r.ok) return connectorFail("google", r);
  return { ok: true, data: r.data, external: externalOk(r, effect) };
}

async function larkFeishuTool<T>(
  ctx: ToolContext,
  provider: LarkFeishuProvider,
  effect: "read" | "write" | "destructive" | "external_send",
  toolName: string,
  account: unknown,
  fn: (token: string, accountLabel: string) => Promise<T>,
  extra?: (data: T) => { externalId?: string; externalUrl?: string; resourceType?: string; verifiedAt?: number; metadata?: Record<string, string | number | boolean | null> },
): Promise<ToolResult> {
  const r = await withLarkFeishuCall(
    ctx.env,
    { workspaceId: ctx.workspaceId, provider, accountLabel: account ? String(account) : undefined, taskId: ctx.taskId },
    effect,
    toolName,
    fn,
  );
  if (!r.ok) return connectorFail(provider, r);
  const extraProps = extra ? extra(r.data) : undefined;
  return { ok: true, data: r.data, external: externalOk(r, effect, extraProps) };
}

export const TOOL_gmail_search: Tool = {
  name: "gmail_search",
  effect: "read",
  scheduledAllowed: true,
  description: "搜索 Gmail。支持 Gmail 检索语法（from:/subject:/is:unread 等）。",
  parameters: obj({ query: str("检索式，如 'from:airline subject:确认'"), max: { type: "integer" } , account: { type: "string", description: "Gmail/日历账号（可选，不填=默认最早连接账号；多账号传 account_label）" }}, ["query"]),
  run: async (ctx, a) => googleTool(ctx, "read", "gmail_search", a.account, (token) => gmailSearch(token, String(a.query ?? ""), Number(a.max ?? 5))),
};

export const TOOL_gmail_read: Tool = {
  name: "gmail_read",
  effect: "read",
  scheduledAllowed: true,
  description: "读一封 Gmail 的完整正文。",
  parameters: obj({ id: str("gmail_search 返回的邮件 id") , account: { type: "string", description: "Gmail 账号（可选，不填=默认最早连接账号）" }}, ["id"]),
  run: async (ctx, a) => {
    const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "google", accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId }, "read", "gmail_read", (token) => gmailGet(token, String(a.id)));
    if (!r.ok) return connectorFail("google", r);
    if (!r.data) return { ok: false, error: "邮件不存在或已删除" };
    return { ok: true, data: r.data };
  },
};

export const TOOL_gmail_draft: Tool = {
  name: "gmail_draft",
  effect: "write",
  description: "在 Gmail 建草稿（不发送）。用户想发邮件但没明确说'直接发'时用这个。",
  parameters: obj({ to: str("收件人邮箱"), subject: str("主题"), body: str("正文") , account: { type: "string", description: "Gmail 账号（可选，不填=默认最早连接账号）" }}, ["to", "subject", "body"]),
  run: async (ctx, a) => {
    const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "google", accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId }, "write", "gmail_draft", async (token) => {
      const created = await gmailDraft(token, { to: String(a.to), subject: String(a.subject), body: String(a.body) });

      const back = await gmailDraftGet(token, created.id);
      if (!back) return { verification_failed: true as const, reason: "draft_not_found_after_create" };
      if (!back.isDraft) return { verification_failed: true as const, reason: "draft_state_missing" };
      if (!addressesMatch(back.to, String(a.to))) return { verification_failed: true as const, reason: "to_mismatch" };
      if (normalizeSubject(back.subject) !== normalizeSubject(String(a.subject))) return { verification_failed: true as const, reason: "subject_mismatch" };
      return created;
    });
    if (!r.ok) return connectorFail("google", r);
    if ((r.data as any)?.verification_failed) {
      const f = externalFailure("google", "verification_failed", `（草稿读回验证失败：${(r.data as any).reason}。不能声称草稿已创建。）`);
      return { ok: false, error: f.error.message, external: { ok: false, error: f.error } };
    }
    return { ok: true, data: { draftId: (r.data as any).id, status: "草稿已建，未发送" }, external: externalOk(r, "write", { externalId: String((r.data as any).id), resourceType: "draft", verifiedAt: Date.now() }) };
  },
};

export const TOOL_gmail_send: Tool = {
  name: "gmail_send",
  effect: "external_send",
  description: "用 Gmail 发邮件。【对外发送，必须走审批】用户明确说'发送'才能用。",
  parameters: obj({ to: str("收件人邮箱"), subject: str("主题"), body: str("正文") , account: { type: "string", description: "Gmail 账号（可选，不填=默认最早连接账号）" }}, ["to", "subject", "body"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "google", accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId }, "external_send", "gmail_send", async (token) => {
      const profile = await gmailProfile(token);
      const sent = await gmailSend(token, { to: String(a.to), subject: String(a.subject), body: String(a.body) });
      return { id: sent.id, from: profile.emailAddress };
    });
    if (!r.ok) return connectorFail("google", r);
    if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "gmail_message_id", r.data.id);
    return { ok: true, data: { messageId: r.data.id, from: r.data.from, to: a.to, subject: a.subject }, external: externalOk(r, "external_send", { externalId: String(r.data.id), resourceType: "message" }) };
  },
};

export const TOOL_gmail_thread: Tool = {
  name: "gmail_thread",
  effect: "read",
  scheduledAllowed: true,
  description: "按线索 ID 读取 Gmail 完整往来对话线索（Thread）。适合了解邮件上下文。",
  parameters: obj({ threadId: str("gmail_search 返回的 threadId") , account: { type: "string", description: "Gmail 账号（可选）" }}, ["threadId"]),
  run: async (ctx, a) => {
    const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "google", accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId }, "read", "gmail_thread", (token) => gmailThreadGet(token, String(a.threadId)));
    if (!r.ok) return connectorFail("google", r);
    if (!r.data) return { ok: false, error: "邮件线索不存在" };
    return { ok: true, data: r.data };
  },
};

export const TOOL_gmail_update: Tool = {
  name: "gmail_update",
  effect: "local",
  description: "修改邮件状态：archive（归档）、move_to_inbox（移回收件箱）、mark_read（标为已读）、mark_unread（标为未读）、star（加星标）、unstar（去星标）。",
  parameters: obj(
    {
      id: str("邮件 id"),
      action: {
        type: "string",
        description: "操作类型",
        enum: ["archive", "move_to_inbox", "mark_read", "mark_unread", "star", "unstar"],
      },
      account: { type: "string", description: "Gmail 账号（可选，不填=默认最早连接账号）" },
    },
    ["id", "action"],
  ),
  run: async (ctx, a) => {
    const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "google", accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId }, "write", "gmail_update", (token) => gmailModify(token, String(a.id), a.action as GmailAction));
    if (!r.ok) return connectorFail("google", r);
    return { ok: true, data: { messageId: a.id, action: a.action, status: "updated" }, external: externalOk(r, "write", { operation: "update", externalId: String(a.id), resourceType: "message" }) };
  },
};

export const TOOL_contacts_search: Tool = {
  name: "contacts_search",
  effect: "read",
  scheduledAllowed: true,
  description: "搜索 Google 通讯录联系人（按姓名/邮箱/电话/公司模糊搜索）。发邮件、发邀请前补全邮箱信息。",
  parameters: obj({ query: str("搜索词，如姓名或公司名"), max: { type: "integer", description: "最多返回数量，默认10" } , account: { type: "string", description: "Gmail 账号（可选）" }}, ["query"]),
  run: async (ctx, a) => {
    const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "google", accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId }, "read", "contacts_search", (token) => googleContactsSearch(token, String(a.query ?? ""), Number(a.max ?? 10)));
    if (!r.ok) return connectorFail("google", r);
    if (r.data.length === 0) return { ok: true, data: "（未找到匹配的联系人）" };
    return { ok: true, data: r.data };
  },
};




const SEMANTIC_PROVIDER_PARAM = { type: "string", description: "可选 provider（google | lark | feishu …）。不填由 Provider Resolver 按连接与上下文解决。" };
const SEMANTIC_ACCOUNT_PARAM = { type: "string", description: "账号 label（可选，多账号时精确选择）" };

const CAPABILITY_CANDIDATE_PROVIDERS: Record<string, string[]> = {
  calendar: ["google", "lark", "feishu"],
  todo: ["google", "lark", "feishu"],
  contacts: ["google", "lark", "feishu"],
  documents: ["lark", "feishu"],
  spreadsheet: ["lark", "feishu"],
  database: ["lark", "feishu"],
  mail: ["mailbox", "google", "lark", "feishu"],
  code: ["github"],
};

async function resolveSemanticProvider(
  ctx: ToolContext,
  capability: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; provider: string } | { ok: false; error: string }> {
  const { resolveProvider } = await import("./provider-resolver");
  const { listAccounts } = await import("../connectors/token-store");
  const candidateProviders = CAPABILITY_CANDIDATE_PROVIDERS[capability] ?? ["google", "lark", "feishu"];
  const capable: string[] = [];
  for (const p of candidateProviders) {
    if (p === "mailbox") continue;
    try {
      const accounts = await listAccounts(ctx.env, ctx.workspaceId, p);
      if (accounts.filter((a) => a.needs_reauth !== 1).length > 0) capable.push(p);
    } catch {                             }
  }
  if (candidateProviders.includes("mailbox")) {
    try {
      const { defaultMailboxAccountForSemantic } = await import("./tools-semantic-helpers");
      if (await defaultMailboxAccountForSemantic(ctx.env, ctx.workspaceId)) capable.push("mailbox");
    } catch {                       }
  }
  const r = resolveProvider({
    explicitProvider: args.provider ? String(args.provider) : undefined,
    sessionAffinity: undefined,
    userDefault: undefined,
    connectedCapableProviders: capable,
    accountLabel: args.account ? String(args.account) : undefined,
  });
  if (r.ok) return { ok: true, provider: r.provider };
  if (r.error === "provider_ambiguous") {
    return { ok: false, error: `（多个服务都可执行该操作（${r.choices.join("/")}），请明确要使用哪一个，或先调用 ask_question 向用户确认。）` };
  }
  return { ok: false, error: "（该能力当前没有已连接的服务。请引导用户去控制台连接后继续。）" };
}

// ── Calendar ──

export const TOOL_calendar_list: Tool = {
  name: "calendar_list",
  effect: "read",
  scheduledAllowed: true,
  description: "列出日历日程（Google / Lark / Feishu 时间范围）。",
  parameters: obj({ timeMin: str("ISO 时间，如 2026-09-07T00:00:00+08:00"), timeMax: str("ISO 时间"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["timeMin", "timeMax"]),
  run: async (ctx, a) => {
    const r = await resolveSemanticProvider(ctx, "calendar", a);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.provider === "google") {
      return googleTool(ctx, "read", "calendar_list", a.account, (token) => calendarList(token, String(a.timeMin), String(a.timeMax)));
    }
    if (r.provider === "lark" || r.provider === "feishu") {
      const prov = r.provider as LarkFeishuProvider;
      return larkFeishuTool(ctx, prov, "read", "calendar_list", a.account, (token) => larkFeishuCalendarList(ctx.env, prov, token, String(a.timeMin), String(a.timeMax)), () => ({ resourceType: "calendar_list" }));
    }
    return { ok: false, error: `（不支持的日历 provider：${r.provider}）` };
  },
};

export const TOOL_calendar_create: Tool = {
  name: "calendar_create",
  effect: "external_send",

  requiresApproval: () => true,
  description: "建日程（Google / Lark / Feishu）。【写外部状态，必须走审批】",
  parameters: obj(
    {
      summary: str("标题"),
      startIso: str("开始时间 ISO"),
      endIso: str("结束时间 ISO"),
      description: { type: "string", description: "描述" },
      location: { type: "string", description: "地点" },
      attendees: { type: "array", items: { type: "string" }, description: "参会人邮箱（有则邀请对方）" },
      provider: SEMANTIC_PROVIDER_PARAM,
      account: SEMANTIC_ACCOUNT_PARAM,
    },
    ["summary", "startIso", "endIso"],
  ),
  needsApproval: true,
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "calendar", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "google") {
      const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "google", accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId }, "write", "calendar_create", async (token) => {
        const created = await calendarCreate(token, {
          summary: String(a.summary),
          startIso: String(a.startIso),
          endIso: String(a.endIso),
          description: a.description ? String(a.description) : undefined,
          location: a.location ? String(a.location) : undefined,
          attendees: Array.isArray(a.attendees) ? (a.attendees as string[]) : undefined,
        });

        const back = await calendarGetEvent(token, created.id);
        if (!back) return { verification_failed: true as const, reason: "event_not_found_after_create" };
        if (normalizeSubject(back.summary) !== normalizeSubject(String(a.summary))) return { verification_failed: true as const, reason: "summary_mismatch" };
        const attendeeCount = back.attendees.filter(Boolean).length;
        const expectedAttendees = Array.isArray(a.attendees) ? (a.attendees as string[]).filter(Boolean).length : 0;
        if (attendeeCount !== expectedAttendees) return { verification_failed: true as const, reason: "attendee_mismatch" };
        return created;
      });
      if (!r.ok) return connectorFail("google", r);
      if ((r.data as any)?.verification_failed) {
        const f = externalFailure("google", "verification_failed", `（日程读回验证失败：${(r.data as any).reason}。不能声称日程已创建。）`);
        return { ok: false, error: f.error.message, external: { ok: false, error: f.error } };
      }
      const eventId = String((r.data as any).id);
      if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "calendar_event_id", eventId);
      return { ok: true, data: { eventId, link: (r.data as any).htmlLink }, external: externalOk(r, "write", { externalId: eventId, externalUrl: (r.data as any).htmlLink ? String((r.data as any).htmlLink) : undefined, resourceType: "event", verifiedAt: Date.now() }) };
    }
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      const r = await withLarkFeishuCall(
        ctx.env,
        { workspaceId: ctx.workspaceId, provider: prov, accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId },
        "write",
        "calendar_create",
        async (token) => {
          return larkFeishuCalendarCreate(ctx.env, prov, token, {
            summary: String(a.summary),
            startIso: String(a.startIso),
            endIso: String(a.endIso),
            description: a.description ? String(a.description) : undefined,
            location: a.location ? String(a.location) : undefined,
            attendees: Array.isArray(a.attendees) ? (a.attendees as string[]) : undefined,
          });
        },
      );
      if (!r.ok) return connectorFail(prov, r);
      if ((r.data as any)?.verification_failed) {
        const f = externalFailure(prov, "verification_failed", `（日程读回验证失败：${(r.data as any).reason}。不能声称日程已创建。）`);
        return { ok: false, error: f.error.message, external: { ok: false, error: f.error } };
      }
      const eventId = String((r.data as any).id);
      if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "calendar_event_id", eventId);
      return {
        ok: true,
        data: { eventId, link: (r.data as any).htmlLink },
        external: externalOk(r, "write", { externalId: eventId, externalUrl: (r.data as any).htmlLink ? String((r.data as any).htmlLink) : undefined, resourceType: "event", verifiedAt: Date.now() }),
      };
    }
    return { ok: false, error: `（不支持的日历 provider：${p.provider}）` };
  },
};

export const TOOL_calendar_delete: Tool = {
  name: "calendar_delete",
  effect: "destructive",
  description: "删除日程（Google / Lark / Feishu）。【破坏性，必须走审批】",
  parameters: obj({ eventId: str("日程 id"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["eventId"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "calendar", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "google") {
      return googleTool(ctx, "destructive", "calendar_delete", a.account, (token) => calendarDelete(token, String(a.eventId)));
    }
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "destructive",
        "calendar_delete",
        a.account,
        (token) => larkFeishuCalendarDelete(ctx.env, prov, token, String(a.eventId)),
        () => ({ externalId: String(a.eventId), resourceType: "event" }),
      );
    }
    return { ok: false, error: `（不支持的日历 provider：${p.provider}）` };
  },
};

export const TOOL_tasks_add: Tool = {
  name: "tasks_add",
  effect: "local",

  description: "加一条 Google Tasks 待办。（旧名；新语义请用 todo_create）",
  parameters: obj({ title: str("内容"), dueIso: { type: "string", description: "截止 ISO（可选）" } , account: { type: "string", description: "Google 账号（可选）" }}, ["title"]),
  run: async (ctx, a) => {
    const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "google", accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId }, "write", "tasks_add", (token) => tasksInsert(token, String(a.title), a.dueIso ? String(a.dueIso) : undefined));
    if (!r.ok) return connectorFail("google", r);
    if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "google_task", String(r.data.id ?? a.title));
    return { ok: true, data: r.data };
  },
};

export const TOOL_tasks_list: Tool = {
  name: "tasks_list",
  effect: "read",
  scheduledAllowed: true,
  description: "列出 Google Tasks 待办。（旧名；新语义请用 todo_list）",
  parameters: obj({account: { type: "string", description: "Google 账号（可选）" }}),
  run: async (ctx, a) => googleTool(ctx, "read", "tasks_list", a.account, (token) => tasksList(token)),
};

export const TOOL_calendar_freebusy: Tool = {
  name: "calendar_freebusy",
  effect: "read",
  scheduledAllowed: true,
  description: "查询日历忙闲（free/busy，只读，权威可用性来源）。（Lark / Feishu 真实支持；Google fail-closed 请用 calendar_list。）",
  parameters: obj({ timeMin: str("查询起点 ISO 时间"), timeMax: str("查询终点 ISO 时间"), timeZone: { type: "string", description: "IANA 时区（可选）" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["timeMin", "timeMax"]),
  run: async (ctx, a) => {
    const r = await resolveSemanticProvider(ctx, "calendar", a);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.provider === "lark" || r.provider === "feishu") {
      const prov = r.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "calendar_freebusy",
        a.account,
        (token) => larkFeishuCalendarFreebusy(ctx.env, prov, token, String(a.timeMin), String(a.timeMax)),
        () => ({ resourceType: "calendar_freebusy" }),
      );
    }
    return { ok: false, error: "（Google 日历忙闲协议未开放，不得用事件列表自行推断忙闲冒充权威可用性。可调用 calendar_list 查日程。）" };
  },
};

export const TOOL_calendar_update: Tool = {
  name: "calendar_update",
  effect: "write",
  requiresApproval: (a) => Array.isArray(a.attendees) && a.attendees.length > 0,
  description: "更新日程（标题/时间/地点/描述/参会人）。修改 attendees 时【必须走审批】。（Lark / Feishu 真实支持。）",
  parameters: obj({ eventId: str("日程 id"), summary: { type: "string", description: "新标题" }, startIso: { type: "string", description: "新开始 ISO" }, endIso: { type: "string", description: "新结束 ISO" }, description: { type: "string" }, location: { type: "string" }, attendees: { type: "array", items: { type: "string" }, description: "新的参会人邮箱列表（提供则需审批）" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["eventId"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "calendar", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "write",
        "calendar_update",
        a.account,
        (token) => larkFeishuCalendarUpdate(ctx.env, prov, token, String(a.eventId), {
          summary: a.summary ? String(a.summary) : undefined,
          startIso: a.startIso ? String(a.startIso) : undefined,
          endIso: a.endIso ? String(a.endIso) : undefined,
          description: a.description ? String(a.description) : undefined,
          location: a.location ? String(a.location) : undefined,
        }),
        () => ({ externalId: String(a.eventId), resourceType: "event", verifiedAt: Date.now() }),
      );
    }
    return { ok: false, error: "（Google 日历更新未实现：没有真实的更新协议，不得用新建冒充。请先用 calendar_list 确认，再用 provider 原生工具执行。）" };
  },
};

export const TOOL_todo_list: Tool = {
  name: "todo_list",
  effect: "read",
  scheduledAllowed: true,
  description: "列出用户外部待办事项（Google Tasks / Lark / Feishu）。Agent 自己执行的任务仍用 task_*，不要混用。",
  parameters: obj({ provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "todo", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "google") {
      return TOOL_tasks_list.run(ctx, a);
    }
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "todo_list",
        a.account,
        (token) => larkFeishuTodoList(ctx.env, prov, token),
        () => ({ resourceType: "todo_list" }),
      );
    }
    return { ok: false, error: `（不支持的待办 provider：${p.provider}）` };
  },
};

export const TOOL_todo_get: Tool = {
  name: "todo_get",
  effect: "read",
  scheduledAllowed: true,
  description: "读取一条外部待办的完整内容。（Lark / Feishu 真实支持；Google fail-closed 请用 todo_list 浏览。）",
  parameters: obj({ taskId: str("待办 id"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["taskId"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "todo", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "todo_get",
        a.account,
        (token) => larkFeishuTodoGet(ctx.env, prov, token, String(a.taskId)),
        () => ({ externalId: String(a.taskId), resourceType: "todo" }),
      );
    }
    return { ok: false, error: "（Google Tasks 单条待办读取协议未开放，不得用列表近似冒充。可用 todo_list 浏览。）" };
  },
};

export const TOOL_todo_create: Tool = {
  name: "todo_create",
  effect: "write",
  description: "新建一条用户外部待办事项（Google Tasks / Lark / Feishu）。",
  parameters: obj({ title: str("内容"), notes: { type: "string", description: "备注（可选）" }, dueIso: { type: "string", description: "截止 ISO（可选）" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["title"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "todo", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "google") {
      return TOOL_tasks_add.run(ctx, a);
    }
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      const r = await withLarkFeishuCall(
        ctx.env,
        { workspaceId: ctx.workspaceId, provider: prov, accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId },
        "write",
        "todo_create",
        async (token) => {
          return larkFeishuTodoCreate(ctx.env, prov, token, {
            title: String(a.title),
            notes: a.notes ? String(a.notes) : undefined,
            dueIso: a.dueIso ? String(a.dueIso) : undefined,
          });
        },
      );
      if (!r.ok) return connectorFail(prov, r);
      if ((r.data as any)?.verification_failed) {
        const f = externalFailure(prov, "verification_failed", `（待办读回验证失败：${(r.data as any).reason}。不能声称待办已创建。）`);
        return { ok: false, error: f.error.message, external: { ok: false, error: f.error } };
      }
      const id = String((r.data as any).id);
      if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "todo_task_id", id);
      return {
        ok: true,
        data: r.data,
        external: externalOk(r, "write", { externalId: id, externalUrl: (r.data as any).url, resourceType: "todo", verifiedAt: Date.now() }),
      };
    }
    return { ok: false, error: `（不支持的待办 provider：${p.provider}）` };
  },
};

export const TOOL_todo_update: Tool = {
  name: "todo_update",
  effect: "write",
  description: "更新一条用户外部待办（标题/备注/截止时间）。（Lark / Feishu 真实支持；Google fail-closed 不得用新建冒充更新。）",
  parameters: obj({ taskId: str("待办 id"), title: { type: "string", description: "新标题" }, notes: { type: "string", description: "新备注" }, dueIso: { type: "string", description: "新截止 ISO" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["taskId"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "todo", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "write",
        "todo_update",
        a.account,
        (token) => larkFeishuTodoUpdate(ctx.env, prov, token, String(a.taskId), {
          title: a.title ? String(a.title) : undefined,
          notes: a.notes ? String(a.notes) : undefined,
          dueIso: a.dueIso ? String(a.dueIso) : undefined,
        }),
        () => ({ externalId: String(a.taskId), resourceType: "todo", verifiedAt: Date.now() }),
      );
    }
    return { ok: false, error: "（Google Tasks 更新未实现：没有真实的更新协议，不得用新建待办冒充更新。）" };
  },
};

export const TOOL_todo_complete: Tool = {
  name: "todo_complete",
  effect: "write",
  description: "把一条用户外部待办标记为完成。（Lark / Feishu 真实支持。）",
  parameters: obj({ taskId: str("待办 id"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["taskId"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "todo", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "write",
        "todo_complete",
        a.account,
        (token) => larkFeishuTodoComplete(ctx.env, prov, token, String(a.taskId)),
        () => ({ externalId: String(a.taskId), resourceType: "todo", verifiedAt: Date.now() }),
      );
    }
    return { ok: false, error: "（Google Tasks 完成未实现：没有真实的完成协议，不得合成成功。）" };
  },
};

export const TOOL_todo_delete: Tool = {
  name: "todo_delete",
  effect: "destructive",
  description: "删除一条用户外部待办。【破坏性，必须先获得用户确认】（Lark / Feishu 真实支持。）",
  parameters: obj({ taskId: str("待办 id"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["taskId"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "todo", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "destructive",
        "todo_delete",
        a.account,
        (token) => larkFeishuTodoDelete(ctx.env, prov, token, String(a.taskId)),
        () => ({ externalId: String(a.taskId), resourceType: "todo" }),
      );
    }
    return { ok: false, error: "（Google Tasks 删除未实现：没有真实的删除协议，不得合成成功。）" };
  },
};

export const TOOL_contact_search: Tool = {
  name: "contact_search",
  effect: "read",
  scheduledAllowed: true,
  description: "搜索联系人（Google / Lark / Feishu 按姓名/邮箱/电话/公司模糊搜索）。发邮件、发邀请前补全信息。",
  parameters: obj({ query: str("搜索词"), max: { type: "integer", description: "最多返回数量，默认10" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["query"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "contacts", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "google") {
      return TOOL_contacts_search.run(ctx, a);
    }
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "contact_search",
        a.account,
        (token) => larkFeishuContactSearch(ctx.env, prov, token, String(a.query), a.max ? Number(a.max) : 10),
        () => ({ resourceType: "contacts" }),
      );
    }
    return { ok: false, error: `（不支持的联系人 provider：${p.provider}）` };
  },
};

export const TOOL_contact_get: Tool = {
  name: "contact_get",
  effect: "read",
  scheduledAllowed: true,
  description: "读取一个联系人的完整信息。（Lark / Feishu 真实支持；Google fail-closed 请用 contact_search。）",
  parameters: obj({ id: str("联系人 id（open_id / user_id）"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["id"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "contacts", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "contact_get",
        a.account,
        (token) => larkFeishuContactGet(ctx.env, prov, token, String(a.id)),
        () => ({ externalId: String(a.id), resourceType: "contact" }),
      );
    }
    return { ok: false, error: "（Google 通讯录单条读取未实现：没有真实的单条读取协议，不得用搜索近似冒充。可用 contact_search 搜索。）" };
  },
};

export const TOOL_contact_create: Tool = {
  name: "contact_create",
  effect: "write",
  description: "创建联系人。（V1 未实现：fail-closed。）",
  parameters: obj({ name: str("姓名"), email: { type: "string", description: "邮箱（可选）" }, phone: { type: "string", description: "电话（可选）" }, organization: { type: "string", description: "组织（可选）" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["name"]),
  run: async () => ({ ok: false, error: "（contact_create V1 未实现：没有真实的创建协议，不得合成成功。）" }),
};

export const TOOL_contact_update: Tool = {
  name: "contact_update",
  effect: "write",
  description: "更新联系人（只更新传入的字段）。（V1 未实现：fail-closed。）",
  parameters: obj({ id: str("联系人 id"), name: { type: "string", description: "新名" }, email: { type: "string", description: "新邮箱" }, phone: { type: "string", description: "新电话" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["id"]),
  run: async () => ({ ok: false, error: "（contact_update V1 未实现：没有真实的更新协议，不得合成成功。）" }),
};

export const TOOL_contact_delete: Tool = {
  name: "contact_delete",
  effect: "destructive",
  description: "删除联系人。【破坏性，必须先获得用户确认】（V1 未实现：fail-closed。）",
  parameters: obj({ id: str("联系人 id"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["id"]),
  needsApproval: true,
  run: async () => ({ ok: false, error: "（contact_delete V1 未实现：没有真实的删除协议，不得合成成功。）" }),
};

// ── Documents / Spreadsheet / Database Semantic Tools (§10.5 / §10.6 / §10.7) ──

export const TOOL_document_search: Tool = {
  name: "document_search",
  effect: "read",
  scheduledAllowed: true,
  description: "搜索云文档（Lark / Feishu 云文档）。",
  parameters: obj({ query: str("搜索词"), max: { type: "integer", description: "最多返回数量，默认10" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["query"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "documents", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "document_search",
        a.account,
        (token) => larkFeishuDocumentSearch(ctx.env, prov, token, a.query ? String(a.query) : undefined, a.max ? Number(a.max) : 10),
        () => ({ resourceType: "document" }),
      );
    }
    return { ok: false, error: `（不支持的文档 provider：${p.provider}）` };
  },
};

export const TOOL_document_read: Tool = {
  name: "document_read",
  effect: "read",
  scheduledAllowed: true,
  description: "读取云文档内容（纯文本/段落，Lark / Feishu）。",
  parameters: obj({ documentId: str("文档 token / document_id"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["documentId"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "documents", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "document_read",
        a.account,
        (token) => larkFeishuDocumentRead(ctx.env, prov, token, String(a.documentId)),
        () => ({ externalId: String(a.documentId), resourceType: "document" }),
      );
    }
    return { ok: false, error: `（不支持的文档 provider：${p.provider}）` };
  },
};

export const TOOL_document_create: Tool = {
  name: "document_create",
  effect: "write",
  description: "新建云文档（Lark / Feishu）。【写外部状态，读回确认】",
  parameters: obj({ title: str("文档标题"), folderToken: { type: "string", description: "所在文件夹 token（可选）" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["title"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "documents", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      const r = await withLarkFeishuCall(
        ctx.env,
        { workspaceId: ctx.workspaceId, provider: prov, accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId },
        "write",
        "document_create",
        async (token) => {
          return larkFeishuDocumentCreate(ctx.env, prov, token, String(a.title));
        },
      );
      if (!r.ok) return connectorFail(prov, r);
      if ((r.data as any)?.verification_failed) {
        const f = externalFailure(prov, "verification_failed", `（文档读回验证失败：${(r.data as any).reason}。不能声称文档已创建。）`);
        return { ok: false, error: f.error.message, external: { ok: false, error: f.error } };
      }
      const docId = String((r.data as any).documentId);
      if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "document_id", docId);
      return {
        ok: true,
        data: r.data,
        external: externalOk(r, "write", { externalId: docId, externalUrl: (r.data as any).url, resourceType: "document", verifiedAt: Date.now() }),
      };
    }
    return { ok: false, error: `（不支持的文档 provider：${p.provider}）` };
  },
};

export const TOOL_document_append: Tool = {
  name: "document_append",
  effect: "write",
  description: "向云文档末尾追加内容段落（Lark / Feishu）。",
  parameters: obj({ documentId: str("文档 token / document_id"), text: str("要追加的纯文本内容"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["documentId", "text"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "documents", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "write",
        "document_append",
        a.account,
        (token) => larkFeishuDocumentAppend(ctx.env, prov, token, String(a.documentId), String(a.text)),
        () => ({ externalId: String(a.documentId), resourceType: "document", verifiedAt: Date.now() }),
      );
    }
    return { ok: false, error: `（不支持的文档 provider：${p.provider}）` };
  },
};

export const TOOL_spreadsheet_create: Tool = {
  name: "spreadsheet_create",
  effect: "write",
  description: "新建电子表格（Lark / Feishu）。【写外部状态，读回确认】",
  parameters: obj({ title: str("表格标题"), folderToken: { type: "string", description: "所在文件夹 token（可选）" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["title"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "spreadsheet", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      const r = await withLarkFeishuCall(
        ctx.env,
        { workspaceId: ctx.workspaceId, provider: prov, accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId },
        "write",
        "spreadsheet_create",
        async (token) => {
          const created = await larkFeishuSpreadsheetCreate(ctx.env, prov, token, String(a.title));
          return { spreadsheetToken: created.token, title: created.title, url: created.url };
        },
      );
      if (!r.ok) return connectorFail(prov, r);
      if ((r.data as any)?.verification_failed) {
        const f = externalFailure(prov, "verification_failed", `（表格读回验证失败：${(r.data as any).reason}。不能声称表格已创建。）`);
        return { ok: false, error: f.error.message, external: { ok: false, error: f.error } };
      }
      const sheetToken = String((r.data as any).spreadsheetToken);
      if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "spreadsheet_token", sheetToken);
      return {
        ok: true,
        data: r.data,
        external: externalOk(r, "write", { externalId: sheetToken, externalUrl: (r.data as any).url, resourceType: "spreadsheet", verifiedAt: Date.now() }),
      };
    }
    return { ok: false, error: `（不支持的电子表格 provider：${p.provider}）` };
  },
};

export const TOOL_spreadsheet_get: Tool = {
  name: "spreadsheet_get",
  effect: "read",
  scheduledAllowed: true,
  description: "获取电子表格元数据与工作表（sheets）列表（Lark / Feishu）。",
  parameters: obj({ spreadsheetToken: str("表格 token"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["spreadsheetToken"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "spreadsheet", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "spreadsheet_get",
        a.account,
        (token) => larkFeishuSpreadsheetGet(ctx.env, prov, token, String(a.spreadsheetToken)),
        () => ({ externalId: String(a.spreadsheetToken), resourceType: "spreadsheet" }),
      );
    }
    return { ok: false, error: `（不支持的电子表格 provider：${p.provider}）` };
  },
};

export const TOOL_spreadsheet_read: Tool = {
  name: "spreadsheet_read",
  effect: "read",
  scheduledAllowed: true,
  description: "读取电子表格指定范围的单元格数据（Lark / Feishu）。",
  parameters: obj({ spreadsheetToken: str("表格 token"), range: str("单元格范围，如 'Sheet1!A1:D10'"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["spreadsheetToken", "range"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "spreadsheet", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "spreadsheet_read",
        a.account,
        (token) => larkFeishuSpreadsheetRead(ctx.env, prov, token, String(a.spreadsheetToken), String(a.range)),
        () => ({ externalId: String(a.spreadsheetToken), resourceType: "spreadsheet" }),
      );
    }
    return { ok: false, error: `（不支持的电子表格 provider：${p.provider}）` };
  },
};

export const TOOL_spreadsheet_append_rows: Tool = {
  name: "spreadsheet_append_rows",
  effect: "write",
  description: "向电子表格指定工作表追加行数据（Lark / Feishu）。",
  parameters: obj({
    spreadsheetToken: str("表格 token"),
    range: str("范围，如 'Sheet1!A1:D1'"),
    values: { type: "array", items: { type: "array", items: {} }, description: "二维数组，每行为单元格值" },
    provider: SEMANTIC_PROVIDER_PARAM,
    account: SEMANTIC_ACCOUNT_PARAM,
  }, ["spreadsheetToken", "range", "values"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "spreadsheet", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "write",
        "spreadsheet_append_rows",
        a.account,
        (token) => larkFeishuSpreadsheetAppendRows(ctx.env, prov, token, String(a.spreadsheetToken), String(a.range), a.values as any[][]),
        () => ({ externalId: String(a.spreadsheetToken), resourceType: "spreadsheet", verifiedAt: Date.now() }),
      );
    }
    return { ok: false, error: `（不支持的电子表格 provider：${p.provider}）` };
  },
};

export const TOOL_database_query: Tool = {
  name: "database_query",
  effect: "read",
  scheduledAllowed: true,
  description: "查询多维表格（Bitable / Base）记录（Lark / Feishu）。",
  parameters: obj({
    appToken: str("Base / 多维表格 app_token"),
    tableId: str("数据表 table_id"),
    filter: { type: "string", description: "过滤条件表达式（可选）" },
    pageSize: { type: "integer", description: "单页数量，默认 20，最多 100" },
    provider: SEMANTIC_PROVIDER_PARAM,
    account: SEMANTIC_ACCOUNT_PARAM,
  }, ["appToken", "tableId"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "database", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "read",
        "database_query",
        a.account,
        (token) => larkFeishuDatabaseQuery(ctx.env, prov, token, String(a.appToken), String(a.tableId), {
          pageSize: a.pageSize ? Number(a.pageSize) : undefined,
        }),
        () => ({ externalId: `${a.appToken}/${a.tableId}`, resourceType: "database" }),
      );
    }
    return { ok: false, error: `（不支持的多维表格 provider：${p.provider}）` };
  },
};

export const TOOL_database_create_record: Tool = {
  name: "database_create_record",
  effect: "write",
  description: "在多维表格中插入一条记录（Lark / Feishu）。【写外部状态，读回确认】",
  parameters: obj({
    appToken: str("Base / 多维表格 app_token"),
    tableId: str("数据表 table_id"),
    fields: { type: "object", description: "字段键值对对象" },
    provider: SEMANTIC_PROVIDER_PARAM,
    account: SEMANTIC_ACCOUNT_PARAM,
  }, ["appToken", "tableId", "fields"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "database", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      const r = await withLarkFeishuCall(
        ctx.env,
        { workspaceId: ctx.workspaceId, provider: prov, accountLabel: a.account ? String(a.account) : undefined, taskId: ctx.taskId },
        "write",
        "database_create_record",
        async (token) => {
          return larkFeishuDatabaseCreateRecord(ctx.env, prov, token, String(a.appToken), String(a.tableId), (a.fields ?? {}) as Record<string, unknown>);
        },
      );
      if (!r.ok) return connectorFail(prov, r);
      if ((r.data as any)?.verification_failed) {
        const f = externalFailure(prov, "verification_failed", `（记录读回验证失败：${(r.data as any).reason}。不能声称记录已创建。）`);
        return { ok: false, error: f.error.message, external: { ok: false, error: f.error } };
      }
      const recordId = String((r.data as any).recordId);
      if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "database_record_id", recordId);
      return {
        ok: true,
        data: r.data,
        external: externalOk(r, "write", { externalId: recordId, resourceType: "database_record", verifiedAt: Date.now() }),
      };
    }
    return { ok: false, error: `（不支持的多维表格 provider：${p.provider}）` };
  },
};

export const TOOL_database_update_record: Tool = {
  name: "database_update_record",
  effect: "write",
  description: "更新多维表格中一条记录的字段（Lark / Feishu）。",
  parameters: obj({
    appToken: str("Base / 多维表格 app_token"),
    tableId: str("数据表 table_id"),
    recordId: str("记录 ID"),
    fields: { type: "object", description: "更新的字段键值对对象" },
    provider: SEMANTIC_PROVIDER_PARAM,
    account: SEMANTIC_ACCOUNT_PARAM,
  }, ["appToken", "tableId", "recordId", "fields"]),
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "database", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "write",
        "database_update_record",
        a.account,
        (token) => larkFeishuDatabaseUpdateRecord(ctx.env, prov, token, String(a.appToken), String(a.tableId), String(a.recordId), (a.fields ?? {}) as Record<string, unknown>),
        () => ({ externalId: String(a.recordId), resourceType: "database_record", verifiedAt: Date.now() }),
      );
    }
    return { ok: false, error: `（不支持的多维表格 provider：${p.provider}）` };
  },
};

export const TOOL_database_delete_record: Tool = {
  name: "database_delete_record",
  effect: "destructive",
  description: "删除多维表格中一条记录（Lark / Feishu）。【破坏性，必须走审批】",
  parameters: obj({
    appToken: str("Base / 多维表格 app_token"),
    tableId: str("数据表 table_id"),
    recordId: str("记录 ID"),
    provider: SEMANTIC_PROVIDER_PARAM,
    account: SEMANTIC_ACCOUNT_PARAM,
  }, ["appToken", "tableId", "recordId"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const p = await resolveSemanticProvider(ctx, "database", a);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.provider === "lark" || p.provider === "feishu") {
      const prov = p.provider as LarkFeishuProvider;
      return larkFeishuTool(
        ctx,
        prov,
        "destructive",
        "database_delete_record",
        a.account,
        (token) => larkFeishuDatabaseDeleteRecord(ctx.env, prov, token, String(a.appToken), String(a.tableId), String(a.recordId)),
        () => ({ externalId: String(a.recordId), resourceType: "database_record" }),
      );
    }
    return { ok: false, error: `（不支持的多维表格 provider：${p.provider}）` };
  },
};

export const TOOL_mail_search: Tool = {
  name: "mail_search",
  effect: "read",
  scheduledAllowed: true,
  description: "搜索用户自己的邮箱（IMAP / Lark / Feishu 统一语义）。支持 from:/subject:/is:unread 等检索式。agent_mail_* 是 Agent 自己的邮箱，不要混用。provider 可选（mailbox/feishu/lark/google），不填按连接态解决；显式 provider 不得 silent fallback。",
  parameters: obj({ query: str("检索式"), max: { type: "integer" }, folder: { type: "string", description: "邮箱文件夹，默认 INBOX" }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["query"]),
  run: async (ctx, a) => {
    const explicit = typeof (a as Record<string, unknown>).provider === "string" ? String((a as Record<string, unknown>).provider).toLowerCase() : "";
    if (explicit) {
      const r = await resolveSemanticProvider(ctx, "mail", a);
      if (!r.ok) return { ok: false, error: r.error };
      if (r.provider !== "mailbox") return { ok: false, error: `（${r.provider} 邮件搜索 V1 尚未接入：显式 provider 不得 fallback 到其他邮箱。）` };
    }
    return TOOL_mail_list.run(ctx, { search: String(a.query ?? ""), max: a.max, folder: a.folder, account: a.account, provider: (a as Record<string, unknown>).provider });
  },
};

export const TOOL_mail_thread: Tool = {
  name: "mail_thread",
  effect: "read",
  scheduledAllowed: true,
  description: "按线索读取完整往来邮件（统一语义）。（V1 未实现：fail-closed。IMAP seq/UID 都不等于 semantic threadId。）",
  parameters: obj({ threadId: str("线索 id"), provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["threadId"]),
  run: async () => ({ ok: false, error: "（mail_thread V1 未实现：没有真实 thread 协议，IMAP seq/UID 均不等于 semantic threadId，不得退化成读第 N 封。保持 hidden + fail-closed。）" }),
};

export const TOOL_mail_update: Tool = {
  name: "mail_update",
  effect: "write",
  description: "修改邮件状态：archive / move_to_inbox / mark_read / mark_unread / star / unstar（统一语义）。（V1 未实现：fail-closed。）",
  parameters: obj({ id: str("邮件 id"), action: { type: "string", description: "操作类型", enum: ["archive", "move_to_inbox", "mark_read", "mark_unread", "star", "unstar"] }, provider: SEMANTIC_PROVIDER_PARAM, account: SEMANTIC_ACCOUNT_PARAM }, ["id", "action"]),
  run: async () => ({ ok: false, error: "（mail_update V1 未实现：没有真实的 provider 状态修改协议，不得合成 local success。须按真实 external write 建模并返回 external evidence。）" }),
};

export const TOOL_code_repo_list: Tool = {
  name: "code_repo_list",
  effect: "read",
  scheduledAllowed: true,
  description: "列出我的代码仓库（按最近更新）。用户说'看看代码/项目'时用这个，不要求出现 GitHub。",
  parameters: obj({ max: { type: "integer" }, provider: SEMANTIC_PROVIDER_PARAM }, ["max"]),
  run: async (ctx, a) => TOOL_github_repos.run(ctx, a),
};

export const TOOL_code_search: Tool = {
  name: "code_search",
  effect: "read",
  scheduledAllowed: true,
  description: "搜索代码与 Issue/PR（统一 code 语义）。语法：repo:x/y is:open label:bug 等。（V1 未实现：fail-closed，不得把 issue 搜索冒充代码搜索。）",
  parameters: obj({ query: str("检索式"), provider: SEMANTIC_PROVIDER_PARAM }, ["query"]),
  run: async () => ({ ok: false, error: "（code_search V1 未实现：没有真实的统一 code 搜索协议，不得用 issue 搜索冒充。可用 code_repo_list 浏览仓库。）" }),
};

export const TOOL_code_issue_read: Tool = {
  name: "code_issue_read",
  effect: "read",
  scheduledAllowed: true,
  description: "读取一个 Issue 的完整内容。（V1 未实现：fail-closed，不得用搜索近似冒充精确读取。）",
  parameters: obj({ repo: str("owner/name"), number: { type: "integer", description: "issue 编号" }, provider: SEMANTIC_PROVIDER_PARAM }, ["repo", "number"]),
  run: async () => ({ ok: false, error: "（code_issue_read V1 未实现：没有真实的单 issue 读取协议，不得用搜索近似冒充。）" }),
};

export const TOOL_code_issue_create: Tool = {
  name: "code_issue_create",
  effect: "external_send",
  description: "在代码仓库建 issue。【对外创建，必须走审批】",
  parameters: obj({ repo: str("owner/name"), title: str("标题"), body: { type: "string", description: "正文" }, provider: SEMANTIC_PROVIDER_PARAM }, ["repo", "title"]),
  needsApproval: true,
  run: async (ctx, a) => TOOL_github_create_issue.run(ctx, a),
};

export const TOOL_code_comment: Tool = {
  name: "code_comment",
  effect: "external_send",
  description: "在 Issue/PR 上评论。【对外发言，必须走审批】",
  parameters: obj({ repo: str("owner/name"), number: { type: "integer", description: "issue 编号" }, body: str("评论"), provider: SEMANTIC_PROVIDER_PARAM }, ["repo", "number", "body"]),
  needsApproval: true,
  run: async (ctx, a) => TOOL_github_comment.run(ctx, a),
};

export const SEMANTIC_CAPABILITY_TOOLS: Tool[] = [
  TOOL_calendar_freebusy, TOOL_calendar_update,
  TOOL_todo_list, TOOL_todo_get, TOOL_todo_create, TOOL_todo_update, TOOL_todo_complete, TOOL_todo_delete,
  TOOL_contact_search, TOOL_contact_get, TOOL_contact_create, TOOL_contact_update, TOOL_contact_delete,
  TOOL_mail_search, TOOL_mail_thread, TOOL_mail_update,
  TOOL_code_repo_list, TOOL_code_search, TOOL_code_issue_read, TOOL_code_issue_create, TOOL_code_comment,
];



export const TOOL_feishu_mail_list: Tool = {
  name: "feishu_mail_list",
  effect: "read",
  scheduledAllowed: true,
  description: "列出飞书邮箱邮件（国内主力连接器）。",
  parameters: obj({ query: { type: "string", description: "过滤词（可选）" }, max: { type: "integer" } , account: { type: "string", description: "飞书账号（可选，单账号可不填）" }}),
  run: async (ctx, a) => {
    try {
      return { ok: true, data: await feishuMailList(ctx.env, ctx.workspaceId, { query: a.query ? String(a.query) : undefined, max: Number(a.max ?? 8) }) };
    } catch (e) {
      return { ok: false, error: `飞书未连接或出错：${e}` };
    }
  },
};

export const TOOL_feishu_mail_read: Tool = {
  name: "feishu_mail_read",
  effect: "read",
  scheduledAllowed: true,
  description: "读一封飞书邮件正文。",
  parameters: obj({ id: str("邮件 id") , account: { type: "string", description: "飞书账号（可选）" }}, ["id"]),
  run: async (ctx, a) => {
    try {
      const r = await feishuMailGet(ctx.env, ctx.workspaceId, String(a.id));
      return r ? { ok: true, data: r } : { ok: false, error: "邮件不存在" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};

export const TOOL_feishu_calendar_list: Tool = {
  name: "feishu_calendar_list",
  effect: "read",
  scheduledAllowed: true,
  description: "列出飞书日程。",
  parameters: obj({ timeMin: str("ISO"), timeMax: str("ISO") , account: { type: "string", description: "飞书账号（可选）" }}, ["timeMin", "timeMax"]),
  run: async (ctx, a) => {
    try {
      return { ok: true, data: await feishuCalendarList(ctx.env, ctx.workspaceId, String(a.timeMin), String(a.timeMax)) };
    } catch (e) {
      return { ok: false, error: `飞书未连接或出错：${e}` };
    }
  },
};

export const TOOL_feishu_calendar_create: Tool = {
  name: "feishu_calendar_create",
  effect: "local",
  description: "建飞书日程。",
  parameters: obj({ summary: str("标题"), startIso: str("ISO"), endIso: str("ISO"), description: { type: "string" } , account: { type: "string", description: "飞书账号（可选）" }}, ["summary", "startIso", "endIso"]),
  run: async (ctx, a) => {
    try {
      const r = await feishuCalendarCreate(ctx.env, ctx.workspaceId, {
        summary: String(a.summary), startIso: String(a.startIso), endIso: String(a.endIso),
        description: a.description ? String(a.description) : undefined,
      });
      if ("error" in r) return { ok: false, error: r.error };
      if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "feishu_event", String((r as any).event_id ?? (r as any).id ?? a.summary));
      return { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};







/**
 * Hosted mailbox account for an executor call. The model often names a mailbox by
 * provider ("126") or label instead of its full address; match those, and with a
 * single connected mailbox use it rather than reporting the mailbox as missing.
 */
export async function resolveExecutorMailboxAccount(env: any, workspaceId: string, requested: unknown): Promise<string | null> {
  const raw = requested ? String(requested).replace(/[\r\n]/g, "").trim().toLowerCase() : "";
  if (!raw) return defaultMailboxAccount(env, workspaceId);
  let rows: Array<{ email: string; provider: string }> = [];
  try {
    const res = await env.DB.prepare(
      `SELECT email, provider FROM mailbox_accounts WHERE workspace_id=? ORDER BY COALESCE(created_at,0) ASC, email ASC`,
    ).bind(workspaceId).all();
    rows = (res?.results ?? []) as Array<{ email: string; provider: string }>;
  } catch {
    return raw;
  }
  const exact = rows.find((r) => r.email.toLowerCase() === raw);
  if (exact) return exact.email.toLowerCase();
  const byProvider = rows.filter((r) => String(r.provider ?? "").toLowerCase() === raw || r.email.toLowerCase().endsWith("@" + raw) || r.email.toLowerCase().split("@")[1]?.startsWith(raw + "."));
  if (byProvider.length === 1) return byProvider[0].email.toLowerCase();
  if (rows.length === 1) return rows[0].email.toLowerCase();
  return raw;
}

async function defaultMailboxAccount(env: any, workspaceId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT email FROM mailbox_accounts WHERE workspace_id=? ORDER BY COALESCE(created_at,0) ASC, email ASC LIMIT 1`,
  ).bind(workspaceId).first() as { email: string } | null;
  return row?.email ?? null;
}

async function executorListMail(env: any, workspaceId: string, account: string | null, search: string, max: number, folder?: string) {
  const executor = (env as any).IMAP;
  if (!executor) return { ok: false, error: "executor_unavailable" } as const;
  try {
    return await executor.listMail({ workspaceId, account, search, max, folder }) as { ok: boolean; mails?: unknown[]; error?: string };
  } catch (e) {
    return { ok: false, error: `executor_rpc_failed: ${String(e).slice(0, 120)}` } as const;
  }
}

async function executorCountMail(env: any, workspaceId: string, account: string | null, search: string, folder?: string) {
  const executor = (env as any).IMAP;
  if (!executor) return { ok: false, error: "executor_unavailable" } as const;
  try {
    return await executor.countMail({ workspaceId, account, search, folder }) as { ok: boolean; count?: number; folder?: string; error?: string };
  } catch (e) {
    return { ok: false, error: `executor_rpc_failed: ${String(e).slice(0, 120)}` } as const;
  }
}

export const TOOL_mail_list: Tool = {
  name: "mail_list",
  effect: "read",
  scheduledAllowed: true,
  description: "列出 QQ/163/126/iCloud 邮箱某个文件夹的邮件（只返回头部：发件人/主题/日期，不含正文。授权码存在 Vault，模型看不到）。中国用户主力邮箱。",
  parameters: obj({ search: { type: "string", description: "IMAP 检索：UNSEEN / FROM xxx / SINCE 7-Sep-2026，留空=最新" }, max: { type: "integer" }, folder: { type: "string", description: "邮箱文件夹，默认 INBOX（如 Archive / Drafts；非法名会被拒绝）" }, provider: { type: "string", description: "qq/163/126/icloud，留空自动" }, account: { type: "string", description: "可选。要使用的邮箱账号（hosted 多邮箱时精确选择）" } }),
  run: async (ctx, a) => {
    const folder = a.folder ? String(a.folder) : "INBOX";
    const executor = (ctx.env as any).IMAP;
    if (executor) {
      const account = await resolveExecutorMailboxAccount(ctx.env, ctx.workspaceId, a.account);
      if (!account) return { ok: false, error: "没有已连接的邮箱。引导用户在控制台 设置 → 邮箱 连接（QQ/163/126/iCloud 授权码）。" };
      const r = await executorListMail(ctx.env, ctx.workspaceId, account, a.search ? String(a.search) : "", Number(a.max ?? 8), folder);
      if (!r.ok) return { ok: false, error: `IMAP 失败：${r.error}` };
      return { ok: true, data: { account: account.replace(/^(.).*@/, "$1***@"), folder, mails: r.mails } };
    }
    const box = await resolveMailbox(ctx.env, ctx.workspaceId, a.provider ? String(a.provider) : undefined);
    if (!box) return { ok: false, error: "没有可用的邮箱授权码。引导用户在控制台 Vault 添加（provider 标签：qq/163/126/icloud）：" + ctx.env.PUBLIC_BASE_URL + "/vault" };
    try {
      const mails = await imapList(box.imap, a.search ? String(a.search) : "", Number(a.max ?? 8), folder);
      return { ok: true, data: { provider: box.provider, account: box.email.replace(/^(.).*@/, "$1***@"), folder, mails } };
    } catch (e) {
      return { ok: false, error: `IMAP 失败：${e}` };
    }
  },
};

// DEFECT-024: count-only mail tool. The implementation path issues SELECT +
// SEARCH only — no FETCH of headers or bodies can happen, so a "how many
// emails" question can never leak message content.
export const TOOL_mail_count: Tool = {
  name: "mail_count",
  effect: "read",
  scheduledAllowed: true,
  description: "统计邮箱某个文件夹里匹配条件的邮件数量，只返回数字（folder+count），绝不返回任何邮件内容。'我有多少封未读/邮件'、'数一下'这类计数问题必须用这个，不要用 mail_list 更不要用 mail_read。",
  parameters: obj({ search: { type: "string", description: "IMAP 检索：UNSEEN / FROM xxx / SINCE 7-Sep-2026，留空=全部" }, folder: { type: "string", description: "邮箱文件夹，默认 INBOX（如 Archive；非法名会被拒绝）" }, provider: { type: "string", description: "qq/163/126/icloud，留空自动" }, account: { type: "string", description: "可选。要使用的邮箱账号（hosted 多邮箱时精确选择）" } }),
  run: async (ctx, a) => {
    const folder = a.folder ? String(a.folder) : "INBOX";
    const search = a.search ? String(a.search) : "";
    const executor = (ctx.env as any).IMAP;
    if (executor) {
      const account = await resolveExecutorMailboxAccount(ctx.env, ctx.workspaceId, a.account);
      if (!account) return { ok: false, error: "没有已连接的邮箱。引导用户在控制台 设置 → 邮箱 连接（QQ/163/126/iCloud 授权码）。" };
      const r = await executorCountMail(ctx.env, ctx.workspaceId, account, search, folder);
      if (!r.ok) return { ok: false, error: `IMAP 失败：${r.error}` };
      return { ok: true, data: { account: account.replace(/^(.).*@/, "$1***@"), folder: r.folder ?? folder, count: r.count ?? 0 } };
    }
    const box = await resolveMailbox(ctx.env, ctx.workspaceId, a.provider ? String(a.provider) : undefined);
    if (!box) return { ok: false, error: "没有可用的邮箱授权码。引导用户在控制台 Vault 添加（provider 标签：qq/163/126/icloud）：" + ctx.env.PUBLIC_BASE_URL + "/vault" };
    try {
      const r = await imapCount(box.imap, search, folder);
      return { ok: true, data: { provider: box.provider, account: box.email.replace(/^(.).*@/, "$1***@"), folder: r.folder, count: r.count } };
    } catch (e) {
      return { ok: false, error: `IMAP 失败：${e}` };
    }
  },
};

export const TOOL_mail_read: Tool = {
  name: "mail_read",
  effect: "read",
  scheduledAllowed: true,
  description: "读取一封 QQ/163 等邮箱邮件的完整正文。只允许在用户明确要求阅读某一封具体邮件的内容时使用。严禁把 mail_read 用于计数、列清单、按文件夹汇总、扫描或'看看有什么邮件'之类的任务——那些场景必须用 mail_count（纯数字）或 mail_list（仅头部）。优先用 mail_list 返回的 uid 稳定读取；seq 仅兼容旧调用。",
  parameters: obj({ seq: { type: "integer", description: "mail_list 返回的序号（兼容；推荐用 uid）" }, uid: { type: "integer", description: "mail_list 返回的 UID（稳定身份，推荐）" }, provider: { type: "string" }, account: { type: "string", description: "可选。要使用的邮箱账号（hosted 多邮箱时精确选择）" } }, []),
  run: async (ctx, a) => {
    const executor = (ctx.env as any).IMAP;
    const uid = typeof a.uid === "number" && Number.isFinite(a.uid) && (a.uid as number) > 0 ? Number(a.uid) : undefined;
    const seq = Number(a.seq);
    if (uid === undefined && !(Number.isFinite(seq) && seq > 0)) return { ok: false, error: "需要 uid 或 seq 之一" };
    if (executor) {
      const account = await resolveExecutorMailboxAccount(ctx.env, ctx.workspaceId, a.account);
      if (!account) return { ok: false, error: "没有已连接的邮箱" };
      try {
        const r = await executor.readMail({ workspaceId: ctx.workspaceId, account, seq, uid });
        if (!r.ok) return { ok: false, error: `IMAP 失败：${r.error}` };
        const m = r.mail as { from?: string } | null;
        return { ok: true, data: { ...(m ?? {}), from: (m?.from ?? "").replace(/^(.).*@/, "$1***@") } };
      } catch (e) {
        return { ok: false, error: `executor_rpc_failed: ${String(e).slice(0, 120)}` };
      }
    }
    const box = await resolveMailbox(ctx.env, ctx.workspaceId, a.provider ? String(a.provider) : undefined);
    if (!box) return { ok: false, error: "没有可用邮箱授权码" };
    try {
      const { imapGetByUid } = await import("../imap/imap");
      const m = uid !== undefined ? await imapGetByUid(box.imap, uid) : await imapGet(box.imap, seq);
      return m ? { ok: true, data: { ...m, from: m.from.replace(/^(.).*@/, "$1***@") } } : { ok: false, error: "读不到该邮件" };
    } catch (e) {
      return { ok: false, error: `IMAP 失败：${e}` };
    }
  },
};

export const TOOL_mail_draft: Tool = {
  name: "mail_draft",
  effect: "write",
  description: "在已连接邮箱（QQ/163/Gmail IMAP 等）的草稿箱建草稿（绝不发送）。用户想发邮件但没明确说'直接发'时用这个。草稿创建后经 provider 读回验证。",
  parameters: obj({ to: str("收件人邮箱"), subject: str("主题"), body: str("正文"), account: { type: "string", description: "可选。要使用的邮箱账号（hosted 多邮箱时精确选择）" } }, ["to", "subject", "body"]),
  run: async (ctx, a) => {
    const to = String(a.to).trim();
    const subject = String(a.subject);
    const body = String(a.body);
    if (!/^[^\s@<>,;:"']+@[^\s@<>,;:"'@]+\.[^\s@<>,;:"']+$/.test(to) || /[\r\n]/.test(to)) {
      const f = externalFailure("mailbox", "invalid_input", "（收件人邮箱格式不合法。）");
      return { ok: false, error: f.error.message, external: { ok: false, error: f.error, operation: "create" } };
    }
    const executor = (ctx.env as any).IMAP;
    if (executor) {
      const account = await resolveExecutorMailboxAccount(ctx.env, ctx.workspaceId, a.account);
      if (!account) return { ok: false, error: "没有已连接的邮箱。引导用户在控制台 设置 → 邮箱 连接。" };
      const payloadHash = await sha256Hex(JSON.stringify({ account, to, subject, body, operation: "draft" }));
      const requestId = `${ctx.taskId ?? "adhoc"}:${payloadHash.slice(0, 16)}`;
      let r: { ok: boolean; deduped?: boolean; uid?: number; folder?: string; to?: string; subject?: string; isDraft?: boolean; messageId?: string; verifiedAt?: number; error?: string; queueLine?: string };
      try {
        r = await executor.draftMail({ workspaceId: ctx.workspaceId, requestId, account, mail: { to, subject, body } });
      } catch (e) {
        return { ok: false, error: `executor_rpc_failed: ${String(e).slice(0, 120)}` };
      }
      if (r.ok) {
        const draftMeta: Record<string, string | number | boolean | null> = { transport: "imap_append", deduped: !!r.deduped };
        const verifiedAt = r.verifiedAt ?? Date.now();
        // DEFECT-027-support: make draft creation visible in task evidence.
        if (ctx.taskId) {
          addEvidence(ctx.env, ctx.taskId, "mail_draft_created", `${r.folder ?? "Drafts"}/${r.uid ?? "?"} ${subject.slice(0, 80)}`);
        }
        return {
          ok: true,
          data: { draftUid: r.uid, folder: r.folder, deduped: !!r.deduped, status: "草稿已建，未发送（已读回验证）" },
          external: {
            ok: true,
            evidence: { provider: "mailbox", account, externalId: `${r.folder ?? "Drafts"}:uid=${r.uid}`, fetchedAt: Date.now(), verifiedAt, resourceType: "draft", metadata: draftMeta },
            operation: "create",
          },
        };
      }
      return { ok: false, error: `草稿创建失败：${r.error}` };
    }
    const targetAccount = a.account ? String(a.account).replace(/[\r\n]/g, "").trim().toLowerCase() : undefined;
    const box = await resolveMailbox(ctx.env, ctx.workspaceId, targetAccount);
    if (!box) {
      if (targetAccount) return { ok: false, error: `account_not_found: 未找到指定邮箱账号 "${targetAccount}"` };
      return { ok: false, error: "没有可用邮箱授权码。引导用户在控制台 Vault 添加：" + ctx.env.PUBLIC_BASE_URL + "/vault" };
    }
    try {
      const r = await imapAppendDraft(box.imap, { from: box.email, to, subject, body });
      if (!r.ok || !r.isDraft) return { ok: false, error: `草稿创建或读回验证失败：${r.error ?? "state_missing"}` };
      const verifiedAt = r.verifiedAt ?? Date.now();
      // DEFECT-027-support: make draft creation visible in task evidence.
      if (ctx.taskId) {
        addEvidence(ctx.env, ctx.taskId, "mail_draft_created", `${r.folder ?? "Drafts"}/${r.uid ?? "?"} ${subject.slice(0, 80)}`);
      }
      return {
        ok: true,
        data: { draftUid: r.uid, folder: r.folder, status: "草稿已建，未发送（已读回验证）" },
        external: {
          ok: true,
          evidence: { provider: "mailbox", account: box.email, externalId: `${r.folder ?? "Drafts"}:uid=${r.uid}`, fetchedAt: Date.now(), verifiedAt, resourceType: "draft", metadata: { transport: "imap_append" } },
          operation: "create",
        },
      };
    } catch (e) {
      return { ok: false, error: `IMAP 失败：${String(e).slice(0, 120)}` };
    }
  },
};

export const TOOL_mail_send: Tool = {
  name: "mail_send",
  effect: "external_send",
  description: "用 QQ/163 等邮箱发邮件（SMTP）。【对外发送，必须走审批】",
  parameters: obj({ to: str("收件人"), subject: str("主题"), body: str("正文"), provider: { type: "string" }, account: { type: "string", description: "可选。发件邮箱账号（hosted 多邮箱时精确选择）" } }, ["to", "subject", "body"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const to = String(a.to);
    const subject = String(a.subject);
    const body = String(a.body);
    const executor = (ctx.env as any).IMAP;
    if (executor) {
      const account = await resolveExecutorMailboxAccount(ctx.env, ctx.workspaceId, a.account);
      if (!account) return { ok: false, error: "没有已连接的邮箱" };
      const payloadHash = await sha256Hex(JSON.stringify({ account, to, subject, body, from: account, operation: "send" }));
      const requestId = `${ctx.taskId ?? "adhoc"}:${payloadHash.slice(0, 16)}`;
      let r: { ok: boolean; deduped?: boolean; error?: string; deliveryUnknown?: boolean; queueLine?: string };
      try {
        r = await executor.send({ workspaceId: ctx.workspaceId, requestId, account, mail: { to, subject, body } });
      } catch (e) {
        return { ok: false, error: `executor_rpc_failed: ${String(e).slice(0, 120)}` };
      }
      const smtpMeta: Record<string, string | number | boolean | null> = { transport: "smtp", deduped: !!r.deduped };
      if (r.ok) {
        if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "mail_sent_to", to);
        const smtpMeta: Record<string, string | number | boolean | null> = { transport: "smtp", deduped: !!r.deduped };
        if (r.queueLine) smtpMeta.queue_line = r.queueLine;
        return {
          ok: true, data: { sent: true, deduped: !!r.deduped, from: account.replace(/^(.).*@/, "$1***@"), to, queueLine: r.queueLine },
          external: {
            ok: true,
            evidence: { provider: "mailbox", account, externalId: requestId, fetchedAt: Date.now(), resourceType: "message", metadata: smtpMeta },
            operation: "send",
          },
        };
      }
      if (r.deliveryUnknown) {
        const f = externalFailure("mailbox", "unknown_delivery_state", "投递状态未知（连接在确认前中断）。绝不自动重发；如需重发请重新发起并再次审批。", { retryable: false });
        return { ok: false, error: f.error.message, external: { ok: false, error: f.error, operation: "send" } };
      }
      return { ok: false, error: r.error };
    }
    const targetAccount = a.account ? String(a.account).replace(/[\r\n]/g, "").trim().toLowerCase() : (a.provider ? String(a.provider) : undefined);
    const box = await resolveMailbox(ctx.env, ctx.workspaceId, targetAccount);
    if (!box) {
      if (targetAccount) return { ok: false, error: `account_not_found: 未找到指定邮箱账号 "${targetAccount}"` };
      return { ok: false, error: "没有可用邮箱授权码" };
    }

    const { smtpIdempotencyBegin, smtpIdempotencyFinish, sha256Hex: sha } = await import("../imap/executor");
    const payloadHash = await sha(JSON.stringify({ account: box.email, to, subject, body, from: box.email, operation: "send" }));
    const requestId = `${ctx.taskId ?? "adhoc"}:${payloadHash.slice(0, 16)}`;
    const gate = await smtpIdempotencyBegin(ctx.env.DB, requestId, ctx.workspaceId, payloadHash);
    if (!gate.ok) {
      if (gate.deduped) {
        const dedupeMeta: Record<string, string | number | boolean | null> = { transport: "smtp", deduped: true };
        return { ok: true, data: { sent: true, deduped: true, from: box.email.replace(/^(.).*@/, "$1***@"), to }, external: { ok: true, evidence: { provider: "mailbox", account: box.email, externalId: requestId, fetchedAt: Date.now(), resourceType: "message", metadata: dedupeMeta }, operation: "send" } };
      }
      return { ok: false, error: gate.error === "delivery_status_unknown_do_not_auto_retry" ? "投递状态未知，绝不自动重发；如需重发请重新发起并再次审批。" : gate.error };
    }
    const r = await smtpSend(box.smtp, { from: box.email, to, subject, body });
    if (r.phase === "sent") {
      await smtpIdempotencyFinish(ctx.env.DB, requestId, "sent");
      if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "mail_sent_to", to);
      const sentMeta: Record<string, string | number | boolean | null> = { transport: "smtp" };
      return { ok: true, data: { sent: true, from: box.email.replace(/^(.).*@/, "$1***@"), to }, external: { ok: true, evidence: { provider: "mailbox", account: box.email, externalId: requestId, fetchedAt: Date.now(), resourceType: "message", metadata: sentMeta }, operation: "send" } };
    }
    if (r.phase === "pre_send") {
      await smtpIdempotencyFinish(ctx.env.DB, requestId, "failed_pre_send", r.error);
      return { ok: false, error: r.error };
    }
    await smtpIdempotencyFinish(ctx.env.DB, requestId, "unknown", r.error);
    const unknown = externalFailure("mailbox", "unknown_delivery_state", "投递状态未知（连接在确认前中断）。绝不自动重发；如需重发请重新发起并再次审批。", { retryable: false });
    return { ok: false, error: unknown.error.message, external: { ok: false, error: unknown.error, operation: "send" } };
  },
};

// ── Files / workspace artifacts (DEFECT-021) ──

// Writes a text artifact into the workspace's Files collection (source
// "generated") via the artifact service: initUpload → putContent →
// completeUpload. Failures return a specific, actionable reason — never a
// bare failure — because the user-visible Files UI advertises this collection.
export const TOOL_files_create_text: Tool = {
  name: "files_create_text",
  effect: "write",
  scheduledAllowed: false,
  description: "把一段文本保存为工作区『文件 → Agent 生成』集合里的文件（如总结 report.md、清单 items.txt）。成功后文件会出现在用户的文件列表中。需要给用户留下可下载产物时用这个；不要用它替代聊天回复。",
  parameters: obj({ filename: str("文件名（含扩展名，如 summary.md / 数据.txt；仅中英文、数字、点、横线、下划线、空格、括号）"), content: str("文件全文内容"), overwrite: { type: "boolean", description: "同名文件已存在时是否仍生成新版本（默认 false：同名时拒绝并提示）" } }, ["filename", "content"]),
  run: async (ctx, a) => {
    const filename = String(a.filename ?? "").trim();
    const content = String(a.content ?? "");
    const overwrite = a.overwrite === true;
    if (!filename) return { ok: false, error: "（filename 不能为空。请给出带扩展名的文件名，例如 summary.md。）" };
    if (!envSupportsArtifacts(ctx.env)) {
      return { ok: false, error: "（当前部署未绑定工件存储（缺少 DB 或 ARTIFACTS 存储桶），无法生成文件。请在控制台检查部署配置后再试。）" };
    }
    try {
      const existing = await listArtifacts(ctx.env, ctx.workspaceId, { limit: 200 });
      const duplicate = existing.find((row) => row.filename === filename);
      if (duplicate && !overwrite) {
        return { ok: false, error: `（工作区里已有同名文件 "${filename}"。如需另存新版本，请带 overwrite: true 重新调用，或换一个文件名。）` };
      }
      const init = await initUpload(ctx.env, {
        workspaceId: ctx.workspaceId,
        filename,
        taskId: ctx.taskId,
        mimeType: "text/plain; charset=utf-8",
        source: "generated",
      });
      if (!init.ok) {
        return { ok: false, error: init.error === "filename_invalid"
          ? "（文件名不合法：只能包含中英文、数字、点、横线、下划线、空格和括号，长度 1–180，且不能含路径分隔符。）"
          : `（文件创建失败：${init.error}）` };
      }
      const artifactId = init.artifact.id;
      const bytes = new TextEncoder().encode(content);
      const put = await putContent(ctx.env, {
        workspaceId: ctx.workspaceId,
        artifactId,
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        contentType: "text/plain; charset=utf-8",
      });
      if (!put.ok) {
        const reason = put.error === "file_too_large"
          ? "（内容超过单文件 50MB 上限，无法生成。请拆分成多个文件或缩小内容。）"
          : put.error === "not_found"
            ? "（工件记录丢失，生成失败。请重试一次。）"
            : `（写入文件内容失败：${put.error}）`;
        return { ok: false, error: reason };
      }
      const done = await completeUpload(ctx.env, { workspaceId: ctx.workspaceId, artifactId });
      if (!done.ok) {
        return { ok: false, error: `（文件写入完成但确认失败：${done.error}。文件可能仍显示为处理中，请重试。）` };
      }
      const storedBytes = done.artifact.size_bytes ?? bytes.byteLength;
      if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "artifact_created", `${artifactId} ${filename}`);
      return { ok: true, data: { artifactId, filename, bytes: storedBytes, collection: "generated" } };
    } catch (e) {
      return { ok: false, error: `（生成文件失败：${String(e).slice(0, 160)}。请重试或改用更简单的文件名。）` };
    }
  },
};

function envSupportsArtifacts(env: any): boolean {
  return !!env?.DB && !!env?.ARTIFACTS;
}

// ── GitHub ──


async function githubTool<T>(
  ctx: ToolContext,
  effect: string,
  toolName: string,
  fn: (token: string, accountLabel: string) => Promise<T>,
): Promise<ToolResult> {
  const r = await withConnectorCall(ctx.env, { workspaceId: ctx.workspaceId, provider: "github", taskId: ctx.taskId }, effect, toolName, fn);
  if (!r.ok) return connectorFail("github", r);
  return { ok: true, data: r.data, external: externalOk(r, effect) };
}

export const TOOL_github_repos: Tool = {
  name: "github_repos",
  effect: "read",
  scheduledAllowed: true,
  description: "列出我的 GitHub 仓库（按最近更新）。",
  parameters: obj({ max: { type: "integer" } }),
  run: async (ctx, a) => githubTool(ctx, "read", "github_repos", (token) => githubListRepos(token, Number(a.max ?? 8))),
};

export const TOOL_github_search_issues: Tool = {
  name: "github_search_issues",
  effect: "read",
  scheduledAllowed: true,
  description: "搜索 GitHub issues/PRs。语法：repo:x/y is:open label:bug 等。",
  parameters: obj({ query: str("检索式") }, ["query"]),
  run: async (ctx, a) => githubTool(ctx, "read", "github_search_issues", (token) => githubSearchIssues(token, String(a.query))),
};

export const TOOL_github_create_issue: Tool = {
  name: "github_create_issue",
  effect: "external_send",
  description: "在 GitHub 仓库建 issue。【对外创建，必须走审批】",
  parameters: obj({ repo: str("owner/name"), title: str("标题"), body: { type: "string", description: "正文" } }, ["repo", "title"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const r = await githubTool(ctx, "external_send", "github_create_issue", (token) => githubCreateIssue(token, String(a.repo), String(a.title), String(a.body ?? "")));
    if (!r.ok) return r;
    if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "github_issue_url", String((r.data as any).url ?? `${a.repo}#${(r.data as any).number ?? ""}`));
    const issueNumber = Number((r.data as any).number);
    return {
      ...r,
      external: {
        ok: true,
        evidence: { provider: "github", externalId: Number.isFinite(issueNumber) ? `${a.repo}#${issueNumber}` : String((r.data as any).url ?? ""), externalUrl: (r.data as any).url ? String((r.data as any).url) : undefined, resourceType: "issue", fetchedAt: Date.now() },
        operation: "create",
      },
    };
  },
};

export const TOOL_github_comment: Tool = {
  name: "github_comment",
  effect: "external_send",
  description: "在 GitHub issue/PR 上评论。【对外发言，必须走审批】",
  parameters: obj({ repo: str("owner/name"), number: { type: "integer", description: "issue 编号" }, body: str("评论") }, ["repo", "number", "body"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const r = await githubTool(ctx, "external_send", "github_comment", (token) => githubCommentIssue(token, String(a.repo), Number(a.number), String(a.body)));
    if (!r.ok) return r;
    if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "github_comment", `${a.repo}#${a.number}`);
    return {
      ...r,
      external: {
        ok: true,
        evidence: { provider: "github", externalId: `${a.repo}#${a.number}`, externalUrl: (r.data as any)?.url ? String((r.data as any).url) : undefined, resourceType: "comment", fetchedAt: Date.now() },
        operation: "create",
      },
    };
  },
};



export const TOOL_browser_task: Tool = {
  name: "browser_task",
  effect: "destructive",
  description: "开云浏览器执行网页任务。公开可读的网页必须先用 web_fetch/web_search，拿得到内容就不要用本工具。仅在用户明确要求用浏览器、需要登录态、需要点击/填表/下单等交互，或 web_fetch 因需要渲染/被拦截/内容为空而失败时使用。启动后系统会自动给用户发观看/接管卡片。已有邮箱（mail_search/mail_draft）、日历（calendar_list）、代码连接器的任务必须优先用连接器；Browser 只用于没有连接器且确实需要网页交互的任务。委派时必须说清：站点、目标、成功标准、哪一步要用户确认。terminal：结果或'需要用户输入'会直接回给用户。",
  parameters: obj(
    {
      goal: str("完整任务简报"),
      startUrl: str("起始 URL"),
      vaultHints: { type: "array", items: { type: "string" }, description: "可能用到的 Vault candidateId" },
    },
    ["goal", "startUrl"],
  ),
  terminal: true,
  run: async () => ({ ok: false, error: "internal_reroute" }),
};



export const TOOL_task_mark_pending: Tool = {
  name: "task_mark_pending",
  effect: "local",
  description: "当一项多步任务没有完全做完、当前在等待用户做出决定、挑选方案（如几选一）或补充关键信息时调用。系统会在约 18 小时后（按用户作息自动避开夜间）主动跟进进度。",
  parameters: obj(
    {
      goal: str("任务目标或正在推进的事项，如'帮用户预定去上海的机票，已给出3个航班'"),
      waiting_on: str("当前在等待用户的具体内容，如'等待用户挑选合适航班'或'等待用户确认邮件草稿'"),
    },
    ["goal", "waiting_on"],
  ),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_schedule_reminder: Tool = {
  name: "schedule_reminder",
  effect: "local",
  description: "安排一次主动跟进（到点 agent 会主动发消息）。例：'3 天后提醒我确认报销'、'明天早上问我那封邮件有没有回'。",
  parameters: obj(
    {
      when: str("ISO 时间或相对描述，如 2026-09-10T09:00:00+08:00 / in_3_days"),
      message: str("到时要发给用户的内容/要做的事"),
    },
    ["when", "message"],
  ),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_schedule_create: Tool = {
  name: "schedule_create",
  effect: "local",
  description: "创建高级定时任务或时区自然日历循环计划。支持单次（once）、固定间隔（interval）、自然日历（calendar，如工作日每天 09:00、每周三 18:00，自动纠正夏令时）。到点 agent 会自动执行 prompt 并主动汇报结果。",
  parameters: obj(
    {
      prompt: str("到时要执行的任务或汇报指令，如 '整理未读邮件并汇报' 或 '提醒我交水电费'"),
      timingKind: { type: "string", enum: ["once", "interval", "calendar"], description: "调度类型" },
      at: { type: "string", description: "once 类型时的执行时间，ISO 格式或自然日期如 2026-09-10T09:00:00+08:00" },
      everyMinutes: { type: "integer", description: "interval 类型时的循环分钟数，如 60（每小时）" },
      frequency: { type: "string", enum: ["daily", "weekdays", "weekly"], description: "calendar 类型时的循环频次" },
      localTime: { type: "string", description: "calendar 类型时的本地时间，HH:MM 格式，如 '09:00'" },
      timezone: { type: "string", description: "IANA 时区，如 'Asia/Shanghai'、'America/New_York'，默认用户本地时区或 Asia/Shanghai" },
      weekday: { type: "integer", description: "weekly 循环时的星期几（0 为周日，1 为周一，...，6 为周六）" },
      missedRunPolicy: { type: "string", enum: ["run_latest", "catch_up"], description: "离线漏跑处理策略：run_latest 只补跑最新一次，catch_up 补齐全量，默认 run_latest" },
    },
    ["prompt", "timingKind"],
  ),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_schedule_list: Tool = {
  name: "schedule_list",
  effect: "local",
  description: "列出当前已安排的所有定时任务、巡检与周期计划。",
  parameters: obj({}),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_schedule_delete: Tool = {
  name: "schedule_delete",
  effect: "destructive",
  description: "取消或删除一个定时任务计划。",
  parameters: obj({ scheduleId: str("要取消的 scheduleId") }, ["scheduleId"]),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};

export const TOOL_react_to_message: Tool = {
  name: "react_to_message",
  effect: "local",
  description: "给当前用户的上一条消息添加或移除表情反应（Tapback）。类型支持：thumbs_up(👍)、thumbs_down(👎)、heart(❤️)、laugh(😂)、exclamation(🔥)、question(🤔)。用于轻量表达确认、喜欢或疑惑。",
  parameters: obj(
    {
      type: {
        type: "string",
        enum: ["thumbs_up", "thumbs_down", "heart", "laugh", "exclamation", "question"],
        description: "表情类型",
      },
      operation: { type: "string", enum: ["add", "remove"], description: "添加还是移除，默认 add" },
      messageId: { type: "string", description: "指定消息 ID（可选，默认对当前接收的消息反应）" },
    },
    ["type"],
  ),
  run: async (ctx, a) => {
    const targetMsgId = String(a.messageId || ctx.channelMessageId || "");
    if (!targetMsgId) return { ok: true, data: "（当前上下文无对应消息 ID，已忽略反应）" };
    const r = await sendReaction(
      ctx.env,
      ctx.channel as any,
      ctx.channelExternalId || ctx.userId,
      targetMsgId,
      String(a.type),
      (a.operation as "add" | "remove") || "add",
    );
    return r.ok ? { ok: true, data: `已标记 ${a.type}` } : { ok: false, error: r.error };
  },
};



const num = (desc: string) => ({ type: "number", description: desc });

export const TOOL_where_am_i: Tool = {
  name: "where_am_i",
  effect: "read",
  scheduledAllowed: true,
  description: "查用户最新位置（来自 Telegram 实时共享或控制台一键共享），返回坐标和地名。没有位置数据时提示怎么共享。",
  parameters: obj({}),
  run: async (ctx) => {
    const p = await lastKnown(ctx.env, ctx.workspaceId);
    if (!p) return { ok: true, data: "（还没有位置数据。用户可在 Telegram 发送/共享实时位置，或在控制台 Workspace 页点「共享位置」）" };
    const stale = Date.now() - p.created_at > 2 * 3600_000;
    const place = await reverseGeocode(p.lat, p.lng).catch(() => "");
    return {
      ok: true,
      data: {
        lat: p.lat, lng: p.lng,
        source: p.source, live: p.live === 1,
        ageMinutes: Math.round((Date.now() - p.created_at) / 60_000),
        stale: stale || undefined,
        place,
      },
    };
  },
};

export const TOOL_location_history: Tool = {
  name: "location_history",
  effect: "read",
  scheduledAllowed: true,
  description: "查位置历史与造访记录（聚类为'在某处待了多久'）。回答'我的车停哪了/我上个月去过哪家咖啡店/我骑车骑了多久'这类问题。",
  parameters: obj(
    {
      hours: { type: "integer", description: "回看小时数，默认 24，最大 720（30 天）" },
      filter: { type: "string", description: "可选：只看含此关键词的已存地点（如 '家'）" },
    },
  ),
  run: async (ctx, a) => {
    const hours = Math.min(Math.max(Number(a.hours ?? 24), 1), 720);
    const points = await recentPoints(ctx.env, ctx.workspaceId, Date.now() - hours * 3600_000);
    if (points.length === 0) return { ok: true, data: `（最近 ${hours} 小时没有位置记录）` };
    const visits = await labelVisits(ctx.env, ctx.workspaceId, computeVisits(points));
    const filtered = a.filter ? visits.filter((v) => (v.label ?? "").includes(String(a.filter))) : visits;
    return {
      ok: true,
      data: {
        pointsCount: points.length,
        firstAt: new Date(points[0].created_at).toISOString(),
        lastAt: new Date(points[points.length - 1].created_at).toISOString(),
        visits: filtered.map((v) => ({ place: v.label ?? `${v.lat.toFixed(5)},${v.lng.toFixed(5)}`, arrived: new Date(v.arrivedAt).toLocaleString("zh-CN"), minutes: v.minutes })),
      },
    };
  },
};

export const TOOL_save_place: Tool = {
  name: "save_place",
  effect: "local",
  description: "把一个坐标存成命名地点（'家'/'公司'），作为围栏触发和历史问答的锚点。可用最新位置或用户给的坐标。",
  parameters: obj(
    { label: str("地点名，如 家"), lat: num("纬度（不填=用最新位置）"), lng: num("经度"), radiusM: num("半径米数，默认 150") },
    ["label"],
  ),
  run: async (ctx, a) => {
    let lat = Number(a.lat), lng = Number(a.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      const p = await lastKnown(ctx.env, ctx.workspaceId);
      if (!p) return { ok: false, error: "没有坐标也没有位置历史。先让用户共享一次位置，或让用户给坐标。" };
      lat = p.lat; lng = p.lng;
    }
    const place = await savePlace(ctx.env, ctx.workspaceId, String(a.label), lat, lng, Number(a.radiusM ?? 150));
    return { ok: true, data: { label: place.label, lat: place.lat, lng: place.lng, radiusM: place.radius_m } };
  },
};

export const TOOL_list_places: Tool = {
  name: "list_places",
  effect: "local",
  description: "列出已存地点。",
  parameters: obj({}),
  run: async (ctx) => {
    const places = await listPlaces(ctx.env, ctx.workspaceId);
    return { ok: true, data: places.length ? places : "（还没有存地点。可以用 save_place 存）" };
  },
};

export const TOOL_set_location_trigger: Tool = {
  name: "set_location_trigger",
  effect: "local",
  description: "设围栏触发器：进入/离开某地时，主动向用户发一条消息。例：'到家提醒我拿快递'、'到机场告诉我值机柜台'。已存地点用 placeLabel，否则给坐标。",
  parameters: obj(
    {
      label: str("触发器名，如 到家拿快递"),
      kind: str("enter（进入时）或 leave（离开时）"),
      placeLabel: { type: "string", description: "已存地点名（与 lat/lng 二选一）" },
      lat: num("纬度"), lng: num("经度"), radiusM: num("半径米，默认 150"),
      message: str("触发时要发给用户的话（可以结合用户偏好写得贴心些）"),
    },
    ["label", "kind", "message"],
  ),
  run: async (ctx, a) => {
    if (!ctx.channelExternalId) return { ok: false, error: "no_channel_route（请在聊天里设置围栏触发器，控制台无法确定发送目标）" };
    const kind = String(a.kind) === "leave" ? "leave" : "enter";
    const r = await createTrigger(ctx.env, ctx.workspaceId, {
      label: String(a.label), kind,
      placeLabel: a.placeLabel ? String(a.placeLabel) : undefined,
      lat: a.lat != null ? Number(a.lat) : undefined,
      lng: a.lng != null ? Number(a.lng) : undefined,
      radiusM: a.radiusM != null ? Number(a.radiusM) : undefined,
      message: String(a.message),
      channel: ctx.channel,
      externalId: ctx.channelExternalId ?? "",
      contextToken: ctx.channelContextToken,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, data: { id: r.id, note: "进入/离开对应范围时会主动发消息给用户（30 分钟冷却）" } };
  },
};

export const TOOL_list_location_triggers: Tool = {
  name: "list_location_triggers",
  effect: "local",
  description: "列出围栏触发器。",
  parameters: obj({}),
  run: async (ctx) => {
    const t = await listTriggers(ctx.env, ctx.workspaceId);
    return {
      ok: true,
      data: t.length
        ? t.map((x) => ({ id: x.id, label: x.label, kind: x.kind, target: x.placeLabel ?? `${x.lat},${x.lng}`, message: x.message, enabled: !!x.enabled }))
        : "（没有触发器）",
    };
  },
};

export const TOOL_delete_location_trigger: Tool = {
  name: "delete_location_trigger",
  effect: "destructive",
  description: "删除一个围栏触发器（用户明确要求取消时用）。",
  parameters: obj({ idOrLabel: str("触发器 id 或名字") }, ["idOrLabel"]),
  run: async (ctx, a) => {
    const ok = await deleteTrigger(ctx.env, ctx.workspaceId, String(a.idOrLabel));
    return { ok, error: ok ? undefined : "没有找到这个触发器" };
  },
};

export const TOOL_nearby_search: Tool = {
  name: "nearby_search",
  effect: "read",
  scheduledAllowed: true,
  description: "搜附近的设施（OpenStreetMap）。amenity 例：restaurant / cafe / supermarket / pharmacy / atm / fuel / charging_station。默认以用户最新位置为中心。",
  parameters: obj(
    {
      amenity: str("设施类型"),
      lat: num("纬度（不填=最新位置）"), lng: num("经度"),
      radiusM: num("搜索半径米，默认 1000"),
    },
    ["amenity"],
  ),
  run: async (ctx, a) => {
    let lat = Number(a.lat), lng = Number(a.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      const p = await lastKnown(ctx.env, ctx.workspaceId);
      if (!p) return { ok: false, error: "没有位置数据也无法给坐标。先让用户共享位置。" };
      lat = p.lat; lng = p.lng;
    }
    const r = await nearbySearch(lat, lng, String(a.amenity), Number(a.radiusM ?? 1000));
    return { ok: true, data: r.length ? r : "（没搜到，试试换 amenity 关键词或加大半径）" };
  },
};

export const TOOL_geocode: Tool = {
  name: "geocode",
  effect: "read",
  scheduledAllowed: true,
  description: "地名 ↔ 坐标。query 给地名返回坐标；lat/lng 给坐标返回地名。",
  parameters: obj({ query: { type: "string", description: "地名（与 lat/lng 二选一）" }, lat: num("纬度"), lng: num("经度") }),
  run: async (_ctx, a) => {
    if (a.lat != null && a.lng != null) {
      const name = await reverseGeocode(Number(a.lat), Number(a.lng)).catch(() => null);
      return name ? { ok: true, data: { name } } : { ok: false, error: "反查失败" };
    }
    if (a.query) {
      const r = await geocode(String(a.query)).catch(() => []);
      return { ok: true, data: r.length ? r : "（没找到）" };
    }
    return { ok: false, error: "需要 query 或 lat/lng" };
  },
};

// ── Linear ──

export const TOOL_linear_issues: Tool = {
  name: "linear_issues",
  effect: "read",
  scheduledAllowed: true,
  description: "列出我的 Linear 工单（未完成优先）。filter 可按标题过滤。",
  parameters: obj({ filter: { type: "string" }, includeDone: { type: "boolean", description: "包含已完成，默认否" }, max: { type: "integer" } }),
  run: async (ctx, a) => {
    try {
      return { ok: true, data: await linearIssues(ctx.env, ctx.workspaceId, { filter: a.filter ? String(a.filter) : undefined, includeDone: !!a.includeDone, max: Number(a.max ?? 10) }) };
    } catch (e) {
      return { ok: false, error: String(e).includes("not_connected") ? "（Linear 未连接。让用户在控制台 Workspace 页粘贴 Personal API Key）" : `Linear 出错：${e}` };
    }
  },
};

export const TOOL_linear_create_issue: Tool = {
  name: "linear_create_issue",
  effect: "local",
  description: "在 Linear 建 issue。【对外创建，必须走审批】teamKey 是团队代号（如 ENG）。",
  parameters: obj({ teamKey: str("团队 key，如 ENG"), title: str("标题"), description: { type: "string" } }, ["teamKey", "title"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const r = await linearCreateIssue(ctx.env, ctx.workspaceId, { teamKey: String(a.teamKey), title: String(a.title), description: a.description ? String(a.description) : undefined });
    if ("error" in r) return { ok: false, error: r.error };
    if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "linear_issue", r.identifier);
    return { ok: true, data: r };
  },
};

// ── Slack ──

export const TOOL_slack_search: Tool = {
  name: "slack_search",
  effect: "read",
  scheduledAllowed: true,
  description: "搜索 Slack 工作区里的消息（需要 User Token）。",
  parameters: obj({ query: str("搜索词，支持 from: in: 修饰"), max: { type: "integer" } }, ["query"]),
  run: async (ctx, a) => {
    try {
      return { ok: true, data: await slackSearch(ctx.env, ctx.workspaceId, String(a.query), Number(a.max ?? 8)) };
    } catch (e) {
      return { ok: false, error: String(e).includes("not_connected") ? "（Slack 未连接。让用户在控制台 Workspace 页粘贴 User Token，scope 需含 search:read）" : `Slack 出错：${e}` };
    }
  },
};

export const TOOL_slack_post: Tool = {
  name: "slack_post",
  effect: "external_send",
  description: "在 Slack 频道/会话发消息。【对外发言，必须走审批】channel 用 #名字 或 ID。",
  parameters: obj({ channel: str("如 #general 或 C1234"), text: str("内容"), threadTs: { type: "string", description: "串消息 ts（回复主题时）" } }, ["channel", "text"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const r = await slackPost(ctx.env, ctx.workspaceId, String(a.channel), String(a.text), a.threadTs ? String(a.threadTs) : undefined);
    if ("error" in r) return { ok: false, error: r.error };
    if (ctx.taskId) addEvidence(ctx.env, ctx.taskId, "slack_posted", r.channel);
    return { ok: true, data: r };
  },
};



export const TOOL_get_quote: Tool = {
  name: "get_quote",
  effect: "read",
  scheduledAllowed: true,
  description: "获取全球多资产实时行情（A股、港股、美股、ETF、大宗商品黄金/白银/原油、外汇汇率、加密货币及股指）。支持输入股票代码、英文Ticker或中文名称。大宗商品/外汇/币/指数可指定asset_class以精准消歧（例如'白银'避免匹配到同名上市公司）。查实时价格优先用本工具，比普通网页搜索快数倍且数据权威。",
  parameters: obj({
    symbols: {
      type: "array",
      items: { type: "string" },
      description: "一个或多个标的名称或代码，如 [\"AAPL\"], [\"00700\"], [\"600519\"], [\"黄金\"], [\"白银\"], [\"BTC\"]",
    },
    asset_class: {
      type: "string",
      enum: ["equity", "commodity", "fx", "index", "crypto"],
      description: "可选资产类别：commodity(黄金/白银/原油), crypto(比特币/以太坊), fx(汇率USDCNH/USDJPY), index(标普/纳指/恒指), equity(股票/ETF)。",
    },
  }, ["symbols"]),
  run: async (ctx, a) => {
    const rawSymbols = Array.isArray(a.symbols) ? a.symbols.map(String) : [String(a.symbols || "")];
    const assetClass = a.asset_class ? String(a.asset_class) : undefined;
    const res = await getQuotes(rawSymbols, assetClass, ctx.env?.KV);
    if (!res.ok) {
      return { ok: false, error: res.error || "failed_to_fetch_quotes" };
    }
    return { ok: true, data: res.quotes };
  },
};

export const TOOL_get_kline: Tool = {
  name: "get_kline",
  effect: "read",
  scheduledAllowed: true,
  description: "获取分时或历史K线蜡烛图数据（A股、港股、美股、大宗商品、加密货币、主要股指）。period支持分时m1/m5/m15/m30/m60或长周期day/week/month。适合技术分析、均线趋势或日内量价分析。",
  parameters: obj({
    symbol: str("标的代码或名称，如 '600519', '00700', 'AAPL', 'BTC', '黄金'"),
    period: {
      type: "string",
      enum: ["m1", "m5", "m15", "m30", "m60", "day", "week", "month"],
      description: "K线周期，默认为 'day'",
    },
    limit: {
      type: "number",
      description: "获取K线根数，默认 30，上限 100",
    },
    asset_class: {
      type: "string",
      enum: ["equity", "commodity", "fx", "index", "crypto"],
      description: "资产类别（查商品/汇率/加密币/指数时选填）",
    },
  }, ["symbol"]),
  run: async (ctx, a) => {
    const symbol = String(a.symbol || "").trim();
    const period = a.period ? String(a.period) : "day";
    const limit = Math.min(Math.max(Number(a.limit || 30), 1), 100);
    const assetClass = a.asset_class ? String(a.asset_class) : undefined;
    const res = await getKline(symbol, period, limit, assetClass);
    if (!res.ok || !res.data) {
      return { ok: false, error: res.error || "failed_to_fetch_kline" };
    }
    return { ok: true, data: res.data };
  },
};

export const TOOL_get_stock_profile: Tool = {
  name: "get_stock_profile",
  effect: "read",
  scheduledAllowed: true,
  description: "获取上市公司财务与基本面全景画像（估值PE/PB/PEG、盈利ROE/毛利率/净利率、营收与利润同比增速、EPS、分析师评级与目标价）。覆盖A股、港股、美股。适合回答'这家公司业绩如何/估值高不高/分析师怎么看'。",
  parameters: obj({
    symbol: str("股票代码或名称，如 '600519', '00700', 'AAPL'"),
  }, ["symbol"]),
  run: async (ctx, a) => {
    const symbol = String(a.symbol || "").trim();
    const res = await getStockProfile(symbol);
    if (!res.ok || !res.data) {
      return { ok: false, error: res.error || "failed_to_fetch_profile" };
    }
    return { ok: true, data: res.data };
  },
};

export const TOOL_get_news: Tool = {
  name: "get_news",
  effect: "read",
  scheduledAllowed: true,
  description: "获取7x24宏观经济与证券实时快讯。支持按标的代码精准检索个股重大资讯，或按关键词检索宏观经济热点。所有新闻均经过严格时区标准化，权威精准。",
  parameters: obj({
    symbol: { type: "string", description: "可选：指定股票代码（如 'AAPL', '00700'）" },
    query: { type: "string", description: "可选：宏观或主题搜索词（如 '美联储', '降息', '关税'）" },
    limit: { type: "number", description: "条数上限，默认 6，上限 15" },
  }),
  run: async (ctx, a) => {
    const symbol = a.symbol ? String(a.symbol).trim() : undefined;
    const query = a.query ? String(a.query).trim() : undefined;
    const limit = Math.min(Math.max(Number(a.limit || 6), 1), 15);
    const res = await getNews({ symbol, query, limit });
    if (!res.ok) {
      return { ok: false, error: res.error || "no_news_available" };
    }
    return { ok: true, data: res.news };
  },
};


//



const KERNEL_MAIL_ALIASES = ["邮箱", "邮件", "email", "mail", "gmail", "收件箱", "inbox", "imap", "qq邮箱", "163邮箱"];
const KERNEL_CALENDAR_ALIASES = ["日历", "日程", "会议", "calendar", "日程安排", "空闲", "freebusy", "忙闲", "约会", "有没有会", "有没有空", "会议安排"];
const KERNEL_TODO_ALIASES = ["待办", "todo", "tasks", "任务清单", "提醒事项"];
const KERNEL_CONTACTS_ALIASES = ["联系人", "通讯录", "contacts", "contact", "电话", "邮箱地址"];
const KERNEL_AGENT_MAIL_ALIASES = ["agent邮箱", "agent email", "agent mail", "自己的邮箱"];
const KERNEL_TRUSTED_PEOPLE_ALIASES = ["信任", "受信任的人", "好友", "trusted", "trusted_people", "约时间", "找时间", "schedule"];
const KERNEL_CODE_ALIASES = ["代码", "源码", "项目", "仓库", "code", "repo", "repository", "github", "issue", "pr", "pull request", "commit", "提交", "ci", "构建", "build", "bug"];
const KERNEL_LOCATION_ALIASES = ["位置", "地点", "location", "导航", "附近", "经纬度", "地址", "围栏"];
const KERNEL_FINANCE_ALIASES = ["行情", "股价", "股票", "k线", "finance", "quote", "财报", "新闻资讯"];
const KERNEL_DOCUMENTS_ALIASES = ["文档", "doc", "docx", "云文档", "飞书文档", "lark doc"];
const KERNEL_SPREADSHEET_ALIASES = ["表格", "sheet", "sheets", "电子表格", "飞书表格", "lark sheets"];
const KERNEL_DATABASE_ALIASES = ["多维表格", "base", "bitable", "数据库", "记录", "lark base"];

export function buildKernelCatalogEntries(): ToolCatalogEntry[] {
  return [

    catalogEntry(TOOL_get_self_info, "core", { defaultVisible: true }),
    catalogEntry(TOOL_files_create_text, "files", { aliases: ["生成文件", "保存文件", "写文件", "创建文件", "artifact", "生成文档", "报告文件"], defaultVisible: true }),
    catalogEntry(TOOL_memory_save, "memory", { aliases: ["记忆", "记住", "偏好", "memory"], defaultVisible: true }),
    catalogEntry(TOOL_personal_info_update, "memory", { aliases: ["个人信息", "姓名", "时区", "profile"], defaultVisible: true }),
    catalogEntry(TOOL_web_search, "web", { aliases: ["搜索", "网页搜索", "search", "查资料"], defaultVisible: true }),
    catalogEntry(TOOL_web_fetch, "web", { aliases: ["抓取", "网页正文", "fetch", "打开链接"], defaultVisible: true }),
    catalogEntry(TOOL_vault_list, "vault", { aliases: ["vault", "密码", "密钥"], defaultVisible: true }),
    catalogEntry(TOOL_request_vault_setup, "vault", { aliases: ["vault设置"], defaultVisible: true }),
    catalogEntry(TOOL_request_vault_import, "vault", { aliases: ["vault导入", "导入密码"] }),
    catalogEntry(TOOL_browser_task, "browser", { aliases: ["浏览器", "browser", "网页操作", "登录"], defaultVisible: true }),
    catalogEntry(TOOL_task_mark_pending, "task", { aliases: ["待办", "跟进", "pending"], defaultVisible: true }),
    catalogEntry(TOOL_schedule_create, "schedule", { aliases: ["定时", "提醒", "计划任务", "schedule"], defaultVisible: true }),
    catalogEntry(TOOL_schedule_list, "schedule", { aliases: ["定时列表"], defaultVisible: true }),
    catalogEntry(TOOL_schedule_delete, "schedule", { aliases: ["取消定时"], defaultVisible: true }),
    catalogEntry(TOOL_react_to_message, "core", { aliases: ["表情", "反应", "react"], defaultVisible: true }),
    catalogEntry(TOOL_workstream_find, "workstream", { aliases: ["工作流", "项目记忆", "workstream"], defaultVisible: true }),
    catalogEntry(TOOL_workstream_read, "workstream", { defaultVisible: true }),
    catalogEntry(TOOL_workstream_save, "workstream", { defaultVisible: true }),
    catalogEntry(TOOL_workstream_forget, "workstream", { aliases: ["归档工作流"] }),
    catalogEntry(TOOL_task_update, "task", { aliases: ["进度", "汇报"], defaultVisible: true }),
    catalogEntry(TOOL_task_cancel, "task", { aliases: ["取消任务"], defaultVisible: true }),
    catalogEntry(TOOL_ask_question, "task", { aliases: ["提问", "确认", "澄清"], defaultVisible: true }),
    ...DOMAIN_FACADE_TOOLS.map((t) => catalogEntry(t, t.name as ToolNamespace, { defaultVisible: true })),



    ...AGENT_MAIL_TOOLS.map((t) => catalogEntry(t, "agent_mail" as ToolNamespace, { aliases: KERNEL_AGENT_MAIL_ALIASES })),
    ...TRUSTED_PEOPLE_TOOLS.map((t) => catalogEntry(t, "trusted_people" as ToolNamespace, { aliases: KERNEL_TRUSTED_PEOPLE_ALIASES })),
    catalogEntry(TOOL_gmail_search, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "搜索邮件"], providers: ["google", "mailbox"], hidden: true }),
    catalogEntry(TOOL_gmail_read, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "读邮件"], providers: ["google", "mailbox"], hidden: true }),
    catalogEntry(TOOL_gmail_draft, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "草稿"], providers: ["google", "mailbox"], hidden: true }),
    catalogEntry(TOOL_gmail_send, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "发邮件", "发送"], providers: ["google", "mailbox"], hidden: true }),
    catalogEntry(TOOL_gmail_thread, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "线程", "往来"], providers: ["google", "mailbox"], hidden: true }),
    catalogEntry(TOOL_gmail_update, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "归档", "标已读"], providers: ["google", "mailbox"], hidden: true }),
    catalogEntry(TOOL_contacts_search, "contacts", { aliases: KERNEL_CONTACTS_ALIASES, providers: ["google", "lark", "feishu"], hidden: true }),
    catalogEntry(TOOL_calendar_list, "calendar", { aliases: KERNEL_CALENDAR_ALIASES, providers: ["google", "lark", "feishu"], hidden: true }),
    catalogEntry(TOOL_calendar_create, "calendar", { aliases: [...KERNEL_CALENDAR_ALIASES, "建日程"], providers: ["google", "lark", "feishu"], hidden: true }),
    catalogEntry(TOOL_calendar_delete, "calendar", { aliases: [...KERNEL_CALENDAR_ALIASES, "删日程"], providers: ["google", "lark", "feishu"], hidden: true }),
    catalogEntry(TOOL_tasks_list, "todo", { aliases: KERNEL_TODO_ALIASES, providers: ["google", "lark", "feishu"], hidden: true }),
    catalogEntry(TOOL_tasks_add, "todo", { aliases: [...KERNEL_TODO_ALIASES, "新建待办"], providers: ["google", "lark", "feishu"], hidden: true }),
    catalogEntry(TOOL_feishu_mail_list, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "飞书邮箱", "feishu"], providers: ["feishu"], hidden: true }),
    catalogEntry(TOOL_feishu_mail_read, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "飞书"], providers: ["feishu"], hidden: true }),
    catalogEntry(TOOL_feishu_calendar_list, "calendar", { aliases: [...KERNEL_CALENDAR_ALIASES, "飞书"], providers: ["feishu"], hidden: true }),
    catalogEntry(TOOL_feishu_calendar_create, "calendar", { aliases: [...KERNEL_CALENDAR_ALIASES, "飞书"], providers: ["feishu"], hidden: true }),
    catalogEntry(TOOL_mail_list, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "qq", "163", "imap"], providers: ["mailbox"], hidden: true }),
    catalogEntry(TOOL_mail_count, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "统计", "多少封", "计数", "count"], providers: ["mailbox"], hidden: true }),
    catalogEntry(TOOL_mail_read, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "imap"], providers: ["mailbox"], hidden: true }),
    catalogEntry(TOOL_mail_draft, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "草稿"], providers: ["mailbox"], hidden: true }),
    catalogEntry(TOOL_mail_send, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "发送"], providers: ["mailbox"], hidden: true }),
    catalogEntry(TOOL_github_repos, "code", { aliases: KERNEL_CODE_ALIASES, providers: ["github"], hidden: true }),
    catalogEntry(TOOL_github_search_issues, "code", { aliases: KERNEL_CODE_ALIASES, providers: ["github"], hidden: true }),
    catalogEntry(TOOL_github_create_issue, "code", { aliases: [...KERNEL_CODE_ALIASES, "建issue"], providers: ["github"], hidden: true }),
    catalogEntry(TOOL_github_comment, "code", { aliases: [...KERNEL_CODE_ALIASES, "评论"], providers: ["github"], hidden: true }),
    catalogEntry(TOOL_linear_issues, "code", { aliases: ["linear", "工单"], providers: ["linear"] }),
    catalogEntry(TOOL_linear_create_issue, "code", { aliases: ["linear"], providers: ["linear"] }),
    catalogEntry(TOOL_slack_search, "messaging", { aliases: ["slack", "消息", "message"], providers: ["slack"] }),
    catalogEntry(TOOL_slack_post, "messaging", { aliases: ["slack"], providers: ["slack"] }),
    catalogEntry(TOOL_where_am_i, "location", { aliases: KERNEL_LOCATION_ALIASES }),
    catalogEntry(TOOL_location_history, "location", { aliases: KERNEL_LOCATION_ALIASES }),
    catalogEntry(TOOL_save_place, "location", { aliases: KERNEL_LOCATION_ALIASES }),
    catalogEntry(TOOL_list_places, "location", { aliases: KERNEL_LOCATION_ALIASES }),
    catalogEntry(TOOL_set_location_trigger, "location", { aliases: KERNEL_LOCATION_ALIASES }),
    catalogEntry(TOOL_list_location_triggers, "location", { aliases: KERNEL_LOCATION_ALIASES }),
    catalogEntry(TOOL_delete_location_trigger, "location", { aliases: KERNEL_LOCATION_ALIASES }),
    catalogEntry(TOOL_nearby_search, "location", { aliases: KERNEL_LOCATION_ALIASES }),
    catalogEntry(TOOL_geocode, "location", { aliases: KERNEL_LOCATION_ALIASES }),
    catalogEntry(TOOL_schedule_reminder, "schedule", { aliases: ["提醒", "跟进"] }),

    catalogEntry(TOOL_calendar_freebusy, "calendar", { aliases: [...KERNEL_CALENDAR_ALIASES, "忙闲", "有没有空"], providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_calendar_update, "calendar", { aliases: [...KERNEL_CALENDAR_ALIASES, "改日程"], providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_todo_list, "todo", { aliases: KERNEL_TODO_ALIASES, providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_todo_get, "todo", { aliases: KERNEL_TODO_ALIASES, providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_todo_create, "todo", { aliases: [...KERNEL_TODO_ALIASES, "新建"], providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_todo_update, "todo", { aliases: KERNEL_TODO_ALIASES, providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_todo_complete, "todo", { aliases: [...KERNEL_TODO_ALIASES, "完成"], providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_todo_delete, "todo", { aliases: [...KERNEL_TODO_ALIASES, "删除"], providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_contact_search, "contacts", { aliases: KERNEL_CONTACTS_ALIASES, providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_contact_get, "contacts", { aliases: KERNEL_CONTACTS_ALIASES, providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_contact_create, "contacts", { aliases: KERNEL_CONTACTS_ALIASES, providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_contact_update, "contacts", { aliases: KERNEL_CONTACTS_ALIASES, providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_contact_delete, "contacts", { aliases: KERNEL_CONTACTS_ALIASES, providers: ["google", "lark", "feishu"] }),
    catalogEntry(TOOL_mail_search, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "搜索"], providers: ["mailbox", "lark", "feishu"] }),
    catalogEntry(TOOL_mail_thread, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "线程"], providers: ["mailbox", "lark", "feishu"] }),
    catalogEntry(TOOL_mail_update, "mail", { aliases: [...KERNEL_MAIL_ALIASES, "状态"], providers: ["mailbox", "lark", "feishu"] }),
    catalogEntry(TOOL_code_repo_list, "code", { aliases: KERNEL_CODE_ALIASES, providers: ["github"] }),
    catalogEntry(TOOL_code_search, "code", { aliases: KERNEL_CODE_ALIASES, providers: ["github"] }),
    catalogEntry(TOOL_code_issue_read, "code", { aliases: KERNEL_CODE_ALIASES, providers: ["github"] }),
    catalogEntry(TOOL_code_issue_create, "code", { aliases: [...KERNEL_CODE_ALIASES, "建issue"], providers: ["github"] }),
    catalogEntry(TOOL_code_comment, "code", { aliases: [...KERNEL_CODE_ALIASES, "评论"], providers: ["github"] }),
    catalogEntry(TOOL_get_quote, "finance", { aliases: KERNEL_FINANCE_ALIASES }),
    catalogEntry(TOOL_get_kline, "finance", { aliases: KERNEL_FINANCE_ALIASES }),
    catalogEntry(TOOL_get_stock_profile, "finance", { aliases: KERNEL_FINANCE_ALIASES }),
    catalogEntry(TOOL_get_news, "finance", { aliases: KERNEL_FINANCE_ALIASES }),
    // documents / spreadsheet / database namespaces (§10.5 / §10.6 / §10.7)
    catalogEntry(TOOL_document_search, "documents", { aliases: KERNEL_DOCUMENTS_ALIASES, providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_document_read, "documents", { aliases: KERNEL_DOCUMENTS_ALIASES, providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_document_create, "documents", { aliases: [...KERNEL_DOCUMENTS_ALIASES, "新建文档"], providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_document_append, "documents", { aliases: [...KERNEL_DOCUMENTS_ALIASES, "追加内容"], providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_spreadsheet_create, "spreadsheet", { aliases: [...KERNEL_SPREADSHEET_ALIASES, "新建表格"], providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_spreadsheet_get, "spreadsheet", { aliases: KERNEL_SPREADSHEET_ALIASES, providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_spreadsheet_read, "spreadsheet", { aliases: KERNEL_SPREADSHEET_ALIASES, providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_spreadsheet_append_rows, "spreadsheet", { aliases: [...KERNEL_SPREADSHEET_ALIASES, "添加行"], providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_database_query, "database", { aliases: KERNEL_DATABASE_ALIASES, providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_database_create_record, "database", { aliases: [...KERNEL_DATABASE_ALIASES, "添加记录", "插入记录"], providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_database_update_record, "database", { aliases: [...KERNEL_DATABASE_ALIASES, "更新记录"], providers: ["lark", "feishu"] }),
    catalogEntry(TOOL_database_delete_record, "database", { aliases: [...KERNEL_DATABASE_ALIASES, "删除记录"], providers: ["lark", "feishu"] }),
  ];
}


//






export const CORE_TOOL_NAMES = [
  "get_self_info",
  "memory_save", "personal_info_update",
  "web_search", "web_fetch",
  "vault_list", "request_vault_setup",
  "browser_task", "task_mark_pending",
  "mail_search", "mail_count", "mail_draft", "calendar_list",
  "files_create_text",
  ...DOMAIN_FACADE_NAMES,
  "schedule_create", "schedule_list", "schedule_delete",
  "workstream_find", "workstream_read", "workstream_save",
  "task_update", "task_cancel", "ask_question",
  "react_to_message",
] as const;

export function isDynamicRoutingEnabled(env?: Env): boolean {
  return (env as { DYNAMIC_TOOL_ROUTING_ENABLED?: string } | undefined)?.DYNAMIC_TOOL_ROUTING_ENABLED !== "0";
}


export const TOOL_tool_search_placeholder: Tool = {
  name: "tool_search",
  effect: "read",
  scheduledAllowed: true,
  description: toolSearchDescription(),
  parameters: toolSearchParameters(),
  run: async () => ({ ok: false, error: "internal_reroute" }),
};






export function buildFullCatalog(env?: Env, ctx?: TaskContext & { scheduled?: boolean }): ToolCatalogEntry[] {
  const byName = new Map<string, ToolCatalogEntry>();
  for (const e of buildKernelCatalogEntries()) byName.set(e.tool.name, e);
  if (env?.FINANCE_TOOLS_ENABLED === "0") {
    for (const n of ["get_quote", "get_kline", "get_stock_profile", "get_news"]) byName.delete(n);
  }
  if (env && ctx) {
    const hostTools = getHostHooks().getAdditionalTools?.(env, ctx) ?? [];
    for (const t of hostTools) {
      const prev = byName.get(t.name);
      byName.set(t.name, {
        tool: t,
        namespace: prev?.namespace ?? "core",
        aliases: prev?.aliases,
        searchText: prev?.searchText ?? t.name.toLowerCase(),
        providers: prev?.providers,
        requiresConnector: prev?.requiresConnector,
        scheduledAllowed: (t as { scheduledAllowed?: boolean }).scheduledAllowed === true,
        defaultVisible: prev?.defaultVisible,
      });
    }
  }
  return [...byName.values()];
}


export function defaultToolSession(): ToolSessionState {
  return createToolSession([...CORE_TOOL_NAMES, "tool_search"]);
}

export function allTools(env?: Env, ctx?: TaskContext & { scheduled?: boolean }): Tool[] {
  if (env && isDynamicRoutingEnabled(env)) {
    const catalog = buildFullCatalog(env, ctx);
    const byName = new Map(catalog.map((e) => [e.tool.name, e.tool]));



    const tools = [...byName.values()];
    if ((ctx as any)?.scheduled) {
      return tools.filter((t) => (t as any).scheduledAllowed === true
        && t.name !== "browser_task" && t.name !== "schedule_create" && t.name !== "schedule_reminder"
        && !t.name.startsWith("slack_") && !t.name.startsWith("linear_"));
    }
    return tools.filter((t) => !t.name.startsWith("slack_") && !t.name.startsWith("linear_"));
  }
  const tools = [
    TOOL_get_self_info,
    ...AGENT_MAIL_TOOLS,
    ...TRUSTED_PEOPLE_TOOLS,
    TOOL_memory_save, TOOL_personal_info_update,
    TOOL_web_search, TOOL_web_fetch,
    TOOL_vault_list, TOOL_request_vault_setup, TOOL_request_vault_import,
    TOOL_gmail_search, TOOL_gmail_read, TOOL_gmail_draft, TOOL_gmail_send,
    TOOL_gmail_thread, TOOL_gmail_update, TOOL_contacts_search,
    TOOL_calendar_list, TOOL_calendar_create, TOOL_calendar_delete,
    TOOL_tasks_list, TOOL_tasks_add,
    TOOL_feishu_mail_list, TOOL_feishu_mail_read, TOOL_feishu_calendar_list, TOOL_feishu_calendar_create,
    TOOL_mail_list, TOOL_mail_count, TOOL_mail_read, TOOL_mail_draft, TOOL_mail_send,
    TOOL_files_create_text,
    TOOL_github_repos, TOOL_github_search_issues, TOOL_github_create_issue, TOOL_github_comment,
    TOOL_linear_issues, TOOL_linear_create_issue,
    TOOL_slack_search, TOOL_slack_post,
    TOOL_where_am_i, TOOL_location_history, TOOL_save_place, TOOL_list_places,
    TOOL_set_location_trigger, TOOL_list_location_triggers, TOOL_delete_location_trigger,
    TOOL_nearby_search, TOOL_geocode,
    TOOL_browser_task, TOOL_task_mark_pending, TOOL_schedule_reminder,
    TOOL_schedule_create, TOOL_schedule_list, TOOL_schedule_delete,
    TOOL_react_to_message,
    TOOL_workstream_find, TOOL_workstream_read, TOOL_workstream_save, TOOL_workstream_forget,
    TOOL_task_update, TOOL_task_cancel, TOOL_ask_question,
  ];


  let filtered = tools;
  if ((ctx as any)?.scheduled) {
    filtered = tools.filter((t) => (t as any).scheduledAllowed === true
      && t.name !== "browser_task" && t.name !== "schedule_create" && t.name !== "schedule_reminder"
      && !t.name.startsWith("slack_") && !t.name.startsWith("linear_"));
  } else {

    filtered = tools.filter((t) => !t.name.startsWith("slack_") && !t.name.startsWith("linear_"));
  }
  const tools2 = filtered;
  // Kill Switch: enabled by default, can be disabled by FINANCE_TOOLS_ENABLED="0"
  if (env?.FINANCE_TOOLS_ENABLED !== "0") {
    tools2.push(TOOL_get_quote, TOOL_get_kline, TOOL_get_stock_profile, TOOL_get_news);
  }


  if (env && ctx) {
    const hostTools = getHostHooks().getAdditionalTools?.(env, ctx) ?? [];
    if (hostTools.length > 0) {
      const byName = new Map<string, Tool>();
      for (const t of tools2) byName.set(t.name, t);
      for (const t of hostTools) byName.set(t.name, t); // host wins
      return [...byName.values()];
    }
  }

  return tools2;
}


export function toolDefs(env?: Env, ctx?: TaskContext & { scheduled?: boolean }, session?: ToolSessionState): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  if (env && isDynamicRoutingEnabled(env)) {
    return toolDefsForSession(buildFullCatalog(env, ctx), session ?? defaultToolSession(), { env, taskCtx: ctx });
  }
  return allTools(env, ctx).map((t) => ({
    name: t.name,
    description: t.description + (t.needsApproval ? "【需要用户批准】" : ""),
    parameters: t.parameters,
  }));
}


export function toolDefsForSession(
  catalog: ToolCatalogEntry[],
  session: ToolSessionState,
  opts: { env?: Env; taskCtx?: TaskContext & { scheduled?: boolean }; externalNoTools?: boolean; agentMailAllowed?: boolean } = {},
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  const tools = activeDefsForSession(catalog, session, {
    env: opts.env,
    taskCtx: opts.taskCtx,
    externalNoTools: opts.externalNoTools,
    agentMailAllowed: opts.agentMailAllowed,
  });
  const withSearch = tools.some((t) => t.name === "tool_search") ? tools : [...tools, TOOL_tool_search_placeholder];
  return withSearch.map((t) => ({
    name: t.name,
    description: t.description + (t.needsApproval ? "【需要用户批准】" : ""),
    parameters: t.parameters,
  }));
}

export function findTool(name: string, env?: Env, ctx?: TaskContext & { scheduled?: boolean }): Tool | undefined {
  if (name === "tool_search") return TOOL_tool_search_placeholder;
  return allTools(env, ctx).find((t) => t.name === name);
}





export function findToolInSession(name: string, catalog: ToolCatalogEntry[], session: ToolSessionState): Tool | undefined {
  if (name === "tool_search") return TOOL_tool_search_placeholder;
  const entry = catalog.find((e) => e.tool.name === name);
  if (!entry) return undefined;
  if (isEffectivelyHidden(entry)) return undefined;
  if (!session.activeNames.has(name)) return undefined;
  return entry.tool;
}


export { isEffectivelyHidden };

export function searchAndActivateTools(
  session: ToolSessionState,
  catalog: ToolCatalogEntry[],
  args: ToolSearchArgs,
  filter: (e: ToolCatalogEntry) => boolean = () => true,
) {
  return executeToolSearch(session, catalog, args, filter);
}
