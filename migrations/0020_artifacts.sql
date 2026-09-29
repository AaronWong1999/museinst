-- Artifacts (spec §15.2): R2 holds the binary truth; this table is the
-- ownership/index metadata. r2_key is namespaced per workspace and never
-- exposed; content access is owner-authenticated only.
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  r2_key TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX idx_artifacts_workspace_created
  ON artifacts(workspace_id, created_at DESC);

CREATE INDEX idx_artifacts_task ON artifacts(task_id);
