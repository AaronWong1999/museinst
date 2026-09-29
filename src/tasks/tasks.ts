
//




import type { Env } from "../env";
import { newId, newSlug, now, todayDay } from "../util";

export type TaskStatus = "running" | "verified_success" | "failed" | "cancelled";

export interface TaskRec {
  id: string;
  workspace_id: string;
  thread_id: string | null;
  channel: string;
  class: string;
  title: string | null;
  status: TaskStatus;
  fail_reason: string | null;
  started_at: number;
  completed_at: number | null;
  cost_usd: number | null;
  trace_id: string | null;
}

export function startTask(
  env: Env,
  opts: { workspaceId: string; threadId?: string; channel: string; class: string; title: string },
): string {
  const id = newId("t");
  const trace = newSlug(10);
  const p = env.DB.prepare(
    `INSERT INTO tasks (id, workspace_id, thread_id, channel, class, title, status, started_at, trace_id)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).bind(id, opts.workspaceId, opts.threadId ?? "main", opts.channel, opts.class, opts.title, now(), trace);
  env.DB.batch([p, bumpUsage(env, opts.workspaceId)]).catch(() => {});
  return id;
}

export function bumpUsage(env: Env, workspaceId: string) {
  return env.DB.prepare(
    `INSERT INTO usage_daily (workspace_id, day, tasks_ok) VALUES (?, ?, 0)
     ON CONFLICT(workspace_id, day) DO NOTHING`,
  ).bind(workspaceId, todayDay());
}

export function addStep(env: Env, taskId: string, desc: string): void {
  env.DB.prepare(
    `INSERT INTO task_steps (task_id, seq, desc, ts) VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM task_steps WHERE task_id=?), ?, ?)`,
  )
    .bind(taskId, taskId, desc.slice(0, 300), now())
    .run()
    .catch(() => {});
}

export function addEvidence(env: Env, taskId: string, type: string, value: string): void {
  env.DB.prepare(
    `INSERT OR IGNORE INTO task_evidence (task_id, type, value, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(taskId, type, value.slice(0, 500), now())
    .run()
    .catch(() => {});
}

export async function completeTask(
  env: Env,
  taskId: string,
  status: Exclude<TaskStatus, "running">,
  failReason?: string,
): Promise<void> {
  const task = await env.DB.prepare(`SELECT workspace_id, status FROM tasks WHERE id=?`)
    .bind(taskId)
    .first<{ workspace_id: string; status: string }>();
  if (!task) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks SET status=?, fail_reason=?, completed_at=? WHERE id=? AND status='running'`,
    ).bind(status, failReason?.slice(0, 300) ?? null, now(), taskId),
    env.DB.prepare(
      `UPDATE usage_daily SET tasks_ok = tasks_ok + ?, tasks_fail = tasks_fail + ?
        WHERE workspace_id=? AND day=?`,
    ).bind(
      status === "verified_success" ? 1 : 0,
      status === "failed" ? 1 : 0,
      task.workspace_id,
      todayDay(),
    ),
  ]);

  // Founding grant and invite rewards are hosted concepts handled by host hooks.afterTask
}



export interface ReceiptData {
  title: string;
  steps: string[];
  evidence: Array<{ type: string; value: string }>;
  durationMs: number;
  channel: string;
  taskClass: string;
}


export async function createReceipt(env: Env, taskId: string): Promise<string | null> {
  const task = await env.DB.prepare(
    `SELECT * FROM tasks WHERE id=? AND status='verified_success'`,
  )
    .bind(taskId)
    .first<TaskRec>();
  if (!task) return null;
  const steps = await env.DB.prepare(`SELECT desc FROM task_steps WHERE task_id=? ORDER BY seq`)
    .bind(taskId)
    .all<{ desc: string }>();
  const evidence = await env.DB.prepare(`SELECT type, value FROM task_evidence WHERE task_id=?`)
    .bind(taskId)
    .all<{ type: string; value: string }>();
  const slug = newSlug(6);
  const receiptId = newId("r");
  const data: ReceiptData = {
    title: redact(task.title ?? task.class),
    steps: (steps.results ?? []).map((s) => redact(s.desc)),
    evidence: (evidence.results ?? []).map((e) => ({ type: e.type, value: redact(e.value) })),
    durationMs: (task.completed_at ?? now()) - task.started_at,
    channel: task.channel,
    taskClass: task.class,
  };
  await env.DB.prepare(
    `INSERT INTO task_receipts (id, task_id, share_slug, redacted_json, public, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
  )
    .bind(receiptId, taskId, slug, JSON.stringify(data), now())
    .run();
  return slug;
}

