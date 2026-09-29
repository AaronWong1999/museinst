
//


//   waiting_for_user_input   → pending_tasks.kind='conversational_goal'
//   waiting_for_approval     → pending_tasks.kind='approval'


//



import type { ExternalLedger } from "./external-completion-guard";

export type WaitingType = "user_input" | "connector" | "approval";


export function firstWaitingConnector(ledger: ExternalLedger): { provider: string; tool: string } | null {
  for (const r of ledger) {
    if (!r.ok && r.errorCode === "not_connected" && (r.provider === "github" || r.provider === "google" || r.provider === "mailbox" || r.provider === "feishu")) {
      return { provider: r.provider, tool: r.tool };
    }
  }
  return null;
}





export function isConnectorResumeText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 200) return false;
  return /(?:已经?连接好?了?|连接完成了?|连好了|已连接|重新连接好了?|刚刚连接了?|connected\s+(?:it\s+)?now|i'?ve\s+connected)\S{0,12}[,，。！!\s]*.{0,40}(?:继续|接着|恢复|resume|continue|go\s+ahead)|(?:继续|接着|恢复|resume|continue)\S{0,6}(?:刚才|刚刚|之前|之前那个|那个)?(?:的)?任务/i.test(t)
    || /^(?:继续|接着|继续吧|请继续|继续刚才的任务|继续那个任务|resume|continue)[\s!.。！]*$/i.test(t);
}


export function buildResumeMessage(originalUserMessage: string, currentText: string): string {
  const original = originalUserMessage.trim();
  const added = currentText.trim();
  if (!original) return added;
  if (isPureAck(added)) {
    return `${original}\n\n（用户确认前置条件已满足，请继续完成上述任务。）`;
  }
  return `${original}\n\n（用户补充：${added}。请合并以上信息继续完成原任务。）`;
}

function isPureAck(text: string): boolean {
  return /^(?:已经?连接好?了?|连接完成了?|连好了|已连接|刚刚连接了?|好的|好|ok|yes|继续|请继续|继续吧|继续刚才的任务)[\s!.。！]*$/i.test(text);
}


export interface PendingTaskRowLike {
  kind: string;
  status: string;
  provider?: string | null;
  goal_summary?: string | null;
  original_message?: string | null;
  revision?: number | null;
}

export function pendingStateOf(row: PendingTaskRowLike): string {
  if (row.status !== "pending") {
    return row.status === "resolved" ? "completed" : "cancelled";
  }
  switch (row.kind) {
    case "approval": return "waiting_for_approval";
    case "connector": return "waiting_for_connector";
    case "conversational_goal": return "waiting_for_user_input";
    default: return "waiting_for_user_input";
  }
}
