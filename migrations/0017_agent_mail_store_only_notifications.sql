-- 0017_agent_mail_store_only_notifications.sql — durable owner notifications for
-- store-only ingress outcomes that never reach the Queue consumer.
--
-- Queue-terminal outcomes enqueue notifications in TypeScript. These ingress-terminal
-- states happen before Queue dispatch, so enforce notification creation at the same D1
-- commit boundary as the state transition. INSERT OR IGNORE is replay-safe via the
-- existing UNIQUE(email_row_id, kind).

CREATE TRIGGER IF NOT EXISTS trg_agent_mail_store_only_owner_notification
AFTER UPDATE OF ingest_state, ingest_last_error ON email_messages
FOR EACH ROW
WHEN NEW.direction = 'in'
  AND (
    (NEW.ingest_state = 'stored' AND NEW.ingest_last_error IN (
      'empty_body',
      'stranger_autoreply_off',
      'total_cap_exceeded',
      'peer_cap_exceeded',
      'admission_race_lost'
    ))
    OR NEW.ingest_state = 'stored_gated'
  )
BEGIN
  INSERT OR IGNORE INTO email_owner_notifications
    (id, workspace_id, email_row_id, kind, reason, status, attempts, next_attempt_at, created_at)
  VALUES (
    'notif_store_' || NEW.id,
    NEW.workspace_id,
    NEW.id,
    'inbound_email',
    CASE
      WHEN NEW.ingest_state = 'stored_gated' THEN 'stored_gated'
      WHEN NEW.ingest_last_error IN ('total_cap_exceeded','peer_cap_exceeded','admission_race_lost') THEN 'stored_quota_exceeded'
      ELSE NEW.ingest_last_error
    END,
    'queued',
    0,
    CAST(strftime('%s','now') AS INTEGER) * 1000,
    CAST(strftime('%s','now') AS INTEGER) * 1000
  );
END;
