//
// Canonical Message / Card protocol (spec §8) — edition-neutral shared contract.
//
// Core generates one canonical semantic message per turn; channel renderers
// decide how it is presented (Web rich cards, Telegram/WeChat text + link).
// Web must never infer card types from natural language, and provider URLs
// must never be embedded in a card — cards carry stable object references and
// the Link Resolver mints MuseInst URLs at delivery/JIT time.
//
// Compatibility: every card/message carries `version: 1`. Unknown card types
// must fall back to the canonical plain text on every surface; host wrappers
// must not drop unknown fields.

export const CANONICAL_VERSION = 1 as const;

export type CanonicalChannel = "web" | "telegram" | "wechat" | "email" | "a2a";

export type CanonicalRole = "user" | "assistant" | "system";

export type CanonicalCardType =
  | "browser_session"
  | "task"
  | "approval"
  | "email"
  | "file"
  | "document"
  | "automation"
  | "connector"
  | "goal";

export type CanonicalActionKind =
  | "browser_watch"
  | "browser_takeover"
  | "task_open"
  | "approval_open"
  | "approval_accept"
  | "approval_reject"
  | "file_open"
  | "document_open"
  | "automation_open"
  | "connector_open"
  | "goal_confirm"
  | "goal_open"
  | "goal_edit";

/** Actions reference objects by stable ID; the server re-validates every action. */
export interface CanonicalAction {
  id: string;
  kind: CanonicalActionKind;
  label: string;
  targetId?: string;
  sensitivity?: "normal" | "private_link";
}

/** Stable object reference — never a provider URL or credential (spec §8.2). */
export interface CanonicalObjectRef {
  /** MuseInst-stable reference, e.g. "task:t_123", "grant:g_abc". */
  sessionRef: string;
  targetRef?: string;
}

/** Browser control states mirror the §14.4 state machine. */
export type BrowserSessionState =
  | "created"
  | "agent_active"
  | "watch_available"
  | "handoff_requested"
  | "user_active"
  | "completing"
  | "agent_resuming"
  | "completed"
  | "cancelled"
  | "expired"
  | "session_lost"
  | "failed";

export interface BrowserSessionCard {
  type: "browser_session";
  version: typeof CANONICAL_VERSION;
  id: string;
  revision: number;
  taskId: string;
  threadId: string;
  ref: CanonicalObjectRef;
  title?: string;
  displayUrl?: string;
  state: BrowserSessionState;
  continuity: "same_session" | "new_recovery_session";
  recordingReady?: boolean;
  actions: CanonicalAction[];
}

export interface TaskCard {
  type: "task";
  version: typeof CANONICAL_VERSION;
  id: string;
  revision: number;
  taskId: string;
  threadId: string;
  title: string;
  state: string;
  waitingReason?: string;
  progress?: { completed: number; total?: number; current?: string };
  actions: CanonicalAction[];
}

export type ApprovalState =
  | "pending"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "rejected"
  | "expired"
  | "cancelled";

export interface ApprovalCard {
  type: "approval";
  version: typeof CANONICAL_VERSION;
  id: string;
  revision: number;
  approvalId: string;
  taskId?: string;
  summary: string;
  target?: string;
  amount?: { value: string; currency: string };
  paramVersion?: string;
  expiresAt?: number;
  state: ApprovalState;
  actions: CanonicalAction[];
}

export interface EmailCard {
  type: "email";
  version: typeof CANONICAL_VERSION;
  id: string;
  revision: number;
  mailboxRef: string;
  messageRef: string;
  subject: string;
  from: string;
  receivedAt: number;
  snippet?: string;
  actions: CanonicalAction[];
}

export interface FileCard {
  type: "file";
  version: typeof CANONICAL_VERSION;
  id: string;
  revision: number;
  artifactId: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  source?: string;
  state: "available" | "expired" | "deleted" | "processing";
  actions: CanonicalAction[];
}

