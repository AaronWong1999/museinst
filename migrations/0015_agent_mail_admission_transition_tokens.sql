-- 0015_agent_mail_admission_transition_tokens.sql — make Agent Mail admission side effects transition-owned.
--
-- A reserve/release can race with replay/recovery. The token identifies the single
-- state transition that owns counter side effects, so losing attempts cannot
-- double-charge or double-refund another email's quota.

ALTER TABLE email_model_admissions ADD COLUMN transition_token TEXT;
