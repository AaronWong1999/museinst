//
// Browser Live View Service (§14.10, §14.11, §14.12, §14.13).
//

import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../env";
import { RestBrowserLiveViewProvider, type BrowserProviderCapabilities, type ProviderView } from "./provider";
import { BrowserGrantRepository, type BrowserAccessGrantRow, type IssuedGrant } from "./grants";

export interface SessionInfo {
  taskId: string;
  sessionId: string;
  targetId: string;
  title?: string;
  url?: string;
  state: string;
  controlEpoch: number;
  goalRevision: number;
  controlLease?: { heldBy: string | null; expiresAt: number | null; held: boolean };
}

const TERMINAL_GRANT_STATUSES = new Set(["revoked", "expired", "completed"]);

export class BrowserService {
  private readonly grantRepo: BrowserGrantRepository;
  private readonly provider: RestBrowserLiveViewProvider;

  constructor(private readonly env: Env) {
    this.grantRepo = new BrowserGrantRepository(env.DB);

    // §24.2: browser live-view credentials are deliberately browser-specific.
    // Never fall back to a global Cloudflare API token, EXPECTED_ACCOUNT_ID, or
    // a hard-coded account id: missing least-privilege credentials must disable
    // the capability rather than silently widening authority.
    const accountId = env.BROWSER_LIVE_VIEW_ACCOUNT_ID || "";
    const apiToken = env.BROWSER_LIVE_VIEW_API_TOKEN || env.BROWSER_API_TOKEN;

    this.provider = new RestBrowserLiveViewProvider({ accountId, apiToken });
  }

  /**
   * Return product capabilities for this deployment.
   *
   * Cloudflare can mint interactive live views but cannot revoke a connected
   * viewer. MuseInst revokes at the app level instead: on hand-back, cancel or
   * a change of controller, BrowserWorker closes the viewer's tab and reopens
   * the page in a fresh tab of the same session (see revokeLiveViewers), and
   * fails closed when that cannot be confirmed.
   */
  async capabilities(): Promise<BrowserProviderCapabilities> {
    const caps = await this.provider.capabilities();
    return { ...caps, revokeInteractiveView: caps.interactiveView };
  }

  get repository(): BrowserGrantRepository {
    return this.grantRepo;
  }

  private assertGrantActive(grant: BrowserAccessGrantRow): void {
    if (TERMINAL_GRANT_STATUSES.has(grant.status)) {
      throw new Error(`grant_${grant.status}`);
    }
    if (grant.expires_at <= Date.now()) {
      throw new Error("grant_expired");
    }
  }

  private assertGrantWorkspace(grant: BrowserAccessGrantRow, workspaceId: string): void {
    if (grant.workspace_id !== workspaceId) {
      throw new Error("grant_workspace_mismatch");
    }
  }

  private async assertSafeTakeoverAvailable(): Promise<void> {
    const caps = await this.capabilities();
    if (!caps.interactiveView) {
      throw new Error("browser_takeover_unavailable");
    }
  }

