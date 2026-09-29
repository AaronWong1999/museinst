import { Hono } from "hono";
import type { Env, SessionInfo } from "../../env";
import { readSession } from "../../session";
import {
  registerMailbox,
  getMailboxSettings,
  readEmailMessage,
  emailOutboundAllowed,
} from "./mailbox";
import { enqueueOutbox, getOutboundMessageId } from "./outbox";
import { isFlagOn } from "../../util";

export const agentMailCoreApp = new Hono<{ Bindings: Env; Variables: { session: SessionInfo } }>();

function configuredEmailDomain(env: Env): string | null {
  const domain = String(env.EMAIL_DOMAIN || "").trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
    return null;
  }
  return domain;
}

agentMailCoreApp.use("/api/agent-email/*", async (c, next) => {
  const session = await readSession(c.env, c.req.raw);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("session", session);
  await next();
});

// GET /api/agent-email/availability
agentMailCoreApp.get("/api/agent-email/availability", async (c) => {
  const prefix = String(c.req.query("prefix") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,30}[a-z0-9]$/.test(prefix)) {
    return c.json({ available: false, error: "invalid_format" });
  }
  const domain = configuredEmailDomain(c.env);
  if (!domain) return c.json({ available: false, error: "email_domain_not_configured" }, 503);
  const address = `${prefix}@${domain}`;
  const row = await c.env.DB.prepare(`SELECT workspace_id FROM agent_mailboxes WHERE address=?`)
    .bind(address)
    .first<{ workspace_id: string }>();
  const s = c.get("session");
  if (row && row.workspace_id !== s.workspaceId) {
    return c.json({ available: false, error: "taken" });
  }
  return c.json({ available: true, email: address });
});

// GET /api/agent-email/mailbox
agentMailCoreApp.get("/api/agent-email/mailbox", async (c) => {
  const s = c.get("session");
  const row = await c.env.DB.prepare(
    `SELECT address, local_part, domain, status, daily_out_cap, daily_in_cap, stranger_autoreply, notify_channel FROM agent_mailboxes WHERE workspace_id=?`,
  )
    .bind(s.workspaceId)
    .first<{ address: string; local_part: string; domain: string; status: string; daily_out_cap: number; daily_in_cap: number; stranger_autoreply: number; notify_channel: string | null }>();

  const factsRow = await c.env.DB.prepare(`SELECT value FROM settings WHERE workspace_id=? AND key='public_facts'`)
    .bind(s.workspaceId)
    .first<{ value: string }>();
  let publicFacts: Record<string, string> = {};
  try { if (factsRow?.value) publicFacts = JSON.parse(factsRow.value); } catch {}

  return c.json({
    mailbox: row ? {
      address: row.address,
      localPart: row.local_part,
      domain: row.domain,
      status: row.status,
      dailyOutCap: row.daily_out_cap,
      dailyInCap: row.daily_in_cap,
      strangerAutoreply: row.stranger_autoreply === 1,
      notifyChannel: row.notify_channel ?? "web",
      publicFacts,
    } : null,
    platformEnabled: isFlagOn(c.env.AGENT_EMAIL_ENABLED),
  });
});

// POST /api/agent-email/mailbox
agentMailCoreApp.post("/api/agent-email/mailbox", async (c) => {
  if (!isFlagOn(c.env.AGENT_EMAIL_ENABLED)) {
    return c.json({ error: "email_disabled" }, 403);
  }
  const s = c.get("session");
  const body = await c.req.json().catch(() => ({})) as { prefix?: string };
  const prefix = String(body.prefix ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,30}[a-z0-9]$/.test(prefix)) {
    return c.json({ error: "invalid_format" }, 400);
  }
  const domain = configuredEmailDomain(c.env);
  if (!domain) return c.json({ error: "email_domain_not_configured" }, 503);
  const reg = await registerMailbox(c.env, s.workspaceId, prefix, domain, Date.now(), {
    strangerAutoreply: 1,
    notifyChannel: "wechat",
  });
  if (!reg.ok) {
    return c.json({ error: reg.error }, reg.error === "taken" ? 409 : 400);
  }
  return c.json({ ok: true, email: reg.address });
});

