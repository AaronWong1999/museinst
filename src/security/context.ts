
//







export type ContactClass = "unknown" | "known" | "blocked";

export type MessageAuth = "none" | "thread_capability" | "a2a_signature" | "dmarc_aligned";

export type EventSource = "owner_chat" | "email" | "a2a";

export type PromptProfile = "owner_full" | "external_minimal" | "a2a_structured";


export interface SecurityClaims {
  source: EventSource;
  workspaceId: string;
  scopeKey: string;
  emailMessageRowId?: string;
  threadId?: string;
  peerAddress?: string;
  capabilityId?: string;
  a2aLocalMessageId?: string;
}

export interface ApprovalRoute {
  channel: "wechat" | "telegram" | "web";
  externalId?: string;
  contextToken?: string;
}

export interface SecurityContext {
  source: EventSource;
  workspaceId: string;
  scopeKey: string;

  authenticatedOwner: boolean;
  contactClass: ContactClass;
  addressVerifiedByOwner: boolean;
  messageAuth: MessageAuth;

  peerAddress?: string;
  agentAddress?: string;
  emailThreadId?: string;
  protocolConvoId?: string;

  promptProfile: PromptProfile;
  allowPrivateContext: boolean;
  allowTools: string[];
  allowAccountStateDisclosure: boolean;

  threadSummary?: string;
  publicFacts?: Record<string, string>;
  a2aState?: string;
  a2aPayload?: unknown;

  maxLoopIterations: number;
  maxHistory: number;
  maxOutputTokens: number;

  approvalRoute: ApprovalRoute | null;
}

export interface EmailIdentityFacts {
  peerAddress: string;
  contactClass: ContactClass;

  addressVerifiedByOwner: boolean;
  messageAuth: MessageAuth;
  capabilityId?: string;
}

export interface DeriveInput {
  claims: SecurityClaims;
  identity: EmailIdentityFacts | null;
  approvalRoute: ApprovalRoute | null;
  agentAddress?: string;
  threadSummary?: string;
  publicFacts?: Record<string, string>;
  a2aState?: string;
  a2aPayload?: unknown;
  protocolConvoId?: string;
}









export function deriveSecurityContext(input: DeriveInput): SecurityContext {
  const { claims, identity } = input;
  if (claims.source === "owner_chat") {
    return {
      source: "owner_chat",
      workspaceId: claims.workspaceId,
      scopeKey: OWNER_GLOBAL_SCOPE,
      authenticatedOwner: true,
      contactClass: "unknown",
      addressVerifiedByOwner: false,
      messageAuth: "none",
      promptProfile: "owner_full",
      allowPrivateContext: true,
      allowTools: ["*"],
      allowAccountStateDisclosure: true,
      maxLoopIterations: 8,
      maxHistory: 24,
      maxOutputTokens: 4096,
      approvalRoute: input.approvalRoute,
    };
  }
  const messageAuth: MessageAuth = identity?.messageAuth ?? "none";
  const contactClass: ContactClass = identity?.contactClass ?? "unknown";
  if (claims.source === "a2a") {
    return {
      source: "a2a",
      workspaceId: claims.workspaceId,
      scopeKey: claims.scopeKey,
      authenticatedOwner: false,
      contactClass,
      addressVerifiedByOwner: identity?.addressVerifiedByOwner ?? false,
      messageAuth,
      peerAddress: identity?.peerAddress ?? claims.peerAddress,
      agentAddress: input.agentAddress,
      emailThreadId: claims.threadId,
      protocolConvoId: input.protocolConvoId,
      promptProfile: "a2a_structured",
      allowPrivateContext: false,
      allowTools: [],
      allowAccountStateDisclosure: false,
      a2aState: input.a2aState,
      a2aPayload: input.a2aPayload,
      publicFacts: input.publicFacts,
      maxLoopIterations: 2,
      maxHistory: 0,
      maxOutputTokens: 400,
      approvalRoute: input.approvalRoute,
    };
  }
  return {
    source: "email",
    workspaceId: claims.workspaceId,
    scopeKey: claims.scopeKey,
    authenticatedOwner: false,
    contactClass,
    addressVerifiedByOwner: identity?.addressVerifiedByOwner ?? false,
    messageAuth,
    peerAddress: identity?.peerAddress ?? claims.peerAddress,
    agentAddress: input.agentAddress,
    emailThreadId: claims.threadId,
    promptProfile: "external_minimal",
    allowPrivateContext: false,
    allowTools: [],
    allowAccountStateDisclosure: false,
    threadSummary: input.threadSummary,
    publicFacts: input.publicFacts,
    maxLoopIterations: 2,
    maxHistory: 8,
    maxOutputTokens: 400,
    approvalRoute: input.approvalRoute,
  };
}

export const OWNER_GLOBAL_SCOPE = "owner:global";

export function emailScopeKey(peerHashHex: string, threadId: string): string {
  return `email:${peerHashHex.slice(0, 16)}:${threadId}`;
}

export function humanA2aScopeKey(protocolConvoId: string): string {
  return `human-a2a:${protocolConvoId}`;
}


export function doIdempotencyKey(source: EventSource, scopeKey: string, messageId: string): string {
  return `${source}:${scopeKey}:${messageId}`;
}


export function normalizeParkedState<T>(raw: unknown): Record<string, T> {
  if (!raw || typeof raw !== "object") return {};
  if ("taskId" in (raw as Record<string, unknown>)) {
    return { [OWNER_GLOBAL_SCOPE]: raw as T };
  }
  return raw as Record<string, T>;
}
