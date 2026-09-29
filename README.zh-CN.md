<div align="center">

<img src="docs/readme/hero.png" alt="MuseInst。把 Personal Agent 放进你的产品，成本降到 1/1000。" width="100%">

<br>

<a href="https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FAaronWong1999%2Fmuseinst"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height="44"></a>

<br>

[官网](https://museinst.com) · [工作原理](#工作原理) · [成本](#成本) · [部署](#部署到你的-cloudflare) · [企业版](#企业版) · [English](README.md)

</div>

<br>

MuseInst 是一套 Personal Agent 基础设施，在 Cloudflare 上运行无 VM 的 Personal Agent。<br>
不用给每个用户配云电脑，每人每月约 $0.02，是独享 VM 的 1/1000、共享 VM 的 1/100。<br>
Agent 邮箱、微信、Telegram、云浏览器、长期记忆，一样不少。

## 为什么

<sub><code>Hermes Agent · OpenClaw · Grok Bot · Instinct · Muse · Cue · dots …</code></sub>

Personal Agent 一个接一个出现，但每个用户一台云电脑的成本，让它一直只是大厂的游戏。机器全天候计费，Agent 大部分时间却在等待。

MuseInst 给每个用户**一个持久的 Agent，而不是一台持久的机器**。Agent 的记忆和任务存在存储里，只在干活时才用算力。这样每个用户每月只要几美分，低到任何产品都能给每个用户配一个，一个人用 Cloudflare 的免费额度也能跑自己的。

这是几天时间写出来的，还很早期，但已经在 [museinst.com](https://museinst.com) 上线运行。

## 工作原理

<img src="docs/readme/arch.png" alt="VM-less personal agent 架构示意" width="100%">

- **每个用户一个 Durable Object，它就是 Agent 本体。** 记忆、任务、定时计划和对话都在里面。收到消息、邮件或定时触发时醒来，干完继续休眠。
- **浏览器按任务启动。** 可以实时观看，遇到登录或验证码时接管，完成后交还；任务结束就停止。
- **其余数据存在 D1、KV、R2 里**，都在你自己的 Cloudflare 账号下。

## 一个 Agent，处处都在

<img src="docs/readme/everywhere.png" alt="微信、Telegram、网页工作区和 Agent 邮箱共享同一份长期记忆" width="100%">

| | |
| --- | --- |
| **Agent 邮箱** | 它自己的邮箱地址。可信联系人按你授予的权限协作，陌生人只能看到公开信息。 |
| **渠道** | 微信（iLink）、Telegram 和网页工作区，共享同一份记忆。 |
| **云浏览器** | 搜索、登录、填表、下载，支持实时观看与接管。 |
| **记忆与时间** | 长期记忆、任务、提醒、周期计划。 |
| **连接器** | Google Workspace、GitHub、飞书 / Lark、任意 IMAP/SMTP 邮箱。 |
| **网页** | 无需 API Key 的搜索与网页抓取。 |
| **模型** | 默认 Workers AI，也可以接任意 OpenAI 兼容接口。 |
| **任务凭证** | 完成的任务可以生成可分享的凭证。 |

## 成本

<img src="docs/readme/cost.png" alt="成本公式与不同浏览器用量下的对比" width="100%">

`基础设施成本 ≈ $0.02 + $0.09 × 每月浏览器小时数`

以下是估算，不是报价。口径如下：

- **Agent 运行时。** 每个用户每天约 20 个任务、不用浏览器，按 Cloudflare 公开价格，Workers、Durable Objects、D1、KV、R2 的用量约合每月 $0.01，预算按 $0.02 计。
- **云浏览器。** 按用量计费，Cloudflare Browser Rendering 超出包含额度后为每小时 $0.09。
- **对比基准。** 共享 VM 按每用户每月约 $2、独享 VM 约 $20 计。所有方案都不含大模型 Token。
- **影响数字的因素。** Agent 单次任务越长，Durable Object 活跃时间越长；浏览器按小时累计。重度用户会更贵，但上面的公式依然成立。

## 部署到你的 Cloudflare

<div align="center">

<a href="https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FAaronWong1999%2Fmuseinst"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height="44"></a>

**不需要服务器，起步不需要任何 API Key。个人使用，大概率免费额度就够。**

</div>

1. 点 **Deploy to Cloudflare** 并登录，保持默认设置即可。Worker、数据库和存储由 Cloudflare 自动创建，没有任何需要填写的东西。
2. 打开 Worker 地址，点 **认领我的 Agent**。它就是你的了，直接开始对话。

模型用同一账号下的 Workers AI，不需要 API Key。加密密钥在部署时自动生成，不离开 Cloudflare。部署后一小时内认领；过了时间重新部署一次即可，也可以在 Worker 里设置 `ADMIN_KEY`，改用密码进入。

### 免费计划够用吗？

MuseInst 用到的每个服务都有免费额度，通常最先用完的是浏览器。

| 服务 | 用途 | Workers Free | Workers Paid（$5/月） |
| --- | --- | --- | --- |
| Workers | 所有请求 | 每天 100,000 次请求 | 每月含 1000 万次请求 |
| Durable Objects（SQLite） | Agent 本体 | 每天 100,000 次请求，5 GB | 含额度，超出按量计费 |
| D1 · KV | 任务、凭证、设置 | 每日免费额度 | 含额度，超出按量计费 |
| R2 | 文件 | 10 GB 免费（需在账号中开启 R2） | 10 GB 免费，超出按量计费 |
| Browser Rendering | 云浏览器 | 每天 10 分钟，3 个并发浏览器 | 每月含 10 小时，超出 $0.09/小时 |
| Workers AI | 默认模型 | 每日免费额度 | 按量计费 |

轻度个人使用在免费计划内。如果 Agent 经常用浏览器，升级到 Workers Paid 即可，费用直接付给 Cloudflare，不经过我们。

起步**不需要** Telegram Bot、微信登录、Google OAuth 应用或模型 API Key，渠道和连接器之后逐个添加。

**实时观看与接管。** 创建一个带 *Browser Rendering: Edit* 权限的 Cloudflare API Token，然后在 Worker 设置里（Dashboard → Workers → 你的 Worker → Settings → Variables and Secrets）添加以下两个 Secret，或在下方的本地配置里填写 `browser.liveView`。

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `BROWSER_LIVE_VIEW_ACCOUNT_ID` | Secret | 你的 Cloudflare 账号 ID |
| `BROWSER_API_TOKEN` | Secret | 上面创建的 Token |

### 本地命令行部署

自定义域名、Telegram、Agent 邮箱、自选模型或更多连接器，使用本地配置文件：

```bash
git clone https://github.com/AaronWong1999/museinst.git
cd museinst
npm ci
npm run config:init          # 生成 config/openinst.config.json
# 编辑 config/openinst.config.json
npx wrangler login
npm run deploy
```

`config/openinst.config.json`、`.generated/` 和 `.dev.vars` 已被 Git 忽略，请勿提交真实凭证。

| 能力 | 如何开启 |
| --- | --- |
| 网页工作区 | 初始化后即可使用 |
| 云浏览器 | 默认开启 |
| 微信（iLink） | 在管理页扫码登录 |
| Telegram | 在本地配置中填写 BotFather Token 和 Webhook Secret |
| Agent 邮箱 | 托管在 Cloudflare 的域名 + Email Routing，以及发信配置 |
| Google Workspace | 你自己的 Google OAuth 应用 |
| GitHub · 飞书 · Lark | 你自己的 OAuth 或应用凭证 |
| IMAP / SMTP 邮箱 | 在 Vault 中添加 |
| 其他模型 | 任意 OpenAI 兼容接口 |

## 企业版

想在**你自己的产品里**给每个用户配一个 Personal Agent？通常卡住的是云电脑成本。MuseInst 企业版在同一个 VM-less 内核上，增加了多用户、SSO、白标、套餐与计费和管理后台，部署在你自己的 Cloudflare 账号里。

企业版 Demo 在 [museinst.com](https://museinst.com) 上线运行，凭邀请码进入。邀请码可以在 X 上找 [@aaron0x10](https://x.com/aaron0x10)，或发邮件到 run@museinst.com。

## 参与贡献

```bash
npm ci
npm run verify     # 公开源码审计、类型检查、测试与生产构建
npm run dry-run    # 校验 Wrangler 部署配置
```

欢迎提 Issue 和 PR。请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)，不要在报告或测试数据中放入凭证或个人信息。

## 许可

[Apache-2.0](LICENSE)，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

MuseInst 是独立开源项目，与 Meta、Cloudflare、腾讯、Telegram、Google 均无关联。文中产品名称为各自所有者的商标。
