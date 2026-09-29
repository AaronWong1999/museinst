


import type { Tool } from "./tool-types";
import { enqueueOutbox, getOutboundMessageId } from "../channels/email/outbox";
import { mintThreadCapability, sendAddressVerificationEmail } from "../channels/email/thread";
import { readEmailMessage } from "../channels/email/mailbox";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const str = (desc: string) => ({ type: "string", description: desc });

async function requireMailbox(env: { DB: D1Database }, workspaceId: string): Promise<{ address: string; localPart: string; domain: string } | null> {
  const row = await (env.DB as D1Database).prepare(`SELECT address, local_part, domain FROM agent_mailboxes WHERE workspace_id=? AND status='active'`)
    .bind(workspaceId)
    .first<{ address: string; local_part: string; domain: string }>()
    .catch(() => null);
  if (!row) return null;
  return { address: row.address, localPart: row.local_part, domain: row.domain };
}

export const TOOL_agent_mail_list: Tool = {
  name: "agent_mail_list",
  effect: "read",
  description: "列出 Agent 自己邮箱收到的邮件（主题/发件人/摘要，支持按方向过滤或按关键词搜索）。",
  parameters: obj({
    limit: { type: "integer", description: "条数，默认20，上限50" },
    direction: { type: "string", enum: ["in", "out", "all"], description: "收发方向：in（收件）、out（发件）、all（全部，默认）" },
    query: { type: "string", description: "搜索关键词（匹配发件人、收件人或主题）" },
  }),
  run: async (ctx, a) => {
    const limit = Math.min(Math.max(Number(a.limit ?? 20), 1), 50);
    const direction = a.direction === "in" || a.direction === "out" ? a.direction : null;
    const query = a.query ? String(a.query).trim().toLowerCase() : null;

    let sql = `SELECT id, direction, thread_id, from_addr, to_addr, subject, snippet, message_auth, created_at FROM email_messages WHERE workspace_id=?`;
    const binds: any[] = [ctx.workspaceId];

    if (direction) {
      sql += ` AND direction=?`;
      binds.push(direction);
    }
    if (query) {
      sql += ` AND (LOWER(subject) LIKE ? OR LOWER(from_addr) LIKE ? OR LOWER(to_addr) LIKE ?)`;
      const pattern = `%${query}%`;
      binds.push(pattern, pattern, pattern);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    binds.push(limit);

    const { results } = await ctx.env.DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] as unknown[] }));
    return { ok: true, data: results ?? [] };
  },
};

export const TOOL_agent_mail_read: Tool = {
  name: "agent_mail_read",
  effect: "read",
  description: "读 Agent 自己邮箱里一封邮件的完整清洗正文（列表接口只给 snippet）。",
  parameters: obj({ id: str("agent_mail_list 返回的邮件 id") }, ["id"]),
  run: async (ctx, a) => {

    const row = await readEmailMessage(ctx.env, ctx.workspaceId, String(a.id ?? ""));
    if (!row) return { ok: false, error: "邮件不存在" };
    return {
      ok: true,
      data: {
        id: row.id,
        direction: row.direction,
        threadId: row.threadId,
        from: row.fromAddr,
        to: row.toAddr,
        subject: row.subject,
        body: row.bodyText,
        bodyHtml: row.bodyHtml,
        snippet: row.snippet,
        attachments: row.attachments,
        messageAuth: row.messageAuth,
        createdAt: row.createdAt,
        bodyAvailable: row.bodyAvailable,
      },
    };
  },
};

export const TOOL_agent_mail_thread: Tool = {
  name: "agent_mail_thread",
  effect: "read",
  description: "读 Agent 自己邮箱的一个完整线程（含每封的清洗正文）。",
  parameters: obj({ threadId: str("线程 id") }, ["threadId"]),
  run: async (ctx, a) => {

    const { results } = await ctx.env.DB.prepare(
      `SELECT id FROM email_messages WHERE workspace_id=? AND thread_id=? ORDER BY created_at ASC LIMIT 100`,
    ).bind(ctx.workspaceId, String(a.threadId ?? "")).all<{ id: string }>();
    const messages: unknown[] = [];
    for (const r of results ?? []) {
      const full = await readEmailMessage(ctx.env, ctx.workspaceId, r.id);
      if (!full) continue;
      messages.push({
        id: full.id,
        direction: full.direction,
        from: full.fromAddr,
        to: full.toAddr,
        subject: full.subject,
        body: full.bodyText,
        snippet: full.snippet,
        messageAuth: full.messageAuth,
        createdAt: full.createdAt,
        bodyAvailable: full.bodyAvailable,
      });
    }
    return { ok: true, data: messages };
  },
};

