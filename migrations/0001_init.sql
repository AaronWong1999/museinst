CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  display_name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE channel_identities (
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  first_bound_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (channel, external_id)
);
CREATE INDEX idx_ci_ws ON channel_identities(workspace_id);

CREATE TABLE unbind_cooldowns (
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  unbound_at INTEGER NOT NULL,
  PRIMARY KEY (channel, external_id)
);

CREATE TABLE vault_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('login','payment','address','contact','phone','identity','token')),
  label TEXT NOT NULL,
  account TEXT NOT NULL,
  origin TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_vi_ws ON vault_items(workspace_id);

CREATE TABLE encrypted_secrets (
  workspace_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, namespace, id)
);

CREATE TABLE connections (
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_label TEXT NOT NULL DEFAULT '',
  encrypted_token TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at INTEGER,
  scopes TEXT,
  PRIMARY KEY (workspace_id, provider, account_label)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  class TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  fail_reason TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  cost_usd REAL,
  trace_id TEXT
);
CREATE INDEX idx_tasks_ws ON tasks(workspace_id, started_at DESC);

CREATE TABLE task_evidence (
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, type, value)
);

CREATE TABLE task_steps (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  desc TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE task_receipts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  share_slug TEXT UNIQUE,
  redacted_json TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  source_task_id TEXT,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  template_json TEXT NOT NULL,
  connectors TEXT,
  locale TEXT NOT NULL DEFAULT 'zh',
  public INTEGER NOT NULL DEFAULT 0,
  runs INTEGER DEFAULT 0,
  author_workspace TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  tool_name TEXT,
  payload_json TEXT NOT NULL,
  channel TEXT NOT NULL,
  decided_at INTEGER,
  decision TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE usage_daily (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  browser_ms INTEGER DEFAULT 0,
  tasks_ok INTEGER DEFAULT 0,
  tasks_fail INTEGER DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);

CREATE TABLE bind_nonces (
  nonce TEXT PRIMARY KEY,
  workspace_id TEXT,
  user_id TEXT,
  purpose TEXT NOT NULL DEFAULT 'login',
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE wechat_bots (
  id TEXT PRIMARY KEY,
  token_enc TEXT NOT NULL,
  bot_user_id TEXT,
  updates_buf_enc TEXT,
  updates_buf_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  dead_reason TEXT,
  mode TEXT NOT NULL DEFAULT 'solo' CHECK (mode='solo'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE wechat_qr_sessions (
  id TEXT PRIMARY KEY,
  qrcode_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  bot_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  redirect_to TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
