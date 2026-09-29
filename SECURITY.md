# Security Policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting / a private Security Advisory for this repository. Do not open a public issue containing credentials, private customer data, or exploit details.

Include the affected commit, deployment mode, reproduction steps, impact, and relevant logs with secrets redacted.

## Supported release

Security fixes target the current release branch and the documented Node.js 22 / Cloudflare Workers deployment.

## Operational security

Keep `OPENINST_SECRET`, `VAULT_MASTER_KEY`, `ADMIN_KEY`, OAuth credentials, bot tokens, model keys, and signing keys in Cloudflare secrets or the generated secret payload. Rotate credentials after suspected exposure. Backups and production exports must not be attached to public issues.
