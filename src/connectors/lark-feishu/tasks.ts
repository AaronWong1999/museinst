// tasks.ts — Semantic Todo/Tasks adapter for Lark & Feishu.
// V2 §10.3 / §13: todo_list, todo_get, todo_create, todo_update, todo_complete, todo_delete.
// Uses Task v2 API (/open-apis/task/v2/tasks) with read-back verification.

import type { Env } from "../../env";
import { ConnectorCallError } from "../types";
import { larkFeishuUserRequest } from "./client";
import type { LarkFeishuProvider, LarkFeishuTask } from "./types";

function toMsTimestamp(iso: string): string {
  if (/^\d{13}$/.test(iso)) return iso;
  if (/^\d{10}$/.test(iso)) return String(Number(iso) * 1000);
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) throw new ConnectorCallError("provider_error", `invalid_datetime_format: ${iso}`);
  return String(ms);
}

function mapTask(t: any): LarkFeishuTask {
  const guid = String(t.guid || t.id || "");
  const dueMs = t.due?.timestamp ? Number(t.due.timestamp) : undefined;
  const completedAt = t.completed_at && t.completed_at !== "0" ? new Date(Number(t.completed_at)).toISOString() : undefined;
  return {
    id: guid,
    guid,
    summary: String(t.summary ?? ""),
    description: t.description ? String(t.description) : undefined,
    dueIso: dueMs ? new Date(dueMs).toISOString() : undefined,
    completed: !!completedAt,
    completedAt,
    url: t.url ? String(t.url) : undefined,
  };
}

export async function larkFeishuTodoList(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  opts?: { pageSize?: number; pageToken?: string },
): Promise<LarkFeishuTask[]> {
  const p = new URLSearchParams({
    page_size: String(opts?.pageSize ?? 50),
  });
  if (opts?.pageToken) p.set("page_token", opts.pageToken);

  const res = await larkFeishuUserRequest(env, provider, userToken, `/task/v2/tasks?${p}`);
  const items = (res as any)?.items ?? [];
  return items.map(mapTask);
}

export async function larkFeishuTodoGet(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  taskGuid: string,
): Promise<LarkFeishuTask | null> {
  try {
    const res = await larkFeishuUserRequest(env, provider, userToken, `/task/v2/tasks/${encodeURIComponent(taskGuid)}`);
    const t = (res as any)?.task ?? res;
    return t?.guid ? mapTask(t) : null;
  } catch (e) {
    if (e instanceof ConnectorCallError && e.kind === "not_found") return null;
    throw e;
  }
}

export async function larkFeishuTodoCreate(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  task: {
    title: string;
    dueIso?: string;
    notes?: string;
  },
): Promise<{ id: string; guid: string; url?: string }> {
  const body: Record<string, unknown> = {
    summary: task.title,
  };
  if (task.dueIso) {
    body.due = { timestamp: toMsTimestamp(task.dueIso) };
  }
  if (task.notes) {
    body.description = task.notes;
  }

  const res = await larkFeishuUserRequest(env, provider, userToken, `/task/v2/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const createdGuid = String((res as any)?.task?.guid ?? (res as any)?.guid ?? "");
  if (!createdGuid) throw new ConnectorCallError("provider_error", `${provider}_todo_create: missing_task_guid`);

  // Read-back verification
  const back = await larkFeishuTodoGet(env, provider, userToken, createdGuid);
  if (!back) {
    throw new ConnectorCallError("provider_error", `${provider}_todo_create: read_back_not_found`);
  }
  if (back.summary.trim() !== task.title.trim()) {
    throw new ConnectorCallError("provider_error", `${provider}_todo_create: summary_mismatch`);
  }

  return { id: createdGuid, guid: createdGuid, url: back.url };
}

export async function larkFeishuTodoUpdate(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  taskGuid: string,
  patch: {
    title?: string;
    dueIso?: string;
    notes?: string;
  },
): Promise<{ id: string; guid: string }> {
  const updateFields: string[] = [];
  const taskObj: Record<string, unknown> = {};

  if (patch.title !== undefined) {
    taskObj.summary = patch.title;
    updateFields.push("summary");
  }
  if (patch.dueIso !== undefined) {
    taskObj.due = { timestamp: toMsTimestamp(patch.dueIso) };
    updateFields.push("due");
  }
  if (patch.notes !== undefined) {
    taskObj.description = patch.notes;
    updateFields.push("description");
  }

  await larkFeishuUserRequest(env, provider, userToken, `/task/v2/tasks/${encodeURIComponent(taskGuid)}`, {
    method: "PATCH",
    body: JSON.stringify({ task: taskObj, update_fields: updateFields }),
  });

  // Read-back verification
  const back = await larkFeishuTodoGet(env, provider, userToken, taskGuid);
  if (!back) {
    throw new ConnectorCallError("provider_error", `${provider}_todo_update: read_back_not_found`);
  }

  return { id: taskGuid, guid: taskGuid };
}

export async function larkFeishuTodoComplete(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  taskGuid: string,
): Promise<{ id: string; guid: string; completed: true }> {
  const nowMs = String(Date.now());
  await larkFeishuUserRequest(env, provider, userToken, `/task/v2/tasks/${encodeURIComponent(taskGuid)}`, {
    method: "PATCH",
    body: JSON.stringify({
      task: { completed_at: nowMs },
      update_fields: ["completed_at"],
    }),
  });

  // Read-back verification
  const back = await larkFeishuTodoGet(env, provider, userToken, taskGuid);
  if (!back || !back.completed) {
    throw new ConnectorCallError("provider_error", `${provider}_todo_complete: read_back_incomplete`);
  }

  return { id: taskGuid, guid: taskGuid, completed: true };
}

export async function larkFeishuTodoDelete(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  taskGuid: string,
): Promise<{ ok: true; id: string }> {
  await larkFeishuUserRequest(env, provider, userToken, `/task/v2/tasks/${encodeURIComponent(taskGuid)}`, {
    method: "DELETE",
  });
  return { ok: true, id: taskGuid };
}
