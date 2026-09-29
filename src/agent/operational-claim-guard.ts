// operational-claim-guard.ts — prevents unsupported current-state claims from
// becoming durable assistant history or outbound replies.
//
// This is deliberately a small, high-precision guard. It does not deduplicate
// user text and it does not try to decide whether transport actually retried a
// message. Transport truth belongs to the idempotency layer; this module only
// rejects a model claim when the current turn has no trusted evidence for it.

export type OperationalClaimType = "duplicate_input" | "billing_state" | "sync_state" | "approval_state";

export type OperationalClaimContext = {
  currentUserText: string;
  channel: string;
  source: "owner_chat" | "email" | "a2a";
  duplicateConfirmed: boolean;
  currentAccountEvidence: boolean;
  currentConnectorEvidence: boolean;
  currentApprovalEvidence?: boolean;
};

export type OperationalClaimViolation = {
  type: OperationalClaimType;
  text: string;
};

const NEGATION = /(?:没(?:有)?|没有|并非|不是|并不|未(?:曾)?|无法(?:确认)?|不能(?:确认)?|无证据|未发现|未检测到|did\s+not|didn't|not|never|cannot|can't|no\s+evidence)/iu;

const DUPLICATE_PATTERNS: RegExp[] = [
  /(?:你|您|用户)\s*(?:刚才|刚刚|此前)?\s*(?:连发|发了|发送了|重复发送了|重复发了)\s*(?:两|二|2)\s*(?:条|次|遍)?/iu,
  /(?:你|您|用户).{0,24}(?:两条相同|两条重复|重复消息|重复内容)/iu,
  /(?:收到|接收|检测到|发现).{0,20}(?:两条|两次).{0,20}(?:相同|重复|同样)/iu,
  /\b(?:you|the user)\b.{0,30}\b(?:sent|submitted|received|got).{0,15}\b(?:twice|two times|a duplicate|duplicate)\b/iu,
  /\b(?:i|we)\s+(?:received|got|detected).{0,25}(?:the same message twice|a duplicate message)\b/iu,
];

const BILLING_PATTERNS: RegExp[] = [
  /(?:你|您|当前)?(?:的)?(?:账号|账户|帐户).{0,35}(?:欠费|欠额|计费冻结|账单冻结|余额不足|点数不足|被冻结)/iu,
  /(?:当前|目前).{0,24}(?:欠费|欠额|计费冻结|账单冻结|余额不足|点数不足|被冻结)/iu,
  /\b(?:your|the)\s+(?:account|billing).{0,45}\b(?:overdue|in debt|billing hold|frozen|insufficient|outstanding)\b/iu,
  /\b(?:you|your account)\b.{0,40}\b(?:owe|owes|debt|billing hold|frozen|insufficient credits?)\b/iu,
];

// Transport health is never established by model prose or account/connector reads.
const SYNC_PATTERNS = [
  /(?:同步|sync(?:hroni[sz](?:ation|ing))?).{0,12}(?:报错|报error|失败|错误|延迟|异常|error|fail|delay)/iu,
  /(?:刚才|刚刚|现在|当前|显示|处于|已经).{0,20}(?:离线|offline|断线|断连)/iu,
  /\b(?:you|we|the (?:app|client|session|connection|system))\b.{0,25}\b(?:is|are|was|were|went)\s+offline\b/iu,
  /(?:同一事件|消息|通知|事件).{0,15}(?:重复推送|重复投递|重复通知)/u,
  /\b(?:duplicate|repeated)\s+(?:push|notification|delivery|deliveries|event)s?\b/iu,
];
const APPROVAL_PATTERNS = [
  /(?:待审批|审批|批准).{0,15}(?:提案|请求).{0,12}(?:已生成|已创建|已提交)/u,
  /(?:正等|正在等|仍在等|等待你|等你).{0,10}(?:批准|审批|拒绝)/u,
  /\b(?:proposal|request|task)\b.{0,25}\b(?:is|was|has been)\b.{0,15}(?:awaiting approval|pending approval|created for approval)/iu,
];
const QUALIFIED_STATE = /(?:如果|若|假如|是否|可能|无法确认|不能确认|没有证据|并未|没有发生|未发生|你(?:提到|说|反馈)|您(?:提到|说|反馈)|\b(?:if|whether|might|may|cannot confirm|can't confirm|no evidence|you (?:said|reported|mentioned))\b)/iu;

function stateClaim(text: string, patterns: RegExp[]): boolean {
  // Qualifiers apply to their own clause, not an unrelated sentence fragment.
  return text.split(/[，,；;]/u).some(clause =>
    patterns.some(pattern => pattern.test(clause)) && !QUALIFIED_STATE.test(clause) && !/(?:没有|并非|不是|并不|未曾|未发现|未检测到|\b(?:not|never|cannot|can't|didn't)\b)/iu.test(clause));
}

/** Only quarantine the characteristic corrupted output, not user reports or normal history. */
export function hasRepeatedSyncDiagnostics(text: string): boolean {
  return text.split(/\r?\n/u).filter(line => stateClaim(line, SYNC_PATTERNS)).length >= 3;
}

function claimChunks(text: string): string[] {
  // An ASCII dot inside a URL, email, decimal, or numbered item is not a sentence boundary.
  return text.split(/(?:\r?\n)+|(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Z])/u)
    .map(chunk => chunk.trim()).filter(Boolean);
}

/** Requests to quote, rewrite, explain, or summarize text are not state claims. */
export function isExplicitTransformRequest(userText: string): boolean {
  return /(?:润色|改写|改成|起草|写一段|引用|原文|这句话|解释.*(?:术语|英文|含义)|总结.*(?:排障|结论|重复消息)|\brewrite\b|\bredraft\b|\bdraft\b|\bquote\b|\bexplain\b.{0,30}\bbilling hold\b|\bsummarize\b)/iu.test(userText);
}

/** Whether the current user request needs a fresh account/plan/credit lookup. */
export function isAccountStateQuestion(userText: string): boolean {
  return /(?:余额|点数|欠费|欠额|计费冻结|账单冻结|套餐|订阅状态|billing\s+hold|credits?|balance|overdue|outstanding|plan|subscription)/iu.test(userText)
    && !isExplicitTransformRequest(userText);
}

function positiveMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text)) && !NEGATION.test(text);
}

