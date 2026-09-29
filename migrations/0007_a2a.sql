


CREATE TABLE IF NOT EXISTS trust_edges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  peer_address TEXT NOT NULL,
  peer_agent TEXT,
  peer_issuer TEXT,
  display_name TEXT,
  relation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  disclosure_json TEXT NOT NULL,
  auto_accept INTEGER NOT NULL DEFAULT 0,
  invited_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  revoked_at INTEGER,
  UNIQUE(workspace_id, peer_address)
);

CREATE TABLE IF NOT EXISTS trust_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS a2a_convos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  protocol_convo_id TEXT NOT NULL,
  role TEXT NOT NULL,
  peer_address TEXT NOT NULL,
  intent TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  rounds INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 12,
  budget_micro INTEGER NOT NULL DEFAULT 10000000,
  spent_micro INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  thread_id TEXT,
  root_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, protocol_convo_id)
);

CREATE TABLE IF NOT EXISTS a2a_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  local_convo_id TEXT NOT NULL,
  protocol_convo_id TEXT NOT NULL,
  peer_address TEXT NOT NULL,
  direction TEXT NOT NULL,
  type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  human_body TEXT NOT NULL,
  human_body_sha256 TEXT NOT NULL,
  sig_kid TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  email_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, protocol_convo_id, peer_address, direction, seq)
);

CREATE TABLE IF NOT EXISTS a2a_domain_keys (
  issuer TEXT NOT NULL,
  kid TEXT NOT NULL,
  public_key TEXT NOT NULL,
  not_before INTEGER,
  not_after INTEGER,
  fetched_at INTEGER NOT NULL,
  cache_expires_at INTEGER NOT NULL,
  PRIMARY KEY(issuer, kid)
);

CREATE TABLE IF NOT EXISTS a2a_domain_consents (
  workspace_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  status TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at INTEGER,
  PRIMARY KEY(workspace_id, issuer)
);

CREATE TABLE IF NOT EXISTS a2a_optouts (
  workspace_id TEXT NOT NULL,
  peer_address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, peer_address)
);
