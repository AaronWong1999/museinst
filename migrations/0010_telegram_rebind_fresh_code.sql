-- Telegram rebind must always start from a fresh channel-bind capability.
--
-- A workspace can accumulate unused bind_code rows from earlier console/QR visits.
-- When its Telegram identity is explicitly removed, those old capabilities must
-- not survive the unlink boundary: an old tab/link could otherwise be reused,
-- and the next bind UI could surface a stale capability.
--
-- Consumed rows are intentionally retained for short-term idempotent replay and
-- audit behavior in the dispatcher; only still-unused bind codes are revoked.
CREATE TRIGGER IF NOT EXISTS trg_telegram_unbind_revoke_unused_bind_codes
AFTER DELETE ON channel_identities
WHEN OLD.channel = 'telegram'
BEGIN
  DELETE FROM bind_nonces
   WHERE workspace_id = OLD.workspace_id
     AND purpose = 'bind_code'
     AND used_at IS NULL;
END;
