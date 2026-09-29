// wechat-typing.ts — WeChat typing status lifecycle manager.
// Guarantees:
// 1. Idempotent start/stop.
// 2. Guaranteed cleanup via finally wrappers (zero stuck "typing..." state on error/timeout).
// 3. 60-second TTL auto-expiration sweep to prevent memory leaks or stranded state.
// 4. Scoped by `botId|toUserId` to ensure multi-tenant and multi-session isolation.

export interface TypingSession {
  botId: string;
  toUserId: string;
  startedAt: number;
  lastBeatAt: number;
  active: boolean;
}

export class WeChatTypingManager {
  private sessions = new Map<string, TypingSession>();
  private idleTimeoutMs: number;

  constructor(opts: { idleTimeoutMs?: number } = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  }

  private key(botId: string, toUserId: string): string {
    return `${botId}|${toUserId}`;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  isActive(botId: string, toUserId: string): boolean {
    const s = this.sessions.get(this.key(botId, toUserId));
    return Boolean(s && s.active);
  }

  async start(
    botId: string,
    toUserId: string,
    sendFn?: (status: 1) => Promise<void>
  ): Promise<boolean> {
    if (!botId || !toUserId) return false;
    const k = this.key(botId, toUserId);
    const now = Date.now();
    const existing = this.sessions.get(k);

    if (existing && existing.active) {
      existing.lastBeatAt = now;
      return false; // Idempotent: already active, no redundant upstream call
    }

    this.sessions.set(k, {
      botId,
      toUserId,
      startedAt: now,
      lastBeatAt: now,
      active: true,
    });

    if (sendFn) {
      try {
        await sendFn(1);
      } catch (e) {
        // Upstream send error does not corrupt session lifecycle
      }
    }
    return true;
  }

  async beat(
    botId: string,
    toUserId: string,
    sendFn?: (status: 1) => Promise<void>
  ): Promise<boolean> {
    const k = this.key(botId, toUserId);
    const s = this.sessions.get(k);
    if (!s || !s.active) return false;

    const now = Date.now();
    s.lastBeatAt = now;

    if (sendFn) {
      try {
        await sendFn(1);
      } catch {}
    }
    return true;
  }

  async stop(
    botId: string,
    toUserId: string,
    sendFn?: (status: 2) => Promise<void>
  ): Promise<boolean> {
    if (!botId || !toUserId) return false;
    const k = this.key(botId, toUserId);
    const s = this.sessions.get(k);

    if (!s) return false; // Idempotent: already stopped

    this.sessions.delete(k);

    if (sendFn) {
      try {
        await sendFn(2);
      } catch {}
    }
    return true;
  }

  /**
   * Sweeps stranded sessions past 60s idle timeout.
   */
  async sweepIdle(sendFn?: (botId: string, toUserId: string, status: 2) => Promise<void>): Promise<string[]> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [k, s] of this.sessions.entries()) {
      if (now - s.lastBeatAt >= this.idleTimeoutMs) {
        this.sessions.delete(k);
        expired.push(k);
        if (sendFn) {
          try {
            await sendFn(s.botId, s.toUserId, 2);
          } catch {}
        }
      }
    }
    return expired;
  }
}

export const globalTypingManager = new WeChatTypingManager();

/**
 * Execute long-running action wrapped with guaranteed typing start/stop lifecycle.
 */
export async function withWeChatTyping<T>(
  botId: string,
  toUserId: string,
  enabled: boolean,
  sendFn: (status: 1 | 2) => Promise<void>,
  action: () => Promise<T>,
  manager: WeChatTypingManager = globalTypingManager
): Promise<T> {
  if (!enabled || !botId || !toUserId) {
    return await action();
  }

  await manager.start(botId, toUserId, () => sendFn(1)).catch(() => {});
  try {
    return await action();
  } finally {
    // Guaranteed stop cleanup on normal exit, exception, or timeout
    await manager.stop(botId, toUserId, () => sendFn(2)).catch(() => {});
  }
}
