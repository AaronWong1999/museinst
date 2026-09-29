/// <reference lib="dom" />

//












import { Agent } from "agents";
import puppeteer from "@cloudflare/puppeteer";
import type { Browser, Page } from "@cloudflare/puppeteer";
import type { Env } from "../env";
import { callModel, type ModelMessage, type ToolDef } from "../model/call";
import { browserWorkerPrompt } from "./instructions";
import { clampText } from "../util";
import { getItemFields, getItemMeta } from "../vault/service";
import { getLoginTotpCode, setLoginTotpPending, activateLoginTotp, generateTotp, parseOtpAuthUri } from "../vault/totp";
import { detectTotpPrompt } from "../vault/totp-detector";
import { extractEnrollmentSecret, hasEnrollmentSuccessEvidence, requiresOwnerApprovalForEnrollment } from "../vault/totp-enrollment";
import { TaskSecretScrubber } from "./secret-scrub";
import { addEvidence, addStep } from "../tasks/tasks";

interface AssignPayload {
  workspaceId: string;
  taskId: string;
  goal: string;
  startUrl: string;
  vaultHints: string[];
  lang: "zh" | "en";
}

export type BrowserExpectedInput =
  | { kind: "otp"; minLength?: number; maxLength?: number; pattern?: string }
  | { kind: "manual_done" }
  | { kind: "choice"; options: string[] }
  | { kind: "free_text"; promptId?: string; resumeToken?: string };

export interface BrowserInputTarget {
  elementRole?: string;
  elementType?: string;
  selectorRef?: string;
  origin?: string;
}

export type BrowserHandoffReasonCode =
  | "credentials"
  | "mfa"
  | "passkey"
  | "captcha"
  | "sensitive_confirmation"
  | "automation_blocked"
  | "manual_interaction"
  | "user_requested";

/**
 * Agent-initiated handoff request (§14.9). The agent never attempts to defeat
 * CAPTCHA or MFA; it parks the turn and hands control to the human.
 */
export interface BrowserHandoffRequest {
  reasonCode: BrowserHandoffReasonCode;
  instructions: string;
  privacyMode: "normal" | "secret_entry";
  preferredView: "tab";
  origin?: string;
  expiresAt?: number;
}

export interface WorkerOutcome {
  status: "done" | "needs_input" | "needs_approval" | "needs_handoff" | "failed";
  result?: unknown;
  question?: string;
  error?: string;
  workerSessionId?: string;
  expectedInput?: BrowserExpectedInput;
  inputTarget?: BrowserInputTarget;
  expiresAt?: number;
  origin?: string;
  handoff?: BrowserHandoffRequest;
  /** Set when the loop halted on a stale control_epoch / user_active state. */
  staleControlEpoch?: boolean;

  usage?: { input?: number; output?: number; browserMs?: number };
  evidence?: Array<{ type: string; value: string }>;
}

interface ElementRef {
  ref: number;
  tag: string;
  type: string;
  text: string;
  x: number;
  y: number;
  offscreen: boolean;
  password: boolean;
}





const MAX_STEPS_DEFAULT = 30;
const STEP_TIMEOUT_DEFAULT_MS = 360_000;
const STEP_TIMEOUT_CAP_MS = 600_000;

function envInt(v: string | undefined, dflt: number, cap?: number): number {
  const n = Number(v ?? "");
  if (!Number.isFinite(n) || n <= 0) return dflt;
  const i = Math.floor(n);
  return cap === undefined ? i : Math.min(i, cap);
}

const MASK_CSS = `[data-vault-secret="true"]{color:transparent !important;-webkit-text-security:disc !important;text-shadow:0 0 8px black !important;}`;


const PAYMENT_RE = /(支付|付款|提交订单|确认订单|结算|place order|checkout|pay now|confirm purchase|submit payment|下单|立即购买)/i;

export class BrowserWorker extends Agent<Env, Record<string, never>> {
  declare env: Env;
  initialState = {};



  private taskSecrets = new TaskSecretScrubber();

  private clearTaskSecrets(): void {
    this.taskSecrets.clear();
  }

  private registerTaskSecret(value: unknown): void {
    this.taskSecrets.register(value);
  }

  private scrubSecrets(text: string): string {
    return this.taskSecrets.scrub(text);
  }

  onStart(): void {
    for (const stmt of [
      `CREATE TABLE IF NOT EXISTS sessions (task_id TEXT PRIMARY KEY, session_id TEXT, created_at INTEGER, last_used_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS task_state (task_id TEXT PRIMARY KEY, status TEXT, goal TEXT, start_url TEXT, vault_hints TEXT, lang TEXT, question TEXT, updated_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS used_vault_items (task_id TEXT, candidate_id TEXT, PRIMARY KEY(task_id, candidate_id))`,
      // §14.16 — append-only steer history; the current goal is task_state.goal.
      `CREATE TABLE IF NOT EXISTS task_goal_revisions (task_id TEXT NOT NULL, revision INTEGER NOT NULL, goal TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(task_id, revision))`,
      // §14.18 — single controller across devices. One row per task.
      `CREATE TABLE IF NOT EXISTS control_leases (task_id TEXT PRIMARY KEY, controller_device_id TEXT, lease_expires_at INTEGER, updated_at INTEGER NOT NULL)`,
    ]) {
      this.ctx.storage.sql.exec(stmt);
    }
    for (const col of [
      "target_id TEXT",
      "title TEXT",
      "url TEXT",
      "state TEXT DEFAULT 'created'",
      "control_epoch INTEGER DEFAULT 0",
      "goal_revision INTEGER DEFAULT 0",
      // §14.9 — a parked handoff keeps its reason/instructions across restarts.
      "handoff_reason TEXT",
      "handoff_instructions TEXT",
      "handoff_privacy_mode TEXT",
    ]) {
      try {
        this.ctx.storage.sql.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
      } catch {
        // Column may already exist
      }
    }
  }

  /** Current control epoch for a task, or 0 when no session row exists. */
  private controlEpochFor(taskId: string): number {
    const rows = this.ctx.storage.sql
      .exec(`SELECT control_epoch FROM sessions WHERE task_id = ?`, taskId)
      .toArray() as any[];
    return (rows[0] as any)?.control_epoch ?? 0;
  }

  // ── Browser session publication (DEFECT-022, §13/§25.7) ────────────────────
  // The Computer → Browser tab polls D1 (browser_sessions), which previously
  // only saw handoff grants — a normal agent-run browser task was invisible.
  // The DO therefore publishes its real sessions to D1, fire-and-forget: a
  // publication failure must never affect task execution or fail-closed gates.

  /** D1 id for a task's published session row (stable across start/update). */
  private static publishedSessionId(workspaceId: string, taskId: string): string {
    return `bs_${workspaceId}_${taskId}`;
  }

  private publishSessionStart(p: AssignPayload, opts: { freshRun: boolean } = { freshRun: true }): void {
    const now = Date.now();
    try {
      this.env.DB.prepare(
        `INSERT INTO browser_sessions (id, workspace_id, task_id, url, title, state, observed_text, started_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           task_id=excluded.task_id, url=excluded.url, title=NULL, state='active',
           observed_text=NULL, started_at=excluded.started_at, updated_at=excluded.updated_at, ended_at=NULL`,
      )
        .bind(
          BrowserWorker.publishedSessionId(p.workspaceId, p.taskId),
          p.workspaceId,
          p.taskId ?? null,
          p.startUrl ?? null,
          now,
          now,
        )
        .run()
        .catch(() => {});
    } catch {
      // Publication is best-effort by design.
    }
    // Only a fresh run owns the DO-local state machine; a resumed run must not
    // clobber `user_active`/`handoff_requested` parked by a takeover.
    if (opts.freshRun) this.setDoSessionState(p.taskId, "watch_available");
  }

  private publishSessionEnd(
    workspaceId: string,
    taskId: string,
    state: "completed" | "failed",
    opts: { url?: string; title?: string; observedText?: string } = {},
  ): void {
    const now = Date.now();
    try {
      this.env.DB.prepare(
        `UPDATE browser_sessions SET state=?, url=COALESCE(?, url), title=COALESCE(?, title), observed_text=COALESCE(?, observed_text), updated_at=?, ended_at=? WHERE id=?`,
      )
        .bind(state, opts.url ?? null, opts.title ?? null, opts.observedText ?? null, now, now, BrowserWorker.publishedSessionId(workspaceId, taskId))
        .run()
        .catch(() => {});
    } catch {
      // Publication is best-effort by design.
    }
    this.setDoSessionState(taskId, state);
  }

  /** Flip the DO-local sessions row terminal state if such a column exists. */
  private setDoSessionState(taskId: string, state: string): void {
    try {
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET state=?, last_used_at=? WHERE task_id=?`,
        state,
        Date.now(),
        taskId,
      );
    } catch {}
  }

  /** Last known URL of the DO-local session row, or null. */
  private doSessionUrl(taskId: string): string | null {
    try {
      const rows = this.ctx.storage.sql
        .exec(`SELECT url FROM sessions WHERE task_id = ?`, taskId)
        .toArray() as any[];
      return (rows[0] as any)?.url ?? null;
    } catch {
      return null;
    }
  }

  /**
   * True while a human holds the write lease (§14.5, §14.18). The lease is
   * authoritative: an expired lease means the human is gone and the agent may
   * resume, but an active lease always wins.
   */
  private humanHoldsControl(taskId: string, nowMs: number = Date.now()): boolean {
    const rows = this.ctx.storage.sql
      .exec(`SELECT lease_expires_at FROM control_leases WHERE task_id = ?`, taskId)
      .toArray() as any[];
    const exp = (rows[0] as any)?.lease_expires_at;
    return typeof exp === "number" && exp > nowMs;
  }

  private setControlLease(taskId: string, deviceId: string | null, expiresAt: number | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO control_leases (task_id, controller_device_id, lease_expires_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET controller_device_id=excluded.controller_device_id,
         lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at`,
      taskId,
      deviceId,
      expiresAt,
      Date.now(),
    );
  }

  /** Parked handoff policy for a task (§14.9, §14.15). */
  private loadPolicy(taskId: string): { privacyMode: "normal" | "secret_entry"; reason: string | null } {
    const rows = this.ctx.storage.sql
      .exec(`SELECT handoff_privacy_mode, handoff_reason FROM sessions WHERE task_id = ?`, taskId)
      .toArray() as any[];
    const mode = (rows[0] as any)?.handoff_privacy_mode;
    return {
      privacyMode: mode === "secret_entry" ? "secret_entry" : "normal",
      reason: (rows[0] as any)?.handoff_reason ?? null,
    };
  }

