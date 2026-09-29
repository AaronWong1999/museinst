


CREATE TABLE IF NOT EXISTS agent_mailboxes (
  workspace_id TEXT PRIMARY KEY,
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  daily_out_cap INTEGER NOT NULL DEFAULT 100,
  daily_in_cap INTEGER NOT NULL DEFAULT 300,
  stranger_autoreply INTEGER NOT NULL DEFAULT 0,
  notify_channel TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_mailboxes_address ON agent_mailboxes(address);

CREATE TABLE IF NOT EXISTS email_contacts (
  workspace_id TEXT NOT NULL,
  address TEXT NOT NULL,
  contact_class TEXT NOT NULL DEFAULT 'unknown',
  display_name TEXT,
  address_verified_by_owner INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  msg_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, address)
);

CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_id TEXT,
  fingerprint TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  in_reply_to TEXT,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  r2_key TEXT,
  scope_key TEXT NOT NULL,
  message_auth TEXT NOT NULL DEFAULT 'none',
  capability_id TEXT,
  spam_score REAL,
  root_task_id TEXT,
  ingest_state TEXT NOT NULL DEFAULT 'reserved',
  processing_started_at INTEGER,
  processing_finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_dedupe
  ON email_messages(workspace_id, direction, fingerprint);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread
  ON email_messages(workspace_id, thread_id, created_at);

CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  text_body TEXT NOT NULL,
  html_body TEXT,
  body_sha256 TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}',
  reply_to TEXT,
  message_id TEXT NOT NULL,
  in_reply_to TEXT,
  references_json TEXT,
  thread_id TEXT,
  root_task_id TEXT,
  transport TEXT NOT NULL DEFAULT 'send_email',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER,
  provider_message_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  sent_marked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_logical
  ON email_outbox(workspace_id, logical_key);
CREATE INDEX IF NOT EXISTS idx_email_outbox_due
  ON email_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS email_counters (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, scope)
);
