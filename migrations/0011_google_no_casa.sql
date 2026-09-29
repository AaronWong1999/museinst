






CREATE TABLE IF NOT EXISTS google_file_grants (
  workspace_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  file_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  name TEXT NOT NULL,
  web_view_link TEXT,
  source TEXT NOT NULL CHECK(source IN ('picker','created_by_openinst')),
  granted_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (workspace_id, account_label, file_id)
);

CREATE INDEX IF NOT EXISTS idx_google_file_grants_ws
ON google_file_grants(workspace_id, account_label, granted_at DESC);


ALTER TABLE mailbox_accounts ADD COLUMN username TEXT;


DELETE FROM connector_slots WHERE slot_key LIKE 'oauth:outlook:%';
DELETE FROM connections WHERE provider = 'outlook';
DELETE FROM encrypted_secrets WHERE namespace = 'connection:outlook';
DELETE FROM oauth_states WHERE provider = 'outlook';