export const TOOL_agent_mail_reply: Tool = {
  name: "agent_mail_reply",
  effect: "external_send",
  description: "回复 Agent 自己邮箱里的既有线程。owner 主动要求时直接发；模型自主决定时需要审批。",
  parameters: obj({ inboundId: str("要回复的收件 id"), body: str("回复正文") }, ["inboundId", "body"]),
  run: async (ctx, a) => {
    const box = await requireMailbox(ctx.env, ctx.workspaceId);
    if (!box) return { ok: false, error: "还没有 Agent 邮箱，先在控制台注册。" };
    const inbound = await ctx.env.DB.prepare(`SELECT id, thread_id, from_addr, message_id FROM email_messages WHERE id=? AND workspace_id=?`)
      .bind(String(a.inboundId), ctx.workspaceId)
      .first<{ id: string; thread_id: string; from_addr: string; message_id: string | null }>()
      .catch(() => null);
    if (!inbound) return { ok: false, error: "原邮件不存在" };
    const body = String(a.body ?? "").slice(0, 8000);
    if (!body) return { ok: false, error: "empty_body" };
    const r = await enqueueOutbox(ctx.env as never, {
      workspaceId: ctx.workspaceId,
      logicalKey: `reply:${inbound.id}:owner:${ctx.taskId ?? "manual"}`,
      fromAddr: box.address,
      toAddr: inbound.from_addr,
      subject: "Re: thread",
      textBody: body,
      threadId: inbound.thread_id,
      inReplyTo: inbound.message_id ?? undefined,
      rootTaskId: ctx.taskId,
      messageId: getOutboundMessageId(box.address),
    } as never).catch(() => null);
    if (!r) return { ok: false, error: "enqueue_failed" };
    return { ok: true, data: { outboxId: (r as { id: string }).id } };
  },
};