// PATCH /api/agent-email/mailbox
agentMailCoreApp.patch("/api/agent-email/mailbox", async (c) => {
  const s = c.get("session");
  const body = await c.req.json().catch(() => ({})) as {
    strangerAutoreply?: boolean;
    notifyChannel?: string | null;
    publicFacts?: Record<string, string>;
  };
  const hasAutoreply = typeof body.strangerAutoreply === "boolean";
  const hasNotify = body.notifyChannel !== undefined;
  const hasPublicFacts = body.publicFacts !== undefined && typeof body.publicFacts === "object" && body.publicFacts !== null;

  if (!hasAutoreply && !hasNotify && !hasPublicFacts) {
    return c.json({ error: "invalid_body" }, 400);
  }

  const box = await c.env.DB.prepare(`SELECT address FROM agent_mailboxes WHERE workspace_id=?`)
    .bind(s.workspaceId)
    .first<{ address: string }>();
  if (!box) return c.json({ error: "no_mailbox" }, 404);

  const updates: string[] = [];
  const binds: any[] = [];
  if (hasAutoreply) {
    updates.push("stranger_autoreply=?");
    binds.push(body.strangerAutoreply ? 1 : 0);
  }
  if (hasNotify) {
    const ch = body.notifyChannel;
    if (ch !== null && ch !== "wechat" && ch !== "telegram" && ch !== "web") {
      return c.json({ error: "invalid_notify_channel" }, 400);
    }
    updates.push("notify_channel=?");
    binds.push(ch);
  }
  if (updates.length > 0) {
    updates.push("updated_at=?");
    binds.push(Date.now());
    binds.push(s.workspaceId);
    await c.env.DB.prepare(`UPDATE agent_mailboxes SET ${updates.join(", ")} WHERE workspace_id=?`)
      .bind(...binds)
      .run();
  }
  if (hasPublicFacts) {
    await c.env.DB.prepare(
      `INSERT INTO settings (workspace_id, key, value) VALUES (?, 'public_facts', ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value`,
    ).bind(s.workspaceId, JSON.stringify(body.publicFacts)).run();
  }
  return c.json({ ok: true });
});

// GET /api/agent-email/messages
agentMailCoreApp.get("/api/agent-email/messages", async (c) => {
  const s = c.get("session");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 50);
  const { results } = await c.env.DB.prepare(
    `SELECT id, direction, thread_id, from_addr, to_addr, subject, snippet, message_auth, created_at
     FROM email_messages WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?`,
  ).bind(s.workspaceId, limit).all();
  return c.json({ messages: results ?? [] });
});

// GET /api/agent-email/messages/:id
agentMailCoreApp.get("/api/agent-email/messages/:id", async (c) => {
  const s = c.get("session");
  const id = c.req.param("id");
  const row = await readEmailMessage(c.env, s.workspaceId, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ message: row });
});

// GET /api/agent-email/threads/:id
agentMailCoreApp.get("/api/agent-email/threads/:id", async (c) => {
  const s = c.get("session");
  const threadId = c.req.param("id");
  const { results } = await c.env.DB.prepare(
    `SELECT id FROM email_messages WHERE workspace_id=? AND thread_id=? ORDER BY created_at ASC LIMIT 100`,
  ).bind(s.workspaceId, threadId).all<{ id: string }>();
  const messages = [];
  for (const r of results ?? []) {
    const m = await readEmailMessage(c.env, s.workspaceId, r.id);
    if (m) messages.push(m);
  }
  return c.json({ threadId, messages });
});

// GET /api/agent-email/outbox
agentMailCoreApp.get("/api/agent-email/outbox", async (c) => {
  const s = c.get("session");
  const { results } = await c.env.DB.prepare(
    `SELECT id, logical_key, from_addr, to_addr, subject, status, attempts, last_error, created_at, accepted_at
     FROM email_outbox WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50`,
  ).bind(s.workspaceId).all();
  return c.json({ outbox: results ?? [] });
});

// POST /api/agent-email/send
agentMailCoreApp.post("/api/agent-email/send", async (c) => {
  const s = c.get("session");
  const body = await c.req.json().catch(() => ({})) as { to?: string; subject?: string; text?: string; requestId?: string };
  const to = String(body.to ?? "").trim().toLowerCase();
  const text = String(body.text ?? "").slice(0, 8000);
  const subject = String(body.subject ?? "").slice(0, 300);
  const requestId = String(c.req.header("Idempotency-Key") ?? body.requestId ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return c.json({ error: "invalid_to" }, 400);
  if (!text) return c.json({ error: "empty_body" }, 400);
  if (requestId.length < 8) return c.json({ error: "idempotency_key_required" }, 400);

  const box = await getMailboxSettings(c.env, s.workspaceId);
  if (!box || box.status !== "active") return c.json({ error: "no_mailbox" }, 400);

  const allowed = await emailOutboundAllowed(c.env, s.workspaceId);
  if (!allowed.allow) return c.json({ error: "outbound_blocked", reason: allowed.reason }, 403);

  const res = await enqueueOutbox(c.env, {
    workspaceId: s.workspaceId,
    logicalKey: `proactive:${requestId}`,
    fromAddr: box.address,
    toAddr: to,
    subject,
    textBody: text,
    messageId: getOutboundMessageId(box.address),
  });
  return c.json({ ok: true, outboxId: res.id, created: res.created });
});
