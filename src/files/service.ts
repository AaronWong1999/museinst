//
// Files / Artifacts service (spec §15, §25.6).
//
// R2 is the binary truth; D1 `artifacts` is the ownership/index metadata.
// Content access is always owner-authenticated — no public R2 URLs, no
// presigned links that outlive the session (§15.4). An artifact created by
// upload/init stays "uploading" (size_bytes NULL) until upload/complete
// verifies the object in R2.
//
import type { Env } from "../env";

export interface ArtifactRow {
  id: string;
  workspace_id: string;
  thread_id: string | null;
  task_id: string | null;
  kind: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  r2_key: string;
  source: string;
  source_ref: string | null;
  created_at: number;
  deleted_at: number | null;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per artifact (P1 review point)

const FILENAME_RE = /^[\w.\- ()\u4e00-\u9fff]{1,180}$/;

export function newArtifactId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("");
  return `f_${s}`;
}

export function r2KeyFor(workspaceId: string, artifactId: string): string {
  // Workspace-scoped key: the R2 layout mirrors ownership even though every
  // read goes through the authenticated API.
  return `artifacts/${workspaceId}/${artifactId}`;
}

export async function initUpload(
  env: Env,
  input: {
    workspaceId: string;
    filename: string;
    mimeType?: string;
    threadId?: string;
    taskId?: string;
    source?: string;
  },
): Promise<{ ok: true; artifact: ArtifactRow } | { ok: false; error: string }> {
  const filename = (input.filename ?? "").trim();
  if (!filename || filename.length > 180 || !FILENAME_RE.test(filename)) {
    return { ok: false, error: "filename_invalid" };
  }
  const id = newArtifactId();
  const kind = input.source === "browser_download"
    ? "browser_download"
    : input.source === "email_attachment"
      ? "email_attachment"
      : input.source === "generated"
        ? "generated"
        : "file";
  const row: ArtifactRow = {
    id,
    workspace_id: input.workspaceId,
    thread_id: input.threadId ?? null,
    task_id: input.taskId ?? null,
    kind,
    filename,
    mime_type: input.mimeType ? String(input.mimeType).slice(0, 120) : null,
    size_bytes: null,
    r2_key: r2KeyFor(input.workspaceId, id),
    source: input.source ? String(input.source).slice(0, 60) : "upload",
    source_ref: null,
    created_at: Date.now(),
    deleted_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO artifacts (id, workspace_id, thread_id, task_id, kind, filename, mime_type, size_bytes, r2_key, source, source_ref, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    row.id, row.workspace_id, row.thread_id, row.task_id, row.kind, row.filename,
    row.mime_type, row.size_bytes, row.r2_key, row.source, row.source_ref, row.created_at,
  ).run();
  return { ok: true, artifact: row };
}

export async function getArtifact(env: Env, workspaceId: string, artifactId: string): Promise<ArtifactRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, thread_id, task_id, kind, filename, mime_type, size_bytes, r2_key, source, source_ref, created_at, deleted_at
     FROM artifacts WHERE id=? AND workspace_id=?`,
  ).bind(artifactId, workspaceId).first<ArtifactRow>();
  return row ?? null;
}

export async function putContent(
  env: Env,
  input: { workspaceId: string; artifactId: string; body: ArrayBuffer; contentType?: string },
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const row = await getArtifact(env, input.workspaceId, input.artifactId);
  if (!row || row.deleted_at) return { ok: false, error: "not_found", status: 404 };
  if (row.size_bytes !== null) return { ok: false, error: "already_uploaded", status: 409 };
  if (input.body.byteLength > MAX_FILE_BYTES) return { ok: false, error: "file_too_large", status: 413 };
  await env.ARTIFACTS.put(row.r2_key, input.body, {
    httpMetadata: { contentType: input.contentType || row.mime_type || "application/octet-stream" },
  });
  return { ok: true };
}

export async function completeUpload(
  env: Env,
  input: { workspaceId: string; artifactId: string },
): Promise<{ ok: true; artifact: ArtifactRow } | { ok: false; error: string; status?: number }> {
  const row = await getArtifact(env, input.workspaceId, input.artifactId);
  if (!row || row.deleted_at) return { ok: false, error: "not_found", status: 404 };
  if (row.size_bytes !== null) return { ok: true, artifact: row };
  const obj = await env.ARTIFACTS.head(row.r2_key);
  if (!obj) return { ok: false, error: "upload_not_found", status: 400 };
  await env.DB.prepare(`UPDATE artifacts SET size_bytes=? WHERE id=?`).bind(obj.size, row.id).run();
  return { ok: true, artifact: { ...row, size_bytes: obj.size } };
}

export async function listArtifacts(
  env: Env,
  workspaceId: string,
  opts: { source?: string; threadId?: string; taskId?: string; limit?: number } = {},
): Promise<ArtifactRow[]> {
  const clauses = ["workspace_id=?", "deleted_at IS NULL"];
  const binds: unknown[] = [workspaceId];
  if (opts.source) { clauses.push("source=?"); binds.push(opts.source); }
  if (opts.threadId) { clauses.push("thread_id=?"); binds.push(opts.threadId); }
  if (opts.taskId) { clauses.push("task_id=?"); binds.push(opts.taskId); }
  binds.push(Math.min(Math.max(opts.limit ?? 100, 1), 200));
  const res = await env.DB.prepare(
    `SELECT id, workspace_id, thread_id, task_id, kind, filename, mime_type, size_bytes, r2_key, source, source_ref, created_at, deleted_at
     FROM artifacts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  ).bind(...binds).all<ArtifactRow>();
  return res.results ?? [];
}

export async function readContent(
  env: Env,
  workspaceId: string,
  artifactId: string,
): Promise<{ ok: true; row: ArtifactRow; body: R2ObjectBody } | { ok: false; error: string; status?: number }> {
  const row = await getArtifact(env, workspaceId, artifactId);
  if (!row || row.deleted_at) return { ok: false, error: "not_found", status: 404 };
  if (row.size_bytes === null) return { ok: false, error: "upload_incomplete", status: 409 };
  const body = await env.ARTIFACTS.get(row.r2_key);
  if (!body) return { ok: false, error: "content_missing", status: 404 };
  return { ok: true, row, body };
}


export async function deleteArtifact(env: Env, workspaceId: string, artifactId: string): Promise<{ ok: boolean; error?: string; status?: number }> {
  const row = await getArtifact(env, workspaceId, artifactId);
  if (!row || row.deleted_at) return { ok: false, error: "not_found", status: 404 };
  await env.ARTIFACTS.delete(row.r2_key);
  // Defense in depth (Round 1 J32): the tombstone update also carries the
  // workspace predicate, so even a raced re-check can never soft-delete
  // another workspace's row by id alone.
  await env.DB.prepare(`UPDATE artifacts SET deleted_at=? WHERE id=? AND workspace_id=?`)
    .bind(Date.now(), row.id, workspaceId).run();
  return { ok: true };
}
