-- Preserve the conversation thread that accepted each task so callers can
-- link completed work back to the originating main or side thread.
ALTER TABLE tasks ADD COLUMN thread_id TEXT;
