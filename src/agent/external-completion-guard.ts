
//



//




import type { ExternalOperation } from "../external/result";
import type { ToolResult } from "./tool-types";


export interface ExternalOutcomeRecord {
  tool: string;

  provider: string;
  operation: ExternalOperation;
  ok: boolean;

  errorCode?: string;
  externalId?: string;
  externalUrl?: string;
  fetchedAt?: number;

  verifiedAt?: number;

  observation?: boolean;
  resourceType?: string;
}

export type ExternalLedger = ExternalOutcomeRecord[];

export type ExternalClaimType =
  | "external_send"
  | "external_create"
  | "external_update"
  | "external_delete"
  | "external_read"
  | "external_login"
  | "external_browse";

export interface ExternalClaimViolation {
  type: ExternalClaimType;
  text: string;

  required: string;
}

export interface ExternalClaimContext {
  ledger: ExternalLedger;
}

const NEGATION = /(?:没(?:有)?|没有|尚未|还没|并未|不是|并不|未(?:曾|能)?|无法(?:确认)?|不能(?:确认)?|无证据|未发现|未检测到|暂未|could\s*(?:not|n't)|did\s*(?:not|n't)|didn't|not\s+yet|never|cannot|can't|no\s+evidence|unable)/iu;


const NON_ASSERTION = /(?:\?|？|要不要|是否|能否|需不需要|要不要我|如果|一旦|待批准|等待批准|等.*批准|批准后|will\s|won\s|won't|shall|should|may\s|might\s|going\s+to|about\s+to|once\s+(?:you|we|i)\s|after\s+(?:you|we|i)\s)/iu;



const SEND_PATTERNS: RegExp[] = [
  /(?:邮件|消息|邮件草稿)?(?:已经?|成功|刚)?(?:发出|发送(?:出去|成功|完成)?|寄出|送出)/iu,
  /(?:已|已经|成功)发送/u,
  /已?发给了/u,
  /\b(?:email|message|mail)\w*\s+(?:has\s+been|was|is)\s+sent\b/iu,
  /\b(?:i|we)\s+(?:have\s+)?sent\b/iu,
  /\bsent\s+(?:the\s+)?(?:email|message|mail|invitation)\b/iu,
];

const CREATE_PATTERNS: RegExp[] = [
  /(?:已(?:经)?|成功|刚刚)(?:创建|新建|建立|建好|创建好|添加了?|发出?了?)?(?:了)?(?:一个)?(?:草稿|日程|事件|issue|工单|文档|表格|幻灯片|仓库|PR|pull\s*request|评论)/iu,
  /(?:草稿|日程|事件|issue|工单|文档|表格|幻灯片|评论)(?:已经?|已)?(?:创建|建立|建好)(?:了吗)?$/u,
  /已?建了?一?个?/u,
  /\b(?:created|opened|drafted|scheduled|submitted)\b/iu,
  /\b(?:draft|issue|event|document|spreadsheet|presentation|ticket|comment|PR|pull\s+request)\s+(?:has\s+been|was|is)\s+created\b/iu,
];

const UPDATE_PATTERNS: RegExp[] = [
  /(?:已(?:经)?|成功)(?:更新|修改|重命名|移动|归档|标记(?:为)?|改)(?:了|好)/u,
  /\b(?:updated|renamed|moved|archived|modified|marked)\b/iu,
];

const DELETE_PATTERNS: RegExp[] = [
  /(?:已(?:经)?|成功)(?:删除|移除|清空|取消)(?:了|掉|好)/u,
  /\b(?:deleted|removed|cleared)\b/iu,
];

const READ_PATTERNS: RegExp[] = [
  /(?:已(?:经)?|成功)?(?:读取|读到|读出|查到|查询到|获取到|抓取到|找到|检索到|拉取到|看到了?)(?:了)?/u,
  /\b(?:read|fetched|retrieved|pulled|queried|looked\s+up|found)\b/iu,
];

const LOGIN_PATTERNS: RegExp[] = [
  /(?:已(?:经)?|成功)(?:登录|登入|签到)(?:了|成功)?/u,
  /(?:登录|登入|签到)(?:成功|了)/u,
  /\b(?:logged\s*in|logged\s+into|signed\s*in|authenticated)\b/iu,
];

const BROWSE_FOUND_PATTERNS: RegExp[] = [
  /(?:浏览器|网页上?)(?:已(?:经)?)?(?:打开|访问|浏览|看到|读到|查到|确认)(?:了)?/u,
  // DEFECT-022-RC4: "opened example.com" / "visited site.cn" is a
  // browser-usage claim even without the browser keyword prefix — a plain
  // web fetch does not count as opening a browser page.
  /(?:打开|访问|浏览)(?:了|过)?\s*(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*\.[a-z]{2,}/iu,
  /\b(?:browser|page)\b.{0,30}\b(?:opened|visited|observed|confirmed)\b/iu,
  /\b(?:opened|visited)\s+(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*\.[a-z]{2,}/iu,
];

// DEFECT-022-RC4: completed interaction claims (click/type/submit/press).
// Bare imperatives (e.g. asking the user to click a button) are user guidance,
// not completion claims, so the CJK patterns require a completion aspect.
const BROWSER_ACTION_PATTERNS: RegExp[] = [
  /(?:点击|单击|双击)(?:了|过|完)/u,
  /(?:已(?:经)?|成功|刚刚)(?:点击|单击|双击|输入|填写|提交|按下|选中|勾选)/u,
  /(?:输入|填写|提交|按下|选中|勾选)(?:了|完|过)/u,
  /\b(?:clicked|double[- ]?clicked|typed|submitted|pressed|entered|filled\s+in)\b/iu,
  /\b(?:type|enter)\s+into\b/iu,
];

// Claims that observe what a browser page rendered (see/read phrasing with
// page/browser context). A plain web_fetch record (provider "web") proves static
// HTML was fetched — it cannot back what the rendered page showed.
const BROWSER_PAGE_OBSERVE_PATTERNS: RegExp[] = [
  /(?:看到|读到|查到|观察到)[^。！？.!?]{0,40}(?:网页|页面|浏览器)/u,
  /(?:浏览器|网页上|页面上)[^。！？.!?]{0,40}(?:看到|读到|查到|观察到)/u,
  /\b(?:saw|read|observed)\b[^.!?]{0,40}\b(?:on\s+the\s+)?(?:page|website|browser)\b/iu,
];



function mentionedProviders(sentence: string): string[] {
  const p: string[] = [];
  if (/github|\bissue\b|\bpr\b|pull\s*request|仓库|repo\b|代码库/iu.test(sentence)) p.push("github");
  if (/\bemail\b|\bmail\b|gmail|邮箱|邮件|收件箱/iu.test(sentence)) p.push("mailbox", "gmail", "google", "feishu");
  if (/日历|日程|calendar|freebusy|忙闲|事件|event/iu.test(sentence)) p.push("google");
  if (/docs?|文档|sheets?|表格|slides?|幻灯片|drive/iu.test(sentence)) p.push("google");
  if (/网页|网站|web\b|search|搜索/iu.test(sentence)) p.push("web");
  if (/浏览器|browser/iu.test(sentence)) p.push("browser");
  return p;
}

function hasOkRecord(ledger: ExternalLedger, pred: (r: ExternalOutcomeRecord) => boolean): boolean {
  return ledger.some((r) => r.ok && pred(r));
}

// DEFECT-022-RC4: claims about what a browser page shows/renders (read/see
// phrasing + page/browser objects) require a browser-sourced record — a
// provider "browser"
// observation, or an observation-evidence record explicitly tied to a rendered
// page. A plain web_fetch record (provider "web") proves only that static HTML
// was fetched; it never satisfies these claims.
function requiresBrowserObservation(sentence: string): boolean {
  return BROWSER_PAGE_OBSERVE_PATTERNS.some((re) => re.test(sentence));
}

function browserObservedRecord(ledger: ExternalLedger): ExternalOutcomeRecord | undefined {
  return ledger.find((r) =>
    r.ok
    && (r.provider === "browser" && r.operation === "browse" && r.observation === true
      || r.observation === true && /page|browser/iu.test(r.resourceType ?? "")),
  );
}

function readSatisfied(sentence: string, ledger: ExternalLedger): { ok: boolean; required: string } {

  const isReadLike = (r: ExternalOutcomeRecord) =>
    (r.operation === "read" && typeof r.fetchedAt === "number")
    || (r.provider === "browser" && r.operation === "browse" && r.observation === true);
  const providers = mentionedProviders(sentence);
  if (requiresBrowserObservation(sentence)) {
    const ok = browserObservedRecord(ledger) !== undefined;
    return { ok, required: "浏览器实际观察到页面内容（provider=browser 且带观察证据）；web_fetch 抓取的静态 HTML 不能证明渲染后的页面内容" };
  }
  if (providers.length === 0) {
    const ok = ledger.some((r) => r.ok && isReadLike(r));
    return { ok, required: "本轮至少一个来自 provider 的成功读取记录（含 fetchedAt）" };
  }
  const ok = ledger.some((r) => r.ok && isReadLike(r) && providers.includes(r.provider));
  return { ok, required: `本轮对这些 provider（${providers.join("/")}）的成功 provider 读取记录（含 fetchedAt）` };
}


function violationForSentence(sentence: string, ledger: ExternalLedger): ExternalClaimViolation | null {
  if (!sentence.trim() || NEGATION.test(sentence) || NON_ASSERTION.test(sentence)) return null;


  if (SEND_PATTERNS.some((re) => re.test(sentence))) {
    const ok = hasOkRecord(ledger, (r) => r.operation === "send" && !!r.externalId);
    if (!ok) {
      return { type: "external_send", text: sentence, required: "本轮成功的发送记录（provider 消息 ID）；unknown_delivery_state 不是成功" };
    }
  }


  if (CREATE_PATTERNS.some((re) => re.test(sentence))) {
    const wantsDraft = /草稿|draft/iu.test(sentence);
    const wantsEvent = /日程|日历|事件|event|schedule/iu.test(sentence) && !/schedule_re|定时|计划任务/iu.test(sentence);
    const ok = ledger.some(
      (r) => r.ok && r.operation === "create" && (!!r.externalId || !!r.externalUrl)
        && (!wantsDraft || (r.resourceType === "draft" && typeof r.verifiedAt === "number"))
        && (!wantsEvent || (r.resourceType === "event" && typeof r.verifiedAt === "number")),
    );
    if (!ok) {
      const extra = wantsDraft || wantsEvent ? "，且 provider 读回验证（verifiedAt）" : "";
      return { type: "external_create", text: sentence, required: `本轮成功创建记录（provider 原生 ID/URL${extra}）` };
    }
  }

  if (UPDATE_PATTERNS.some((re) => re.test(sentence))) {
    if (!hasOkRecord(ledger, (r) => r.operation === "update")) {
      return { type: "external_update", text: sentence, required: "本轮成功的更新记录" };
    }
  }

  if (DELETE_PATTERNS.some((re) => re.test(sentence))) {
    if (!hasOkRecord(ledger, (r) => r.operation === "delete")) {
      return { type: "external_delete", text: sentence, required: "本轮成功的删除记录" };
    }
  }

  if (LOGIN_PATTERNS.some((re) => re.test(sentence))) {
    const ok = hasOkRecord(ledger, (r) => r.operation === "login" && (typeof r.verifiedAt === "number" || r.observation === true));
    if (!ok) {
      return { type: "external_login", text: sentence, required: "本轮已验证的登录成功证据（不含任何明文密钥）" };
    }
  }

  if (BROWSE_FOUND_PATTERNS.some((re) => re.test(sentence))) {
    const ok = hasOkRecord(ledger, (r) => r.operation === "browse" && r.observation === true);
    if (!ok) {
      return { type: "external_browse", text: sentence, required: "浏览器实际观察到请求值/内容的证据（final URL + 观察时间）" };
    }
  }

  // DEFECT-022-RC4: completed click/type/submit/press claims must come from
  // the browser worker. "clicked Start" / "clicked Submit" cannot be satisfied
  // by a web_fetch of the page HTML — web_fetch never interacts with pages.
  if (BROWSER_ACTION_PATTERNS.some((re) => re.test(sentence))) {
    const ok = browserObservedRecord(ledger) !== undefined;
    if (!ok) {
      return { type: "external_browse", text: sentence, required: "浏览器实际执行该操作的记录（provider=browser 且带观察证据）；web_fetch 不产生任何页面交互" };
    }
  }

  const read = readSatisfied(sentence, ledger);
  if (!read.ok && READ_PATTERNS.some((re) => re.test(sentence))) {

    return { type: "external_read", text: sentence, required: read.required };
  }
  return null;
}

// DEFECT-022-RC4: sentence splitting used to cut at every ASCII '.', which
// chopped domain names ("opened example.cn" -> "opened example." + "cn") and
// made browser-usage claims with URLs undetectable. Domain-like tokens are
// masked out before splitting and restored afterwards so only real sentence
// boundaries split.
const DOMAIN_TOKEN_RE = /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;

function splitSentences(text: string): string[] {
  const protectedTokens: string[] = [];
  const masked = text.replace(DOMAIN_TOKEN_RE, (m) => {
    protectedTokens.push(m);
    return `\u0000${protectedTokens.length - 1}\u0000`;
  });
  const restore = (s: string) =>
    s.replace(/\u0000(\d+)\u0000/g, (_, i) => protectedTokens[Number(i)] ?? "");
  return masked
    .split(/(?:\r?\n)+|(?<=[。！？.!?])\s*/u)
    .map((chunk) => restore(chunk).trim())
    .filter(Boolean);
}


export function findExternalCompletionViolations(
  text: string,
  context: ExternalClaimContext,
): ExternalClaimViolation[] {


  if (!text.trim()) return [];
  const violations: ExternalClaimViolation[] = [];
  for (const sentence of splitSentences(text)) {
    const violation = violationForSentence(sentence, context.ledger);
    if (violation) violations.push(violation);
  }
  return violations;
}

export function externalClaimTypes(violations: ExternalClaimViolation[]): ExternalClaimType[] {
  return [...new Set(violations.map((v) => v.type))];
}


export function stripUnsupportedExternalClaims(
  text: string,
  context: ExternalClaimContext,
): { text: string; claimTypes: ExternalClaimType[] } {
  if (findExternalCompletionViolations(text, context).length === 0) return { text, claimTypes: [] };
  const kept: string[] = [];
  const rejected: ExternalClaimViolation[] = [];
  for (const sentence of splitSentences(text)) {
    const violation = violationForSentence(sentence, context.ledger);
    if (!violation) kept.push(sentence);
    else rejected.push(violation);
  }
  return { text: kept.join("\n").trim(), claimTypes: externalClaimTypes(rejected) };
}


export function externalCorrectionInstruction(lang: "zh" | "en", violations: ExternalClaimViolation[]): string {
  const details = violations.map((v) => `${v.type}: ${v.required}`).join("; ");
  const quoted = violations.map((v) => v.text.trim().slice(0, 160)).filter(Boolean).join(" / ");
  return lang === "zh"
    ? `内部校正：你准备发给用户的草稿（用户没有看到）声称了本轮工具结果不支持的外部操作（${details}；草稿原句：${quoted}）。如果用户要求你执行这个操作而本轮还没有调用对应工具，现在就调用工具去做（需要审批的操作会自动生成审批请求），不要描述一个没有发生的结果。否则只声明本轮成功工具结果真正证明的外部状态；失败/等待审批/未连接/结果未知必须如实说明（未连接时给出连接入口并说明任务会保持等待）。绝不把 unknown_delivery_state 说成成功。用户没有看到草稿，所以不要道歉、不要提到「上一条」或这条内部校正。`
    : `Internal correction: the draft you were about to send (the user has not seen it) claims external actions that this turn's tool results do not support (${details}; draft: ${quoted}). If the user asked you to perform the action and you have not called the tool this turn, call it now (actions that need approval create an approval request) instead of describing an outcome that did not happen. Otherwise claim only external states proven by successful tool results this turn; failures, pending approvals, disconnected providers and unknown delivery states must be stated truthfully (for disconnected providers, give the connect entry point and note the task stays waiting). Never present unknown_delivery_state as success. The user never saw the draft, so do not apologize, refer to a previous message, or mention this correction.`;
}




export function providerForToolName(toolName: string): string {
  if (/^github_/i.test(toolName)) return "github";
  if (/^code_/i.test(toolName)) return "github";
  if (/^(gmail|calendar|google_|contacts_|tasks_)/i.test(toolName)) return "google";
  if (/^(contact_search|contact_get|contact_create|contact_update|contact_delete|todo_|calendar_freebusy|calendar_update)/i.test(toolName)) return "google";
  if (/^(document_|spreadsheet_|database_)/i.test(toolName)) return "feishu";
  if (/^mail_/i.test(toolName)) return "mailbox";
  if (/^feishu_/i.test(toolName)) return "feishu";
  if (/^web_(search|fetch)$/i.test(toolName)) return "web";
  if (/^browser_/i.test(toolName)) return "browser";
  if (/^slack_/i.test(toolName)) return "slack";
  if (/^linear_/i.test(toolName)) return "linear";
  return "local";
}


function operationForEffect(effect: string): ExternalOperation {
  if (effect === "external_send") return "send";
  if (effect === "destructive") return "delete";
  if (effect === "write") return "create";
  return "read";
}






export function recordFromToolResult(toolName: string, effect: string, result: ToolResult): ExternalOutcomeRecord | null {
  const provider = providerForToolName(toolName);
  if (provider === "local" && !result.external) return null;
  const record: ExternalOutcomeRecord = {
    tool: toolName,
    provider,
    operation: operationForEffect(effect),
    ok: result.ok === true,
  };
  const ext = result.external;
  if (ext) {
    if (ext.ok) {
      record.provider = ext.evidence.provider || record.provider;
      record.externalId = ext.evidence.externalId;
      record.externalUrl = ext.evidence.externalUrl;
      record.fetchedAt = ext.evidence.fetchedAt;
      record.verifiedAt = ext.evidence.verifiedAt;
      record.resourceType = ext.evidence.resourceType;
      record.operation = ext.operation;
      if (ext.evidence.metadata?.observation === true) record.observation = true;
    } else {
      record.provider = ext.error.provider || record.provider;
      record.errorCode = ext.error.code;
      record.operation = ext.operation ?? record.operation;
    }
  }
  return record;
}
