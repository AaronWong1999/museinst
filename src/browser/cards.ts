//
// Browser session card + handoff delivery (§8.3, §14.3, §14.9, §14.11).
//
// Chat surfaces never see a Cloudflare Live View URL. Agent-initiated handoff
// mints a one-time grant (raw token exists only in the message we hand the
// user), builds a canonical BrowserSessionCard that carries stable object refs,
// and returns the text+link form Telegram/WeChat render.
//
import type { Env } from "../env";
import type { BrowserSessionCard, CanonicalAction, BrowserSessionState } from "../channels/message-contract";
import { CANONICAL_VERSION } from "../channels/message-contract";
import { BrowserGrantRepository, type IssuedGrant } from "./grants";
import { BrowserService, type SessionInfo } from "./service";

export interface BrowserCardContext {
  workspaceId: string;
  threadId: string;
  taskId: string;
  sessionId: string;
  targetId?: string;
  title?: string;
  displayUrl?: string;
  state: BrowserSessionState;
  continuity: "same_session" | "new_recovery_session";
  recordingReady?: boolean;
  revision?: number;
}

/**
 * Build the canonical browser card. Actions reference the *grant* by stable id
 * (`targetId`), never a provider URL — the server re-validates on every action.
 */
export function buildBrowserSessionCard(
  ctx: BrowserCardContext,
  input: { grantId: string; canTakeover: boolean; mode: "readonly" | "interactive" },
): BrowserSessionCard {
  const actions: CanonicalAction[] = [
    { id: `${ctx.taskId}:watch`, kind: "browser_watch", label: "观看", targetId: input.grantId, sensitivity: "private_link" },
  ];
  if (input.canTakeover) {
    actions.push({
      id: `${ctx.taskId}:takeover`,
      kind: "browser_takeover",
      label: "接管",
      targetId: input.grantId,
      sensitivity: "private_link",
    });
  }
  const card: BrowserSessionCard = {
    type: "browser_session",
    version: CANONICAL_VERSION,
    id: `bc_${ctx.taskId}`,
    revision: ctx.revision ?? 1,
    taskId: ctx.taskId,
    threadId: ctx.threadId,
    ref: { sessionRef: ctx.taskId, targetRef: ctx.targetId },
    state: ctx.state,
    continuity: ctx.continuity,
    actions,
  };
  if (ctx.title) card.title = ctx.title;
  if (ctx.displayUrl) card.displayUrl = ctx.displayUrl;
  if (ctx.recordingReady !== undefined) card.recordingReady = ctx.recordingReady;
  return card;
}

export interface HandoffDelivery {
  grant: IssuedGrant;
  card: BrowserSessionCard;
  /** Text + one-time link for Telegram / WeChat. */
  text: string;
  /** Web timeline text: the card carries the action, so no raw link. */
  webText: string;
  buttons: Array<{ text: string; url: string }>;
}

/**
 * Mint a one-time grant and produce the handoff delivery for a parked browser
 * task. Capability checks are deliberately performed before issuing a link: an
 * interactive handoff must not be advertised when provider revocation has not
 * been proven.
 */