export interface DocumentCard {
  type: "document";
  version: typeof CANONICAL_VERSION;
  id: string;
  revision: number;
  sourceArtifactId: string;
  newArtifactId?: string;
  documentKind: string;
  supportedFields?: string[];
  state: "inspect_ready" | "filled" | "preview_ready" | "sent" | "unsupported";
  actions: CanonicalAction[];
}

export interface AutomationCard {
  type: "automation";
  version: typeof CANONICAL_VERSION;
  id: string;
  revision: number;
  automationId: string;
  title: string;
  enabled: boolean;
  nextRunAt?: number;
  timezone?: string;
  lastRun?: { state: string; delivery: string; at: number };
  actions: CanonicalAction[];
}

export interface ConnectorCard {
  type: "connector";
  version: typeof CANONICAL_VERSION;
  id: string;
  revision: number;
  connectorId: string;
  provider: string;
  state: "connected" | "reauth_needed" | "missing";
  actions: CanonicalAction[];
}

export interface GoalCard {
  type: "goal";
  version: typeof CANONICAL_VERSION;
  id: string;
  revision: number;
  proposalId: string;
  threadId: string;
  title: string;
  doneWhen?: string;
  due?: string;
  milestones?: string[];
  state: "draft" | "confirmed";
  goalId?: string;
  linkedWorkstreamId?: string;
  actions: CanonicalAction[];
}

export type CanonicalCard =
  | BrowserSessionCard
  | TaskCard
  | ApprovalCard
  | EmailCard
  | FileCard
  | DocumentCard
  | AutomationCard
  | ConnectorCard
  | GoalCard;

export interface CanonicalOrigin {
  channel: CanonicalChannel;
  externalId?: string;
  messageId?: string;
}

export interface CanonicalMessage {
  version: typeof CANONICAL_VERSION;
  id: string;
  workspaceId: string;
  threadId: string;
  taskId?: string;
  role: CanonicalRole;
  /** Always present, always high quality — the universal fallback. */
  text: string;
  cards?: CanonicalCard[];
  createdAt: number;
  origin?: CanonicalOrigin;
}

/** True when the payload structurally satisfies the v1 message contract. */
export function isCanonicalMessage(value: unknown): value is CanonicalMessage {
  const m = value as CanonicalMessage | null;
  return (
    !!m &&
    typeof m === "object" &&
    m.version === CANONICAL_VERSION &&
    typeof m.id === "string" &&
    typeof m.threadId === "string" &&
    typeof m.text === "string" &&
    (m.role === "user" || m.role === "assistant" || m.role === "system")
  );
}

/**
 * Cards are optional and unknown types degrade to text. Returns well-formed
 * cards only; anything malformed is dropped so renderers never crash.
 */
export function sanitizeCards(cards: unknown): CanonicalCard[] | undefined {
  if (!Array.isArray(cards)) return undefined;
  const out: CanonicalCard[] = [];
  for (const raw of cards) {
    const c = raw as CanonicalCard | null;
    if (
      !!c &&
      typeof c === "object" &&
      typeof (c as { version?: unknown }).version === "number" &&
      typeof (c as { id?: unknown }).id === "string" &&
      typeof (c as { type?: unknown }).type === "string"
    ) {
      out.push(c);
    }
  }
  return out.length > 0 ? out : undefined;
}

export function canonicalMessageFrom(input: {
  id: string;
  workspaceId: string;
  threadId: string;
  role: CanonicalRole;
  text: string;
  taskId?: string;
  cards?: unknown;
  createdAt: number;
  origin?: CanonicalOrigin;
}): CanonicalMessage {
  const msg: CanonicalMessage = {
    version: CANONICAL_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    role: input.role,
    text: input.text,
    createdAt: input.createdAt,
  };
  if (input.taskId) msg.taskId = input.taskId;
  if (input.origin) msg.origin = input.origin;
  const cards = sanitizeCards(input.cards);
  if (cards) msg.cards = cards;
  return msg;
}
