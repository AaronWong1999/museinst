




//



import type { Env } from "../../env";
import { encryptField, decryptField, fingerprint } from "../../crypto";
import { ilinkGetConfig, ilinkGetUpdates, ilinkSendMessage, ilinkSendTyping } from "./ilink";
import { dispatchChannelEvent } from "../dispatch";
import { textEvent } from "../normalize";

export const MAX_TOKENS_PER_DO = 3;
const SWEEP_BUDGET_MS = 9 * 60 * 1000;
const POLL_TIMEOUT_MS = 40_000;
const TYPING_HEARTBEAT_MS = 2_000;

export interface PollerToken {
  botId: string;
  token: string;
  cursor: string;
  botUserId: string;
  deadReason?: string;
}

export class WeChatPoller {
  private state: DurableObjectState;
  private env: Env;
  private sweeping = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const adminOk =
      !!this.env.ADMIN_KEY && req.headers.get("x-admin-key") === this.env.ADMIN_KEY;

    if (url.pathname === "/healthz") {
      const tokens = await this.loadTokens();
      return Response.json({
        ok: true,
        tokens: tokens.length,
        alive: tokens.filter((t) => !t.deadReason).length,
        maxTokens: MAX_TOKENS_PER_DO,
        nextAlarm: await this.state.storage.getAlarm(),
        sweeping: this.sweeping,
        diag: (await this.state.storage.get("diag")) ?? null,
        deadReasons: tokens.filter((t) => t.deadReason).map((t) => ({ botId: t.botId, reason: t.deadReason })),
        tokenFingerprints: await Promise.all(tokens.map(async (t) => ({ botId: t.botId, fp: await fingerprint(t.token) }))),
      });
    }

    if (url.pathname === "/kick" && req.method === "POST" && adminOk) {
      await this.state.storage.setAlarm(Date.now());
      return Response.json({ ok: true, kicked: true });
    }


    if (url.pathname === "/register" && req.method === "POST") {
      const body = (await req.json()) as { botId: string; token: string; botUserId?: string; cursor?: string };
      if (!body?.botId || !body?.token) return Response.json({ error: "botId_and_token_required" }, { status: 400 });
      const next: PollerToken[] = [
        { botId: body.botId, token: body.token, cursor: body.cursor ?? "", botUserId: body.botUserId ?? "" },
      ];
      await this.state.storage.put("tokens", next);
      await this.state.storage.put("botId", body.botId);
      await this.ensureAlarm(0);
      return Response.json({ ok: true, tokens: 1 });
    }

    if (url.pathname === "/unregister" && req.method === "POST") {
      await this.state.storage.delete("tokens");
      await this.state.storage.delete("botId");
      await this.state.storage.deleteAlarm();
      return Response.json({ ok: true, tokens: 0 });
    }


    if (url.pathname === "/send" && req.method === "POST") {
      const body = (await req.json()) as { botId?: string; toUserId: string; contextToken: string; text: string };
      const tokens = await this.loadTokens();
      const tok = body.botId ? tokens.find((t) => t.botId === body.botId) : tokens.find((t) => !t.deadReason);
      if (!tok) return Response.json({ error: "unknown_bot" }, { status: 404 });
      const r = await ilinkSendMessage(tok.token, {
        toUserId: body.toUserId,
        contextToken: body.contextToken,
        text: body.text,
      });
      return Response.json(r);
    }

    if (url.pathname === "/typing" && req.method === "POST") {
      const body = (await req.json()) as { toUserId: string; typingTicket: string; stop?: boolean };
      const tok = (await this.loadTokens()).find((t) => !t.deadReason);
      if (!tok) return Response.json({ error: "unknown_bot" }, { status: 404 });
      const r = await ilinkSendTyping(tok.token, {
        ilinkUserId: body.toUserId,
        typingTicket: body.typingTicket,
        status: body.stop ? 2 : 1,
      }).catch(() => ({ ok: false }));
      return Response.json(r);
    }

