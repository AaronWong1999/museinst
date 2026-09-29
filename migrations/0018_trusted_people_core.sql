-- 0018_trusted_people_core.sql — Trusted People core workflow and A2A initiation tables.
-- Defines trust_requests (independent workflow table for pending/accepted/declined/cancelled/expired requests),
-- trust_control_seen (idempotency barrier for signed control messages),
-- and a2a_initiations (durable crash-safe owner A2A coordination intents).

CREATE TABLE IF NOT EXISTS trust_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  protocol_request_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  peer_address TEXT NOT NULL,
  peer_issuer TEXT,
  display_name TEXT,
  relation TEXT,
  edge_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  verification_source TEXT,
  transport_email_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  last_error TEXT,
  UNIQUE(workspace_id, protocol_request_id, direction)
);

CREATE INDEX IF NOT EXISTS idx_trust_requests_ws_status
  ON trust_requests(workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trust_requests_peer
  ON trust_requests(workspace_id, peer_address, status);

CREATE TABLE IF NOT EXISTS trust_control_seen (
  workspace_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  protocol_request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  envelope_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, issuer, protocol_request_id, kind)
);

CREATE TABLE IF NOT EXISTS a2a_initiations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  protocol_convo_id TEXT NOT NULL,
  peer_address TEXT NOT NULL,
  intent TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'allocated',
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, logical_key)
);

CREATE INDEX IF NOT EXISTS idx_a2a_initiations_ws_state
  ON a2a_initiations(workspace_id, state, created_at DESC);
