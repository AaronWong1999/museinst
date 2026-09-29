import { Hono } from "hono";
import type { EmailDispatchEnvelope, Env, InboundEnvelope, SessionInfo } from "./env";
import { json, newId, now } from "./util";
import {
  createSession,
  readSession,
  sessionCookieHeader,
  consumeLoginNonceAndCreateSession,
} from "./session";
import { ensureOwnerWorkspace } from "./identity";
import { createBindCode } from "./channels/dispatch";
import { consumeInboundEnvelope } from "./channels/inbox";
import { handleTelegramWebhook, setupTelegramBot, getWebhookInfo } from "./channels/telegram";
import {
  getTelegramToken,
  getTelegramBotId,
  getTelegramUsername,
  telegramConfigured,
  wechatConfigured,
  isAdmin,
} from "./channels/config";
import { fetchLoginQrCode, pollQrStatus, mapQrStatusToBotStatus } from "./channels/wechat/ilink";
import { encryptField, decryptField, sha256hex } from "./crypto";
import { googleConfigured } from "./connectors/google";
import { feishuConfigured, larkConfigured } from "./connectors/feishu";
import { githubConfigured } from "./connectors/github";
import { agentMailCoreApp } from "./channels/email/http";
import { coreApiApp } from "./core/router";
import { registerPublicReceiptRoutes } from "./tasks/receipt-routes";
import QRCode from "qrcode";

const app = new Hono<{ Bindings: Env; Variables: { session: SessionInfo } }>();
registerPublicReceiptRoutes(app);

async function requireAuth(c: any, next: () => Promise<void>): Promise<Response | void> {
  const session = await readSession(c.env, c.req.raw);
  if (!session) return json({ error: "unauthorized" }, 401);
  c.set("session", session as SessionInfo);
  await next();
}

const RECOVERY_KEY_SETTING = "owner_recovery_key_sha256";

// A Deploy-button instance has no ADMIN_KEY. Right after deployment the first
// visitor claims it in the browser and receives a recovery key; the window
// closes on its own, and never opens when ADMIN_KEY is configured.
function keylessClaimOpen(env: Env): boolean {
  if (env.ADMIN_KEY) return false;
  const until = Date.parse(String(env.SETUP_CLAIM_UNTIL ?? ""));
  return Number.isFinite(until) && Date.now() < until;
}

async function isRecoveryKey(env: Env, req: Request): Promise<boolean> {
  const supplied = req.headers.get("x-admin-key") ?? "";
  if (supplied.length < 32) return false;
  const row = await env.DB.prepare(
    `SELECT value FROM settings WHERE workspace_id='__global' AND key=?`,
  ).bind(RECOVERY_KEY_SETTING).first<{ value: string }>();
  return !!row?.value && row.value === await sha256hex(supplied);
}