export const TOOL_agent_mail_forward: Tool = {
  name: "agent_mail_forward",
  effect: "external_send",
  description: "将 Agent 邮箱收到的一封邮件转发给第三方邮箱。【对外发送，必须走审批】",
  parameters: obj({
    inboundId: str("要转发的收件 id"),
    to: str("目标邮箱地址"),
    note: { type: "string", description: "附言（可选）" },
  }, ["inboundId", "to"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const box = await requireMailbox(ctx.env, ctx.workspaceId);
    if (!box) return { ok: false, error: "还没有 Agent 邮箱，先在控制台注册。" };
    const to = String(a.to ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: "invalid_to" };
    const inbound = await readEmailMessage(ctx.env, ctx.workspaceId, String(a.inboundId ?? ""));
    if (!inbound) return { ok: false, error: "原邮件不存在" };

    const subject = (inbound.subject ? `Fwd: ${inbound.subject}` : "Fwd: message").slice(0, 200);
    const notePrefix = a.note ? `${String(a.note).trim()}\n\n---------- Forwarded message ---------\n` : `---------- Forwarded message ---------\n`;
    const headerBlock = `From: ${inbound.fromAddr}\nDate: ${new Date(inbound.createdAt).toUTCString()}\nSubject: ${inbound.subject ?? "无主题"}\nTo: ${inbound.toAddr}\n\n`;
    const body = (notePrefix + headerBlock + (inbound.bodyText || inbound.snippet || "")).slice(0, 8000);

    const logicalKey = `forward:${inbound.id}:${to}:${ctx.taskId ?? "manual"}`;
    const r = await enqueueOutbox(ctx.env as never, {
      workspaceId: ctx.workspaceId,
      logicalKey,
      fromAddr: box.address,
      toAddr: to,
      subject,
      textBody: body,
      threadId: inbound.threadId,
      rootTaskId: ctx.taskId,
      messageId: getOutboundMessageId(box.address),
    } as never).catch(() => null);
    if (!r) return { ok: false, error: "enqueue_failed" };
    return { ok: true, data: { outboxId: (r as { id: string }).id } };
  },
};

export const TOOL_agent_mail_send: Tool = {
  name: "agent_mail_send",
  effect: "external_send",
  description: "以 Agent 自己邮箱主动给第三方发新邮件。【对外发送，必须走审批】",
  parameters: obj({ to: str("收件人邮箱"), subject: str("主题"), body: str("正文") }, ["to", "subject", "body"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const box = await requireMailbox(ctx.env, ctx.workspaceId);
    if (!box) return { ok: false, error: "还没有 Agent 邮箱，先在控制台注册。" };
    const to = String(a.to ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: "invalid_to" };
    const body = String(a.body ?? "").slice(0, 8000);
    if (!body) return { ok: false, error: "empty_body" };
    const r = await enqueueOutbox(ctx.env as never, {
      workspaceId: ctx.workspaceId,
      logicalKey: `proactive:${ctx.taskId ?? `manual_${Date.now()}`}:${String(to).toLowerCase()}`,
      fromAddr: box.address,
      toAddr: to,
      subject: String(a.subject ?? "").slice(0, 300),
      textBody: body,
      rootTaskId: ctx.taskId,
      messageId: getOutboundMessageId(box.address),
    } as never).catch(() => null);
    if (!r) return { ok: false, error: "enqueue_failed" };
    return { ok: true, data: { outboxId: (r as { id: string }).id } };
  },
};

export const TOOL_agent_mail_contact: Tool = {
  name: "agent_mail_contact",
  effect: "local",
  description: "标记联系人 known / blocked（只影响 UI 与通知优先级，不提升任何消息权限）。owner context only。",
  parameters: obj({
    address: str("对方邮箱"),
    contactClass: { type: "string", enum: ["known", "blocked"], description: "known 或 blocked" },
    displayName: { type: "string", description: "备注名（可选）" },
  }, ["address", "contactClass"]),
  run: async (ctx, a) => {
    const addr = String(a.address ?? "").trim().toLowerCase();
    if (!addr.includes("@")) return { ok: false, error: "invalid_address" };
    const cls = String(a.contactClass);
    if (cls !== "known" && cls !== "blocked") return { ok: false, error: "invalid_class" };
    const t = Date.now();
    await ctx.env.DB.prepare(
      `INSERT INTO email_contacts (workspace_id, address, contact_class, display_name, first_seen_at, last_seen_at, msg_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(workspace_id, address) DO UPDATE SET contact_class=excluded.contact_class, display_name=COALESCE(excluded.display_name, display_name)`,
    ).bind(ctx.workspaceId, addr, cls, a.displayName ? String(a.displayName).slice(0, 80) : null, t, t).run();
    return { ok: true, data: { address: addr, contactClass: cls } };
  },
};

export const TOOL_agent_mail_start_secure_thread: Tool = {
  name: "agent_mail_start_secure_thread",
  effect: "external_send",
  description:
    "给已验证归属的 owner 邮箱发一封带 thread capability 的 Secure Agent Thread 启动信（控制台按钮同效）。" +
    "地址尚未验证时，先发一次性验证挑战，收到回信后本工具才可启动线程。",
  parameters: obj({ to: str("owner 已验证邮箱"), subject: { type: "string", description: "主题（可选）" } }, ["to"]),
  needsApproval: true,
  run: async (ctx, a) => {
    const box = await requireMailbox(ctx.env, ctx.workspaceId);
    if (!box) return { ok: false, error: "还没有 Agent 邮箱，先在控制台注册。" };
    const to = String(a.to ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: "invalid_to" };
    const verified = await ctx.env.DB.prepare(`SELECT address_verified_by_owner FROM email_contacts WHERE workspace_id=? AND address=?`)
      .bind(ctx.workspaceId, to)
      .first<{ address_verified_by_owner: number }>();
    if (!verified || verified.address_verified_by_owner !== 1) {


      const sent = await sendAddressVerificationEmail(ctx.env, { workspaceId: ctx.workspaceId, address: to });
      if (!sent.ok) return { ok: false, error: `address_not_verified:${sent.error}` };
      return {
        ok: false,
        error: "address_not_verified",
        data: {
          verificationSent: true,
          outboxId: sent.outboxId,
          expiresAt: sent.expiresAt,
          hint: "已发送一次性验证邮件；请让收件人直接回信完成地址归属验证，然后再启动安全线程。",
        },
      };
    }
    const threadId = `th_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    let minted;
    try {
      minted = await mintThreadCapability(ctx.env, {
        workspaceId: ctx.workspaceId,
        threadId,
        peerAddress: to,
        localPart: box.localPart,
        domain: box.domain,
      });
    } catch (e) {
      return { ok: false, error: `capability_mint_failed:${String(e).slice(0, 120)}` };
    }
    if (!minted.replyTo) return { ok: false, error: "reply_to_build_failed" };
    const subject = String(a.subject ?? "Secure Agent Thread").slice(0, 200);
    const textBody = `这是你的 MuseInst Agent 安全线程启动信。\n\n直接回复本邮件即可继续同一线程（Reply-To 已带线程凭证）。\n\n注意：邮件本身不能批准高危动作；真正需要你拍板的事项会去微信/Telegram/Web 找你。`;
    const r = await enqueueOutbox(ctx.env, {
      workspaceId: ctx.workspaceId,
      logicalKey: `verification:secure_thread:${threadId}`,
      fromAddr: box.address,
      toAddr: to,
      subject,
      textBody,
      threadId,
      replyTo: minted.replyTo,
      rootTaskId: ctx.taskId,
      messageId: getOutboundMessageId(box.address),
    });
    return { ok: true, data: { outboxId: r.id, threadId, replyTo: minted.replyTo } };
  },
};

export const AGENT_MAIL_TOOLS: Tool[] = [
  TOOL_agent_mail_list,
  TOOL_agent_mail_read,
  TOOL_agent_mail_thread,
  TOOL_agent_mail_reply,
  TOOL_agent_mail_forward,
  TOOL_agent_mail_send,
  TOOL_agent_mail_contact,
  TOOL_agent_mail_start_secure_thread,
];


export function agentMailToolsFor(source: string): Tool[] {
  if (source === "email" || source === "a2a") return [];
  return AGENT_MAIL_TOOLS;
}
