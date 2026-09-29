



CREATE TABLE wechat_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX idx_outbox_user ON wechat_outbox(to_user_id, created_at);