async function firstWorkspaceId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`,
  ).first<{ id: string }>();
  return row?.id ?? null;
}

// Admin routes accept ADMIN_KEY, the recovery key from a browser claim, or the
// signed-in owner, so a keyless Deploy-button instance can still be administered.
async function adminAuthorized(c: any): Promise<boolean> {
  if (isAdmin(c.req.raw, c.env) || await isRecoveryKey(c.env, c.req.raw)) return true;
  const session = await readSession(c.env, c.req.raw).catch(() => null);
  if (!session) return false;
  const env = c.env as Env;
  const user = await env.DB.prepare(`SELECT is_admin FROM users WHERE id=?`)
    .bind((session as SessionInfo).userId).first<{ is_admin: number }>();
  return user?.is_admin === 1;
}

app.get("/api/setup/status", async (c) => {
  const workspaceId = await firstWorkspaceId(c.env);
  const session = workspaceId ? await readSession(c.env, c.req.raw).catch(() => null) : null;
  return json({
    initialized: Boolean(workspaceId),
    authenticated: Boolean(session),
    claimable: !workspaceId && keylessClaimOpen(c.env),
  });
});

app.post("/api/setup", async (c) => {
  let recoveryKey: string | undefined;
  if (!isAdmin(c.req.raw, c.env) && !(await isRecoveryKey(c.env, c.req.raw))) {
    if (!keylessClaimOpen(c.env) || await firstWorkspaceId(c.env)) return json({ error: "unauthorized" }, 401);
    const claim = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO settings (workspace_id, key, value) VALUES ('__global', 'owner_claimed_at', ?)`,
    ).bind(String(now())).run();
    if ((claim.meta?.changes ?? 0) !== 1) return json({ error: "already_claimed" }, 409);
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    recoveryKey = "mi_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await c.env.DB.prepare(
      `INSERT INTO settings (workspace_id, key, value) VALUES ('__global', ?, ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value`,
    ).bind(RECOVERY_KEY_SETTING, await sha256hex(recoveryKey)).run();
  }
  const owner = await ensureOwnerWorkspace(c.env);
  const session = await createSession(c.env, owner.userId, owner.workspaceId);
  return json(
    { ok: true, created: owner.created, workspaceId: owner.workspaceId, recoveryKey },
    200,
    { "set-cookie": sessionCookieHeader(session.cookie) },
  );
});

app.get("/api/public/config", async (c) => {
  const [telegram, wechat] = await Promise.all([
    telegramConfigured(c.env),
    wechatConfigured(c.env),
  ]);
  const username = await getTelegramUsername(c.env);
  return json({
    telegram: { configured: telegram, username },
    wechat: { configured: wechat },
    connectors: {
      google: googleConfigured(c.env),
      feishu: feishuConfigured(c.env),
      lark: larkConfigured(c.env),
      github: githubConfigured(c.env),
    },
  });
});

app.get("/bind/:nonce", async (c) => {
  const result = await consumeLoginNonceAndCreateSession(c.env, c.req.param("nonce"));
  if (!result.ok) return c.redirect(`/?bind=${result.reason}`);
  c.header("set-cookie", sessionCookieHeader(result.cookie));
  return c.redirect("/workspace");
});

app.get("/api/qr", async (c) => {
  const text = c.req.query("text") ?? "";
  if (!text || text.length > 512) return json({ error: "text_required" }, 400);
  const svg = await QRCode.toString(text, { type: "svg", margin: 1 }).catch(() => null);
  if (!svg) return json({ error: "qr_failed" }, 500);
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=3600",
    },
  });
});

app.post("/telegram/webhook", async (c) => handleTelegramWebhook(c.env, c.req.raw));

app.post("/admin/telegram/repair", async (c) => {
  if (!(await adminAuthorized(c))) return json({ error: "unauthorized" }, 401);
  const token = await getTelegramToken(c.env);
  if (!token) return json({ error: "telegram_not_configured" }, 400);
  const result = await setupTelegramBot(c.env, token, {
    baseUrl: c.env.PUBLIC_BASE_URL,
    persistToken: false,
  });
  return result.ok ? json(result) : json(result, result.error === "invalid_token" ? 400 : 502);
});