export async function deliverBrowserHandoff(
  env: Env,
  input: {
    workspaceId: string;
    threadId: string;
    taskId: string;
    sessionId: string;
    targetId?: string;
    title?: string;
    displayUrl?: string;
    mode: "readonly" | "interactive";
    reasonCode: string;
    instructions: string;
    privacyMode: "normal" | "secret_entry";
    originChannel?: string;
    originExternalId?: string;
    originScope?: string;
    lang: "zh" | "en";
    state?: BrowserSessionState;
    canTakeover?: boolean;
    controlEpoch?: number;
  },
): Promise<HandoffDelivery> {
  const caps = await new BrowserService(env).capabilities();
  if (input.mode === "readonly" && !caps.readonlyView) {
    throw new Error("browser_watch_unavailable");
  }
  if (input.mode === "interactive" && !caps.interactiveView) {
    throw new Error("browser_takeover_unavailable");
  }
  if (!input.targetId) {
    throw new Error("browser_target_not_found");
  }

  const repo = new BrowserGrantRepository(env.DB);
  const grant = await repo.createGrant(
    {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      requestedMode: input.mode,
      createdBy: "agent",
      browserSessionRef: input.sessionId,
      targetRef: input.targetId,
      controlEpoch: input.controlEpoch,
      originChannel: input.originChannel,
      originExternalId: input.originExternalId,
      originScope: input.originScope,
      reasonCode: input.reasonCode,
      instructions: input.instructions,
      privacyMode: input.privacyMode === "secret_entry" ? "masked" : "normal",
    },
    env.PUBLIC_BASE_URL || "https://museinst.com",
  );

  const canTakeover = input.canTakeover === true && caps.interactiveView && input.mode === "interactive";
  const card = buildBrowserSessionCard(
    {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      targetId: input.targetId,
      title: input.title,
      displayUrl: input.displayUrl,
      state: input.state ?? (input.mode === "interactive" ? "handoff_requested" : "watch_available"),
      continuity: "same_session",
    },
    { grantId: grant.grantId, canTakeover, mode: input.mode },
  );

  const zh = input.lang === "zh";
  const reasonLabel = handoffReasonLabel(input.reasonCode, zh);
  const actionLabel = input.mode === "interactive"
    ? (zh ? "打开浏览器接管：" : "Open the browser to take over:")
    : (zh ? "打开浏览器只读预览：" : "Open the readonly browser view:");
  const tail = input.mode === "interactive"
    ? (zh ? "（链接单次有效，仅能访问这一个浏览器任务；完成后请点击「交还 Agent」。）" : "(Single-use link scoped to this browser task. Use Done to hand control back.)")
    : (zh ? "（链接单次有效，仅能只读查看这一个浏览器任务。）" : "(Single-use link scoped to a readonly view of this browser task.)");
  const text = `${reasonLabel}\n\n${input.instructions}\n\n${actionLabel}\n${grant.accessUrl}\n\n${tail}`;
  const webText = input.mode === "interactive"
    ? `${reasonLabel}\n\n${input.instructions}\n\n${zh ? "点下方按钮接管浏览器，完成后点「交还 Agent」，我会自动继续。" : "Use the button below to take over; press Done when finished and I'll continue automatically."}`
    : `${reasonLabel}\n\n${input.instructions}`;

  return { grant, card, text, webText, buttons: browserLinkButtons(grant.accessUrl, input.mode, input.lang) };
}

function handoffReasonLabel(reasonCode: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    credentials: ["需要你本人登录", "I need you to sign in yourself"],
    mfa: ["需要你完成二次验证", "I need you to complete verification"],
    passkey: ["需要你的 Passkey / 安全密钥", "This needs your passkey / security key"],
    captcha: ["遇到人机验证，我不会绕过它", "There's a CAPTCHA — I won't try to bypass it"],
    sensitive_confirmation: ["这一步需要你本人确认", "This step needs your own confirmation"],
    automation_blocked: ["自动化被页面阻断了", "The page blocked automation here"],
    manual_interaction: ["这一步需要你手工操作", "This step needs you to do it by hand"],
    user_requested: ["好的，浏览器交给你", "Sure — the browser is yours"],
  };
  const [zhLabel, enLabel] = labels[reasonCode] ?? labels.manual_interaction;
  return zh ? `🤝 ${zhLabel}` : `🤝 ${enLabel}`;
}