  /**
   * Helper to fetch BrowserWorker DO for a workspace.
   */
  private async workerFetch(workspaceId: string, path: string, body?: unknown, method: string = "POST"): Promise<Response> {
    const stub = this.env.BROWSER_WORKER.get(this.env.BROWSER_WORKER.idFromName(workspaceId));
    return stub.fetch(`https://browser${path}`, {
      method,
      headers: { "content-type": "application/json", "x-partykit-room": workspaceId },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Queries BrowserWorker DO for the active browser session of a task.
   */
  async getSession(workspaceId: string, taskId: string): Promise<SessionInfo | null> {
    const res = await this.workerFetch(workspaceId, `/session/${encodeURIComponent(taskId)}`, undefined, "GET").catch(() => null);
    if (!res || !res.ok) return null;
    return (await res.json().catch(() => null)) as SessionInfo | null;
  }

  /**
   * Issues a One-Time Browser Access Grant for watching or taking over.
   * The grant is pinned to the exact provider session + target observed now;
   * a later task session must never be substituted under an old grant.
   */
  async issueGrant(input: {
    workspaceId: string;
    taskId: string;
    mode: "readonly" | "interactive";
    createdBy: "agent" | "user" | "system";
    originChannel?: string;
    originExternalId?: string;
    originScope?: string;
    principalId?: string;
    reasonCode?: string;
    instructions?: string;
    ttlMs?: number;
  }): Promise<IssuedGrant> {
    if (input.mode === "interactive") {
      await this.assertSafeTakeoverAvailable();
    }

    const session = await this.getSession(input.workspaceId, input.taskId);
    if (!session?.sessionId || !session.targetId) {
      throw new Error("browser_session_not_ready");
    }

    return this.grantRepo.createGrant(
      {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        requestedMode: input.mode,
        createdBy: input.createdBy,
        originChannel: input.originChannel,
        originExternalId: input.originExternalId,
        originScope: input.originScope,
        principalId: input.principalId,
        reasonCode: input.reasonCode,
        instructions: input.instructions,
        browserSessionRef: session.sessionId,
        targetRef: session.targetId,
        controlEpoch: session.controlEpoch,
        ttlMs: input.ttlMs,
      },
      this.env.PUBLIC_BASE_URL || "https://museinst.com",
    );
  }

  /**
   * Mints a live view URL for an active grant (§14.7, §14.8).
   * Never stores or persists the resulting URL/JWT.
   */
  /**
   * Whether the provider still has this browser session. A Live View minted for a
   * session that already ended only shows the provider's "disconnected" screen.
   * Lookup failures count as alive so a provider hiccup never ends a real session.
   */
  async isProviderSessionAlive(sessionId: string | null | undefined): Promise<boolean> {
    if (!sessionId || !this.env.BROWSER) return true;
    try {
      const list = await puppeteer.sessions(this.env.BROWSER as any);
      return list.some((s) => s.sessionId === sessionId);
    } catch {
      return true;
    }
  }

  /** Close the grant and the published session row after the provider session ended. */
  async markSessionEnded(workspaceId: string, taskId: string): Promise<void> {
    await this.grantRepo.endActiveForTask(workspaceId, taskId, "completed").catch(() => {});
    const now = Date.now();
    await this.env.DB.prepare(
      `UPDATE browser_sessions SET state='completed', updated_at=?, ended_at=COALESCE(ended_at, ?) WHERE workspace_id=? AND task_id=? AND state='active'`,
    ).bind(now, now, workspaceId, taskId).run().catch(() => {});
  }

  async mintLiveView(
    grant: BrowserAccessGrantRow,
    accessOverride?: "readonly" | "interactive",
  ): Promise<ProviderView> {
    this.assertGrantActive(grant);

    const sessionId = grant.browser_session_ref;
    const targetId = grant.target_ref;
    if (!sessionId || !targetId) {
      throw new Error("grant_session_scope_missing");
    }

    // Same-session continuity is a hard invariant. An old grant may not follow
    // a task onto a newly-created browser session or target.
    const current = await this.getSession(grant.workspace_id, grant.task_id);
    if (!current) throw new Error("browser_session_not_found");
    if (current.sessionId !== sessionId || current.targetId !== targetId) {
      throw new Error("browser_session_changed");
    }

    const access = accessOverride ?? grant.current_mode;
    const connectBeforeMs = grant.expires_at;

    if (access === "readonly") {
      const caps = await this.capabilities();
      if (!caps.readonlyView) throw new Error("browser_watch_unavailable");
      return this.provider.createReadonlyView({
        workspaceId: grant.workspace_id,
        taskId: grant.task_id,
        sessionId,
        targetId,
        connectBeforeMs,
      });
    }

    await this.assertSafeTakeoverAvailable();
    return this.provider.createInteractiveView({
      workspaceId: grant.workspace_id,
      taskId: grant.task_id,
      sessionId,
      targetId,
      connectBeforeMs,
      handoff: {
        workspaceId: grant.workspace_id,
        taskId: grant.task_id,
        sessionId,
        targetId,
        handoffId: grant.id,
        controlEpoch: current.controlEpoch,
      },
    });
  }

  /**
   * User requests takeover of the browser session (§14.8).
   * Requires an interactive live view from the provider.
   */
  async takeover(
    workspaceId: string,
    grantId: string,
    deviceId?: string,
  ): Promise<{ success: boolean; controlEpoch: number; providerView: ProviderView }> {
    const grant = await this.grantRepo.findById(grantId);
    if (!grant) throw new Error("grant_not_found");
    this.assertGrantWorkspace(grant, workspaceId);
    this.assertGrantActive(grant);
    await this.assertSafeTakeoverAvailable();
    if (!deviceId) throw new Error("device_id_required");

    const res = await this.workerFetch(workspaceId, "/takeover", { taskId: grant.task_id, deviceId });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`takeover_failed: ${(err as any)?.error || res.status}`);
    }
    const data = (await res.json()) as { success: boolean; controlEpoch: number; targetId?: string | null };

    let targetRef = grant.target_ref;
    if (data.targetId && grant.browser_session_ref && grant.target_ref && data.targetId !== grant.target_ref) {
      await this.grantRepo.retargetTask(workspaceId, grant.task_id, grant.browser_session_ref, grant.target_ref, data.targetId);
      targetRef = data.targetId;
    }
    await this.grantRepo.updateMode(grantId, "interactive", data.controlEpoch);
    const providerView = await this.mintLiveView(
      { ...grant, target_ref: targetRef, current_mode: "interactive", control_epoch: data.controlEpoch },
      "interactive",
    );
    return { success: true, controlEpoch: data.controlEpoch, providerView };
  }

  /**
   * User completes interaction (Done action) (§14.4).
   * Hands the browser back to the agent and completes the grant.
   */
  async done(workspaceId: string, grantId: string): Promise<{ success: boolean; controlEpoch: number }> {
    const grant = await this.grantRepo.findById(grantId);
    if (!grant) throw new Error("grant_not_found");
    this.assertGrantWorkspace(grant, workspaceId);
    this.assertGrantActive(grant);
    await this.assertSafeTakeoverAvailable();

    const res = await this.workerFetch(workspaceId, "/done", { taskId: grant.task_id });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`done_failed: ${(err as any)?.error || res.status}`);
    }
    const data = (await res.json()) as { success: boolean; controlEpoch: number; targetId?: string | null };