/**
 * Receipts are private by default. A receipt is visible to anyone only after its
 * owner marks it public; otherwise only a session from the owning workspace can
 * read it.
 */
export async function getReceiptBySlug(env: Env, slug: string, viewerWorkspaceId?: string | null): Promise<ReceiptData | null> {
  const row = await env.DB.prepare(
    `SELECT tr.redacted_json FROM task_receipts tr JOIN tasks t ON t.id=tr.task_id
      WHERE tr.share_slug=? AND (tr.public=1 OR t.workspace_id=?)`,
  )
    .bind(slug, viewerWorkspaceId ?? "")
    .first<{ redacted_json: string }>();
  return row ? (JSON.parse(row.redacted_json) as ReceiptData) : null;
}

export function redact(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, (m) => m[0] + "***@" + m.split("@")[1])
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "**** **** **** ****")
    .replace(/\b1[3-9]\d{9}\b/g, "1*********")
    .replace(/\b(?:\d{4,})\b(?=[A-Z\u4e00-\u9fff]*订单|\s*确认号)/g, (m) => m.slice(0, 2) + "****");
}



export interface RecipeData {
  goal: string;
  steps: string[];
  connectors: string[];
  sites?: string[];
  approvalPoints: string[];
  lang: string;
}

export async function saveRecipe(
  env: Env,
  opts: { workspaceId: string; sourceTaskId?: string; title: string; data: RecipeData },
): Promise<string> {
  const slug = newSlug(6);
  await env.DB.prepare(
    `INSERT INTO recipes (id, source_task_id, slug, title, description, template_json, connectors, locale, public, author_workspace, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      newId("rc"),
      opts.sourceTaskId ?? null,
      slug,
      opts.title,
      opts.data.goal,
      JSON.stringify(opts.data),
      JSON.stringify(opts.data.connectors),
      opts.data.lang,
      opts.workspaceId,
      now(),
    )
    .run();
  return slug;
}

export async function getRecipe(env: Env, workspaceId: string, slug: string): Promise<{ title: string; description: string; data: RecipeData; runs: number; slug: string } | null> {
  const row = await env.DB.prepare(
    `SELECT title, description, template_json, runs, slug FROM recipes WHERE slug=? AND author_workspace=?`,
  )
    .bind(slug, workspaceId)
    .first<{ title: string; description: string; template_json: string; runs: number; slug: string }>();
  if (!row) return null;
  return {
    title: row.title,
    description: row.description ?? "",
    data: JSON.parse(row.template_json) as RecipeData,
    runs: row.runs ?? 0,
    slug: row.slug,
  };
}

export async function listRecipes(env: Env, workspaceId: string, max = 50): Promise<Array<{ slug: string; title: string; description: string; connectors: string[]; locale: string; runs: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, description, connectors, locale, runs FROM recipes WHERE author_workspace=? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(workspaceId, max)
    .all<{ slug: string; title: string; description: string; connectors: string; locale: string; runs: number }>();
  return (results ?? []).map((r) => ({
    slug: r.slug,
    title: r.title,
    description: r.description ?? "",
    connectors: safeArr(r.connectors),
    locale: r.locale,
    runs: r.runs ?? 0,
  }));
}

function safeArr(s: string | null): string[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
