//
// Goals & Milestones + Ideas memory service (§16, §17, §25.8).
//
// Goals are built on top of Workstream semantics without creating a competing
// long-term state. Ideas provide evidence-backed suggestions with a clear
// accept/dismiss lifecycle.
//
import type { Env } from "../env";

export interface GoalRow {
  id: string;
  workspace_id: string;
  thread_id: string | null;
  linked_workstream_id: string | null;
  proposal_id: string | null;
  title: string;
  target: string | null;
  status: "active" | "completed" | "paused" | "cancelled";
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
}

export interface MilestoneRow {
  id: string;
  goal_id: string;
  title: string;
  state: "planned" | "active" | "completed" | "blocked" | "cancelled";
  ordinal: number;
  created_at: number;
  updated_at: number;
}

export interface IdeaRow {
  id: string;
  workspace_id: string;
  thread_id: string | null;
  suggestion: string;
  why_now: string | null;
  action_label: string | null;
  action_kind: string | null;
  evidence_json: string | null;
  status: "open" | "accepted" | "dismissed" | "expired";
  dedupe_key: string | null;
  accepted_task_id: string | null;
  created_at: number;
  resolved_at: number | null;
  expires_at: number | null;
}

export function newGoalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `goal_${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("")}`;
}

export function newIdeaId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `idea_${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("")}`;
}

export class GoalsService {
  constructor(private readonly env: Env) {}

  async listGoals(workspaceId: string): Promise<Array<GoalRow & { milestones: MilestoneRow[] }>> {
    const goals = await this.env.DB.prepare(
      `SELECT * FROM goals WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 50`,
    )
      .bind(workspaceId)
      .all<GoalRow>()
      .then((r) => r.results ?? [])
      .catch(() => []);

    if (goals.length === 0) return [];

    const goalIds = goals.map((g) => g.id);
    const placeholders = goalIds.map(() => "?").join(",");
    const milestones = await this.env.DB.prepare(
      `SELECT * FROM goal_milestones WHERE goal_id IN (${placeholders}) ORDER BY ordinal ASC`,
    )
      .bind(...goalIds)
      .all<MilestoneRow>()
      .then((r) => r.results ?? [])
      .catch(() => []);

    const byGoal = new Map<string, MilestoneRow[]>();
    for (const m of milestones) {
      const list = byGoal.get(m.goal_id) ?? [];
      list.push(m);
      byGoal.set(m.goal_id, list);
    }

    return goals.map((g) => ({
      ...g,
      milestones: byGoal.get(g.id) ?? [],
    }));
  }

  async createOrConfirmGoal(
    workspaceId: string,
    input: {
      proposalId?: string;
      threadId?: string;
      title: string;
      target?: string;
      milestones?: string[];
      linkedWorkstreamId?: string;
    },
  ): Promise<{ ok: true; goal: GoalRow; milestones: MilestoneRow[] } | { ok: false; error: string }> {
    const title = (input.title ?? "").trim();
    if (!title || title.length > 200) {
      return { ok: false, error: "title_invalid" };
    }

    // Proposal idempotency: if proposalId already confirmed, return existing
    if (input.proposalId) {
      const existing = await this.env.DB.prepare(
        `SELECT * FROM goals WHERE workspace_id = ? AND proposal_id = ?`,
      )
        .bind(workspaceId, input.proposalId)
        .first<GoalRow>();
      if (existing) {
        const ms = await this.env.DB.prepare(
          `SELECT * FROM goal_milestones WHERE goal_id = ? ORDER BY ordinal ASC`,
        )
          .bind(existing.id)
          .all<MilestoneRow>()
          .then((r) => r.results ?? []);
        return { ok: true, goal: existing, milestones: ms };
      }
    }

    const now = Date.now();
    const goalId = newGoalId();

    const goalRow: GoalRow = {
      id: goalId,
      workspace_id: workspaceId,
      thread_id: input.threadId ?? null,
      linked_workstream_id: input.linkedWorkstreamId ?? null,
      proposal_id: input.proposalId ?? null,
      title,
      target: input.target ? input.target.trim().slice(0, 500) : null,
      status: "active",
      created_at: now,
      updated_at: now,
      completed_at: null,
      cancelled_at: null,
    };

    await this.env.DB.prepare(
      `INSERT INTO goals (id, workspace_id, thread_id, linked_workstream_id, proposal_id, title, target, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        goalRow.id,
        goalRow.workspace_id,
        goalRow.thread_id,
        goalRow.linked_workstream_id,
        goalRow.proposal_id,
        goalRow.title,
        goalRow.target,
        goalRow.status,
        goalRow.created_at,
        goalRow.updated_at,
      )
      .run();

    const milestones: MilestoneRow[] = [];
    if (Array.isArray(input.milestones) && input.milestones.length > 0) {
      let ordinal = 0;
      for (const mTitle of input.milestones) {
        const clean = String(mTitle).trim().slice(0, 150);
        if (!clean) continue;
        const mRow: MilestoneRow = {
          id: `ms_${crypto.randomUUID().slice(0, 8)}`,
          goal_id: goalId,
          title: clean,
          state: ordinal === 0 ? "active" : "planned",
          ordinal,
          created_at: now,
          updated_at: now,
        };
        await this.env.DB.prepare(
          `INSERT INTO goal_milestones (id, goal_id, title, state, ordinal, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(mRow.id, mRow.goal_id, mRow.title, mRow.state, mRow.ordinal, mRow.created_at, mRow.updated_at)
          .run();
        milestones.push(mRow);
        ordinal++;
      }
    }

    return { ok: true, goal: goalRow, milestones };
  }

