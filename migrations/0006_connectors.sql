




ALTER TABLE connections ADD COLUMN display_name TEXT;
ALTER TABLE connections ADD COLUMN created_at INTEGER;
ALTER TABLE connections ADD COLUMN updated_at INTEGER;
ALTER TABLE connections ADD COLUMN last_ok_at INTEGER;
ALTER TABLE connections ADD COLUMN last_error TEXT;
ALTER TABLE connections ADD COLUMN needs_reauth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connections ADD COLUMN reauth_notified_at INTEGER;
ALTER TABLE connections ADD COLUMN authorized_at INTEGER;
ALTER TABLE connections ADD COLUMN refresh_expires_at INTEGER;
ALTER TABLE connections ADD COLUMN refresh_generation INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_conn_ws_provider ON connections(workspace_id, provider);
CREATE INDEX IF NOT EXISTS idx_conn_reauth ON connections(workspace_id, needs_reauth);
CREATE INDEX IF NOT EXISTS idx_conn_refresh_exp ON connections(refresh_expires_at);


ALTER TABLE oauth_states ADD COLUMN user_id TEXT;
ALTER TABLE oauth_states ADD COLUMN code_verifier TEXT;
ALTER TABLE oauth_states ADD COLUMN expires_at INTEGER;
ALTER TABLE oauth_states ADD COLUMN reauth_label TEXT;
CREATE INDEX IF NOT EXISTS idx_oauth_state_exp ON oauth_states(expires_at);


ALTER TABLE settings ADD COLUMN updated_at INTEGER;

-- IMAP metadata
CREATE TABLE IF NOT EXISTS mailbox_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL DEFAULT 465,
  smtp_starttls INTEGER NOT NULL DEFAULT 0,
  send_id INTEGER NOT NULL DEFAULT 0,
  vault_item_id TEXT NOT NULL,
  last_ok_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, email)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_ws ON mailbox_accounts(workspace_id);


CREATE TABLE IF NOT EXISTS connector_slots (
  workspace_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, slot_key)
);
CREATE INDEX IF NOT EXISTS idx_connector_slots_ws ON connector_slots(workspace_id);
CREATE INDEX IF NOT EXISTS idx_connector_slots_provider ON connector_slots(workspace_id, provider);


CREATE TABLE IF NOT EXISTS connector_audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_label TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connector_audit_ws ON connector_audit(workspace_id, created_at DESC);


CREATE TABLE IF NOT EXISTS imap_send_idempotency (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_progress','sent','failed_pre_send','unknown')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imap_idem_created ON imap_send_idempotency(created_at);


INSERT OR IGNORE INTO connector_slots(workspace_id, slot_key, provider, account_label, created_at)
SELECT workspace_id,
       'oauth:' || provider || ':' || account_label,
       provider,
       account_label,
       COALESCE(created_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
FROM connections;

UPDATE connections
SET created_at = COALESCE(created_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
    updated_at = COALESCE(updated_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
    authorized_at = COALESCE(authorized_at, CAST(strftime('%s','now') AS INTEGER) * 1000);