/** Link buttons for channels that render them (Telegram); the text carries the same link. */
export function browserLinkButtons(accessUrl: string, mode: "readonly" | "interactive", lang: "zh" | "en"): Array<{ text: string; url: string }> {
  const zh = lang === "zh";
  const text = mode === "interactive" ? (zh ? "🖐 接管浏览器" : "🖐 Take over browser") : (zh ? "👀 观看 / 接管浏览器" : "👀 Watch / take over");
  return [{ text, url: accessUrl }];
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Poll the BrowserWorker until the task's session has a live target. The
 * worker records the target a moment after launching, so a lookup made right
 * after /assign (or right as a handoff comes back) can race it.
 */
export async function waitForBrowserSession(
  env: Env,
  workspaceId: string,
  taskId: string,
  opts: { timeoutMs: number; intervalMs?: number; workerSessionId?: string; stop?: () => boolean },
): Promise<SessionInfo | null> {
  const service = new BrowserService(env);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const session = await service.getSession(workspaceId, taskId).catch(() => null);
    const ready =
      !!session?.sessionId &&
      !!session.targetId &&
      (!opts.workerSessionId || session.sessionId === opts.workerSessionId);
    if (ready) return session;
    if (opts.stop?.() || Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 500));
  }
}

export type AgentHandoffResult =
  | { ok: true; delivery: HandoffDelivery }
  | {
      ok: false;
      error: "browser_takeover_unavailable" | "browser_session_not_ready";
      /**
       * User-facing explanation. The caller releases the browser session, so
       * the text says so. Never contains provider ids or access links.
       */
      text: string;
    };

/**
 * Agent-initiated handoff (worker returned needs_handoff). The worker outcome
 * only carries the provider session id, so the grant's target is resolved from
 * the BrowserWorker session record. The grant is pinned to that observed
 * session/target; if the worker has since moved to another session we refuse
 * rather than hand out access to something the user did not ask for.
 */
export async function deliverAgentBrowserHandoff(
  env: Env,
  input: {
    workspaceId: string;
    threadId: string;
    taskId: string;
    workerSessionId?: string;
    reasonCode: string;
    instructions: string;
    privacyMode: "normal" | "secret_entry";
    originChannel?: string;
    originExternalId?: string;
    originScope?: string;
    lang: "zh" | "en";
    /** How long to wait for the worker to record the session target. */
    sessionWaitMs?: number;
  },
): Promise<AgentHandoffResult> {
  const zh = input.lang === "zh";
  const session = await waitForBrowserSession(env, input.workspaceId, input.taskId, {
    timeoutMs: input.sessionWaitMs ?? 4000,
    workerSessionId: input.workerSessionId,
  });
  if (!session) {
    return {
      ok: false,
      error: "browser_session_not_ready",
      text: zh
        ? "云浏览器会话已经断开，没法交给你操作。我已结束这次浏览器任务，需要的话可以让我重新打开。"
        : "The cloud browser session dropped, so I can't hand it to you. I've ended this browser task; ask me to open it again if you still need it.",
    };
  }
  try {
    const delivery = await deliverBrowserHandoff(env, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      taskId: input.taskId,
      sessionId: session.sessionId,
      targetId: session.targetId,
      title: session.title || undefined,
      displayUrl: session.url || undefined,
      controlEpoch: session.controlEpoch,
      mode: "interactive",
      reasonCode: input.reasonCode,
      instructions: input.instructions,
      privacyMode: input.privacyMode,
      originChannel: input.originChannel,
      originExternalId: input.originExternalId,
      originScope: input.originScope,
      lang: input.lang,
      canTakeover: true,
    });
    return { ok: true, delivery };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === "browser_takeover_unavailable") {
      const page = session.url && /^https?:/i.test(session.url) ? session.url : "";
      if (input.reasonCode === "user_requested") {
        return {
          ok: false,
          error: "browser_takeover_unavailable",
          text: zh
            ? `当前环境还不支持把云浏览器交给你操作，我已关闭这次浏览器会话。${page ? `你可以直接在自己的浏览器里打开：${page}` : ""}`
            : `Handing the cloud browser to you isn't supported in this environment yet, so I've closed this browser session.${page ? ` You can open it in your own browser: ${page}` : ""}`,
        };
      }
      return {
        ok: false,
        error: "browser_takeover_unavailable",
        text: zh
          ? `${handoffReasonLabel(input.reasonCode, zh)}：${input.instructions}\n\n这一步需要你本人操作，但当前环境还不支持把云浏览器交给你，我已关闭这次浏览器会话。${page ? `你可以在自己的浏览器里打开 ${page} 完成这一步，` : "你可以在自己的浏览器里完成这一步，"}然后告诉我结果，我接着处理后面的事。`
          : `${handoffReasonLabel(input.reasonCode, zh)}: ${input.instructions}\n\nThis step needs you, but handing the cloud browser over isn't supported in this environment yet, so I've closed this browser session. ${page ? `You can open ${page} in your own browser to finish it, ` : "You can finish it in your own browser, "}then tell me how it went and I'll take it from there.`,
      };
    }
    throw e;
  }
}

