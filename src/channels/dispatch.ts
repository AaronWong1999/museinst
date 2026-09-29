



//


import type { Env } from "../env";
import type { ChannelEvent } from "./normalize";
import type { MessageAuth, SecurityContext } from "../security/context";
import { createWorkspace, resolveIdentity, bindChannelIdentity, DUPLICATE_BIND_COPY, COOLDOWN_DAYS } from "../identity";
import { isFlagOn, newId, newSlug, now } from "../util";
import { getHostHooks } from "../hooks";
import { ingestLocation, lastKnown } from "../location";
import { chatCopy } from "../copy";

export type DispatchResult = "handled" | "failed";


const BIND_CLAIM_LEASE_MS = 60 * 1000;

export function templateLang(event: ChannelEvent): "zh" | "en" {
  const text = (event.text ?? "").trim();
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[A-Za-z]/.test(text)) return "en";


  return event.channel === "wechat" ? "zh" : "en";
}

function cc(event: ChannelEvent) {
  return templateLang(event) === "zh" ? chatCopy.zh : chatCopy.en;
}

/** Durable receipt for an authenticated Web channel message (spec §9.1.7). */
export interface WebChatAcceptedReceipt {
  status: "accepted" | "queued";
  messageId: string;
  threadId: string;
  runId?: string;
  queueItemId?: string;
  duplicate?: boolean;
}