  override async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/assign" && req.method === "POST") {
      const p = (await req.json()) as AssignPayload;
      const outcome = await this.runTask(p);
      return Response.json(outcome);
    }
    if (url.pathname === "/input" && req.method === "POST") {

      const p = (await req.json()) as { taskId: string; input: string; inputKind?: string; workspaceId: string };
      const state = this.loadTaskState(p.taskId);
      if (!state) return Response.json({ status: "failed", error: "task_state_missing" });
      const outcome = await this.runTask(
        { workspaceId: p.workspaceId, taskId: p.taskId, goal: state.goal, startUrl: state.start_url, vaultHints: JSON.parse(state.vault_hints || "[]"), lang: (state.lang as "zh" | "en") ?? "zh" },
        { resumeInput: p.input, inputKind: p.inputKind },
      );
      return Response.json(outcome);
    }
    if (url.pathname === "/approve" && req.method === "POST") {
      const p = (await req.json()) as { taskId: string; workspaceId: string; proceed: boolean };
      const state = this.loadTaskState(p.taskId);
      if (!state) return Response.json({ status: "failed", error: "task_state_missing" });
      if (!p.proceed) {
        return Response.json({ status: "failed", error: "denied_by_user" });
      }
      const outcome = await this.runTask(
        { workspaceId: p.workspaceId, taskId: p.taskId, goal: state.goal, startUrl: state.start_url, vaultHints: JSON.parse(state.vault_hints || "[]"), lang: (state.lang as "zh" | "en") ?? "zh" },
        { resumeAfterApproval: true },
      );
      return Response.json(outcome);
    }
    if (url.pathname.startsWith("/session/") && req.method === "GET") {
      const taskId = decodeURIComponent(url.pathname.slice("/session/".length));
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM sessions WHERE task_id = ?`, taskId)
        .toArray() as any[];
      if (!rows.length) return new Response("session_not_found", { status: 404 });
      const row = rows[0];
      const leaseRows = this.ctx.storage.sql
        .exec(`SELECT controller_device_id, lease_expires_at FROM control_leases WHERE task_id = ?`, taskId)
        .toArray() as any[];
      const leaseExpiresAt = (leaseRows[0] as any)?.lease_expires_at ?? null;
      return Response.json({
        taskId: row.task_id,
        sessionId: row.session_id,
        targetId: row.target_id ?? "",
        title: row.title ?? "",
        url: row.url ?? "",
        state: row.state ?? "watch_available",
        controlEpoch: row.control_epoch ?? 0,
        goalRevision: row.goal_revision ?? 0,
        handoffReason: row.handoff_reason ?? null,
        privacyMode: row.handoff_privacy_mode ?? "normal",
        controlLease: {
          heldBy: (leaseRows[0] as any)?.controller_device_id ?? null,
          expiresAt: leaseExpiresAt,
          held: typeof leaseExpiresAt === "number" && leaseExpiresAt > Date.now(),
        },
      });
    }
    if (url.pathname === "/takeover" && req.method === "POST") {
      const p = (await req.json()) as { taskId: string; deviceId?: string; leaseDurationMs?: number };
      const curEpoch = this.controlEpochFor(p.taskId);
      const now = Date.now();
      const leaseDurationMs = Math.min(Math.max(p.leaseDurationMs ?? 10 * 60_000, 60_000), 30 * 60_000);
      const leaseExpiresAt = now + leaseDurationMs;

      // §14.18 — a second controller is refused while another device holds an
      // unexpired lease. Readonly Watch is unaffected (readers never take a lease).
      if (this.humanHoldsControl(p.taskId, now)) {
        const lease = this.ctx.storage.sql
          .exec(`SELECT controller_device_id, lease_expires_at FROM control_leases WHERE task_id = ?`, p.taskId)
          .toArray() as any[];
        const heldBy = (lease[0] as any)?.controller_device_id;
        if (heldBy && p.deviceId && heldBy !== p.deviceId) {
          return Response.json(
            { success: false, error: "control_held_by_other_device", leaseExpiresAt: (lease[0] as any)?.lease_expires_at },
            { status: 409 },
          );
        }
      }

      // A previous controller whose lease lapsed may still have its interactive
      // view open. Cut it off before a new controller gets write access, so two
      // humans can never write to the same tab.
      const prevRows = this.ctx.storage.sql
        .exec(`SELECT controller_device_id FROM control_leases WHERE task_id = ?`, p.taskId)
        .toArray() as any[];
      const prevDevice = (prevRows[0] as any)?.controller_device_id ?? null;
      let targetId: string | null | undefined;
      if (prevDevice && prevDevice !== (p.deviceId ?? null)) {
        const revoked = await this.revokeLiveViewers(p.taskId);
        if (!revoked.ok) return Response.json({ success: false, error: revoked.error }, { status: 502 });
        targetId = revoked.targetId;
      }

      const nextEpoch = curEpoch + 1;
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET state='user_active', control_epoch=?, last_used_at=? WHERE task_id=?`,
        nextEpoch,
        now,
        p.taskId,
      );
      this.setControlLease(p.taskId, p.deviceId ?? null, leaseExpiresAt);
      return Response.json({ success: true, controlEpoch: nextEpoch, leaseExpiresAt, ...(targetId !== undefined ? { targetId } : {}) });
    }
    if (url.pathname === "/done" && req.method === "POST") {
      const p = (await req.json()) as { taskId: string };
      // Hand-back is only real once the human's interactive view is gone.
      let targetId: string | null | undefined;
      if (this.hadHumanController(p.taskId)) {
        const revoked = await this.revokeLiveViewers(p.taskId);
        if (!revoked.ok) return Response.json({ success: false, error: revoked.error }, { status: 502 });
        targetId = revoked.targetId;
      }
      const curEpoch = this.controlEpochFor(p.taskId);
      const nextEpoch = curEpoch + 1;
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET state='completing', control_epoch=?, last_used_at=? WHERE task_id=?`,
        nextEpoch,
        now,
        p.taskId,
      );

      this.setControlLease(p.taskId, null, null);
      return Response.json({ success: true, controlEpoch: nextEpoch, ...(targetId !== undefined ? { targetId } : {}) });
    }
    if (url.pathname === "/cancel" && req.method === "POST") {
      const p = (await req.json()) as { taskId: string; workspaceId?: string; reason?: string };
      // A cancelled task keeps nothing: end the browser session so neither a
      // viewer nor an idle cloud browser outlives it. Cancellation itself must
      // not depend on this succeeding.
      await this.revokeLiveViewers(p.taskId, { closeSession: true }).catch(() => {});
      const curEpoch = this.controlEpochFor(p.taskId);
      const nextEpoch = curEpoch + 1;
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET state='cancelled', control_epoch=?, last_used_at=? WHERE task_id=?`,
        nextEpoch,
        now,
        p.taskId,
      );
      this.setControlLease(p.taskId, null, null);
      this.ctx.storage.sql.exec(`UPDATE task_state SET status='cancelled', updated_at=? WHERE task_id=?`, now, p.taskId);
      if (p.workspaceId) {
        this.publishSessionEnd(p.workspaceId, p.taskId, "failed", { observedText: clampText(p.reason || "cancelled", 200) });
        // publishSessionEnd flips the DO row to "failed"; cancellation wins.
        this.setDoSessionState(p.taskId, "cancelled");
      }
      return Response.json({ success: true, controlEpoch: nextEpoch });
    }
    if (url.pathname === "/steer" && req.method === "POST") {
      const p = (await req.json()) as {
        taskId: string;
        goal: string;
        source?: "user" | "agent" | "system";
        expectedRevision?: number;
      };
      const rows = this.ctx.storage.sql
        .exec(`SELECT goal_revision FROM sessions WHERE task_id = ?`, p.taskId)
        .toArray() as any[];
      const curRev = (rows[0] as any)?.goal_revision ?? 0;

      // §14.16 — optimistic concurrency: a caller that read revision N must not
      // silently overwrite a goal that has since moved on.
      if (typeof p.expectedRevision === "number" && p.expectedRevision !== curRev) {
        return Response.json(
          { ok: false, error: "stale_goal_revision", revision: curRev },
          { status: 409 },
        );
      }

      const nextRev = curRev + 1;
      const now = Date.now();
      const source = p.source ?? "user";
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET goal_revision=?, last_used_at=? WHERE task_id=?`,
        nextRev,
        now,
        p.taskId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE task_state SET goal=?, updated_at=? WHERE task_id=?`,
        p.goal,
        now,
        p.taskId,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO task_goal_revisions (task_id, revision, goal, source, created_at) VALUES (?, ?, ?, ?, ?)`,
        p.taskId,
        nextRev,
        p.goal,
        source,
        now,
      );

      // §14.16 — while the human writes, a steer is persisted but not applied;
      // the agent picks up the latest revision after Done.
      const applied: "immediate" | "queued_until_handoff_complete" =
        this.humanHoldsControl(p.taskId, now) ? "queued_until_handoff_complete" : "immediate";
      return Response.json({ ok: true, taskId: p.taskId, revision: nextRev, applied });
    }
    if (url.pathname === "/lease" && req.method === "POST") {
      const p = (await req.json()) as { taskId: string; deviceId?: string; leaseDurationMs?: number };
      const now = Date.now();
      if (this.humanHoldsControl(p.taskId, now)) {
        const rows = this.ctx.storage.sql
          .exec(`SELECT controller_device_id, lease_expires_at FROM control_leases WHERE task_id = ?`, p.taskId)
          .toArray() as any[];
        const heldBy = (rows[0] as any)?.controller_device_id;
        if (heldBy && p.deviceId && heldBy !== p.deviceId) {
          return Response.json({ success: false, error: "control_held_by_other_device" }, { status: 409 });
        }
      }
      const leaseDurationMs = Math.min(Math.max(p.leaseDurationMs ?? 10 * 60_000, 60_000), 30 * 60_000);
      this.setControlLease(p.taskId, p.deviceId ?? null, now + leaseDurationMs);
      return Response.json({ success: true, leaseExpiresAt: now + leaseDurationMs });
    }
    if (url.pathname === "/goal-revisions" && req.method === "GET") {
      const taskId = url.searchParams.get("taskId") || "";
      const rows = this.ctx.storage.sql
        .exec(`SELECT revision, goal, source, created_at FROM task_goal_revisions WHERE task_id = ? ORDER BY revision ASC`, taskId)
        .toArray() as any[];
      return Response.json({ revisions: rows });
    }
    if (url.pathname === "/wipe" && req.method === "POST") {
      for (const row of this.ctx.storage.sql.exec(`SELECT task_id FROM sessions`).toArray() as Array<{ task_id: string }>) {
        await this.revokeLiveViewers(row.task_id, { closeSession: true }).catch(() => {});
      }
      for (const t of ["sessions", "task_state", "used_vault_items", "task_goal_revisions", "control_leases"]) {
        this.ctx.storage.sql.exec(`DELETE FROM ${t}`);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  private loadTaskState(taskId: string): { goal: string; start_url: string; vault_hints: string; lang: string } | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT goal, start_url, vault_hints, lang FROM task_state WHERE task_id = ?`, taskId)
      .toArray() as any[];
    return (rows[0] as { goal: string; start_url: string; vault_hints: string; lang: string }) ?? null;
  }



  private async acquireBrowser(taskId: string): Promise<{ browser: Browser; sessionId: string; continuity: "reconnected" | "new_session" } | { error: string }> {

    // Optional per-workspace cap. puppeteer.limits() lists the whole Cloudflare
    // account's sessions, so only sessions this workspace's BrowserWorker owns
    // are counted; unset / 0 means no app-level cap (the provider's own account
    // limit still applies and surfaces as launch_failed).
    const max = Number(this.env.BROWSER_MAX_CONCURRENT || 0);
    if (Number.isInteger(max) && max > 0) {
      try {
        const limits = await puppeteer.limits(this.env.BROWSER as any);
        const active = new Set(limits.activeSessions.map((s) => s.id));
        const mine = (this.ctx.storage.sql.exec(`SELECT task_id, session_id FROM sessions`).toArray() as any[])
          .filter((r) => r.task_id !== taskId && active.has(r.session_id));
        const known = this.sessionIdFor(taskId);
        const reconnecting = !!known && active.has(known);
        if (!reconnecting && mine.length >= max) return { error: "browser_concurrency_limit" };
      } catch {
        // Limits failure does not block execution
      }
    }

    const known = this.sessionIdFor(taskId);
    if (known) {
      try {
        const browser = await puppeteer.connect(this.env.BROWSER as any, known);
        return { browser, sessionId: known, continuity: "reconnected" };
      } catch {
        this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE task_id = ?`, taskId);
      }
    }
    try {
      const browser = await puppeteer.launch(this.env.BROWSER as any, { keep_alive: 600_000 });
      const sessionId = browser.sessionId();
      this.ctx.storage.sql.exec(
        `INSERT INTO sessions (task_id, session_id, created_at, last_used_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id, last_used_at=excluded.last_used_at`,
        taskId,
        sessionId,
        Date.now(),
        Date.now(),
      );
      return { browser, sessionId, continuity: "new_session" };
    } catch (e) {
      return { error: `launch_failed: ${String(e).slice(0, 200)}` };
    }
  }

  private sessionIdFor(taskId: string): string | null {
    const rows = this.ctx.storage.sql.exec(`SELECT session_id FROM sessions WHERE task_id = ?`, taskId).toArray() as any[];
    return (rows[0] as any)?.session_id ?? null;
  }

  /**
   * Revokes every live-view viewer of a task (§14.8). Cloudflare live views
   * are scoped to one tab and the provider has no revoke API, so the only way
   * to cut off an already-connected viewer is to close its tab. The page is
   * reopened at the same URL in the same browser session, so cookies and
   * storage survive, then every other page is closed and verified gone.
   * Fails closed: if an old page cannot be proven closed, control is not
   * handed back.
   */
  private async revokeLiveViewers(
    taskId: string,
    opts: { closeSession?: boolean } = {},
  ): Promise<{ ok: true; targetId: string | null } | { ok: false; error: string }> {
    const known = this.sessionIdFor(taskId);
    if (!known) return { ok: true, targetId: null };

    let browser: Browser;
    try {
      browser = await puppeteer.connect(this.env.BROWSER as any, known);
    } catch {
      // A session that no longer exists has no viewers left. One that still
      // exists but refuses a connection cannot be proven revoked.
      const alive = await puppeteer
        .sessions(this.env.BROWSER as any)
        .then((list) => list.some((s) => s.sessionId === known))
        .catch(() => true);
      if (alive) return { ok: false, error: "revoke_unconfirmed" };
      this.ctx.storage.sql.exec(`UPDATE sessions SET target_id=NULL WHERE task_id=?`, taskId);
      return { ok: true, targetId: null };
    }

    try {
      if (opts.closeSession) {
        await browser.close();
        this.ctx.storage.sql.exec(`UPDATE sessions SET target_id=NULL WHERE task_id=?`, taskId);
        return { ok: true, targetId: null };
      }

      const oldPages = await browser.pages();
      const rows = this.ctx.storage.sql
        .exec(`SELECT url FROM sessions WHERE task_id = ?`, taskId)
        .toArray() as any[];
      const lastUrl = oldPages.map((pg) => pg.url()).find((u) => u && u !== "about:blank") || (rows[0] as any)?.url || "";

      const fresh = await browser.newPage();
      if (lastUrl && /^https?:/i.test(lastUrl)) {
        await fresh.goto(lastUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      }
      for (const pg of oldPages) {
        await pg.close().catch(() => {});
      }

      const remaining = (await browser.pages()).filter((pg) => pg !== fresh);
      if (remaining.length > 0) return { ok: false, error: "revoke_unconfirmed" };

      const targetId =
        (fresh as any).target?.()?._targetId ||
        (fresh as any).target?.()?.targetId ||
        "";
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET target_id=?, url=?, last_used_at=? WHERE task_id=?`,
        targetId || null,
        fresh.url(),
        Date.now(),
        taskId,
      );
      return { ok: true, targetId: targetId || null };
    } catch (e) {
      return { ok: false, error: `revoke_failed: ${String(e).slice(0, 120)}` };
    } finally {
      try {
        browser.disconnect();
      } catch {}
    }
  }

  /** True when a previous human controller may still hold a live interactive view. */
  private hadHumanController(taskId: string): boolean {
    const rows = this.ctx.storage.sql
      .exec(`SELECT controller_device_id FROM control_leases WHERE task_id = ?`, taskId)
      .toArray() as any[];
    return !!(rows[0] as any)?.controller_device_id;
  }



  private async runTask(p: AssignPayload, resume?: { resumeInput?: string; resumeAfterApproval?: boolean; inputKind?: string }): Promise<WorkerOutcome> {
    this.onStart();
    const deadline = Date.now() + envInt(this.env.BROWSER_TASK_TIMEOUT_MS, STEP_TIMEOUT_DEFAULT_MS, STEP_TIMEOUT_CAP_MS);
    this.ctx.storage.sql.exec(
      `INSERT INTO task_state (task_id, status, goal, start_url, vault_hints, lang, updated_at)
       VALUES (?, 'running', ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET status='running', goal=excluded.goal, updated_at=excluded.updated_at`,
      p.taskId,
      p.goal,
      p.startUrl,
      JSON.stringify(p.vaultHints),
      p.lang,
      Date.now(),
    );

    const startedAt = Date.now();
    // §13/§25.7 — publish the real browser session to D1 so the Computer →
    // Browser tab shows it even without any handoff grant (DEFECT-022).
    this.publishSessionStart(p, { freshRun: !resume });
    const usage: { input?: number; output?: number; browserMs?: number } = { input: 0, output: 0, browserMs: 0 };
    const withUsage = <T extends WorkerOutcome>(o: T): T => {

      const scrubResult = (res: unknown): unknown => {
        if (typeof res === "string") return this.scrubSecrets(res);
        if (res && typeof res === "object") {
          const r = res as Record<string, unknown>;
          if (typeof r.summary === "string") return { ...r, summary: this.scrubSecrets(r.summary) };
        }
        return res;
      };
      const out: unknown = {
        ...o,
        usage: {
          ...usage,
          browserMs: Date.now() - startedAt,
        },
        result: o.result !== undefined ? scrubResult(o.result) : undefined,
        error: o.error ? this.scrubSecrets(String(o.error)) : undefined,
        question: o.question ? this.scrubSecrets(String(o.question)) : undefined,
        evidence: o.evidence?.map((e) => ({ type: e.type, value: this.scrubSecrets(String(e.value ?? "")) })),
      };
      return out as T;
    };


    if (!resume) {
      this.clearTaskSecrets();
    } else {

      try {
        const rows = this.ctx.storage.sql
          .exec(`SELECT candidate_id FROM used_vault_items WHERE task_id = ?`, p.taskId)
          .toArray() as Array<{ candidate_id: string }>;
        for (const r of rows) {
          const f = await getItemFields(this.env, p.workspaceId, r.candidate_id);
          if (f) {
            this.registerTaskSecret(f.password);
            this.registerTaskSecret(f.identifier ?? f.username ?? f.email ?? f.account);
            this.registerTaskSecret(f.otp);
            this.registerTaskSecret(f.token);
            this.registerTaskSecret(f.secret);
            this.registerTaskSecret(f.authCode);
          }
        }
      } catch {}
    }

    const acquired = await this.acquireBrowser(p.taskId);
    if ("error" in acquired) {
      this.publishSessionEnd(p.workspaceId, p.taskId, "failed", { url: p.startUrl, observedText: clampText(acquired.error, 200) });
      return withUsage({ status: "failed", error: acquired.error });
    }
    const { browser, continuity } = acquired;


    if (resume && continuity === "new_session") {
      this.publishSessionEnd(p.workspaceId, p.taskId, "failed", { url: p.startUrl, observedText: "browser_session_expired" });
      return withUsage({ status: "failed", error: "browser_session_expired" });
    }

    try {
      const pages = await browser.pages();
      const page: Page = pages[0] ?? (await browser.newPage());
      await page.setViewport({ width: 1280, height: 800 }).catch(() => {});
      const cdp = await page.createCDPSession();


      await cdp.send("Emulation.setUserAgentOverride", {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        acceptLanguage: p.lang === "zh" ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9",
        platform: "MacIntel",
      } as any).catch(() => {});
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
      } as any).catch(() => {});

      if (!resume) {
        await page.goto(p.startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => {
          throw new Error(`navigation_failed: ${String(e).slice(0, 120)}`);
        });
      } else if (resume.resumeInput) {

        if (resume.inputKind !== "manual_done") {

          if (resume.inputKind === "otp" || /^\d{4,8}$/.test(resume.resumeInput.trim())) {
            this.registerTaskSecret(resume.resumeInput.trim());
          }
          try {
            await cdp.send("Input.insertText", { text: resume.resumeInput } as any);
          } catch (err) {

            return withUsage({
              status: "failed",
              error: `input_injection_failed: ${String(err).slice(0, 120)}`,
            });
          }
        }
      }

      await this.timelineShot(p, page, "start");

      const targetId =
        (page as any).target?.()?._targetId ||
        (page as any).target?.()?.targetId ||
        (await cdp.send("Target.getTargetInfo" as any).then((r: any) => r?.targetInfo?.targetId).catch(() => "")) ||
        "";
      try {
        const title = await page.title().catch(() => "");
        const url = page.url();
        this.ctx.storage.sql.exec(
          `UPDATE sessions SET target_id=?, title=?, url=?, state='agent_active', last_used_at=? WHERE task_id=?`,
          targetId,
          title,
          url,
          Date.now(),
          p.taskId,
        );
      } catch {}

      const messages: ModelMessage[] = [
        { role: "system", content: browserWorkerPrompt(p.lang, p.goal) },
        { role: "user", content: `目标站点：${p.startUrl}${p.vaultHints.length ? `\n可用 Vault 候选：${p.vaultHints.join(", ")}` : ""}${resume?.resumeAfterApproval ? "\n\n（用户已批准，继续执行之前被拦下的动作）" : ""}${resume?.inputKind === "manual_done" ? "\n\n（用户已完成人工接管并把浏览器交还给你，当前页面就是用户操作后的状态。先重新感知页面，再从这里继续完成任务，不要重复用户已完成的步骤，也不要再次为同一原因调用 request_handoff。如果任务目标只是把浏览器交给用户，直接 finish，并概括当前页面的状态。）" : ""}` },
      ];

      const defs: ToolDef[] = browserToolDefs();
      let lastStateHash = "";
      let noProgressSteps = 0;
      let lastPerception = "";


      let maxSteps = envInt(this.env.BROWSER_MAX_STEPS, MAX_STEPS_DEFAULT);
      try {
        const pref = await this.env.DB.prepare(
          `SELECT value FROM settings WHERE workspace_id=? AND key='browser_max_steps'`,
        ).bind(p.workspaceId).first<{ value: string }>();
        const n = Number(pref?.value);
        if (Number.isFinite(n) && n > 0) maxSteps = Math.max(Math.floor(n), 1);
      } catch {                  }

      // §14.6 — snapshot the control version this loop owns. Any later bump
      // (takeover / done / cancel / session replacement) makes this loop stale.
      const epochAtStart = this.controlEpochFor(p.taskId);
      const policy = this.loadPolicy(p.taskId);

      for (let step = 0; step < maxSteps; step++) {
        const sessionRows = this.ctx.storage.sql
          .exec(`SELECT control_epoch, state FROM sessions WHERE task_id = ?`, p.taskId)
          .toArray() as any[];
        const curState = (sessionRows[0] as any)?.state;
        const curEpoch = (sessionRows[0] as any)?.control_epoch ?? 0;

        // §14.6 — any control hand-off invalidates the running loop. The agent
        // must not keep clicking after the user took over, the task was
        // cancelled/expired, or the session was lost.
        if (
          curEpoch !== epochAtStart ||
          curState === "user_active" ||
          curState === "handoff_requested" ||
          curState === "cancelled" ||
          curState === "expired" ||
          curState === "session_lost" ||
          curState === "completed"
        ) {
          return withUsage({
            status: "failed",
            error: "stale_control_epoch",
            staleControlEpoch: true,
            workerSessionId: browser.sessionId(),
          });
        }

        // §14.18 — a live human lease always wins, even before the state row
        // itself is flipped, so a second writer can never interleave.
        if (this.humanHoldsControl(p.taskId)) {
          return withUsage({
            status: "failed",
            error: "stale_control_epoch",
            staleControlEpoch: true,
            workerSessionId: browser.sessionId(),
          });
        }

        // §14.15 privacy shield — while the session is parked for secret entry
        // the model must not perceive the page at all: no screenshot, no DOM.
        // We keep the loop alive but frozen until the human finishes.
        if (policy.privacyMode === "secret_entry") {
          await new Promise((r) => setTimeout(r, 1000));
          step--;
          continue;
        }

        if (Date.now() > deadline) {
          this.publishSessionEnd(p.workspaceId, p.taskId, "failed", { url: page.url(), observedText: "task_timeout" });
          return withUsage({ status: "failed", error: "task_timeout", workerSessionId: browser.sessionId() });
        }
        const perception = await this.perceive(page);
        lastPerception = perception.text;

        perception.text = this.scrubSecrets(perception.text);



        if (perception.stateHash === lastStateHash) noProgressSteps++;
        else noProgressSteps = 0;
        lastStateHash = perception.stateHash;

        const mode = this.env.BROWSER_PERCEPTION ?? "hybrid";
        let parts: import("../model/call").ContentPart[] | undefined;
        if (mode === "vision") {
          parts = [
            { type: "text", text: `${perception.text.split("\n")[0]}\n${perception.text.split("\n")[1] ?? ""}\n（vision 模式：请看截图判断页面）`.trim() },
            { type: "image_url", image_url: { url: await this.shotDataUri(page) } },
          ];
        } else if (mode === "hybrid" && (noProgressSteps >= 2 || perception.elementCount < 5)) {
          parts = [
            { type: "text", text: noProgressSteps >= 2 ? `${perception.text}\n\n[系统] 已连续 ${noProgressSteps} 步无进展，附上截图帮你判断是否有遮挡/弹窗/视觉陷阱。` : perception.text },
            { type: "image_url", image_url: { url: await this.shotDataUri(page) } },
          ];
        }
        const content: import("../model/call").ContentPart[] | string = parts ?? perception.text;

        const prefix = step === 0 && resume?.resumeInput
          ? `${typeof content === "string" ? content : content[0].type === "text" ? content[0].text : ""}\n\n[系统] 用户已输入，已注入聚焦框。继续验证并推进。`
          : null;
        const messageContent = prefix && typeof content === "string" ? prefix : content;
        messages.push(prefix && typeof content !== "string"
          ? { role: "user", content: [{ type: "text", text: prefix }, ...content.slice(1)] }
          : { role: "user", content: messageContent });

        let result;
        try {

          result = await callModel(this.env, "worker", messages, { tools: defs, temperature: 0.2 });
        } catch (e) {
          this.publishSessionEnd(p.workspaceId, p.taskId, "failed", {
            url: page.url(),
            observedText: clampText(`worker_model: ${String(e).slice(0, 160)}`, 200),
          });
          return withUsage({ status: "failed", error: `worker_model: ${String(e).slice(0, 160)}`, workerSessionId: browser.sessionId() });
        }
        if (result.usage) {
          usage.input = (usage.input ?? 0) + result.usage.input;
          usage.output = (usage.output ?? 0) + result.usage.output;
        }

        if (result.toolCalls.length === 0) {
          messages.push({ role: "assistant", content: result.text || "" });
          messages.push({ role: "user", content: "（你没有调用任何工具。要么调用一个动作工具，要么用 finish 结束。）" });
          continue;
        }
        messages.push({
          role: "assistant",
          content: result.text || null,
          tool_calls: result.toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
        });

        let stop: WorkerOutcome | null = null;
        for (const tc of result.toolCalls) {


          const actionAlreadySent = tc.name !== "browser_snapshot" && tc.name !== "screenshot" && tc.name !== "capture_browser_image";
          void actionAlreadySent;
          const r = await this.execAction(tc, page, cdp, p, browser);
          if (r.outcome) {
            stop = r.outcome;
            break;
          }

          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: this.scrubSecrets(r.content) });
        }
        if (stop) {
          // Terminal worker outcomes already published via finish/execAction.
          if (!stop.evidence && stop.status === "failed") {
            this.publishSessionEnd(p.workspaceId, p.taskId, "failed", { url: page.url(), observedText: clampText(String(stop.error ?? ""), 200) });
          }
          return withUsage({ ...stop, workerSessionId: browser.sessionId() });
        }
      }
      this.publishSessionEnd(p.workspaceId, p.taskId, "failed", {
        url: this.doSessionUrl(p.taskId) || p.startUrl,
        observedText: clampText(`max_steps_reached（最后感知：${clampText(lastPerception, 120)}）`, 200),
      });
      return withUsage({
        status: "failed",
        error: `max_steps_reached（最后感知：${clampText(lastPerception, 160)}）`,
        workerSessionId: browser.sessionId(),
      });
    } catch (e) {
      const msg = String(e);
      const friendly = this.isTransientNavError(e)
        ? "页面刚刚发生跳转，旧页面上下文失效。我没有把这当作任务成功；请重新尝试。"
        : msg.slice(0, 300);
      this.publishSessionEnd(p.workspaceId, p.taskId, "failed", {
        url: this.doSessionUrl(p.taskId) || p.startUrl,
        observedText: clampText(friendly, 200),
      });
      return withUsage({ status: "failed", error: friendly });
    }
  }



  private static readonly TRANSIENT_CONTEXT_RES = [
    /execution context was destroyed/i,
    /execution context[^a-z0-9]+(destroyed|invalid|lost)/i,
    /frame (was )?detached/i,
    /target closed/i,
    /context (id )?lost/i,
    /session (with given id )?not found/i,
    /cannot find context/i,
  ];
  private static readonly REAL_NETWORK_RES = [
    /net::err_/i,
    /dns/i,
    /cert/i,
    /ssl/i,
    /tls/i,
    /connection (refused|reset|timed out|aborted)/i,
    /navigation_failed/i,
    /launch_failed/i,
  ];

  private isTransientNavError(err: unknown): boolean {
    const msg = String(err);
    if (BrowserWorker.REAL_NETWORK_RES.some((re) => re.test(msg))) return false;
    return BrowserWorker.TRANSIENT_CONTEXT_RES.some((re) => re.test(msg));
  }


  private async waitForDocumentSettled(
    page: Page,
    opts: { beforeUrl: string; beforeTitle?: string; deadlineMs: number; pollMs?: number; stableSamples?: number },
  ): Promise<{ settled: boolean; url: string }> {
    const deadline = Date.now() + opts.deadlineMs;
    const pollMs = opts.pollMs ?? 400;
    const need = opts.stableSamples ?? 2;
    let stable = 0;
    let lastSig = "";
    for (;;) {
      if (Date.now() > deadline) {
        try { return { settled: false, url: page.url() }; } catch { return { settled: false, url: opts.beforeUrl }; }
      }
      let sig = "";
      let url = opts.beforeUrl;
      try {
        url = page.url();
        const title = await page.title().catch(() => "");

        sig = `${url}|${title}`;
      } catch {
        sig = `unreadable:${Date.now()}`;
      }
      if (sig === lastSig) stable++;
      else { stable = 0; lastSig = sig; }
      if (sig !== `${opts.beforeUrl}|${opts.beforeTitle ?? ""}` && stable >= need) {
        return { settled: true, url };
      }

      if (stable >= need + 1) return { settled: true, url };
      await this.sleep(pollMs);
    }
  }


  private async reacquirePageContext(
    page: Page,
    cdp: any,
    attempt: number,
  ): Promise<{ cdp: any; recovered: boolean }> {
    void attempt;
    try {
      const fresh = await page.createCDPSession().catch(() => null);
      const nextCdp = fresh ?? cdp;

      await this.perceiveRaw(page);
      return { cdp: nextCdp, recovered: true };
    } catch {
      return { cdp, recovered: false };
    }
  }



  private async perceive(page: Page): Promise<{ text: string; elementCount: number; stateHash: string }> {
    let recoveries = 0;
    for (;;) {
      try {
        const r = await this.perceiveRaw(page);
        return r;
      } catch (err) {
        if (!this.isTransientNavError(err) || recoveries >= 3) throw err;
        recoveries++;

        try { await (page.createCDPSession().catch(() => null)); } catch {          }
        await this.sleep(800);
        try {
          return await this.perceiveRaw(page);
        } catch (err2) {
          if (!this.isTransientNavError(err2) || recoveries >= 3) {
            throw new Error("页面刚刚发生跳转，旧页面上下文失效。我没有把这当作任务成功；需要重新读取当前页面。");
          }

        }
      }
    }
  }

  private async perceiveRaw(page: Page): Promise<{ text: string; elementCount: number; stateHash: string }> {
    const map = await page.evaluate((): { url: string; title: string; elements: ElementRef[] } => {
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== "hidden" && st.display !== "none";
      };
      const nodes = Array.from(
        document.querySelectorAll(
          "a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[onclick],[type=submit]",
        ),
      ) as HTMLElement[];
      const vh = window.innerHeight;
      const elements = nodes
        .filter(visible)
        .slice(0, 80)
        .map((el, i) => {
          const r = el.getBoundingClientRect();
          const isPassword = (el as HTMLInputElement).type === "password";
          const isInput = el.tagName.toLowerCase() === "input" || el.tagName.toLowerCase() === "textarea";
          let text = "";
          if (isPassword) {
            text = (el as HTMLInputElement).value ? "[filled]" : "[empty]";
          } else if (isInput) {
            const inputType = ((el as HTMLInputElement).type || "text").toLowerCase();
            const attrStr = (
              (el.getAttribute("name") || "") + " " +
              (el.getAttribute("id") || "") + " " +
              (el.getAttribute("placeholder") || "") + " " +
              (el.getAttribute("aria-label") || "")
            ).toLowerCase();
            const isLoginIdentifier = ["email", "tel", "text"].includes(inputType) &&
              /user|name|login|email|phone|account|账号|用户名|手机|邮箱/i.test(attrStr);
            const hasSecretAttr = el.getAttribute("data-vault-secret") === "true";
            const val = (el as HTMLInputElement).value || "";
            const placeholder = (el as HTMLInputElement).placeholder || el.getAttribute("aria-label") || "";
            if (hasSecretAttr || isLoginIdentifier) {
              const state = val ? "[filled]" : "[empty]";
              text = placeholder ? `${placeholder} ${state}` : state;
            } else {
              text = (val || placeholder || el.getAttribute("aria-label") || "").trim().slice(0, 60);
            }
          } else {
            text = (el.innerText || el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60);
          }

          return {
            ref: i,
            tag: el.tagName.toLowerCase(),
            type: (el as HTMLInputElement).type ?? "",
            text,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            offscreen: r.y + r.height / 2 > vh * 0.96,
            password: isPassword,
          };
        });
      return { url: location.href, title: document.title, elements };
    });
    const lines = map.elements.map(
      (e) => `[${e.ref}] ${e.tag}${e.type ? `(${e.type})` : ""}${e.password ? " 🔑" : ""}${e.offscreen ? " ⬇️需滚动" : ""} "${e.text.replace(/\s+/g, " ")}" @(${e.x},${e.y})`,
    );
    const text = `URL: ${map.url}\n标题: ${map.title}\n可交互元素：\n${lines.join("\n") || "（无）"}`;
    const stateHash = `${map.url}|${map.title}|${lines.join(";").slice(0, 400)}`;
    return { text, elementCount: map.elements.length, stateHash };
  }






  private async safeCaptureScreenshot(
    page: Page,
    options: {
      type?: "jpeg" | "png";
      quality?: number;
      fullPage?: boolean;
      clip?: { x: number; y: number; width: number; height: number };
    } = {},
  ): Promise<Uint8Array> {
    const frames = page.frames ? page.frames() : [];
    let main: any = null;
    try { main = page.mainFrame ? page.mainFrame() : null; } catch {}
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const isMain = frame === main || i === 0;
      try {
        await frame.addStyleTag({ content: MASK_CSS });
      } catch (err) {
        if (isMain) {
          throw new Error(`screenshot_failed: main frame masking failed: ${String(err)}`);
        }

        if (this.taskSecrets.size > 0) {
          const covered = await page.evaluate((frameUrl: string) => {
            const iframes = Array.from(document.querySelectorAll("iframe"));
            for (const ifr of iframes) {
              if (ifr.src && ifr.src.includes(frameUrl)) {
                if (!(ifr as any).__openinst_orig_style) {
                  (ifr as any).__openinst_orig_style = {
                    visibility: ifr.style.visibility || "",
                    filter: ifr.style.filter || "",
                  };
                }
                ifr.style.visibility = "hidden";
                ifr.style.filter = "blur(16px)";
                return true;
              }
            }
            return false;
          }, frame.url()).catch(() => false);
          if (!covered) {
            throw new Error("screenshot_failed: cross-origin frame could not be masked securely (fail-closed)");
          }
        }
      }
    }
    try {
      await this.sleep(100);
      const opts: any = {
        type: options.type ?? "jpeg",
        captureBeyondViewport: false,
        ...options,
      };
      if (opts.type === "jpeg" && opts.quality === undefined) {
        opts.quality = 70;
      }
      const buf = (await page.screenshot(opts)) as unknown as Uint8Array;
      return new Uint8Array(buf);
    } finally {

      if (typeof page.evaluate === "function") {
        await page.evaluate(() => {
          const iframes = Array.from(document.querySelectorAll("iframe"));
          for (const ifr of iframes) {
            if ((ifr as any).__openinst_orig_style) {
              ifr.style.visibility = (ifr as any).__openinst_orig_style.visibility;
              ifr.style.filter = (ifr as any).__openinst_orig_style.filter;
              delete (ifr as any).__openinst_orig_style;
            }
          }
        }).catch(() => {});
      }
    }
  }


  private async shotDataUri(page: Page): Promise<string> {
    const buf = await this.safeCaptureScreenshot(page, { type: "jpeg", quality: 70 });
    let bin = "";
    for (const b of buf) bin += String.fromCharCode(b);
    return `data:image/jpeg;base64,${btoa(bin)}`;
  }



  private async execAction(
    tc: { id: string; name: string; args: Record<string, unknown> },
    page: Page,
    cdp: any,
    p: AssignPayload,
    browser: Browser,
  ): Promise<{ content: string; outcome?: WorkerOutcome }> {
    const lang: "zh" | "en" = p.lang ?? "zh";
    try {
      switch (tc.name) {
        case "navigate": {
          const url = String(tc.args.url);
          if (!/^https?:\/\//i.test(url)) return { content: "URL 必须 http(s) 开头" };
          const beforeUrl = (() => { try { return page.url(); } catch { return ""; } })();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });

          await this.waitForDocumentSettled(page, { beforeUrl, deadlineMs: 15_000 });
          await this.timelineShot(p, page, `nav-${Date.now()}`);
          return { content: `已打开 ${url}` };
        }
        case "back": {
          const beforeUrl = (() => { try { return page.url(); } catch { return ""; } })();
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
          await this.waitForDocumentSettled(page, { beforeUrl, deadlineMs: 10_000 });
          return { content: "已后退。" };
        }
        case "click": {
          const el = await this.findRef(page, Number(tc.args.ref));
          if (!el) return { content: `ref ${tc.args.ref} 不存在（页面可能已变化，重新看感知）` };
          if (el.offscreen) return { content: "元素在屏幕外，先 scroll。" };
          const label = el.text.slice(0, 40);
          if (PAYMENT_RE.test(label) && !this.loadTaskState(p.taskId)?.goal?.match(PAYMENT_RE)) {

            return {
              content: "",
              outcome: {
                status: "needs_approval",
                question: lang === "zh"
                  ? `浏览器正要点击「${label}」（疑似支付/提交）。批准继续吗？`
                  : `About to click "${label}" (payment/submit). Approve?`,
              },
            };
          }

          if (requiresOwnerApprovalForEnrollment(label)) {
            return {
              content: "",
              outcome: {
                status: "needs_approval",
                question: lang === "zh"
                  ? `浏览器正要执行「${label}」（更改 MFA/Authenticator 安全设置）。批准继续吗？`
                  : `About to click "${label}" (security/MFA change). Approve?`,
              },
            };
          }
          const beforeUrl = (() => { try { return page.url(); } catch { return ""; } })();
          await page.mouse.click(el.x, el.y);

          await this.waitForDocumentSettled(page, { beforeUrl, deadlineMs: 12_000 });
          return { content: `已点击 [${el.ref}] "${label}"` };
        }
        case "type": {
          const el = await this.findRef(page, Number(tc.args.ref));
          if (!el) return { content: `ref ${tc.args.ref} 不存在` };
          await page.mouse.click(el.x, el.y);
          await this.sleep(250);
          const text = String(tc.args.text ?? "");

          await cdp.send("Input.insertText", { text } as any);
          await this.sleep(200);
          return { content: `已输入 ${el.password ? "******" : `"${text.slice(0, 30)}"`} 到 [${el.ref}]` };
        }
        case "press": {
          const key = String(tc.args.key ?? "Enter");
          const beforeUrl = (() => { try { return page.url(); } catch { return ""; } })();
          await cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            windowsVirtualKeyCode: key === "Enter" ? 13 : key === "Tab" ? 9 : 0,
          } as any);
          await cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            windowsVirtualKeyCode: key === "Enter" ? 13 : key === "Tab" ? 9 : 0,
          } as any);

          await this.waitForDocumentSettled(page, { beforeUrl, deadlineMs: 10_000 });
          return { content: `已按 ${key}` };
        }
        case "scroll": {
          const dy = Number(tc.args.dy ?? 600);
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: 640,
            y: 400,
            deltaX: 0,
            deltaY: dy,
          } as any);
          await this.sleep(500);
          return { content: `已滚动 ${dy > 0 ? "向下" : "向上"} ${Math.abs(dy)}px` };
        }
        case "wait": {
          await this.sleep(Math.min(Number(tc.args.ms ?? 1500), 8000));
          return { content: "等待完成。" };
        }
        case "screenshot": {
          const key = await this.captureWithMask(p, page, String(tc.args.note ?? ""));
          return { content: `截图已存：${key}（用户可在任务时间线查看）` };
        }
        case "capture_browser_image": {
          const mode = (tc.args.source as any) || "viewport";
          const res = await this.captureBrowserImage(p, page, {
            source: mode,
            selector: tc.args.selector ? String(tc.args.selector) : undefined,
            label: tc.args.label ? String(tc.args.label) : undefined,
          });
          return { content: `图像已捕获并存为制品 [${res.format}]：${res.key}` };
        }
        case "browser_snapshot": {
          const snap = await this.getSemanticSnapshot(page);
          return { content: `页面语义快照：\n${snap}` };
        }
        case "fill_from_vault": {
          const r = await this.fillFromVault(p, page, cdp, String(tc.args.candidateId));
          return r;
        }
        case "fill_totp_from_vault": {
          const r = await this.fillTotpFromVault(p, page, cdp, String(tc.args.candidateId), tc.args.ref ? Number(tc.args.ref) : undefined);
          return r;
        }
        case "capture_totp_enrollment": {
          return await this.captureTotpEnrollment(p, page, cdp, String(tc.args.candidateId ?? ""), tc.args.verifyRef ? Number(tc.args.verifyRef) : undefined);
        }
        case "verify_login": {





          const probe = await page.evaluate((): {
            passwordFields: number;
            loginMarkers: number;
            url: string;
            title: string;
            strongSignals: string[];
            genericSignals: string[];
          } => {
            const visible = (el: Element): boolean => {
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const st = getComputedStyle(el);
              return st.visibility !== "hidden" && st.display !== "none";
            };
            const passwordFields = Array.from(document.querySelectorAll('input[type="password"]')).filter((el) => visible(el)).length;
            const text = (document.body?.innerText ?? "").slice(0, 4000).toLowerCase();
            const loginKeywords = ["sign in", "log in", "登录", "登入", "请输入密码", "enter your password"];
            const loginMarkers = loginKeywords.filter((m) => text.includes(m)).length;


            const strongKeywords = [
              "logout", "log out", "sign out", "退出登录", "退出", "注销",
              "my account", "我的账户", "个人中心", "用户中心",
            ];

            const genericKeywords = [
              "profile", "dashboard", "控制台", "welcome,", "welcome to", "欢迎您",
            ];

            const interactiveElements = Array.from(document.querySelectorAll("a, button, [role='button'], nav, header")).filter(visible);
            const strongSignals: string[] = [];
            const genericSignals: string[] = [];

            for (const el of interactiveElements) {
              const elText = (el.textContent || el.getAttribute("aria-label") || "").toLowerCase().trim();
              for (const kw of strongKeywords) {
                if (elText.includes(kw)) {
                  strongSignals.push(kw);
                  break;
                }
              }
              for (const kw of genericKeywords) {
                if (elText.includes(kw)) {
                  genericSignals.push(kw);
                  break;
                }
              }
            }
            if (strongSignals.length === 0) {
              for (const kw of ["退出登录", "注销", "logout", "sign out"]) {
                if (text.includes(kw)) {
                  strongSignals.push(kw);
                }
              }
            }
            return { passwordFields, loginMarkers, url: location.href, title: document.title, strongSignals, genericSignals };
          });

          const hasStrongSignal = probe.strongSignals.length > 0;
          const formDisappeared = probe.passwordFields === 0 && probe.loginMarkers === 0;

          let authStatus: "verified" | "appears_authenticated" | "unauthenticated";
          if (hasStrongSignal && probe.passwordFields === 0) {
            authStatus = "verified";
          } else if (formDisappeared || probe.genericSignals.length > 0) {
            authStatus = "appears_authenticated";
          } else {
            authStatus = "unauthenticated";
          }

          const isVerified = authStatus === "verified";
          this.taskSecrets.setLoginVerification([
            { type: "observed_text", value: (probe.title || probe.url).slice(0, 200) },
            { type: "final_url", value: probe.url },
            { type: "authenticated", value: isVerified ? "yes" : "no" },
            { type: "auth_status", value: authStatus },
            { type: "observed_at", value: new Date().toISOString() },
          ]);

          let note = "";
          if (authStatus === "verified") {
            note = `已确认已认证状态（强正向信号：${probe.strongSignals.slice(0, 3).join(", ")}，页面无密码框）。`;
            return { content: `verify_login：已认证状态。${note}\n（已通过正向信号严格确认登录态）` };
          } else if (authStatus === "appears_authenticated") {
            const hint = probe.genericSignals.length > 0 ? `（检测到通用标记：${probe.genericSignals.slice(0, 3).join(", ")}）` : "";
            note = `页面无密码框且无登录表单标记${hint}，但缺乏退出登录/明确账户等强正向登录信号。无法确认是否真正登录成功（可能处于 404/错误页/公开主页/验证码页）。`;
            return { content: `verify_login：未确认已认证。${note}\n（请如实转述为未完全确认，切勿声称已成功登录。）` };
          } else {
            note = `页面上仍有 ${probe.passwordFields} 个密码框 / ${probe.loginMarkers} 个登录表单标记。`;
            return { content: `verify_login：未确认已认证。${note}\n（请把该结果如实转述；登录失败时不要声称已登录。）` };
          }
        }
        case "request_human": {
          const kind = (tc.args.input_kind as any) || "manual_done";
          const minLen = typeof tc.args.min_length === "number" ? tc.args.min_length : undefined;
          const maxLen = typeof tc.args.max_length === "number" ? tc.args.max_length : undefined;
          const pattern = typeof tc.args.pattern === "string" ? tc.args.pattern : undefined;
          const options = Array.isArray(tc.args.options) ? tc.args.options.map(String) : undefined;
          const promptId = typeof tc.args.prompt_id === "string" ? tc.args.prompt_id : undefined;

          let expectedInput: BrowserExpectedInput;
          if (kind === "otp") {
            expectedInput = { kind: "otp", minLength: minLen ?? 4, maxLength: maxLen ?? 8, pattern };
          } else if (kind === "choice" && options && options.length > 0) {
            expectedInput = { kind: "choice", options };
          } else if (kind === "free_text") {
            const token = `T${Math.floor(1000 + Math.random() * 9000)}`;
            expectedInput = { kind: "free_text", promptId: promptId ?? `prompt_${Date.now()}`, resumeToken: token };
          } else {
            expectedInput = { kind: "manual_done" };
          }

          let origin = "";
          try { origin = new URL(page.url()).origin; } catch {}

          return {
            content: "",
            outcome: {
              status: "needs_input",
              question: String(tc.args.question ?? "需要用户输入"),
              expectedInput,
              origin,
              expiresAt: Date.now() + 10 * 60_000,
            },
          };
        }
        case "request_handoff": {
          // §14.9 — the agent hands control to the human instead of trying to
          // defeat CAPTCHA/MFA/device approval. The turn is parked by the
          // PersonalAgent, a grant is minted, and the loop stops here.
          const reasonCode = String(tc.args.reason_code ?? "manual_interaction") as BrowserHandoffReasonCode;
          const allowedReasons: BrowserHandoffReasonCode[] = [
            "credentials",
            "mfa",
            "passkey",
            "captcha",
            "sensitive_confirmation",
            "automation_blocked",
            "manual_interaction",
            "user_requested",
          ];
          const safeReason = allowedReasons.includes(reasonCode) ? reasonCode : "manual_interaction";
          const privacyMode = tc.args.privacy_mode === "secret_entry" ? "secret_entry" : "normal";
          let origin = "";
          try { origin = new URL(page.url()).origin; } catch {}

          const handoff: BrowserHandoffRequest = {
            reasonCode: safeReason,
            instructions: String(tc.args.instructions ?? "请在浏览器中完成这一步，然后交还给 Agent。").slice(0, 400),
            privacyMode,
            preferredView: "tab",
            origin: origin || undefined,
            expiresAt: Date.now() + 10 * 60_000,
          };

          // Persist the handoff policy so the frozen loop and the UI agree.
          this.ctx.storage.sql.exec(
            `UPDATE sessions SET state='handoff_requested', handoff_reason=?, handoff_instructions=?, handoff_privacy_mode=?, last_used_at=? WHERE task_id=?`,
            safeReason,
            handoff.instructions,
            privacyMode,
            Date.now(),
            p.taskId,
          );

          return {
            content: "",
            outcome: {
              status: "needs_handoff",
              workerSessionId: browser.sessionId(),
              handoff,
              origin,
              expiresAt: handoff.expiresAt,
            },
          };
        }
        case "request_approval": {
          return {
            content: "",
            outcome: { status: "needs_approval", question: String(tc.args.summary ?? "需要用户批准") },
          };
        }
        case "finish": {
          const success = !!tc.args.success;
          const summary = String(tc.args.summary ?? "");
          const evidence = Array.isArray(tc.args.evidence)
            ? (tc.args.evidence as Array<{ type: string; value: string }>)
            : [];
          await this.timelineShot(p, page, "final");

          const hasObservation = evidence.some((e) => /^observed/i.test(String(e.type ?? "")) && String(e.value ?? "").trim().length > 0);
          if (success && !hasObservation) {
            return {
              content: "（finish 被拒绝：success=true 但没有 observed_* 证据。请先用 browser_snapshot/页面文本观察你要确认的值，然后再次 finish 并在 evidence 里给出 type=observed_text 的条目。仅到达页面不算完成。）",
            };
          }

          const finalUrl = page.url();
          const pageTitle = await page.title().catch(() => "");
          const runtimeEvidence = [
            ...(this.taskSecrets.takeLoginVerification() ?? []),
            { type: "final_url", value: finalUrl },
            ...(pageTitle ? [{ type: "page_title", value: pageTitle.slice(0, 300) }] : []),
            { type: "observed_at", value: new Date().toISOString() },
          ];
          // Publish the terminal session state to D1 alongside the outcome
          // (same evidence feed; best-effort, never blocks the finish gate).
          const observedFact =
            evidence.find((e) => /^observed/i.test(String(e.type ?? "")) && String(e.value ?? "").trim().length > 0)
              ?.value ?? summary;
          this.publishSessionEnd(p.workspaceId, p.taskId, success ? "completed" : "failed", {
            url: finalUrl,
            title: pageTitle,
            observedText: clampText(String(observedFact ?? ""), 200),
          });
          return {
            content: "",
            outcome: success
              ? { status: "done", result: { success: true, summary }, evidence: [...evidence, ...runtimeEvidence] }
              : { status: "failed", error: summary || "worker 报告失败", evidence: [...evidence, ...runtimeEvidence] },
          };
        }
        default:
          return { content: `未知工具 ${tc.name}` };
      }
    } catch (e) {
      return { content: `动作失败：${String(e).slice(0, 200)}` };
    }
  }

  private async findRef(page: Page, ref: number): Promise<ElementRef | null> {
    const map = await page.evaluate((want: number): { elements: ElementRef[] } => {
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== "hidden" && st.display !== "none";
      };
      const nodes = Array.from(
        document.querySelectorAll(
          "a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[onclick],[type=submit]",
        ),
      ) as HTMLElement[];
      const vh = window.innerHeight;
      return {
        elements: nodes
          .filter(visible)
          .slice(0, 80)
          .map((el, i) => {
            const r = el.getBoundingClientRect();
            const isPassword = (el as HTMLInputElement).type === "password";
            const isInput = el.tagName.toLowerCase() === "input" || el.tagName.toLowerCase() === "textarea";
            let text = "";
            if (isPassword) {
              text = (el as HTMLInputElement).value ? "[filled]" : "[empty]";
            } else if (isInput) {
              const inputType = ((el as HTMLInputElement).type || "text").toLowerCase();
              const attrStr = (
                (el.getAttribute("name") || "") + " " +
                (el.getAttribute("id") || "") + " " +
                (el.getAttribute("placeholder") || "") + " " +
                (el.getAttribute("aria-label") || "")
              ).toLowerCase();
              const isLoginIdentifier = ["email", "tel", "text"].includes(inputType) &&
                /user|name|login|email|phone|account|账号|用户名|手机|邮箱/i.test(attrStr);
              const hasSecretAttr = el.getAttribute("data-vault-secret") === "true";
              const val = (el as HTMLInputElement).value || "";
              const placeholder = (el as HTMLInputElement).placeholder || el.getAttribute("aria-label") || "";
              if (hasSecretAttr || isLoginIdentifier) {
                const state = val ? "[filled]" : "[empty]";
                text = placeholder ? `${placeholder} ${state}` : state;
              } else {
                text = (val || placeholder || el.getAttribute("aria-label") || "").trim().slice(0, 60);
              }
            } else {
              text = (el.innerText || el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60);
            }

            return {
              ref: i,
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type ?? "",
              text,
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
              offscreen: r.y + r.height / 2 > vh * 0.96,
              password: isPassword,
            };
          }),
      };
    }, ref);
    return map.elements.find((e) => e.ref === ref) ?? null;
  }



  private async fillFromVault(
    p: AssignPayload,
    page: Page,
    cdp: any,
    candidateId: string,
  ): Promise<{ content: string }> {
    const meta = await getItemMeta(this.env, p.workspaceId, candidateId);
    if (!meta) return { content: `Vault 候选 ${candidateId} 不存在` };
    const fields = await getItemFields(this.env, p.workspaceId, candidateId);
    if (!fields) return { content: "Vault 条目损坏或主密钥变更" };

    const currentOrigin = new URL(page.url()).origin;
    if (meta.kind === "login") {
      if (!meta.origin) return { content: "该 login 条目没有绑定站点 origin（请在控制台补全），拒绝注入以防钓鱼" };
      if (meta.origin !== currentOrigin) {

        await page.goto(meta.origin, { waitUntil: "domcontentloaded", timeout: 45_000 });
      }
    }


    const targets = await this.collectInputTargets(page, meta.origin ?? currentOrigin);
    if (targets.length === 0) return { content: "页面上没找到输入框（可能需要先点击登录入口）" };

    let filled = 0;
    const identifier = fields.identifier ?? fields.username ?? fields.email ?? fields.account ?? "";
    const password = fields.password ?? "";
    const otpish = fields.otp ?? "";

    if (identifier) this.registerTaskSecret(identifier);
    if (password) this.registerTaskSecret(password);
    if (otpish) this.registerTaskSecret(otpish);
    this.registerTaskSecret(fields.token);
    this.registerTaskSecret(fields.secret);
    this.registerTaskSecret(fields.authCode);


    try {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO used_vault_items (task_id, candidate_id) VALUES (?, ?)`,
        p.taskId,
        candidateId,
      );
    } catch {}

    let identifierFilled = false;
    let passwordFilled = false;

    for (const t of targets) {
      if (!t.isPassword && identifier && !identifierFilled && !t.filled) {
        await page.mouse.click(t.x, t.y);
        await this.sleep(200);
        await cdp.send("Input.insertText", { text: identifier } as any);
        await this.markSecret(page, t.frameIndex, t.selector);
        identifierFilled = true;
        filled++;
      } else if (t.isPassword && password && !passwordFilled && !t.filled) {
        await page.mouse.click(t.x, t.y);
        await this.sleep(200);
        await cdp.send("Input.insertText", { text: password } as any);
        await this.markSecret(page, t.frameIndex, t.selector);
        passwordFilled = true;
        filled++;
      }
    }
    void otpish;


    return { content: `fill_from_vault 完成：已填 ${filled} 个字段（明文已丢弃）` };
  }

  private async fillTotpFromVault(
    p: AssignPayload,
    page: Page,
    cdp: any,
    candidateId: string,
    targetRef?: number,
  ): Promise<{ content: string }> {
    if (this.env.TOTP_ENABLED !== "1") return { content: "totp_disabled" };
    const meta = await getItemMeta(this.env, p.workspaceId, candidateId);
    if (!meta) return { content: `Vault 候选 ${candidateId} 不存在` };
    if (meta.kind !== "login") return { content: "该 Vault 候选不是 login 类型凭据" };
    if (!meta.hasTotp) return { content: "该 Vault 候选未配置或未激活 Authenticator" };

    // TOTP is an authentication secret: never navigate to make an origin match.
    // Reject before decrypting fields or generating a code so cross-origin pages cannot materialize it.
    if (!meta.origin) return { content: "vault_totp_origin_missing" };
    let boundOrigin: string;
    let currentOrigin: string;
    try {
      boundOrigin = new URL(meta.origin).origin;
      currentOrigin = new URL(page.url()).origin;
    } catch {
      return { content: "vault_totp_origin_invalid" };
    }
    if (currentOrigin !== boundOrigin) return { content: "vault_totp_origin_mismatch" };

    const fields = await getItemFields(this.env, p.workspaceId, candidateId);
    if (!fields) return { content: "Vault 条目损坏或主密钥变更" };

    // 1. Detect target inputs and inspect negative/positive signals on page
    const pageProbe = await page.evaluate((): {
      elementText: string;
      nearbyText: string;
      inputs: Array<{
        selector: string;
        x: number;
        y: number;
        name: string;
        id: string;
        type: string;
        autocomplete: string;
        ariaLabel: string;
        placeholder: string;
        maxlength: number;
        filled: boolean;
      }>;
    } => {
      const allInputs = Array.from(
        document.querySelectorAll('input[type="text"],input[type="tel"],input[type="number"],input:not([type])')
      ) as HTMLInputElement[];

      const visibleInputs: any[] = [];
      for (let i = 0; i < allInputs.length; i++) {
        const el = allInputs[i];
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const st = window.getComputedStyle(el);
          if (st.visibility !== "hidden" && st.display !== "none") {
            visibleInputs.push({
              selector: `input[data-totp-idx="${i}"]`,
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              name: el.name || "",
              id: el.id || "",
              type: el.type || "",
              autocomplete: el.autocomplete || "",
              ariaLabel: el.getAttribute("aria-label") || "",
              placeholder: el.placeholder || "",
              maxlength: el.maxLength || 0,
              filled: Boolean(el.value),
            });
            el.setAttribute("data-totp-idx", String(i));
          }
        }
      }

      const headers = Array.from(document.querySelectorAll("h1, h2, h3, h4, p, label, form, .mfa, .2fa"))
        .map((e) => (e as HTMLElement).innerText || "")
        .join(" ");

      return {
        elementText: document.title + " " + headers,
        nearbyText: headers,
        inputs: visibleInputs,
      };
    });

    const detection = detectTotpPrompt({
      elementText: pageProbe.elementText,
      nearbyText: pageProbe.nearbyText,
      inputCount: pageProbe.inputs.length,
      attributes: pageProbe.inputs[0] ?? {},
    });

    if (!detection.isTotp) {
      if (detection.rejectedReason === "not_totp_prompt") {
        return { content: "not_totp_prompt: 检测到该页面为短信/邮件/推送或Passkey等其他MFA，非Authenticator，请使用request_human" };
      }
      return { content: `not_totp_prompt: 页面上未检测到两步验证码（TOTP）输入框 (${detection.rejectedReason})` };
    }

    // 2. Time boundary check (<5s wait next period)
    let codeRes = await getLoginTotpCode(this.env, p.workspaceId, candidateId);
    if (!codeRes.ok || !codeRes.code) {
      return { content: `获取动态验证码失败：${codeRes.error ?? "unknown"}` };
    }

    if (codeRes.remainingSeconds !== undefined && codeRes.remainingSeconds < 5) {
      const waitMs = (codeRes.remainingSeconds * 1000) + 300;
      await this.sleep(waitMs);
      codeRes = await getLoginTotpCode(this.env, p.workspaceId, candidateId);
      if (!codeRes.ok || !codeRes.code) {
        return { content: `重新获取动态验证码失败：${codeRes.error ?? "unknown"}` };
      }
    }

    const code = codeRes.code;

    // 3. Register secrets in scrubber
    this.registerTaskSecret(code);
    const totpConfig = (fields as Record<string, unknown>).__totp as { secretBase32?: string } | undefined;
    if (totpConfig?.secretBase32) {
      this.registerTaskSecret(totpConfig.secretBase32);
    }

    try {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO used_vault_items (task_id, candidate_id) VALUES (?, ?)`,
        p.taskId,
        candidateId,
      );
    } catch {}

    // 4. Fill code (V2 §24.4: at most ONE automatic fresh retry on explicit invalid/expired)
    const fillCode = async (value: string): Promise<void> => {
      const isSplit = pageProbe.inputs.length === value.length && (value.length === 6 || value.length === 8);
      if (isSplit) {
        for (let i = 0; i < pageProbe.inputs.length; i++) {
          const inp = pageProbe.inputs[i];
          await page.mouse.click(inp.x, inp.y);
          await this.sleep(50);
          await cdp.send("Input.insertText", { text: value[i] } as any);
          await this.markSecret(page, 0, inp.selector);
        }
      } else {
        const target = pageProbe.inputs[0];
        await page.mouse.click(target.x, target.y);
        await this.sleep(100);
        await cdp.send("Input.insertText", { text: value } as any);
        await this.markSecret(page, 0, target.selector);
      }
    };

    if (pageProbe.inputs.length === 0) {
      return { content: "页面上未找到可填写的输入框" };
    }

    await fillCode(code);

    // Explicit invalid/expired page feedback -> a single fresh retry (never brute-force).
    const feedback = await page.evaluate((): string => (document.body?.innerText || "").slice(0, 5000));
    const clearlyInvalid = /(invalid|incorrect|expired|wrong)\s*(code|otp|验证码)|(验证码|动态口令)[^。]{0,12}(错误|失效|过期|不正确)/i.test(feedback);
    if (clearlyInvalid) {
      const freshRes = await getLoginTotpCode(this.env, p.workspaceId, candidateId);
      if (freshRes.ok && freshRes.code && freshRes.code !== code) {
        this.registerTaskSecret(freshRes.code);
        await fillCode(freshRes.code);
      }
    }

    return { content: "Authenticator code filled." };
  }

  /** V2 §25: deterministic authenticator enrollment (pending -> active). Never sends QR/seed to the model. */
  private async captureTotpEnrollment(
    p: AssignPayload,
    page: Page,
    cdp: any,
    candidateId: string,
    verifyRef?: number,
  ): Promise<{ content: string }> {
    if (this.env.TOTP_ENABLED !== "1") return { content: "totp_disabled" };
    if (this.env.TOTP_ENROLLMENT_ENABLED !== "1") {
      return { content: "自动绑定 Authenticator 未启用（TOTP_ENROLLMENT_ENABLED=0），请提示主人手动添加。" };
    }

    // Enrollment can create a long-lived authentication secret. Bind it to the exact login origin
    // before reading any setup key/otpauth material from the page. Never auto-navigate here.
    const meta = await getItemMeta(this.env, p.workspaceId, candidateId);
    if (!meta || meta.kind !== "login") return { content: "vault_totp_enrollment_login_required" };
    if (!meta.origin) return { content: "vault_totp_enrollment_origin_missing" };
    let boundOrigin: string;
    let currentOrigin: string;
    try {
      boundOrigin = new URL(meta.origin).origin;
      currentOrigin = new URL(page.url()).origin;
    } catch {
      return { content: "vault_totp_enrollment_origin_invalid" };
    }
    if (currentOrigin !== boundOrigin) return { content: "vault_totp_enrollment_origin_mismatch" };

    // 1. Deterministic DOM extraction (no model vision)
    const candidates = await page.evaluate((): Array<{ text: string; value: string; href: string; dataAttrs: Record<string, string>; label: string }> => {
      const out: Array<{ text: string; value: string; href: string; dataAttrs: Record<string, string>; label: string }> = [];
      const push = (el: Element | null) => {
        if (!el) return;
        const dataAttrs: Record<string, string> = {};
        for (const a of Array.from(el.attributes ?? [])) {
          if (a.name.startsWith("data-")) dataAttrs[a.name] = a.value;
        }
        out.push({
          text: (el as HTMLElement).innerText || el.textContent || "",
          value: (el as HTMLInputElement).value || "",
          href: el.getAttribute("href") || "",
          dataAttrs,
          label: el.getAttribute("aria-label") || "",
        });
      };
      document.querySelectorAll("code, kbd, samp, pre, input, a, [data-secret], [data-key], [data-otpauth], [aria-label]").forEach(push);
      return out;
    });

    const extracted = extractEnrollmentSecret(candidates);
    if (!extracted.ok) {
      // 3/4: cannot deterministically decode -> ask owner for the key. NEVER send a QR screenshot to the model.
      return {
        content: "无法在页面上确定性提取设置密钥。请主人手动粘贴 setup key（不要把二维码截图发给模型）。",
      };
    }

    let config: { secretBase32: string; algorithm: "SHA1" | "SHA256" | "SHA512"; digits: 6 | 8; period: number; issuer?: string; accountName?: string; enrolledOrigin?: string };
    if (extracted.source === "otpauth_uri" && extracted.otpauthUri) {
      const parsed = parseOtpAuthUri(extracted.otpauthUri);
      if (!parsed.ok) return { content: `otpauth URI 解析失败：${parsed.error}` };
      config = { ...parsed.config, enrolledOrigin: page.url() };
    } else if (extracted.secretBase32) {
      config = { secretBase32: extracted.secretBase32, algorithm: "SHA1", digits: 6, period: 30, enrolledOrigin: page.url() };
    } else {
      return { content: "无法提取设置密钥，请主人手动粘贴。" };
    }

    // 2. setLoginTotpPending (never activates without proof)
    const pendingRes = await setLoginTotpPending(this.env, p.workspaceId, candidateId, config);
    if (!pendingRes.ok) return { content: `保存待验证 Authenticator 失败：${pendingRes.error ?? "unknown"}` };

    // 3. generate first code + fill verification input
    this.registerTaskSecret(config.secretBase32);
    const codeRes = await getLoginTotpCode(this.env, p.workspaceId, candidateId);
    // pending cannot generate: generate directly from config
    const code = codeRes.ok && codeRes.code ? codeRes.code : await generateTotp(config);
    this.registerTaskSecret(code);

    const probe = await page.evaluate((): { inputs: Array<{ selector: string; x: number; y: number; name: string; id: string; autocomplete: string; maxlength: number; filled: boolean }> } => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"],input[type="tel"],input[type="number"],input:not([type])')) as HTMLInputElement[];
      const visible: any[] = [];
      for (let i = 0; i < inputs.length; i++) {
        const el = inputs[i];
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const st = window.getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none") continue;
        el.setAttribute("data-totp-enroll-idx", String(i));
        visible.push({
          selector: `input[data-totp-enroll-idx="${i}"]`,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          name: el.name || "",
          id: el.id || "",
          autocomplete: el.autocomplete || "",
          maxlength: el.maxLength || 0,
          filled: Boolean(el.value),
        });
      }
      return { inputs: visible };
    });

    const target = probe.inputs.find((i) => /one-time-code/i.test(i.autocomplete))
      ?? probe.inputs.find((i) => /otp|totp|code|verif/i.test(i.name + " " + i.id))
      ?? probe.inputs.find((i) => i.maxlength === 6 || i.maxlength === 8);

    if (!target) {
      // Keep pending: owner must complete manually.
      return { content: "已保存待验证的 Authenticator（pending），但页面上未找到验证码输入框，请主人手动输入当前验证码完成绑定。" };
    }

    await page.mouse.click(target.x, target.y);
    await this.sleep(150);
    await cdp.send("Input.insertText", { text: code } as any);
    await this.markSecret(page, 0, target.selector);

    // 4. Success evidence (ambiguous -> keep pending)
    const evidence = await page.evaluate((): { enabledCopy: boolean; securityEntry: boolean } => {
      const body = (document.body?.innerText || "").toLowerCase();
      const enabledCopy = /(authenticator|two-factor|2fa|two-step|身份验证器|两步验证)[^.]{0,40}(enabled|set up|complete|added|成功|已启用|已添加)/i.test(body)
        || /(enabled|success|added)[^.]{0,20}(authenticator|2fa|two-factor)/i.test(body);
      const securityEntry = /(sign-?out|log ?out|退出登录)/i.test(body) && /(authenticator|2fa|two-factor|身份验证器)/i.test(body);
      return { enabledCopy, securityEntry };
    });

    if (hasEnrollmentSuccessEvidence({ ...evidence, subsequentChallenge: false })) {
      const actRes = await activateLoginTotp(this.env, p.workspaceId, candidateId);
      if (actRes.ok) return { content: "Authenticator enrollment completed (pending -> active)." };
      return { content: `已验证成功但激活失败：${actRes.error ?? "unknown"}` };
    }

    // Ambiguous -> remains pending, require owner confirmation.
    return { content: "验证码已填入，但页面未给出明确成功证据；Authenticator 保持 pending，请主人确认后手动激活。" };
  }

  private async collectInputTargets(
    page: Page,
    expectedOrigin: string,
  ): Promise<Array<{ x: number; y: number; isPassword: boolean; selector: string; frameIndex: number; filled: boolean }>> {
    const out: Array<{ x: number; y: number; isPassword: boolean; selector: string; frameIndex: number; filled: boolean }> = [];

    const main = await page.evaluate((): Array<{ selector: string; x: number; y: number; isPassword: boolean; filled: boolean }> => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"],input[type="email"],input[type="tel"],input[type="password"],input:not([type])')) as HTMLInputElement[];
      return inputs
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== "hidden" && !el.disabled && !el.readOnly;
        })
        .map((el, i) => {
          const r = el.getBoundingClientRect();
          return {
            selector: `input:nth-of-type(${i})`,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            isPassword: el.type === "password",
            filled: Boolean(el.value && el.value.trim().length > 0),
          };
        });
    }).catch(() => []);
    for (const t of main) out.push({ ...t, frameIndex: 0 });


    const frames = page.frames();
    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi];
      if (frame === page.mainFrame()) continue;
      try {
        const origin = new URL(frame.url()).origin;
        if (expectedOrigin && origin !== expectedOrigin && !frame.url().startsWith("http")) continue;
        const inFrame = await frame.evaluate((): Array<{ selector: string; rx: number; ry: number; isPassword: boolean; filled: boolean }> => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"],input[type="email"],input[type="tel"],input[type="password"],input:not([type])')) as HTMLInputElement[];
          return inputs
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && !el.disabled;
            })
            .map((el, i) => {
              const r = el.getBoundingClientRect();
              return {
                selector: `iframe-input-${i}`,
                rx: r.x + r.width / 2,
                ry: r.y + r.height / 2,
                isPassword: el.type === "password",
                filled: Boolean(el.value && el.value.trim().length > 0),
              };
            });
        });
        if (inFrame.length === 0) continue;

        const frameOffset = await page.evaluate((frameUrl: string): { ox: number; oy: number } | null => {
          const candidates = Array.from(document.querySelectorAll("iframe"));
          for (const c of candidates) {
            if ((c as HTMLIFrameElement).src && new URL((c as HTMLIFrameElement).src, location.href).toString() === frameUrl) {
              const r = c.getBoundingClientRect();
              return { ox: r.x, oy: r.y };
            }
          }
          return null;
        }, frame.url());
        if (!frameOffset) continue;
        for (const t of inFrame) {
          out.push({
            selector: t.selector,
            x: Math.round(frameOffset.ox + t.rx),
            y: Math.round(frameOffset.oy + t.ry),
            isPassword: t.isPassword,
            filled: t.filled,
            frameIndex: fi,
          });
        }
      } catch {

      }
    }
    return out;
  }

  private async markSecret(page: Page, frameIndex: number, selector: string): Promise<void> {
    const frame = frameIndex === 0 ? page.mainFrame() : page.frames()[frameIndex];
    if (!frame) return;
    await frame.evaluate((sel: string) => {
      const el = document.activeElement as HTMLElement | null;
      if (el) el.setAttribute("data-vault-secret", "true");
      void sel;
    }, selector).catch(() => {});
  }



  private async captureWithMask(p: AssignPayload, page: Page, note: string): Promise<string> {
    const buf = await this.safeCaptureScreenshot(page, { type: "jpeg", quality: 70 });
    const key = `${p.workspaceId}/${p.taskId}/${Date.now()}-${note ? note.replace(/\W+/g, "-").slice(0, 30) : "shot"}.jpg`;
    await this.env.ARTIFACTS.put(key, buf, { httpMetadata: { contentType: "image/jpeg" } });
    return key;
  }



  private async captureBrowserImage(
    p: AssignPayload,
    page: Page,
    opts: {
      source: "viewport" | "full_page" | "element" | "image_resource";
      selector?: string;
      label?: string;
    },
  ): Promise<{ key: string; format: string }> {
    const safeLabel = opts.label ? opts.label.replace(/\W+/g, "-").slice(0, 30) : "shot";
    const ts = Date.now();


    if (opts.source === "image_resource" && opts.selector) {
      try {
        const imgSrc = await page.$eval(opts.selector, (el) => {
          if (el instanceof HTMLImageElement && el.src) return el.src;
          const bg = window.getComputedStyle(el).backgroundImage;
          const match = bg.match(/url\(["']?([^"']+)["']?\)/);
          return match ? match[1] : null;
        });

        if (imgSrc && /^https?:\/\//i.test(imgSrc)) {
          const res = await fetch(imgSrc);
          if (res.ok) {
            const ab = await res.arrayBuffer();
            const ct = res.headers.get("content-type") || "image/jpeg";
            const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
            const key = `${p.workspaceId}/${p.taskId}/${ts}-${safeLabel}.${ext}`;
            await this.env.ARTIFACTS.put(key, ab, { httpMetadata: { contentType: ct } });
            return { key, format: ext };
          }
        }
      } catch {

      }
    }


    if (opts.source === "element" && opts.selector) {
      const el = await page.$(opts.selector);
      if (el) {
        const box = await el.boundingBox();
        if (box) {
          const buf = await this.safeCaptureScreenshot(page, {
            type: "png",
            clip: box,
          });
          const key = `${p.workspaceId}/${p.taskId}/${ts}-${safeLabel}.png`;
          await this.env.ARTIFACTS.put(key, buf, { httpMetadata: { contentType: "image/png" } });
          return { key, format: "png" };
        }
      }
    }


    const isFull = opts.source === "full_page";
    const buf = await this.safeCaptureScreenshot(page, {
      type: "jpeg",
      quality: 80,
      fullPage: isFull,
    });

    const key = `${p.workspaceId}/${p.taskId}/${ts}-${safeLabel}.jpg`;
    await this.env.ARTIFACTS.put(key, buf, { httpMetadata: { contentType: "image/jpeg" } });
    return { key, format: "jpg" };
  }



  private async getSemanticSnapshot(page: Page): Promise<string> {
    try {
      if ((page as any).accessibility && (page as any).accessibility.snapshot) {
        const axTree = await (page as any).accessibility.snapshot({ interestingOnly: true });
        return JSON.stringify(axTree, null, 2).slice(0, 4000);
      }
    } catch {}

    return await page.evaluate(() => {
      const items: string[] = [];
      document.querySelectorAll("button, a, input, select, textarea, [role='button']").forEach((el, idx) => {
        if (idx > 40) return;
        const isPassword = (el as HTMLInputElement).type === "password";
        const isInput = el.tagName.toLowerCase() === "input" || el.tagName.toLowerCase() === "textarea";
        let text = "";
        if (isPassword) {
          text = (el as HTMLInputElement).value ? "[filled]" : "[empty]";
        } else if (isInput) {
          const inputType = ((el as HTMLInputElement).type || "text").toLowerCase();
          const attrStr = (
            (el.getAttribute("name") || "") + " " +
            (el.getAttribute("id") || "") + " " +
            (el.getAttribute("placeholder") || "") + " " +
            (el.getAttribute("aria-label") || "")
          ).toLowerCase();
          const isLoginIdentifier = ["email", "tel", "text"].includes(inputType) &&
            /user|name|login|email|phone|account|账号|用户名|手机|邮箱/i.test(attrStr);
          const hasSecretAttr = el.getAttribute("data-vault-secret") === "true";
          const placeholder = (el as HTMLInputElement).placeholder || el.getAttribute("aria-label") || "";
          if (hasSecretAttr || isLoginIdentifier) {
            const state = (el as HTMLInputElement).value ? "[filled]" : "[empty]";
            text = placeholder ? `${placeholder} ${state}` : state;
          } else {
            text = ((el as HTMLInputElement).value || placeholder || "").trim().slice(0, 50);
          }
        } else {
          text = (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 50);
        }
        if (text) items.push(`${el.tagName.toLowerCase()}: "${text.slice(0, 50)}"`);
      });
      return items.join("\n");
    });
  }

  private async timelineShot(p: AssignPayload, page: Page, tag: string): Promise<void> {
    try {
      await this.captureWithMask(p, page, tag);
    } catch {

    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

function browserToolDefs(): ToolDef[] {
  return [
    { name: "navigate", description: "打开一个 URL。", parameters: { type: "object", properties: { url: { type: "string", description: "完整 URL" } }, required: ["url"] } },
    { name: "back", description: "后退一页。", parameters: { type: "object", properties: {} } },
    { name: "click", description: "点击感知列表里的元素（用 ref 编号）。支付/提交类按钮会触发审批。", parameters: { type: "object", properties: { ref: { type: "integer", description: "元素 ref" } }, required: ["ref"] } },
    { name: "type", description: "点击聚焦一个输入框（ref）并输入文本。密码框用 fill_from_vault，绝不用 type 输密码。", parameters: { type: "object", properties: { ref: { type: "integer" }, text: { type: "string" } }, required: ["ref", "text"] } },
    { name: "press", description: "按键（Enter/Tab/Escape）。", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
    { name: "scroll", description: "滚动页面。", parameters: { type: "object", properties: { dy: { type: "integer", description: "正=向下" } } } },
    { name: "wait", description: "等待页面加载/动画（毫秒）。", parameters: { type: "object", properties: { ms: { type: "integer" } } } },
    { name: "screenshot", description: "给用户截一张当前页面（自动打码 Vault 字段）。", parameters: { type: "object", properties: { note: { type: "string", description: "截图说明" } } } },
    {
      name: "capture_browser_image",
      description: "多模态高精度截图与图像制品捕获。支持 viewport（视口）、full_page（整页）、element（指定 CSS Selector 截取订单/票据卡片）和 image_resource（提取网页中未压缩原图）。",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["viewport", "full_page", "element", "image_resource"], description: "捕获模式" },
          selector: { type: "string", description: "element 或 image_resource 模式下的 CSS Selector" },
          label: { type: "string", description: "图片制品描述名称" },
        },
        required: ["source"],
      },
    },
    {
      name: "browser_snapshot",
      description: "获取当前页面的结构化语义无障碍快照，了解页面组件树与可交互节点。",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "fill_from_vault",
      description: "从 Vault 注入登录凭据到当前页面的输入框（只传 candidateId，你看不到明文）。login 条目会校验 origin，不匹配会自动先跳到绑定站点。",
      parameters: { type: "object", properties: { candidateId: { type: "string" } }, required: ["candidateId"] },
    },
    {
      name: "fill_totp_from_vault",
      description: "从 Vault 注入两步验证器（TOTP Authenticator App）动态验证码（只传 candidateId，你看不到明文）。遇到短信/邮件/Passkey 等其他 MFA 请使用 request_human，切勿使用本工具。",
      parameters: {
        type: "object",
        properties: {
          candidateId: { type: "string", description: "Vault 中已绑定 Authenticator 的 login 项 ID" },
          ref: { type: "integer", description: "可选：目标验证码输入框的元素 ref" },
        },
        required: ["candidateId"],
      },
    },
    {
      name: "capture_totp_enrollment",
      description: "为 Vault login 项自动绑定 Authenticator（仅 owner 授权的浏览器任务，需 TOTP_ENROLLMENT_ENABLED）。确定性提取页面上的 otpauth URI 或手工 setup key；绝不把二维码发给模型。成功证据明确才 pending->active，否则保持 pending。",
      parameters: {
        type: "object",
        properties: {
          candidateId: { type: "string", description: "要绑定的 Vault login 项 ID" },
          verifyRef: { type: "integer", description: "可选：验证码输入框元素 ref" },
        },
        required: ["candidateId"],
      },
    },
    {
      name: "verify_login",
      description: "登录后必须调用：运行时检测已认证信号（页面是否还有密码框/登录表单）。返回 authenticated yes/no 与页面标题/URL。结果会作为证据并入 finish。",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "request_human",
      description: "遇到 CAPTCHA/3DS/验证码/人工步骤时停下来，把问题交给用户。terminal。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "用户要做什么，说清楚" },
          input_kind: {
            type: "string",
            enum: ["manual_done", "otp", "choice", "free_text"],
            description: "期望输入类型：manual_done(滑块/验证完成回复'完成'), otp(数字验证码), choice(选项), free_text(自由文本)",
          },
          min_length: { type: "number", description: "OTP 最小长度" },
          max_length: { type: "number", description: "OTP 最大长度" },
          pattern: { type: "string", description: "OTP 正则校验模式" },
          options: { type: "array", items: { type: "string" }, description: "choice 可选列表" },
          prompt_id: { type: "string", description: "free_text 关联 prompt 标识" },
        },
        required: ["question"],
      },
    },
    {
      name: "request_handoff",
      description:
        "遇到 CAPTCHA、MFA/短信/邮件验证码、Passkey/安全密钥、设备批准、SSO 人工选择、敏感最终确认、需要文件选择器或自动化被阻断时，停止尝试并把浏览器控制权交给用户。任务简报要求把浏览器交给用户时，打开目标页面后立即以 reason_code=user_requested 调用。禁止尝试绕过 CAPTCHA。terminal。",
      parameters: {
        type: "object",
        properties: {
          reason_code: {
            type: "string",
            enum: [
              "credentials",
              "mfa",
              "passkey",
              "captcha",
              "sensitive_confirmation",
              "automation_blocked",
              "manual_interaction",
              "user_requested",
            ],
            description: "为什么需要人工接管",
          },
          instructions: { type: "string", description: "告诉用户具体要做什么，越具体越好" },
          privacy_mode: {
            type: "string",
            enum: ["normal", "secret_entry"],
            description: "secret_entry：用户要输入密码/密钥等敏感信息，冻结 Agent 感知与截图",
          },
        },
        required: ["reason_code", "instructions"],
      },
    },
    { name: "request_approval", description: "要做支付/提交订单等高影响操作前停下来请求批准。terminal。", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
    {
      name: "finish",
      description: "结束任务。必须给结论与证据（订单号/确认页 URL/下载文件名）。success=true 时 evidence 里必须至少有一条 type=observed_text 的条目，内容是你在页面上实际读到的关键值/文本——仅导航到页面不算完成。",
      parameters: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          summary: { type: "string" },
          evidence: { type: "array", items: { type: "object", properties: { type: { type: "string", description: "observed_text / confirmation_url / artifact 等" }, value: { type: "string" } }, required: ["type", "value"] } },
        },
        required: ["success", "summary", "evidence"],
      },
    },
  ];
}
