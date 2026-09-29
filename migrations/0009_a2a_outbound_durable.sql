-- 0009_a2a_outbound_durable.sql — crash-safe A2A outbound intent.
--




CREATE TABLE IF NOT EXISTS a2a_outbound_intents (
  workspace_id       TEXT NOT NULL,
  logical_key        TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  request_json       TEXT NOT NULL,
  protocol_convo_id  TEXT NOT NULL,
  local_convo_id     TEXT NOT NULL,
  peer_address       TEXT NOT NULL,
  from_agent         TEXT NOT NULL,
  peer_issuer        TEXT NOT NULL,
  message_type       TEXT NOT NULL,
  source_state       TEXT NOT NULL,
  source_revision    INTEGER NOT NULL,
  desired_state      TEXT NOT NULL,
  seq                INTEGER NOT NULL,
  envelope_json      TEXT,
  signature          TEXT,
  human_body         TEXT,
  outbox_id          TEXT,
  message_id         TEXT,
  state              TEXT NOT NULL DEFAULT 'allocated', -- allocated|prepared|state_committed|stale
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, logical_key),
  UNIQUE (workspace_id, protocol_convo_id, peer_address, seq)
);

CREATE INDEX IF NOT EXISTS idx_a2a_outbound_intents_pending
  ON a2a_outbound_intents(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_a2a_outbound_intents_convo
  ON a2a_outbound_intents(workspace_id, protocol_convo_id, created_at);



CREATE TABLE IF NOT EXISTS a2a_outbound_commit_asserts (
  workspace_id TEXT NOT NULL,
  logical_key  TEXT NOT NULL,
  ok           INTEGER NOT NULL CHECK (ok = 1),
  checked_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, logical_key)
);
