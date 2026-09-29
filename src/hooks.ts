//



//


import type { Env, SessionInfo } from "./env";
import type { Tool } from "./agent/tool-types";
export type { Env, SessionInfo };

export interface TaskContext {
  workspaceId: string;
  userId?: string;
  channel: string;
  taskId?: string;
  taskClass?: string;
  lang?: "zh" | "en";
}

export interface UsageRecord {
  tokensIn: number;
  tokensOut: number;
  browserMs: number;





  browserTokensIn?: number;
  browserTokensOut?: number;
}

export interface UsageContext {
  source: "owner_chat" | "email" | "a2a";
  messageAuth?: "none" | "thread_capability" | "a2a_signature" | "dmarc_aligned";
  sourceRef?: string;
}

export interface TransportDeliveredEvent {
  kind: "email";
  transportId: string;
  rootTaskId?: string;
  providerMessageId?: string;
}

export interface BindAttempt {
  channel: string;
  senderId: string;
  arg: string;
  lang: "zh" | "en";
}


export interface ExternalEventClaims {
  source: "owner_chat" | "email" | "a2a";
  workspaceId: string;
  scopeKey: string;
  emailMessageRowId?: string;
  threadId?: string;
  peerAddress?: string;
  capabilityId?: string;
  a2aLocalMessageId?: string;
}





export interface MediaAdmissionRequest {
  channel: "telegram";
  kind: "voice";
  senderId: string;
  botId?: string;
  fileId: string;

  durationSeconds?: number;

  declaredSizeBytes?: number;
  mimeType?: string;
  receivedAt: number;
}

export interface MediaAdmissionDecision {
  allow: boolean;
  reason?: string;

  userMessage?: string;

  costAttribution?: "owner" | "platform" | "none";

  usageRef?: string;
}


export interface MediaUsageRecord {
  channel: "telegram";
  kind: "voice";
  fileId: string;
  model: string;
  durationSeconds?: number;
  costAttribution?: "owner" | "platform" | "none";

  usageRef?: string;
}





export interface OutboundSendRequest {
  channel: string;
  workspaceId?: string;
  destinationId?: string;
  source?: "owner_chat_reply" | "owner_tool" | "owner_http" | "auto_reply" | "cron_outbox" | "system_reply";
  inboxId?: string;
  outboxId?: string;
}

export interface OutboundSendDecision {
  allow: boolean;
  reason?: string;
}

export interface HostHooks {





  beforeTask?(env: Env, ctx: TaskContext): Promise<{ allow: boolean; reason?: string }>;

  afterTask?(env: Env, ctx: TaskContext, usage: UsageRecord, usageCtx?: UsageContext): Promise<void>;

  onTransportDelivered?(env: Env, ctx: TaskContext, event: TransportDeliveredEvent): Promise<void>;

  beforeExternalEvent?(env: Env, claims: ExternalEventClaims): Promise<{ allow: boolean }>;




  revalidateExternalEvent?(
    env: Env,
    claims: ExternalEventClaims,
  ): Promise<{ allow: boolean; reason?: string }>;

  consumeExternalEventAdmission?(env: Env, claims: ExternalEventClaims): Promise<void>;

  releaseExternalEventAdmission?(env: Env, claims: ExternalEventClaims): Promise<void>;




  beforeMediaAdmission?(env: Env, req: MediaAdmissionRequest): Promise<MediaAdmissionDecision>;

  afterMediaUsage?(env: Env, usage: MediaUsageRecord): Promise<void>;




  beforeA2aOutbound?(
    env: Env,
    req: { workspaceId: string; peerAddress: string; logicalKey: string },
  ): Promise<{ allow: boolean; reason?: string }>;




  releaseA2aOutbound?(
    env: Env,
    req: { workspaceId: string; peerAddress: string; logicalKey: string },
  ): Promise<void>;




  beforeOutboundSend?(env: Env, req: OutboundSendRequest): Promise<OutboundSendDecision>;

  resolveModel?(env: Env, ctx: TaskContext, role: "root" | "worker"): Promise<string | null>;




  redeemChatCode?(
    env: Env,
    attempt: BindAttempt,
    send: (texts: string[]) => Promise<void>,
  ): Promise<"handled" | "unhandled">;

  sendOutbound?(
    env: Env,
    channel: string,
    externalId: string,
    text: string,
    contextToken?: string,
    options?: any,
  ): Promise<{ handled: boolean; ok?: boolean; error?: string }>;

  beforeAccountDelete?(env: Env, ctx: { workspaceId: string; userId: string }): Promise<void>;

  onAccountDelete?(env: Env, ctx: { workspaceId: string; userId: string }): Promise<void>;

  getUnboundGuide?(env: Env, event: any): Promise<string | null>;

  getInvalidCodeGuide?(env: Env, event: any, arg?: string): Promise<string | null>;





  getAdditionalTools?(env: Env, ctx: TaskContext): Tool[];

  beforeConnect?(env: Env, ctx: { workspaceId: string; provider: string }): Promise<{ allow: boolean; reason?: string }>;

  connectorQuota?(env: Env, ctx: { workspaceId: string }): Promise<number | null>;

  taskHistoryCutoff?(env: Env, ctx: { workspaceId: string }): Promise<number>;

  checkScheduleCreation?(
    env: Env,
    ctx: { workspaceId: string; currentCount: number },
  ): Promise<{ allow: boolean; reason?: string }>;

  authenticateRequest?(env: Env, req: Request): Promise<SessionInfo | null>;
}

const noop: HostHooks = {};

let current: HostHooks = noop;

export function setHostHooks(h: HostHooks): void {
  current = h;
}

export function resetHostHooks(): void {
  current = noop;
}

export function getHostHooks(): HostHooks {
  return current;
}

/**
 * Runs the host's beforeTask policy for an owner turn. Fails closed: a hook that
 * throws or rejects blocks the turn instead of granting a free model round.
 */
export async function runBeforeTaskGate(
  env: Env,
  ctx: TaskContext & { lang?: "zh" | "en" },
): Promise<{ allow: boolean; reason?: string } | null> {
  const hook = getHostHooks().beforeTask;
  if (!hook) return null;
  try {
    return await hook(env, ctx);
  } catch (e) {
    console.error("[agent] beforeTask failed", String(e));
    return {
      allow: false,
      reason: ctx.lang === "zh" ? "暂时无法处理，请稍后再发一次。" : "Something went wrong on our side. Please send that again in a moment.",
    };
  }
}