export async function dispatchChannelEvent(
  env: Env,
  event: ChannelEvent,
  send: (texts: string[]) => Promise<void>,
  opts: {
    security?: SecurityContext;

    sendWithTask?: (texts: string[], info: { taskId?: string }) => Promise<void>;
    /**
     * Authenticated Web channel envelope (spec §9.1): only an authenticated
     * internal ingress may pass these; the dispatcher verifies the trusted
     * identity before any bind/identity flow, and the DO re-validates it.
     */
    authoritativeIdentity?: { workspaceId: string; userId: string };
    conversation?: { threadId: string };
    executionMode?: "enqueue";
    /** Receives the durable 202 receipt for enqueue mode. */
    onAccepted?: (receipt: WebChatAcceptedReceipt) => void;
  } = {},
): Promise<DispatchResult> {

  // ── Authenticated Web ingress (spec §9.1) ──────────────────────────────
  // Web never enters resolveIdentity / auto account creation / /bind: the
  // browser session is the identity. Fail closed when the trusted envelope is
  // missing or inconsistent instead of falling back to any weaker path.
  if (event.channel === "web") {
    const identity = opts.authoritativeIdentity;
    const security = opts.security;
    if (
      !identity ||
      !security ||
      security.source !== "owner_chat" ||
      !security.authenticatedOwner ||
      security.workspaceId !== identity.workspaceId
    ) {
      console.error("[dispatch] refusing web event without a trusted owner identity");
      return "failed";
    }
    const lang = templateLang(event);
    const { agentFetchWithDeadline } = await import("../agent/rpc");
    const AGENT_EVENT_BUDGET_MS = 14 * 60_000;
    try {
      const res = await agentFetchWithDeadline(
        env.AGENT,
        identity.workspaceId,
        "/event",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event,
            lang,
            security,
            conversation: opts.conversation,
            mode: opts.executionMode ?? "enqueue",
          }),
        },
        AGENT_EVENT_BUDGET_MS,
      );
      if (!res.ok) {
        console.error("[dispatch] web event rejected by agent", res.status);
        return "failed";
      }
      const out = (await res.json()) as WebChatAcceptedReceipt & { replies?: string[] };
      if (opts.onAccepted && (out.status === "accepted" || out.status === "queued")) {
        opts.onAccepted({
          status: out.status,
          messageId: out.messageId,
          threadId: out.threadId,
          runId: out.runId,
          queueItemId: out.queueItemId,
          duplicate: out.duplicate,
        });
      }
      return "handled";
    } catch (e) {
      console.error("[dispatch] web event failed", String(e));
      return "failed";
    }
  }


  if (event.channel === "email") {
    const security = opts.security;
    if (!security || security.source !== "email") {
      console.error("[dispatch] refusing email event without a trusted email security context");
      return "failed";
    }
    return dispatchExternalEmail(
      env,
      {
        workspaceId: security.workspaceId,
        from: event.senderId,
        text: event.text ?? "",
        messageRowId: event.messageId,
        messageId: event.messageId,
        receivedAt: event.receivedAt,
      },
      send,
      { security, sendWithTask: opts.sendWithTask },
    );
  }

  const lang: "zh" | "en" = templateLang(event);
  const copy = cc(event);
  const t = event.text?.trim() ?? "";

  try {

    if (event.groupChatId) {
      const id = await resolveIdentity(env, event.channel, event.senderId);
      if (!id) {
        await send([copy.groupRejected]);
        return "handled";
      }
    }

    const cmd = t.match(/^\/(start|bind)(\s+(\S+))?/i);
    if (cmd) {
      const arg = cmd[3];
      await handleBindCommand(env, event, send, arg);
      return "handled";
    }

    let id = await resolveIdentity(env, event.channel, event.senderId);


    if (!id && event.channel === "wechat" && event.botId) {
      const botRow = await env.DB.prepare(
        `SELECT b.workspace_id, w.owner_user_id FROM wechat_bots b JOIN workspaces w ON w.id=b.workspace_id WHERE b.id=? AND b.status='active'`,
      ).bind(event.botId).first<{ workspace_id: string; owner_user_id: string }>();

      if (botRow?.workspace_id) {

        const existing = await env.DB.prepare(
          `SELECT workspace_id FROM channel_identities WHERE channel='wechat' AND external_id=?`,
        ).bind(event.senderId).first<{ workspace_id: string }>();

        if (existing && existing.workspace_id !== botRow.workspace_id) {
          await send(["⚠️ 该微信已绑定了另一个 MuseInst 账号。如需使用当前账号，请先在原账号解除微信绑定。"]);
          return "handled";
        }

        const { bindChannelIdentity } = await import("../identity");
        const bind = await bindChannelIdentity(env, {
          channel: "wechat",
          externalId: event.senderId,
          workspaceId: botRow.workspace_id,
          displayName: "WeChat User",
        });

        if (bind.ok) {
          id = { workspaceId: botRow.workspace_id, userId: botRow.owner_user_id, created: false };
        } else {
          await send(["⚠️ 微信身份绑定遇到冲突，请稍后重试。"]);
          return "handled";
        }
      }
    } else if (id && event.channel === "wechat" && event.botId) {

      const botRow = await env.DB.prepare(
        `SELECT workspace_id FROM wechat_bots WHERE id=? AND status='active'`,
      ).bind(event.botId).first<{ workspace_id: string }>();
      if (botRow?.workspace_id && botRow.workspace_id !== id.workspaceId) {
        await send(["⚠️ 该微信已绑定了另一个 MuseInst 账号。如需使用当前账号，请先在原账号解除微信绑定。"]);
        return "handled";
      }
    }

    if (!id) {
      const customGuide = await getHostHooks().getUnboundGuide?.(env, event).catch(() => null);
      await send([customGuide || copy.unboundGuide]);
      return "handled";
    }
    if (id.created) {
      await send([copy.firstOwner, firstTaskGuide(env, event)]);
    }


    if (event.kind === "location" && event.location) {
      const prev = await lastKnown(env, id.workspaceId);
      const isQuiet = !!prev && now() - prev.created_at < 2 * 60_000;
      const r = await ingestLocation(env, id.workspaceId, {
        source: event.channel,
        lat: event.location.lat,
        lng: event.location.lng,
        accuracy: event.location.accuracy,
        live: event.location.live,
      });
      if (r.firedTriggers > 0) return "handled";
      if (!isQuiet) {
        await send([copy.locationSaved]);
      }
      return "handled";
    }




    const { agentFetchWithDeadline } = await import("../agent/rpc");
    const { DEADLINE_BUDGETS_MS } = await import("../util/deadlines");
    const AGENT_EVENT_BUDGET_MS = 14 * 60_000;
    void DEADLINE_BUDGETS_MS;
    const { stripToolCallDSL } = await import("./format-cleaner");
    const { withWeChatTyping } = await import("./wechat-typing");
    const { withTelegramTyping } = await import("./outbound");

    const typingEnabled = false;
    const sendTypingFn = async (_status: 1 | 2) => {};

    let replies: string[] = [];
    let rootTaskId: string | undefined;
    const runAgent = async (): Promise<boolean> => await withWeChatTyping(
      event.botId || "bot",
      event.senderId,
      typingEnabled,
      sendTypingFn,
      async () => {
        const res = await agentFetchWithDeadline(env.AGENT, id.workspaceId, "/event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event, lang, security: opts.security ?? null }),
        }, AGENT_EVENT_BUDGET_MS);
        if (!res.ok) return false;
        const out = (await res.json()) as { replies: string[]; taskId?: string };
        replies = out.replies || [];
        rootTaskId = out.taskId || undefined;
        return true;
      }
    );



    const ok = event.channel === "telegram"
      ? await withTelegramTyping(env, event.groupChatId ?? event.senderId, runAgent)
      : await runAgent();

    if (!ok) return "failed";

    if (replies.length > 0) {
      const sanitized = env.TOOL_DSL_SANITIZER_ENABLED !== "0"
        ? replies.map(stripToolCallDSL)
        : replies;
      if (opts.sendWithTask) await opts.sendWithTask(sanitized, { taskId: rootTaskId });
      else await send(sanitized);
    } else if (opts.sendWithTask) {
      await opts.sendWithTask([], { taskId: rootTaskId });
    }
    return "handled";
  } catch (e) {
    console.error("[dispatch] error", String(e));
    return "failed";
  }
}