export interface LiveSessionAnnouncement {
  grant: IssuedGrant;
  card: BrowserSessionCard;
  /** Text + one-time link for Telegram / WeChat. */
  text: string;
  /** Web timeline text: the card carries the action, so no raw link. */
  webText: string;
  buttons: Array<{ text: string; url: string }>;
}

/**
 * The agent just started driving a cloud browser. Give the user a live view
 * right away: a readonly grant whose page offers one-click takeover when that
 * capability is proven. Returns null when watching is unavailable, so the task
 * simply runs without a card.
 */
export async function announceBrowserSession(
  env: Env,
  input: {
    workspaceId: string;
    threadId: string;
    taskId: string;
    session: SessionInfo;
    originChannel?: string;
    originExternalId?: string;
    originScope?: string;
    lang: "zh" | "en";
    ttlMs?: number;
  },
): Promise<LiveSessionAnnouncement | null> {
  const caps = await new BrowserService(env).capabilities();
  if (!caps.readonlyView) return null;
  const zh = input.lang === "zh";
  const grant = await new BrowserGrantRepository(env.DB).createGrant(
    {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      requestedMode: "readonly",
      createdBy: "agent",
      browserSessionRef: input.session.sessionId,
      targetRef: input.session.targetId,
      controlEpoch: input.session.controlEpoch,
      originChannel: input.originChannel,
      originExternalId: input.originExternalId,
      originScope: input.originScope,
      reasonCode: "live_session",
      ttlMs: input.ttlMs ?? 30 * 60_000,
    },
    env.PUBLIC_BASE_URL || "https://museinst.com",
  );
  const card = buildBrowserSessionCard(
    {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      taskId: input.taskId,
      sessionId: input.session.sessionId,
      targetId: input.session.targetId,
      title: input.session.title || undefined,
      displayUrl: input.session.url || undefined,
      state: "agent_active",
      continuity: "same_session",
    },
    { grantId: grant.grantId, canTakeover: caps.interactiveView, mode: "readonly" },
  );
  const host = hostOf(input.session.url);
  const lead = zh
    ? `🌐 我正在云浏览器里操作${host ? ` ${host}` : ""}。`
    : `🌐 I'm working in a cloud browser${host ? ` on ${host}` : ""}.`;
  const how = caps.interactiveView
    ? (zh ? "你可以随时观看，需要时一键接管：" : "Watch any time, and take over with one click if you want:")
    : (zh ? "你可以随时观看：" : "You can watch any time:");
  const tail = zh
    ? "（链接单次有效，仅能访问这一个浏览器任务。）"
    : "(Single-use link scoped to this browser task.)";
  return {
    grant,
    card,
    text: `${lead}\n${how}\n${grant.accessUrl}\n\n${tail}`,
    webText: `${lead}${caps.interactiveView ? (zh ? "你可以随时观看，需要时一键接管。" : " Watch any time, and take over with one click if you want.") : (zh ? "你可以随时观看。" : " You can watch any time.")}`,
    buttons: browserLinkButtons(grant.accessUrl, "readonly", input.lang),
  };
}
