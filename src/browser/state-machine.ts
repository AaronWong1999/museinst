//
// Browser Control State Machine & Single Writer Invariant (§14.4, §14.5, §14.6).
//

import type { BrowserSessionState } from "../channels/message-contract";

export type { BrowserSessionState };

export interface BrowserControlState {
  taskId: string;
  workspaceId: string;
  state: BrowserSessionState;
  controlEpoch: number;
  goalRevision: number;
  activeSessionId?: string;
  activeTargetId?: string;
  goal: string;
  leaseExpiresAt?: number;
  updatedAt: number;
}

export interface WriterPermissions {
  agentWrite: boolean;
  humanWrite: boolean;
}

/** Computes the single-writer invariant per §14.5. */
export function getWriterPermissions(state: BrowserSessionState): WriterPermissions {
  switch (state) {
    case "agent_active":
    case "watch_available":
      return { agentWrite: true, humanWrite: false };
    case "user_active":
      return { agentWrite: false, humanWrite: true };
    case "created":
    case "handoff_requested":
    case "completing":
    case "agent_resuming":
    case "completed":
    case "cancelled":
    case "expired":
    case "session_lost":
    case "failed":
      return { agentWrite: false, humanWrite: false };
    default:
      return { agentWrite: false, humanWrite: false };
  }
}

/** Asserts that agentWrite and humanWrite never coexist. */
export function assertSingleWriter(state: BrowserSessionState): void {
  const { agentWrite, humanWrite } = getWriterPermissions(state);
  if (agentWrite && humanWrite) {
    throw new Error("single_writer_invariant_violation: agentWrite and humanWrite cannot both be true");
  }
}

/** Asserts control epoch matches expected; raises stale_control_epoch otherwise (§14.6). */
export function assertControlEpoch(actualEpoch: number, expectedEpoch: number): void {
  if (actualEpoch !== expectedEpoch) {
    const err = new Error(`stale_control_epoch: actual=${actualEpoch}, expected=${expectedEpoch}`);
    (err as any).code = "stale_control_epoch";
    throw err;
  }
}

export type BrowserTransitionEvent =
  | { type: "agent_start" }
  | { type: "watch_enabled" }
  | { type: "handoff_request"; reason?: string }
  | { type: "takeover_acquired"; leaseDurationMs: number }
  | { type: "user_done" }
  | { type: "agent_resume" }
  | { type: "task_complete" }
  | { type: "task_cancel" }
  | { type: "session_lost" }
  | { type: "task_fail"; error: string }
  | { type: "steer"; goal: string };

/**
 * Transitions browser control state. Enforces valid state machine paths
 * and increments controlEpoch or goalRevision per §14.6.
 */
export function transitionBrowserControlState(
  current: BrowserControlState,
  event: BrowserTransitionEvent,
  nowMs: number = Date.now(),
): BrowserControlState {
  assertSingleWriter(current.state);

  const next = { ...current, updatedAt: nowMs };

  switch (event.type) {
    case "agent_start":
      if (current.state === "created" || current.state === "agent_resuming") {
        next.state = "agent_active";
      }
      break;

    case "watch_enabled":
      if (current.state === "agent_active") {
        next.state = "watch_available";
      }
      break;

    case "handoff_request":
      if (current.state === "agent_active" || current.state === "watch_available") {
        next.state = "handoff_requested";
      }
      break;

    case "takeover_acquired":
      if (current.state === "handoff_requested" || current.state === "watch_available" || current.state === "agent_active") {
        next.state = "user_active";
        next.controlEpoch += 1;
        next.leaseExpiresAt = nowMs + Math.max(10_000, event.leaseDurationMs);
      } else {
        throw new Error(`illegal_transition: cannot takeover from state ${current.state}`);
      }
      break;

    case "user_done":
      if (current.state === "user_active") {
        next.state = "completing";
        next.controlEpoch += 1;
        next.leaseExpiresAt = undefined;
      }
      break;

    case "agent_resume":
      if (current.state === "completing") {
        next.state = "agent_active";
      }
      break;

    case "task_complete":
      next.state = "completed";
      next.controlEpoch += 1;
      next.leaseExpiresAt = undefined;
      break;

    case "task_cancel":
      next.state = "cancelled";
      next.controlEpoch += 1;
      next.leaseExpiresAt = undefined;
      break;

    case "session_lost":
      next.state = "session_lost";
      next.controlEpoch += 1;
      next.leaseExpiresAt = undefined;
      break;

    case "task_fail":
      next.state = "failed";
      next.controlEpoch += 1;
      next.leaseExpiresAt = undefined;
      break;

    case "steer":
      next.goal = event.goal;
      next.goalRevision += 1;
      // Plain steer increments goal_revision without changing control_epoch (§14.6)
      break;

    default:
      throw new Error(`unknown_browser_event: ${(event as any).type}`);
  }

  assertSingleWriter(next.state);
  return next;
}