export interface ExternalEmailEventInput {

  workspaceId: string;

  from: string;

  to?: string;
  text: string;

  subject?: string;

  messageRowId: string;

  messageId?: string;

  messageAuth?: MessageAuth;
  receivedAt?: number;
}

export async function dispatchExternalEmail(
  env: Env,
  input: ExternalEmailEventInput,
  send: (texts: string[]) => Promise<void>,
  opts: {

    security: SecurityContext;
    sendWithTask?: (texts: string[], info: { taskId?: string }) => Promise<void>;
    deadlineMs?: number;
  },
): Promise<DispatchResult> {
  const security = opts.security;

  if (security.source !== "email" || security.workspaceId !== input.workspaceId) {
    console.error("[dispatch] external email target mismatch — refusing to route", {
      securityWorkspace: security.workspaceId,
      claimedWorkspace: input.workspaceId,
      to: input.to,
    });
    return "failed";
  }
  if (input.messageAuth && security.messageAuth !== input.messageAuth) {
    console.error("[dispatch] external email auth mismatch — refusing to route");
    return "failed";
  }

  const text = input.text ?? "";
  const event: ChannelEvent = {
    channel: "email",
    senderId: input.from,
    messageId: input.messageId ?? input.messageRowId,
    kind: "text",
    text,
    emailSubject: (input.subject ?? "").slice(0, 200),
    receivedAt: input.receivedAt ?? now(),
  };
  const lang: "zh" | "en" = templateLang(event);

  try {
    const { agentFetchWithDeadline } = await import("../agent/rpc");
    const AGENT_EVENT_BUDGET_MS = opts.deadlineMs ?? 14 * 60_000;
    const { stripToolCallDSL } = await import("./format-cleaner");

    let replies: string[] = [];
    let rootTaskId: string | undefined;
    const res = await agentFetchWithDeadline(env.AGENT, security.workspaceId, "/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, lang, security }),
    }, AGENT_EVENT_BUDGET_MS);
    if (!res.ok) return "failed";
    const out = (await res.json()) as { replies: string[]; taskId?: string };
    replies = out.replies || [];
    rootTaskId = out.taskId || undefined;

    if (replies.length > 0) {
      const sanitized = env.TOOL_DSL_SANITIZER_ENABLED !== "0" ? replies.map(stripToolCallDSL) : replies;
      if (opts.sendWithTask) await opts.sendWithTask(sanitized, { taskId: rootTaskId });
      else await send(sanitized);
    } else if (opts.sendWithTask) {
      await opts.sendWithTask([], { taskId: rootTaskId });
    }
    return "handled";
  } catch (e) {
    console.error("[dispatch] external email dispatch error", String(e));
    return "failed";
  }
}

