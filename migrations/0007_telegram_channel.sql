






CREATE TABLE IF NOT EXISTS channel_inbox (
  id             TEXT PRIMARY KEY,
  channel        TEXT NOT NULL,
  bot_id         TEXT NOT NULL,
  external_key   TEXT NOT NULL,
  payload_json   TEXT,
  result_json    TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',
  attempts       INTEGER NOT NULL DEFAULT 0,
  lease_token    TEXT,
  lease_until    INTEGER,
  received_at    INTEGER NOT NULL,
  processed_at   INTEGER,
  completed_at   INTEGER,
  last_error     TEXT,
  UNIQUE(channel, bot_id, external_key)
);

CREATE INDEX IF NOT EXISTS idx_channel_inbox_status
  ON channel_inbox(channel, status, received_at);

CREATE TABLE IF NOT EXISTS channel_outbox (
  id                  TEXT PRIMARY KEY,
  inbox_id            TEXT NOT NULL,
  channel             TEXT NOT NULL,
  destination_id      TEXT NOT NULL,
  reply_to_message_id TEXT,
  reply_index         INTEGER NOT NULL,
  chunk_index         INTEGER NOT NULL,
  text                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  telegram_message_id TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  sent_at             INTEGER,
  UNIQUE(inbox_id, reply_index, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_channel_outbox_pending
  ON channel_outbox(channel, status, created_at);

CREATE TABLE IF NOT EXISTS channel_metrics (
  day     TEXT NOT NULL,
  channel TEXT NOT NULL,
  event   TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, channel, event)
);

ALTER TABLE bind_nonces ADD COLUMN used_by_channel TEXT;
ALTER TABLE bind_nonces ADD COLUMN used_by_external_id TEXT;
ALTER TABLE bind_nonces ADD COLUMN result_login_nonce TEXT;
ALTER TABLE bind_nonces ADD COLUMN claim_state TEXT;
ALTER TABLE bind_nonces ADD COLUMN claim_token TEXT;
ALTER TABLE bind_nonces ADD COLUMN claimed_at INTEGER;
