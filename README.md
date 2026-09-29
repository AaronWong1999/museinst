<div align="center">

<img src="docs/readme/hero.png" alt="MuseInst. Put a personal agent inside your product. At 1/1000 the cost." width="100%">

<br>

<a href="https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FAaronWong1999%2Fmuseinst"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height="44"></a>

<br>

[Website](https://museinst.com) · [How it works](#how-it-works) · [Cost](#cost) · [Deploy](#deploy-to-your-cloudflare-account) · [Enterprise](#enterprise) · [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-1a1a1a.svg)](LICENSE) [![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020.svg?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/) [![GitHub stars](https://img.shields.io/github/stars/AaronWong1999/museinst?style=social)](https://github.com/AaronWong1999/museinst/stargazers)

</div>

<br>

MuseInst is personal agent infra that runs VM-less personal agents on Cloudflare.<br>
No cloud computer per user, about $0.02 a month, 1/1000 of a dedicated VM, 1/100 of a shared one.<br>
Agent Mail, WeChat, Telegram, a cloud browser and long-term memory, all included.

## Why

<sub><code>Hermes Agent · OpenClaw · Grok Bot · Instinct · Muse · Cue · dots …</code></sub>

Personal agents keep arriving, but a cloud computer per user has kept them a big-company game. The machine is billed around the clock while the agent mostly waits.

MuseInst gives each user **one persistent agent, not one persistent machine**. The agent keeps its memory and tasks in storage and only uses compute while it works. That brings the cost of an agent down to cents per user per month, low enough that any product can give every user one, and one person can run their own on Cloudflare's free tier.

We built it over a few days, so it is early. It already runs in production at [museinst.com](https://museinst.com).

## How it works

<img src="docs/readme/arch.png" alt="VM-less personal agent. Always there, billed by storage: a Durable Object per user and D1, KV, R2. Only while working, billed by use: the agent turn and an on-demand cloud browser. The VM way: one always-on machine per user." width="100%">

- **A Durable Object per user is the agent.** It holds memory, tasks, schedules and the conversation. It wakes on a message, an email or a schedule, does the work, and sleeps again.
- **The browser starts per task.** Watch it live, take over for a sign-in or CAPTCHA, then hand it back. It stops when the task is done.
- **Everything else lives in D1, KV and R2**, inside your own Cloudflare account.

## One agent, everywhere

<img src="docs/readme/everywhere.png" alt="One agent, one memory, everywhere: WeChat, Telegram, the web workspace and Agent Mail share the same long-term memory." width="100%">

| | |
| --- | --- |
| **Agent Mail** | An address of its own. Trusted people get the permissions you grant; strangers get public information only. |
| **Channels** | WeChat (iLink), Telegram and a web workspace, all sharing one memory. |
| **Cloud browser** | Search, sign in, fill forms and download files, with live view and takeover. |
| **Memory and time** | Long-term memory, tasks, reminders and recurring schedules. |
| **Connectors** | Google Workspace, GitHub, Feishu / Lark and any IMAP/SMTP mailbox. |
| **Web** | Search and page fetch without an API key. |
| **Model** | Workers AI out of the box, or any OpenAI-compatible endpoint. |
| **Receipts** | Every finished task can produce a shareable receipt. |

## Cost

<img src="docs/readme/cost.png" alt="Infra is about $0.02 plus $0.09 per browser hour per month. No browser use: $0.02, 1/100 of a shared VM and 1/1000 of a dedicated VM. Two browser hours: $0.20. Ten browser hours: $0.92." width="100%">

`infra ≈ $0.02 + $0.09 × browser hours per month`

These figures are estimates, not a quote. How we get them:

- **Agent runtime.** About 20 tasks per user per day without a browser comes to roughly $0.01 per user per month in Workers, Durable Objects, D1, KV and R2 usage at Cloudflare's list prices. We budget $0.02.
- **Cloud browser.** Billed per use at Cloudflare Browser Rendering's price, $0.09 per browser hour after the included hours.
- **Baselines.** A shared VM is taken as about $2 and a dedicated VM as about $20 per user per month. LLM tokens are excluded for every option.
- **What moves the number.** Longer agent turns keep the Durable Object active for longer, and browser time adds up by the hour. Heavy users cost more; the formula above still holds.

## Deploy to your Cloudflare account

<div align="center">

<a href="https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FAaronWong1999%2Fmuseinst"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height="44"></a>

**No server and no API key to start. For personal use, the free tier is usually enough.**

</div>

1. Click **Deploy to Cloudflare** and sign in. Keep the defaults: Cloudflare creates the Worker, database and storage, and there is nothing to fill in.
2. Open your Worker URL and press **Claim my agent**. It is yours, and you are already talking to it.

The model runs on Workers AI in the same account, so there is no API key. Encryption keys are generated during the deploy and never leave Cloudflare. Claim within an hour of deploying; after that, redeploy to reopen the window, or set `ADMIN_KEY` as a Worker secret to use a password instead.

### Does it run on the free plan?

Every service MuseInst uses has a free allowance. The browser usually runs out first.

| Service | Used for | Workers Free | Workers Paid ($5/month) |
| --- | --- | --- | --- |
| Workers | Every request | 100,000 requests/day | 10M requests/month included |
| Durable Objects (SQLite) | The agent itself | 100,000 requests/day, 5 GB | Included, then usage-based |
| D1 · KV | Tasks, receipts, settings | Free daily allowance | Included, then usage-based |
| R2 | Files and artifacts | 10 GB free (enable R2 on the account) | 10 GB free, then usage-based |
| Browser Rendering | Cloud browser | 10 minutes/day, 3 concurrent browsers | 10 hours/month included, then $0.09/hour |
| Workers AI | Default model | Free daily allowance | Usage-based |

Light personal use fits the free plan. If your agent browses a lot, move to Workers Paid. You pay Cloudflare directly, never us.

You do **not** need a Telegram bot, a WeChat login, a Google OAuth app or a model API key to start. Add channels and connectors later, one at a time.

**Live view and takeover.** Create a Cloudflare API token with *Browser Rendering: Edit* permission, then add two secrets to your Worker (Dashboard → Workers → your Worker → Settings → Variables and Secrets), or set `browser.liveView` in the local config below.

| Name | Type | Value |
| --- | --- | --- |
| `BROWSER_LIVE_VIEW_ACCOUNT_ID` | Secret | Your Cloudflare account ID |
| `BROWSER_API_TOKEN` | Secret | The API token |

### Local CLI deployment

For a custom domain, Telegram, Agent Mail, your own model or more connectors, use the local config file.

```bash
git clone https://github.com/AaronWong1999/museinst.git
cd museinst
npm ci
npm run config:init          # creates config/openinst.config.json
# edit config/openinst.config.json
npx wrangler login
npm run deploy
```

`config/openinst.config.json`, `.generated/` and `.dev.vars` are git-ignored. Never commit real credentials.

| Capability | How to enable |
| --- | --- |
| Web workspace | Ready after first-run setup |
| Cloud browser | On by default |
| WeChat (iLink) | Scan the login QR code on the admin page |
| Telegram | BotFather token and webhook secret in the local config |
| Agent Mail | A domain on Cloudflare with Email Routing, plus outbound mail |
| Google Workspace | Your own Google OAuth client |
| GitHub · Feishu · Lark | Your own OAuth or app credentials |
| IMAP / SMTP mail | Add the mailbox in Vault |
| Another model | Any OpenAI-compatible endpoint |

## Enterprise

Want a personal agent **inside your own product**, for every user? The cloud-computer bill is usually what stops it. MuseInst Enterprise adds multi-user workspaces, SSO, white-label branding, plans and billing, and admin on top of the same VM-less core, running in your own Cloudflare account.

An Enterprise demo runs at [museinst.com](https://museinst.com), by invitation. Ask on X [@aaron0x10](https://x.com/aaron0x10) or email run@museinst.com.

## Contributing

```bash
npm ci
npm run verify     # public-source audit, types, tests and production build
npm run dry-run    # validates the Wrangler deployment shape
```

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md), and keep credentials and personal data out of reports and fixtures.

## License

[Apache-2.0](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).

MuseInst is an independent open-source project and is not affiliated with Meta, Cloudflare, Tencent, Telegram or Google. Product names are trademarks of their respective owners.
