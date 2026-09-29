-- Phase C4/C7 + Phase F1/F3 (spec §14.16, §14.18, §16, §17).
--
-- This migration adds the durable pieces the browser control and personal-agent
-- surfaces need and that are not part of the one-time grant table (0021):
--   * browser_control_leases — single-controller enforcement across devices
--   * task_goal_revisions    — append-only steer history (§14.16)
--   * goals / goal_milestones — durable goals built on Workstream semantics (§16)
--   * ideas                  — evidence-backed suggestions (§17)
--
-- Nothing here stores a provider URL, JWT, raw grant token, or secret value.

-- ── C4/C7: control lease (§14.18) ────────────────────────────────────────────
-- One row per task. `controller_device_id` is set while a human holds control.
-- Multi-device readonly Watch is unconstrained; a second takeover is refused by
-- the CAS in BrowserWorker instead of persistent state here.
CREATE TABLE IF NOT EXISTS browser_control_leases (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  controller_device_id TEXT,
  control_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_browser_control_leases_expiry
  ON browser_control_leases(lease_expires_at);

-- ── C7: steer revision history (§14.16) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_goal_revisions (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  goal TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(task_id, revision)
);

-- ── F1: Goals / Milestones (§16) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  linked_workstream_id TEXT,
  proposal_id TEXT,
  title TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_proposal
  ON goals(workspace_id, proposal_id) WHERE proposal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_goals_workspace_status
  ON goals(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS goal_milestones (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned',
  ordinal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_milestones_goal
  ON goal_milestones(goal_id, ordinal);

-- ── F3: Ideas (§17) ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  suggestion TEXT NOT NULL,
  why_now TEXT,
  action_label TEXT,
  action_kind TEXT,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  dedupe_key TEXT,
  accepted_task_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  expires_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ideas_dedupe
  ON ideas(workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'open';

CREATE INDEX IF NOT EXISTS idx_ideas_workspace_status
  ON ideas(workspace_id, status, created_at DESC);
