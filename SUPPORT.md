# Support and compatibility

The supported baseline is Node.js 22, the Wrangler version resolved by `package-lock.json`, and Cloudflare Workers with D1, KV, R2, Durable Objects, Browser Rendering, and—when enabled—Queues and Email Routing / Send Email.

The Deploy to Cloudflare button starts from the root `wrangler.jsonc` template. Local CLI deployment generates configuration from `config/openinst.config.json`; do not hand-edit files under `.generated/`. Agent Mail requires an operator-controlled domain in `agentEmail.domain` and matching Cloudflare mail configuration.

For upgrades, run the complete verification suite and local D1 migrations first. Keep a rollback commit and a database backup/export procedure appropriate to your Cloudflare plan before applying production migrations.

Support requests should include the exact MuseInst commit, Node.js version, Wrangler version, deployment mode, and redacted error logs.
