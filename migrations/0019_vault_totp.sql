-- 0019_vault_totp.sql — Vault TOTP authenticator metadata flag.
-- Non-sensitive boolean flag indicating whether an active authenticator is configured.
-- Secrets, seeds, and OTP codes are strictly stored inside encrypted ciphertext.

ALTER TABLE vault_items ADD COLUMN has_totp INTEGER NOT NULL DEFAULT 0;
