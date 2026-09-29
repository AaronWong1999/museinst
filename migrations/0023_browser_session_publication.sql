-- D1 migration: 0023_browser_session_publication.sql
-- Browser session publication (DEFECT-022, spec §13, §25.7).
--
-- The Computer → Browser tab used to list only browser_access_grants (handoff /
-- transfer grants, 0021). A normal agent-run browser task that completes without
-- handoff produced zero grants, so the UI always showed "no browser sessions"
-- even when a real browser session had executed. The BrowserWorker durable
-- object now publishes every real browser session here, workspace-scoped and
-- state-tracked, and GET /api/browser/sessions merges these rows with grants.
--
-- Nothing here stores a provider URL, JWT, raw grant token, or secret value.

CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  url TEXT,
  title TEXT,
  state TEXT NOT NULL,            -- active | completed | failed
  observed_text TEXT,             -- short observation summary (last observed fact)
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_browser_sessions_ws
  ON browser_sessions(workspace_id, started_at DESC);
