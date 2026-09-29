





ALTER TABLE bind_nonces ADD COLUMN claim_channel TEXT;
ALTER TABLE bind_nonces ADD COLUMN claim_external_id TEXT;


ALTER TABLE oauth_states ADD COLUMN consumed_at INTEGER;
ALTER TABLE oauth_states ADD COLUMN claim_token TEXT;


CREATE TABLE IF NOT EXISTS a2a_seq_reservations (
  workspace_id      TEXT NOT NULL,
  protocol_convo_id TEXT NOT NULL,
  peer_address      TEXT NOT NULL,
  direction         TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, protocol_convo_id, peer_address, direction, seq)
);


CREATE TABLE IF NOT EXISTS a2a_discovery_issuers (
  issuer           TEXT PRIMARY KEY,
  accepts_a2a      INTEGER NOT NULL,
  mail_domains_json TEXT NOT NULL,
  fetched_at       INTEGER NOT NULL,
  cache_expires_at INTEGER NOT NULL
);


ALTER TABLE a2a_convos ADD COLUMN peer_issuer TEXT;


ALTER TABLE email_messages ADD COLUMN body_text TEXT;
ALTER TABLE email_messages ADD COLUMN body_html TEXT;
ALTER TABLE email_messages ADD COLUMN attachments_json TEXT;
ALTER TABLE email_messages ADD COLUMN raw_r2_key TEXT;
ALTER TABLE email_messages ADD COLUMN ingest_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_messages ADD COLUMN ingest_last_error TEXT;


CREATE TABLE IF NOT EXISTS email_thread_capabilities (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  workspace_id  TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  peer_address  TEXT NOT NULL,
  local_part    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_email_thread_caps_ws
  ON email_thread_capabilities(workspace_id, thread_id);


CREATE TABLE IF NOT EXISTS trust_stop_tokens (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  edge_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  used_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trust_stop_edge ON trust_stop_tokens(workspace_id, edge_id);


ALTER TABLE email_counters ADD COLUMN updated_at INTEGER;



ALTER TABLE email_outbox ADD COLUMN payload_sha256 TEXT;



ALTER TABLE channel_outbox ADD COLUMN uncertain_at INTEGER;


ALTER TABLE a2a_messages ADD COLUMN issuer TEXT;
