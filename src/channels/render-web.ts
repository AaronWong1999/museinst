//
// Web renderer projection (spec §8.6/§8.9): the DO persists the canonical JSON;
// the Web client renders it directly. This module provides the server-side
// projection helper used when a text-only agent reply must be wrapped into the
// canonical shape, and the action-handling contract (the server re-validates
// every action against the authoritative object before executing).
//
import type { CanonicalCard, CanonicalMessage, CanonicalRole } from "./message-contract";
import { canonicalMessageFrom, sanitizeCards } from "./message-contract";

export interface WebProjectionInput {
  id: string;
  workspaceId: string;
  threadId: string;
  role: CanonicalRole;
  text: string;
  taskId?: string;
  cards?: unknown;
  createdAt: number;
  originChannel?: "web" | "telegram" | "wechat" | "email" | "a2a";
  originMessageId?: string;
}

/** Wrap a persisted turn into the canonical message stored on the timeline. */
export function projectCanonicalMessage(input: WebProjectionInput): CanonicalMessage {
  return canonicalMessageFrom({
    id: input.id,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    role: input.role,
    text: input.text,
    taskId: input.taskId,
    cards: input.cards,
    createdAt: input.createdAt,
    origin: input.originChannel
      ? { channel: input.originChannel, messageId: input.originMessageId }
      : undefined,
  });
}

/**
 * Extract the actions a client may offer for a card. The client must still
 * send the action to the server (typed kind + targetId); the server re-reads
 * the authoritative object, checks workspace/policy/version and idempotency
 * before executing (spec §8.9). Unknown card types expose no actions.
 */
export function actionsForCard(card: CanonicalCard): string[] {
  return (card.actions ?? []).map((a) => a.kind);
}