    await this.grantRepo.updateMode(grantId, "readonly", data.controlEpoch);
    await this.grantRepo.completeGrant(grantId);
    // Watchers of the same task follow the page into its new tab.
    if (data.targetId && grant.browser_session_ref && grant.target_ref && data.targetId !== grant.target_ref) {
      await this.grantRepo.retargetTask(workspaceId, grant.task_id, grant.browser_session_ref, grant.target_ref, data.targetId);
    }
    return { success: data.success, controlEpoch: data.controlEpoch };
  }

  /**
   * Agent-side teardown for a browser task that can no longer continue
   * (handoff undeliverable, handoff expired, task cancelled). Closes the cloud
   * browser session, marks the published session ended and revokes every
   * outstanding link, so nothing is left waiting on a human who never comes.
   * Best-effort: each step runs even if an earlier one failed.
   */
  async releaseTask(workspaceId: string, taskId: string, reason: string): Promise<void> {
    await this.workerFetch(workspaceId, "/cancel", { taskId, workspaceId, reason })
      .then(() => undefined)
      .catch((error) => console.warn("[browser] release: worker cancel failed", String(error).slice(0, 200)));
    await this.grantRepo
      .endActiveForTask(workspaceId, taskId, "revoked")
      .catch((error) => console.warn("[browser] release: grant revoke failed", String(error).slice(0, 200)));
  }

  /** Cancels browser task and revokes grant only after BrowserWorker confirms cancellation. */
  async cancel(workspaceId: string, grantId: string): Promise<{ success: boolean }> {
    const grant = await this.grantRepo.findById(grantId);
    if (!grant) throw new Error("grant_not_found");
    this.assertGrantWorkspace(grant, workspaceId);
    this.assertGrantActive(grant);

    let res: Response;
    try {
      res = await this.workerFetch(workspaceId, "/cancel", { taskId: grant.task_id });
    } catch (error: any) {
      throw new Error(`cancel_failed: ${error?.message || "browser_worker_unreachable"}`);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`cancel_failed: ${(err as any)?.error || res.status}`);
    }
    const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
    if (data?.success !== true) {
      throw new Error("cancel_failed: worker_not_confirmed");
    }

    await this.grantRepo.revokeGrant(grantId);
    return { success: true };
  }

  /** Steer browser task with new goal (§14.16). */
  async steer(
    workspaceId: string,
    taskId: string,
    newGoal: string,
    expectedRevision?: number,
  ): Promise<{ ok: boolean; revision: number; applied: "immediate" | "queued_until_handoff_complete" }> {
    const res = await this.workerFetch(workspaceId, "/steer", {
      taskId,
      goal: newGoal,
      expectedRevision,
      source: "user",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`steer_failed: ${(err as any)?.error || res.status}`);
    }
    return (await res.json()) as { ok: boolean; revision: number; applied: "immediate" | "queued_until_handoff_complete" };
  }
}