async function handleBindCommand(
  env: Env,
  event: ChannelEvent,
  send: (texts: string[]) => Promise<void>,
  arg?: string,
): Promise<void> {
  const copy = cc(event);




  const existing = await env.DB.prepare(
    `SELECT ci.workspace_id, w.owner_user_id
       FROM channel_identities ci JOIN workspaces w ON w.id = ci.workspace_id
      WHERE ci.channel=? AND ci.external_id=?`,
  ).bind(event.channel, event.senderId).first<{ workspace_id: string; owner_user_id: string }>();
  if (existing && !arg) {
    const nonce = await createLoginNonce(env, existing.workspace_id, existing.owner_user_id);
    await send([copy.loginLink(env.PUBLIC_BASE_URL, nonce)]);
    return;
  }

  if (!arg) {
    await send([copy.bindUsage]);
    return;
  }

  const code = arg.toUpperCase();


  const consumed = await env.DB.prepare(
    `SELECT used_by_channel, used_by_external_id, result_login_nonce FROM bind_nonces
      WHERE nonce=? AND purpose='bind_code' AND used_at IS NOT NULL`,
  ).bind(code).first<{ used_by_channel: string | null; used_by_external_id: string | null; result_login_nonce: string | null }>();
  if (consumed) {
    if (consumed.used_by_channel === event.channel && consumed.used_by_external_id === event.senderId && consumed.result_login_nonce) {
      await send([copy.boundOk(env.PUBLIC_BASE_URL, consumed.result_login_nonce), firstTaskGuide(env, event)]);
      return;
    }
    await send([copy.invalidCode]);
    return;
  }




  const claimToken = crypto.randomUUID();
  const t = now();
  const expiredBefore = t - BIND_CLAIM_LEASE_MS;
  const claim = await env.DB.prepare(
    `UPDATE bind_nonces
        SET claim_state='pending', claim_token=?, claimed_at=?, claim_channel=?, claim_external_id=?
      WHERE nonce=? AND purpose='bind_code' AND used_at IS NULL AND expires_at>?
        AND (
          claim_state IS NULL
          OR (claim_state='pending' AND claimed_at<? AND claim_channel=? AND claim_external_id=?)
        )`,
  ).bind(claimToken, t, event.channel, event.senderId, code, t, expiredBefore, event.channel, event.senderId).run();

  if ((claim.meta?.changes ?? 0) !== 1) {

    await bindFallback(env, event, send, arg);
    return;
  }

  const bindCode = await env.DB.prepare(
    `SELECT workspace_id, user_id FROM bind_nonces
      WHERE nonce=? AND claim_token=? AND claim_state='pending'`,
  ).bind(code, claimToken).first<{ workspace_id: string; user_id: string }>();
  if (!bindCode) {

    await releaseBindClaim(env, code, claimToken, "claim_row_lost");
    await bindFallback(env, event, send, arg);
    return;
  }

  const bind = await bindChannelIdentity(env, {
    channel: event.channel,
    externalId: event.senderId,
    workspaceId: bindCode.workspace_id,
  });
  if (!bind.ok) {

    await releaseBindClaim(env, code, claimToken, "bind_failed");
    await send([DUPLICATE_BIND_COPY]);
    return;
  }

  const loginNonce = await createLoginNonce(env, bindCode.workspace_id, bindCode.user_id);

  const finalized = await env.DB.prepare(
    `UPDATE bind_nonces
        SET used_at=?, used_by_channel=?, used_by_external_id=?, claim_state='consumed', result_login_nonce=?
      WHERE nonce=? AND claim_token=? AND claim_state='pending' AND used_at IS NULL`,
  ).bind(now(), event.channel, event.senderId, loginNonce, code, claimToken).run();

  if ((finalized.meta?.changes ?? 0) !== 1) {


    await env.DB.prepare(`DELETE FROM bind_nonces WHERE nonce=? AND purpose='login' AND used_at IS NULL`)
      .bind(loginNonce)
      .run();
    await releaseBindClaim(env, code, claimToken, "consume_failed");
    await send([copy.invalidCode]);
    return;
  }

  await send([copy.boundOk(env.PUBLIC_BASE_URL, loginNonce), firstTaskGuide(env, event)]);
}