app.get("/admin/telegram/status", async (c) => {
  if (!(await adminAuthorized(c))) return json({ error: "unauthorized" }, 401);
  const [token, botId, username] = await Promise.all([
    getTelegramToken(c.env),
    getTelegramBotId(c.env),
    getTelegramUsername(c.env),
  ]);
  if (!token) return json({ configured: false });
  const [hook, queueStats, inbox, outbox] = await Promise.all([
    getWebhookInfo(c.env),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM channel_outbox WHERE status IN ('pending','retryable')`,
    ).first<{ c: number }>().catch(() => ({ c: 0 })),
    c.env.DB.prepare(
      `SELECT status, COUNT(*) AS c FROM channel_inbox GROUP BY status`,
    ).all<{ status: string; c: number }>().catch(() => ({ results: [] })),
    c.env.DB.prepare(
      `SELECT status, COUNT(*) AS c FROM channel_outbox GROUP BY status`,
    ).all<{ status: string; c: number }>().catch(() => ({ results: [] })),
  ]);
  const expectedWebhook = `${c.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/telegram/webhook`;
  return json({
    configured: true,
    initialized: Boolean(botId && username),
    botId,
    username,
    expectedWebhook,
    webhookUrl: hook.info?.url ?? "",
    pendingUpdateCount: hook.info?.pending_update_count ?? null,
    lastTelegramError: hook.info?.last_error_message ?? null,
    healthy: Boolean(botId && hook.ok && hook.info?.url === expectedWebhook),
    queueDepth: queueStats?.c ?? 0,
    inbox: Object.fromEntries((inbox.results ?? []).map((row) => [row.status, row.c])),
    outbox: Object.fromEntries((outbox.results ?? []).map((row) => [row.status, row.c])),
  });
});

app.post("/admin/wechat/qr", async (c) => {
  if (!(await adminAuthorized(c))) return json({ error: "unauthorized" }, 401);
  const qr = await fetchLoginQrCode();
  if (!qr.ok) return json(qr, 502);
  const id = newId("wqr");
  await c.env.DB.prepare(
    `INSERT INTO wechat_qr_sessions (id, qrcode_enc, status, created_at) VALUES (?, ?, 'pending', ?)`,
  ).bind(id, await encryptField(c.env, "wechat:qrcode", qr.qrcode), now()).run();
  const svg = await QRCode.toString(qr.qrcodeImgContent, { type: "svg", margin: 1 }).catch(() => null);
  return json({ id, svg });
});

app.get("/admin/wechat/poll/:id", async (c) => {
  if (!(await adminAuthorized(c))) return json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare(
    `SELECT qrcode_enc, status, bot_id FROM wechat_qr_sessions WHERE id=?`,
  ).bind(c.req.param("id")).first<{ qrcode_enc: string; status: string; bot_id: string | null }>();
  if (!row) return json({ error: "not_found" }, 404);
  if (row.status === "confirmed") return json({ status: "confirmed", botId: row.bot_id });

  const qrcode = await decryptField(c.env, "wechat:qrcode", row.qrcode_enc);
  const status = await pollQrStatus(qrcode);
  if (status.token) {
    const botId = newId("wb");
    const timestamp = now();
    const owner = await ensureOwnerWorkspace(c.env);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO wechat_bots (id, workspace_id, token_enc, bot_user_id, status, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 'solo', ?, ?)`,
      ).bind(
        botId,
        owner.workspaceId,
        await encryptField(c.env, "wechat:token", status.token),
        String((status.identity as any)?.ilink_user_id ?? ""),
        timestamp,
        timestamp,
      ),
      c.env.DB.prepare(
        `UPDATE wechat_qr_sessions SET status='confirmed', bot_id=? WHERE id=?`,
      ).bind(botId, c.req.param("id")),
    ]);
    const poller = c.env.WECHAT_POLLER.get(c.env.WECHAT_POLLER.idFromName(botId));
    await poller.fetch("https://poller/register", {
      method: "POST",
      body: JSON.stringify({
        botId,
        token: status.token,
        botUserId: String((status.identity as any)?.ilink_user_id ?? ""),
      }),
    });
    return json({ status: "confirmed", botId });
  }
  return json({ status: mapQrStatusToBotStatus(status.status) });
});

app.get("/admin/wechat/status", async (c) => {
  if (!(await adminAuthorized(c))) return json({ error: "unauthorized" }, 401);
  const bot = await c.env.DB.prepare(
    `SELECT id FROM wechat_bots WHERE status='active' ORDER BY updated_at DESC LIMIT 1`,
  ).first<{ id: string }>();
  if (!bot?.id) return json({ ok: true, configured: false });
  const poller = c.env.WECHAT_POLLER.get(c.env.WECHAT_POLLER.idFromName(bot.id));
  const response = await poller.fetch("https://poller/healthz").catch(() => null);
  return response ? json(await response.json()) : json({ ok: false }, 502);
});

