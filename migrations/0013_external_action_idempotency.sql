-- migrations/0013_external_action_idempotency.sql

CREATE TABLE IF NOT EXISTS imap_send_idempotency_new (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_progress','sent','succeeded','failed_pre_send','failed_pre_effect','unknown','unknown_effect','applied_unverified')),
  last_error TEXT,
  external_id TEXT,
  result_json TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO imap_send_idempotency_new(request_id, workspace_id, payload_hash, status, last_error, created_at, updated_at)
  SELECT request_id, workspace_id, payload_hash, status, last_error, created_at, updated_at FROM imap_send_idempotency;

DROP TABLE imap_send_idempotency;
ALTER TABLE imap_send_idempotency_new RENAME TO imap_send_idempotency;
CREATE INDEX IF NOT EXISTS idx_imap_idem_created ON imap_send_idempotency(created_at);