async function releaseBindClaim(
  env: Env,
  nonce: string,
  claimToken: string,
  reason: string,
): Promise<void> {
  const r = await env.DB.prepare(
    `UPDATE bind_nonces
        SET claim_state=NULL, claim_token=NULL, claimed_at=NULL, claim_channel=NULL, claim_external_id=NULL
      WHERE nonce=? AND claim_state='pending' AND claim_token=?`,
  ).bind(nonce, claimToken).run();
  if ((r.meta?.changes ?? 0) !== 1) {
    console.warn(`[dispatch] bind claim release missed (${reason}) nonce=${nonce}`);
  }
}


async function bindFallback(
  env: Env,
  event: ChannelEvent,
  send: (texts: string[]) => Promise<void>,
  arg: string,
): Promise<void> {
  const copy = cc(event);
  const hostResult = await getHostHooks()
    .redeemChatCode?.(
      env,
      { channel: event.channel, senderId: event.senderId, arg, lang: templateLang(event) },
      send,
    )
    .catch(() => "unhandled" as const);
  if (hostResult === "handled") return;

  const customInvalid = await getHostHooks().getInvalidCodeGuide?.(env, event, arg).catch(() => null);
  await send([customInvalid || copy.invalidCode]);
}


function firstTaskGuide(env: Env, event: ChannelEvent): string {
  void env;
  const copy = cc(event);


  return copy.firstTasks[2];
}


export async function createLoginNonce(
  env: Env,
  workspaceId: string,
  userId: string,
  purpose = "login",
): Promise<string> {
  const nonce = newSlug(8) + newSlug(8);
  await env.DB.prepare(
    `INSERT INTO bind_nonces (nonce, workspace_id, user_id, purpose, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(nonce, workspaceId, userId, purpose, now() + 5 * 60 * 1000)
    .run();
  return nonce;
}


export async function createBindCode(env: Env, workspaceId: string, userId: string): Promise<string> {
  return createBindCodeTtl(env, workspaceId, userId, 24 * 3600 * 1000);
}

export { newId };





export async function getOrCreateBindCode(
  env: Env,
  workspaceId: string,
  userId: string,
  opts?: { ttlMs?: number; reuseIfMinutesLeft?: number },
): Promise<string> {
  const ttl = opts?.ttlMs ?? 24 * 3600 * 1000;
  const reuseWindow = (opts?.reuseIfMinutesLeft ?? 10) * 60 * 1000;
  const existing = await env.DB.prepare(


    `SELECT nonce FROM bind_nonces
      WHERE purpose='bind_code' AND workspace_id=? AND user_id=? AND used_at IS NULL AND expires_at>?
        AND claim_state IS NULL
      ORDER BY expires_at DESC LIMIT 1`,
  ).bind(workspaceId, userId, now() + reuseWindow).first<{ nonce: string }>();
  if (existing) return existing.nonce;
  return createBindCodeTtl(env, workspaceId, userId, ttl);
}


const BIND_CODE_LEN = 10;

const BIND_CODE_MAX_ATTEMPTS = 20;

async function createBindCodeTtl(env: Env, workspaceId: string, userId: string, ttlMs: number): Promise<string> {
  const expiresAt = now() + ttlMs;
  for (let i = 0; i < BIND_CODE_MAX_ATTEMPTS; i++) {
    const code = newSlug(BIND_CODE_LEN).toUpperCase();
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO bind_nonces (nonce, workspace_id, user_id, purpose, expires_at) VALUES (?, ?, ?, 'bind_code', ?)`,
    ).bind(code, workspaceId, userId, expiresAt).run();
    if ((r.meta?.changes ?? 0) === 1) return code;
  }

  throw new Error("bind_code_generation_failed:collision_limit");
}
