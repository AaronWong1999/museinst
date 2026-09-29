
ALTER TABLE email_messages ADD COLUMN dispatch_enqueued_at INTEGER;
ALTER TABLE email_messages ADD COLUMN ingest_lease_token TEXT;
ALTER TABLE email_messages ADD COLUMN ingest_lease_until INTEGER;
ALTER TABLE email_messages ADD COLUMN external_admission_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE email_messages ADD COLUMN external_admission_reason TEXT;
ALTER TABLE email_messages ADD COLUMN external_admitted_at INTEGER;
ALTER TABLE email_messages ADD COLUMN notified_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_email_messages_dispatch_due
  ON email_messages(ingest_state, dispatch_enqueued_at, ingest_lease_until);

CREATE INDEX IF NOT EXISTS idx_email_messages_ws_dir_created
  ON email_messages(workspace_id, direction, created_at DESC);

CREATE TABLE IF NOT EXISTS email_model_admissions (
  workspace_id TEXT NOT NULL,
  email_row_id TEXT NOT NULL,
  day TEXT NOT NULL,
  peer_scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  released_at INTEGER,
  PRIMARY KEY (workspace_id, email_row_id)
);

CREATE TABLE IF NOT EXISTS email_owner_notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email_row_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'inbound_email',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE(email_row_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_email_owner_notifications_due
  ON email_owner_notifications(status, next_attempt_at);