    return new Response("not found", { status: 404 });
  }


  async alarm(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    const deadline = Date.now() + SWEEP_BUDGET_MS;
    const diag: Record<string, unknown> = { startedAt: Date.now(), rounds: 0, messages: 0, lastError: null, endedBy: "unknown" };
    try {
      while (Date.now() < deadline) {
        const tokens = (await this.loadTokens()).filter((t) => !t.deadReason);
        if (tokens.length === 0) {
          diag.endedBy = "no_tokens";
          return;
        }
        const results = await Promise.all(
          tokens.map((t) => this.pollOne(t).catch((e) => ({ token: t, error: String(e) }))),
        );
        diag.rounds = (diag.rounds as number) + 1;
        for (const r of results) {
          if (r && "error" in r && r.error) {
            diag.lastError = `${r.token.botId}: ${r.error}`;
          }
          if (r && "handled" in r) diag.messages = (diag.messages as number) + (r.handled as number);
        }
        await this.state.storage.put("diag", { ...diag, at: Date.now() });
      }
      diag.endedBy = "budget";
    } catch (e) {
      diag.endedBy = "threw";
      diag.lastError = String(e);
    } finally {
      this.sweeping = false;
      await this.state.storage.put("diag", { ...diag, endedAt: Date.now() }).catch(() => {});
      const tokens = await this.loadTokens();
      if (tokens.some((t) => !t.deadReason)) {
        await this.state.storage.setAlarm(Date.now() + 1000);
      }
    }
  }

  private async pollOne(
    tok: PollerToken,
  ): Promise<{ token: PollerToken; error?: string; handled?: number } | void> {
    const res = await ilinkGetUpdates(tok.token, tok.cursor, POLL_TIMEOUT_MS);

    if (!res.ok) {
      if (res.dead) {
        await this.markDead(tok.botId, res.error ?? "dead");
        return { token: tok, error: `dead: ${res.error}` };
      }
      await new Promise((r) => setTimeout(r, 2000));
      return { token: tok, error: res.error };
    }


    let allHandled = true;
    let handled = 0;
    let lastErr: string | undefined;
    for (const msg of res.messages) {
      const ok = await this.handleInbound(tok, msg).catch((e) => {
        lastErr = String(e);
        return false;
      });
      if (!ok) {
        allHandled = false;
        break;
      }
      handled++;
    }

    if (!allHandled) {

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (allHandled && res.cursor && res.cursor !== tok.cursor) {
      const tokens = await this.loadTokens();
      const idx = tokens.findIndex((t) => t.botId === tok.botId);
      if (idx >= 0) {
        tokens[idx].cursor = res.cursor;
        await this.state.storage.put("tokens", tokens);

        if (res.messages.length > 0) {
          const cursorEnc = await encryptField(this.env, "wechat:cursor", res.cursor);
          const t = Date.now();
          await this.env.DB.prepare(
            `UPDATE wechat_bots SET updates_buf_enc=?, updates_buf_at=?, updated_at=? WHERE id=? AND status='active'`,
          )
            .bind(cursorEnc, t, t, tok.botId)
            .run()
            .catch(() => {});
        }
      }
    }

    return { token: tok, handled, error: lastErr };
  }


  private async handleInbound(tok: PollerToken, msg: Record<string, unknown>): Promise<boolean> {
    const fromUserId = String(msg.from_user_id ?? "");
    const ctxToken = String(msg.context_token ?? "");
    const messageId = String(msg.message_id ?? `${fromUserId}:${msg.create_time_ms ?? Date.now()}`);

    const items = (msg.item_list as Array<Record<string, unknown>>) ?? [];
    let text = "";
    for (const item of items) {
      const ti = item.text_item as Record<string, unknown> | undefined;
      if (ti?.text) text += String(ti.text);
    }
    const messageType = Number(msg.message_type ?? 1);
    if (messageType !== 1) return true;

    const event = textEvent("wechat", fromUserId, messageId, text, ctxToken);
    event.botId = tok.botId;

    const typing = async (status: 1 | 2) => {
      try {
        const ticket = await this.typingTicket(tok, fromUserId, ctxToken);
        if (!ticket) return;
        await ilinkSendTyping(tok.token, { ilinkUserId: fromUserId, typingTicket: ticket, status });
      } catch {

      }
    };
    void typing(1);
    const beat = setInterval(() => void typing(1), TYPING_HEARTBEAT_MS);

    try {
      const result = await dispatchChannelEvent(this.env, event, async (texts) => {
        for (const t of texts) {
          const r = await ilinkSendMessage(tok.token, {
            toUserId: fromUserId,
            contextToken: ctxToken,
            text: t,
          });
          if (!r.ok) throw new Error(`sendmessage failed: ${r.error}`);
        }
      });

      try {
        const { dequeueWechatOutbox, markOutboxDelivered } = await import("../outbound");
        const pending = await dequeueWechatOutbox(this.env, fromUserId);
        const sent: string[] = [];
        for (const p of pending) {
          const r = await ilinkSendMessage(tok.token, { toUserId: fromUserId, contextToken: ctxToken, text: p.text });
          if (r.ok) sent.push(p.id);
          else break;
        }
        await markOutboxDelivered(this.env, sent);
      } catch {                        }
      return result === "handled";
    } finally {
      clearInterval(beat);
      void typing(2);
    }
  }

  private async typingTicket(tok: PollerToken, ilinkUserId: string, contextToken: string): Promise<string | null> {
    const TTL_MS = 10 * 60 * 1000;
    const cached = await this.state.storage.get<{ ticket: string; at: number }>(`ticket:${tok.botId}`);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.ticket;
    const cfg = await ilinkGetConfig(tok.token, { ilinkUserId, contextToken });
    if (!cfg.typingTicket) return null;
    await this.state.storage.put(`ticket:${tok.botId}`, { ticket: cfg.typingTicket, at: Date.now() });
    return cfg.typingTicket;
  }

  private async loadTokens(): Promise<PollerToken[]> {
    const tokens = (await this.state.storage.get<PollerToken[]>("tokens")) ?? [];

    if (tokens.length === 0 && (this.env.WECHAT_TOKEN_KEY || this.env.OPENINST_SECRET)) {
      const savedBotId = await this.state.storage.get<string>("botId");
      let query = `SELECT id, token_enc, updates_buf_enc, bot_user_id FROM wechat_bots WHERE status='active'`;
      let res;
      if (savedBotId) {
        res = await this.env.DB.prepare(`${query} AND id=?`).bind(savedBotId).all<{ id: string; token_enc: string; updates_buf_enc: string | null; bot_user_id: string | null }>();
      } else {
        res = await this.env.DB.prepare(`${query} ORDER BY created_at DESC LIMIT 1`).all<{ id: string; token_enc: string; updates_buf_enc: string | null; bot_user_id: string | null }>();
      }
      const rows = res.results ?? [];
      const restored: PollerToken[] = [];
      for (const row of rows) {
        try {
          restored.push({
            botId: row.id,
            token: await decryptField(this.env, "wechat:token", row.token_enc),
            cursor: row.updates_buf_enc ? await decryptField(this.env, "wechat:cursor", row.updates_buf_enc) : "",
            botUserId: row.bot_user_id ?? "",
          });
        } catch {

        }
      }
      if (restored.length > 0) {
        await this.state.storage.put("tokens", restored);
        await this.state.storage.put("botId", restored[0].botId);
        await this.ensureAlarm(0);
        return restored;
      }
    }
    return tokens;
  }

  private async markDead(botId: string, reason: string): Promise<void> {
    const tokens = await this.loadTokens();
    const idx = tokens.findIndex((t) => t.botId === botId);
    if (idx >= 0) {
      tokens[idx].deadReason = reason;
      await this.state.storage.put("tokens", tokens);
    }
    await this.env.DB.prepare(`UPDATE wechat_bots SET status='dead', dead_reason=?, updated_at=? WHERE id=?`)
      .bind(reason.slice(0, 200), Date.now(), botId)
      .run()
      .catch(() => {});
  }

  private async ensureAlarm(delayMs: number): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > Date.now() + delayMs + 1000) {
      await this.state.storage.setAlarm(Date.now() + delayMs);
    }
  }
}
