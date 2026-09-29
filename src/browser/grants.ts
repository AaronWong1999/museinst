//
// One-Time Browser Access Grant repository & token operations (§14.11, §14.12).
//

import type { Env } from "../env";

export interface BrowserAccessGrantRow {
  id: string;
  workspace_id: string;
  task_id: string;
  principal_id?: string;
  origin_channel?: string;
  origin_external_id?: string;
  origin_scope?: string;
  token_hash: string;
  status: "issued" | "redeemed" | "active" | "completed" | "revoked" | "expired";
  requested_mode: "readonly" | "interactive";
  current_mode: "readonly" | "interactive";
  created_by: string;
  reason_code?: string;
  instructions?: string;
  privacy_mode: "normal" | "masked";
  browser_session_ref?: string;
  target_ref?: string;
  control_epoch: number;
  max_redemptions: number;
  redemption_count: number;
  issued_at: number;
  expires_at: number;
  redeemed_at?: number;
  takeover_at?: number;
  completed_at?: number;
  revoked_at?: number;
  metadata_json?: string;
}

export interface CreateGrantInput {
  workspaceId: string;
  taskId: string;
  requestedMode: "readonly" | "interactive";
  createdBy: "agent" | "user" | "system";
  browserSessionRef?: string;
  targetRef?: string;
  controlEpoch?: number;
  ttlMs?: number;
  originChannel?: string;
  originExternalId?: string;
  originScope?: string;
  principalId?: string;
  reasonCode?: string;
  instructions?: string;
  privacyMode?: "normal" | "masked";
  metadata?: Record<string, unknown>;
}

export interface IssuedGrant {
  grantId: string;
  rawToken: string;
  expiresAt: number;
  accessUrl: string;
}

/** Compute SHA-256 hash of a string using Web Crypto. */
export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a 256-bit URL-safe token. */
export function generateSecureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class BrowserGrantRepository {
  constructor(private readonly db: D1Database) {}

  async createGrant(input: CreateGrantInput, publicBaseUrl: string): Promise<IssuedGrant> {
    const grantId = `bg_${crypto.randomUUID().replace(/-/g, "")}`;
    const rawToken = generateSecureToken();
    const tokenHash = await sha256Hex(rawToken);
    const now = Date.now();
    const ttlMs = input.ttlMs ?? 15 * 60_000; // 15 minutes default short TTL (§14.11)
    const expiresAt = now + ttlMs;

    await this.db
      .prepare(
        `INSERT INTO browser_access_grants (
          id, workspace_id, task_id, principal_id, origin_channel, origin_external_id, origin_scope,
          token_hash, status, requested_mode, current_mode, created_by, reason_code, instructions,
          privacy_mode, browser_session_ref, target_ref, control_epoch, max_redemptions, redemption_count,
          issued_at, expires_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      )
      .bind(
        grantId,
        input.workspaceId,
        input.taskId,
        input.principalId ?? null,
        input.originChannel ?? null,
        input.originExternalId ?? null,
        input.originScope ?? null,
        tokenHash,
        input.requestedMode,
        input.requestedMode,
        input.createdBy,
        input.reasonCode ?? null,
        input.instructions ?? null,
        input.privacyMode ?? "normal",
        input.browserSessionRef ?? null,
        input.targetRef ?? null,
        input.controlEpoch ?? 0,
        now,
        expiresAt,
        input.metadata ? JSON.stringify(input.metadata) : null,
      )
      .run();

    const baseUrl = publicBaseUrl.replace(/\/+$/, "");
    return {
      grantId,
      rawToken,
      expiresAt,
      accessUrl: `${baseUrl}/b/${rawToken}`,
    };
  }

  async findByTokenHash(tokenHash: string): Promise<BrowserAccessGrantRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM browser_access_grants WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<BrowserAccessGrantRow>();
    return row ?? null;
  }

  async findById(grantId: string): Promise<BrowserAccessGrantRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM browser_access_grants WHERE id = ?`)
      .bind(grantId)
      .first<BrowserAccessGrantRow>();
    return row ?? null;
  }

  /**
   * Redeems a grant via CAS (compare-and-swap).
   * Ensures max_redemptions is not exceeded and grant has not expired.
   */
  async redeemGrant(tokenHash: string, nowMs: number = Date.now()): Promise<BrowserAccessGrantRow> {
    const grant = await this.findByTokenHash(tokenHash);
    if (!grant) {
      throw new Error("grant_not_found");
    }
    if (grant.expires_at <= nowMs) {
      await this.db
        .prepare(`UPDATE browser_access_grants SET status = 'expired' WHERE id = ?`)
        .bind(grant.id)
        .run();
      throw new Error("grant_expired");
    }
    if (grant.status === "revoked") {
      throw new Error("grant_revoked");
    }
    if (grant.status === "completed") {
      throw new Error("grant_completed");
    }

    // Atomic CAS consumption
    const res = await this.db
      .prepare(
        `UPDATE browser_access_grants
         SET status = 'redeemed',
             redemption_count = redemption_count + 1,
             redeemed_at = ?
         WHERE id = ? AND redemption_count < max_redemptions AND status = 'issued'`,
      )
      .bind(nowMs, grant.id)
      .run();

    if (!res.meta?.changes || res.meta.changes === 0) {
      throw new Error("grant_already_redeemed");
    }

    return {
      ...grant,
      status: "redeemed",
      redemption_count: grant.redemption_count + 1,
      redeemed_at: nowMs,
    };
  }

  async updateMode(grantId: string, currentMode: "readonly" | "interactive", controlEpoch: number): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE browser_access_grants
         SET current_mode = ?, control_epoch = ?, takeover_at = CASE WHEN ? = 'interactive' THEN ? ELSE takeover_at END
         WHERE id = ?`,
      )
      .bind(currentMode, controlEpoch, currentMode, now, grantId)
      .run();
  }

  /**
   * Moves a task's live grants to the tab that replaced their old one after a
   * viewer revocation. The browser session is unchanged; only the tab is new.
   */
  async retargetTask(workspaceId: string, taskId: string, sessionRef: string, fromTarget: string, toTarget: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE browser_access_grants
         SET target_ref = ?
         WHERE workspace_id = ? AND task_id = ? AND browser_session_ref = ? AND target_ref = ?
           AND status IN ('issued', 'redeemed', 'active')`,
      )
      .bind(toTarget, workspaceId, taskId, sessionRef, fromTarget)
      .run();
  }

  async completeGrant(grantId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE browser_access_grants SET status = 'completed', completed_at = ? WHERE id = ?`)
      .bind(Date.now(), grantId)
      .run();
  }

  /** Ends every still-active grant of a task (task finished, cancelled or abandoned). */
  async endActiveForTask(workspaceId: string, taskId: string, status: "completed" | "revoked"): Promise<void> {
    const column = status === "completed" ? "completed_at" : "revoked_at";
    await this.db
      .prepare(
        `UPDATE browser_access_grants SET status = ?, ${column} = ?
          WHERE workspace_id = ? AND task_id = ? AND status NOT IN ('revoked', 'expired', 'completed')`,
      )
      .bind(status, Date.now(), workspaceId, taskId)
      .run();
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE browser_access_grants SET status = 'revoked', revoked_at = ? WHERE id = ?`)
      .bind(Date.now(), grantId)
      .run();
  }
}
