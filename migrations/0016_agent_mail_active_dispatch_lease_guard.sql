-- 0016_agent_mail_active_dispatch_lease_guard.sql — protect live Queue leases from legacy ingress reclaim.
--
-- The pre-Queue ingress CAS still has a legacy processing_started_at timeout. A duplicate SMTP
-- delivery must never reclaim a row while the Queue consumer owns a non-expired ingest lease.
-- Enforce that invariant at D1 so old/replayed ingress code cannot steal a live worker's row.

CREATE TRIGGER IF NOT EXISTS trg_email_messages_preserve_active_dispatch_lease
BEFORE UPDATE OF ingest_state, processing_started_at ON email_messages
FOR EACH ROW
WHEN OLD.ingest_state = 'processing'
  AND NEW.ingest_state = 'processing'
  AND OLD.ingest_lease_until IS NOT NULL
  AND OLD.ingest_lease_until > (CAST(strftime('%s','now') AS INTEGER) * 1000)
  AND NEW.ingest_lease_token IS OLD.ingest_lease_token
BEGIN
  SELECT RAISE(IGNORE);
END;