/** Returns only claims that are unsupported by this turn's trusted facts. */
export function findOperationalClaimViolations(
  text: string,
  context: OperationalClaimContext,
): OperationalClaimViolation[] {
  if (!text.trim() || isExplicitTransformRequest(context.currentUserText)) return [];

  const violations: OperationalClaimViolation[] = [];
  const chunks = claimChunks(text);

  for (const chunk of chunks) {
    if (stateClaim(chunk, SYNC_PATTERNS)) {
      violations.push({ type: "sync_state", text: chunk });
    }
    if (!context.currentApprovalEvidence && stateClaim(chunk, APPROVAL_PATTERNS)) {
      violations.push({ type: "approval_state", text: chunk });
    }
    if (!context.duplicateConfirmed && positiveMatch(chunk, DUPLICATE_PATTERNS)) {
      violations.push({ type: "duplicate_input", text: chunk });
    }
    if (!context.currentAccountEvidence && positiveMatch(chunk, BILLING_PATTERNS)) {
      violations.push({ type: "billing_state", text: chunk });
    }
  }
  return violations;
}

export function claimTypes(violations: OperationalClaimViolation[]): OperationalClaimType[] {
  return [...new Set(violations.map((violation) => violation.type))];
}

/** Remove unsupported claim sentences while retaining the useful answer. */
export function stripUnsupportedOperationalClaims(
  text: string,
  context: OperationalClaimContext,
): { text: string; claimTypes: OperationalClaimType[] } {
  const rejected = findOperationalClaimViolations(text, context);
  let cleaned = text;
  for (const chunk of new Set(rejected.map(violation => violation.text))) {
    cleaned = cleaned.split(chunk).join("");
  }
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), claimTypes: claimTypes(rejected) };
}

export function correctionInstruction(
  lang: "zh" | "en",
  violations: OperationalClaimViolation[],
): string {
  const types = claimTypes(violations).join(", ");
  return lang === "zh"
    ? `内部校正：你刚才的草稿包含没有本轮证据支持的运行状态声明（${types}）。请重新回答用户当前请求。除非本轮成功的权威工具结果明确提供，不要声称用户重复发送、同步报错、离线、重复推送，也不要声称当前欠费、冻结、余额或套餐状态。审批状态只能依据当前真实待审批记录，不能沿用历史任务。直接回答当前问题；不要解释、引用或道歉于用户从未看过的草稿，不要提及这条内部校正。`
    : `Internal correction: your draft contains unsupported operational claims (${types}). Answer the user's current request again. Do not invent sync errors, offline status, or duplicate notifications. Do not claim duplicate delivery or current debt, billing hold, balance, or plan state without current trusted evidence. Pending approval requires a current pending record, not an old task in history. Answer the current request directly; do not quote, explain, or apologize for an unseen draft. Do not mention this correction.`;
}
