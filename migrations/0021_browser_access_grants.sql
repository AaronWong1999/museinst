-- D1 migration: 0021_browser_access_grants.sql
-- Browser Access Grants for secure Live View Watch and Takeover (§14.11).

CREATE TABLE IF NOT EXISTS browser_access_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,

  principal_id TEXT,
  origin_channel TEXT,
  origin_external_id TEXT,
  origin_scope TEXT,

  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,

  requested_mode TEXT NOT NULL,
  current_mode TEXT NOT NULL,
  created_by TEXT NOT NULL,
  reason_code TEXT,
  instructions TEXT,
  privacy_mode TEXT NOT NULL DEFAULT 'normal',

  browser_session_ref TEXT,
  target_ref TEXT,
  control_epoch INTEGER NOT NULL DEFAULT 0,

  max_redemptions INTEGER NOT NULL DEFAULT 1,
  redemption_count INTEGER NOT NULL DEFAULT 0,

  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  takeover_at INTEGER,
  completed_at INTEGER,
  revoked_at INTEGER,

  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_browser_grants_task
  ON browser_access_grants(workspace_id, task_id, status);

CREATE INDEX IF NOT EXISTS idx_browser_grants_expiry
  ON browser_access_grants(status, expires_at);
