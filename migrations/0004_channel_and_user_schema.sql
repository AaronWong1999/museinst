ALTER TABLE wechat_bots ADD COLUMN workspace_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_bots_workspace
  ON wechat_bots(workspace_id)
  WHERE workspace_id IS NOT NULL;