app.use("/api/channels/*", (c, next) => requireAuth(c, next));
app.get("/api/channels/telegram-link", async (c) => {
  const session = c.get("session") as SessionInfo;
  const username = await getTelegramUsername(c.env);
  const bindCode = await createBindCode(c.env, session.workspaceId, session.userId);
  if (!username) return json({ configured: false, bindCode });
  const link = `https://t.me/${username}?start=${bindCode}`;
  const svg = await QRCode.toString(link, { type: "svg", margin: 1 }).catch(() => null);
  return json({ configured: true, link, bindCode, svg });
});

app.get("/api/channels/wechat-bind", async (c) => {
  const session = c.get("session") as SessionInfo;
  const bindCode = await createBindCode(c.env, session.workspaceId, session.userId);
  return json({
    bindCode,
    howTo: `在微信里向你已登录的 openinst 微信账号发送：/bind ${bindCode}`,
  });
});

app.get("/api/channels/status", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { results } = await c.env.DB.prepare(
    `SELECT channel, external_id, display_name FROM channel_identities WHERE workspace_id=?`,
  ).bind(session.workspaceId).all<{ channel: string; external_id: string; display_name: string | null }>();
  const activeBot = await c.env.DB.prepare(
    `SELECT id FROM wechat_bots WHERE workspace_id=? AND status='active' LIMIT 1`,
  ).bind(session.workspaceId).first<{ id: string }>();
  return json({
    bound: (results ?? []).length > 0,
    channels: (results ?? []).map((row) => row.channel),
    bindings: results ?? [],
    wechatActive: Boolean(activeBot?.id),
  });
});

app.route("/", agentMailCoreApp);
app.route("/", coreApiApp);

app.get("*", async (c) => {
  const url = new URL(c.req.url);
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/admin/") ||
    url.pathname.startsWith("/telegram/")
  ) {
    return json({ error: "not_found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await app.fetch(request, env, ctx);
    } catch (error) {
      console.error("[worker] unhandled", String(error));
      return json({ error: "internal_error" }, 500);
    }
  },

  async queue(
    batch: MessageBatch<InboundEnvelope | EmailDispatchEnvelope>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        if ((message.body as EmailDispatchEnvelope)?.kind === "agent_mail_dispatch") {
          const { consumeEmailDispatchEnvelope } = await import("./channels/email/dispatch-queue");
          const outcome = await consumeEmailDispatchEnvelope(
            env,
            message.body as EmailDispatchEnvelope,
          );
          if (outcome.kind === "retry") message.retry({ delaySeconds: outcome.delaySeconds });
          else message.ack();
        } else {
          const outcome = await consumeInboundEnvelope(env, message.body as InboundEnvelope);
          if (outcome.kind === "retry") message.retry({ delaySeconds: outcome.delaySeconds });
          else message.ack();
        }
      } catch (error) {
        console.error("[queue] unhandled", String(error));
        message.retry();
      }
    }
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const { handleInboundEmail } = await import("./channels/email/reliable-ingress");
    await handleInboundEmail(message, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const { sweepEmailDispatchQueue } = await import("./channels/email/drive");
    const { driveOwnerEmailNotifications } = await import("./channels/email/notifications");
    ctx.waitUntil(sweepEmailDispatchQueue(env, 50).catch(() => {}));
    ctx.waitUntil(driveOwnerEmailNotifications(env, 20).catch(() => {}));
  },
};

export { PersonalAgent } from "./agent/personal-agent";
export { BrowserWorker } from "./agent/browser-worker";
export { WeChatPoller } from "./channels/wechat/poller";
export { TokenBroker } from "./connectors/token-broker";