  async updateGoalStatus(
    workspaceId: string,
    goalId: string,
    status: "active" | "completed" | "paused" | "cancelled",
  ): Promise<boolean> {
    const now = Date.now();
    const completedAt = status === "completed" ? now : null;
    const cancelledAt = status === "cancelled" ? now : null;

    const res = await this.env.DB.prepare(
      `UPDATE goals SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at), cancelled_at = COALESCE(?, cancelled_at)
       WHERE id = ? AND workspace_id = ?`,
    )
      .bind(status, now, completedAt, cancelledAt, goalId, workspaceId)
      .run();

    return (res.meta?.changes ?? 0) > 0;
  }

  // ── Ideas (§17) ─────────────────────────────────────────────────────────────

  async listIdeas(workspaceId: string): Promise<IdeaRow[]> {
    const rows = await this.env.DB.prepare(
      `SELECT * FROM ideas WHERE workspace_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 20`,
    )
      .bind(workspaceId)
      .all<IdeaRow>()
      .then((r) => r.results ?? [])
      .catch(() => []);
    return rows;
  }

  async createIdea(
    workspaceId: string,
    input: {
      suggestion: string;
      whyNow?: string;
      actionLabel?: string;
      actionKind?: string;
      evidence?: Array<{ type: string; value: string; ref?: string }>;
      dedupeKey?: string;
      threadId?: string;
    },
  ): Promise<IdeaRow> {
    const id = newIdeaId();
    const now = Date.now();
    const row: IdeaRow = {
      id,
      workspace_id: workspaceId,
      thread_id: input.threadId ?? null,
      suggestion: input.suggestion.trim().slice(0, 300),
      why_now: input.whyNow ? input.whyNow.trim().slice(0, 300) : null,
      action_label: input.actionLabel ? input.actionLabel.trim().slice(0, 60) : null,
      action_kind: input.actionKind ? input.actionKind.trim().slice(0, 60) : null,
      evidence_json: input.evidence ? JSON.stringify(input.evidence) : null,
      status: "open",
      dedupe_key: input.dedupeKey ?? null,
      accepted_task_id: null,
      created_at: now,
      resolved_at: null,
      expires_at: now + 7 * 24 * 3600 * 1000,
    };

    await this.env.DB.prepare(
      `INSERT INTO ideas (id, workspace_id, thread_id, suggestion, why_now, action_label, action_kind, evidence_json, status, dedupe_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
       ON CONFLICT(workspace_id, dedupe_key) DO UPDATE SET suggestion=excluded.suggestion, updated_at=excluded.created_at`,
    )
      .bind(
        row.id,
        row.workspace_id,
        row.thread_id,
        row.suggestion,
        row.why_now,
        row.action_label,
        row.action_kind,
        row.evidence_json,
        row.dedupe_key,
        row.created_at,
        row.expires_at,
      )
      .run()
      .catch(() => {});

    return row;
  }

  async resolveIdea(
    workspaceId: string,
    ideaId: string,
    action: "accepted" | "dismissed",
    acceptedTaskId?: string,
  ): Promise<boolean> {
    const res = await this.env.DB.prepare(
      `UPDATE ideas SET status = ?, resolved_at = ?, accepted_task_id = ?
       WHERE id = ? AND workspace_id = ? AND status = 'open'`,
    )
      .bind(action, Date.now(), acceptedTaskId ?? null, ideaId, workspaceId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }
}
