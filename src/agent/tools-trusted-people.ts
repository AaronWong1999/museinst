// agent/tools-trusted-people.ts — Trusted People Agent tools (owner authenticated context only).
// Double-layer interception: not registered in external turns, and refused in executeTool if source != owner_chat.

import type { Tool } from "./tool-types";
import {
  listTrustEdges,
  listTrustRequests,
  inviteTrustPerson,
  acceptTrustRequest,
  declineTrustRequest,
  removeTrustPerson,
  blockTrustPeer,
  unblockTrustPeer,
} from "../channels/email/trust-service";
import { startScheduleCoordination } from "../channels/email/a2a/initiate";
import { newId } from "../util";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const str = (desc: string) => ({ type: "string", description: desc });

type BusyWindow = { start: string; end: string; status: "free" | "busy" };

function validIsoRange(start: unknown, end: unknown): { start: string; end: string } | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { start, end };
}

/** Merge calendar busy periods before the disclosure serializer's 20-window safety cap. */
function mergeBusyWindows(windows: Array<{ start: string; end: string }>): Array<{ start: string; end: string; status: "busy" }> {
  const parsed = windows
    .map((w) => ({ ...w, startMs: Date.parse(w.start), endMs: Date.parse(w.end) }))
    .filter((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs > w.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const w of parsed) {
    const last = merged.at(-1);
    if (last && w.startMs <= last.endMs) last.endMs = Math.max(last.endMs, w.endMs);
    else merged.push({ startMs: w.startMs, endMs: w.endMs });
  }
  return merged.map((w) => ({
    start: new Date(w.startMs).toISOString(),
    end: new Date(w.endMs).toISOString(),
    status: "busy" as const,
  }));
}

export const TOOL_trusted_people_list: Tool = {
  name: "trusted_people_list",
  effect: "read",
  description: "列出当前工作区中受信任的人及其 Agent 地址与状态。默认只列 active；需要其它状态时显式指定。",
  parameters: obj({
    status: { type: "string", enum: ["active", "pending", "revoked", "blocked", "all"], description: "状态过滤，默认 active" },
  }),
  run: async (ctx, a) => {
    const requested = a.status == null ? "active" : String(a.status);
    if (!["active", "pending", "revoked", "blocked", "all"].includes(requested)) {
      return { ok: false, error: "invalid_status" };
    }
    const filter = requested === "all" ? undefined : { status: requested };
    const edges = await listTrustEdges(ctx.env, ctx.workspaceId, filter);
    return {
      ok: true,
      data: edges.map((e) => ({
        edgeId: e.id,
        displayName: e.displayName,
        peerAddress: e.peerAddress,
        peerIssuer: e.peerIssuer,
        status: e.status,
        relation: e.relation,
        invitedAt: e.invitedAt,
        confirmedAt: e.confirmedAt,
      })),
    };
  },
};

export const TOOL_trusted_people_requests: Tool = {
  name: "trusted_people_requests",
  effect: "read",
  description: "列出当前工作区正在等待处理的受信任人请求（incoming 待我接受，或 outgoing 等待对方接受）。",
  parameters: obj({
    direction: { type: "string", enum: ["in", "out", "all"], description: "请求方向：in（他人请求我）、out（我发出的请求）、all（全部，默认）" },
  }),
  run: async (ctx, a) => {
    const direction = a.direction === "in" || a.direction === "out" ? a.direction : undefined;
    const requests = await listTrustRequests(ctx.env, ctx.workspaceId, { direction, status: "pending" });
    return {
      ok: true,
      data: requests.map((r) => ({
        requestId: r.id,
        protocolRequestId: r.protocolRequestId,
        direction: r.direction,
        peerAddress: r.peerAddress,
        peerIssuer: r.peerIssuer,
        displayName: r.displayName,
        relation: r.relation,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      })),
    };
  },
};

export const TOOL_trusted_people_invite: Tool = {
  name: "trusted_people_invite",
  effect: "external_send",
  description: "向对方的 MuseInst Agent Mail 发送建立受信任人（Trusted Person）连接的请求。",
  parameters: obj({
    peerAddress: str("对方的 MuseInst Agent Mail 地址，如 alice@bot.museinst.com"),
    displayName: { type: "string", description: "备注姓名（可选）" },
    relation: { type: "string", description: "关系标签，默认 trusted" },
  }, ["peerAddress"]),
  run: async (ctx, a) => {
    const peerAddress = String(a.peerAddress ?? "").trim();
    const res = await inviteTrustPerson(ctx.env, {
      workspaceId: ctx.workspaceId,
      peerAddress,
      displayName: a.displayName ? String(a.displayName).trim() : undefined,
      relation: a.relation ? String(a.relation).trim() : undefined,
    });
    if (!res.ok) return { ok: false, error: res.error ?? "invite_failed" };
    return {
      ok: true,
      message: `已向 ${peerAddress} 发出受信任人连接邀请。对方接受后，双方 Agent 可在已开放的 Trusted People 能力范围内协作。`,
      requestId: res.requestId,
      protocolRequestId: res.protocolRequestId,
      edgeId: res.edgeId,
    };
  },
};

export const TOOL_trusted_people_respond: Tool = {
  name: "trusted_people_respond",
  effect: "external_send",
  description: "接受或拒绝收到的受信任人请求（Accept 或 Decline）。",
  parameters: obj({
    requestId: str("请求 ID（来自 trusted_people_requests）"),
    action: { type: "string", enum: ["accept", "decline"], description: "操作类型：accept（接受）或 decline（拒绝）" },
  }, ["requestId", "action"]),
  run: async (ctx, a) => {
    const requestId = String(a.requestId ?? "").trim();
    const action = String(a.action ?? "").trim();
    if (action === "accept") {
      const res = await acceptTrustRequest(ctx.env, { workspaceId: ctx.workspaceId, requestId });
      if (!res.ok) return { ok: false, error: res.error ?? "accept_failed" };
      return { ok: true, message: "已接受请求，受信任人关系已建立。", edgeId: res.edgeId };
    }
    if (action === "decline") {
      const res = await declineTrustRequest(ctx.env, { workspaceId: ctx.workspaceId, requestId });
      if (!res.ok) return { ok: false, error: res.error ?? "decline_failed" };
      return { ok: true, message: "已拒绝该连接请求。" };
    }
    return { ok: false, error: "invalid_action" };
  },
};

export const TOOL_trusted_people_schedule: Tool = {
  name: "trusted_people_schedule",
  effect: "external_send",
  description: "向已直接信任的 Agent 发起日程协调请求。仅交换 free/busy、时区等最小必要事实；不会披露事件标题、Vault、邮件或联系人网络。",
  parameters: obj({
    peers: { type: "array", items: { type: "string" }, description: "对方的 Agent Mail 地址列表（1个或多个）" },
    timeWindow: {
      type: "object",
      properties: {
        start: { type: "string", description: "建议范围起始 ISO 时间，例如 2026-09-18T18:00:00+08:00" },
        end: { type: "string", description: "建议范围结束 ISO 时间，例如 2026-09-18T23:00:00+08:00" },
      },
      required: ["start", "end"],
      description: "时间协商窗口",
    },
    durationMinutes: { type: "integer", description: "期望活动时长（分钟），如 60 或 90" },
    preference: { type: "string", description: "活动类型或偏好说明，如 dinner、call、meeting" },
    freeBusyWindows: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          start: { type: "string" },
          end: { type: "string" },
          status: { type: "string", enum: ["free", "busy"] },
        },
        required: ["start", "end", "status"],
      },
      description: "可选：显式提供本人 free/busy 窗口（最多 20 条）。未提供时会尝试读取已授权的 Google Calendar；读取失败时不会伪造日历事实。",
    },
    timezone: { type: "string", description: "时区，如 Asia/Shanghai" },
  }, ["peers", "timeWindow", "durationMinutes"]),
  run: async (ctx, a) => {
    const peers = Array.isArray(a.peers) ? a.peers.map((p) => String(p).trim()).filter(Boolean) : [];
    const timeWindow = a.timeWindow as { start?: unknown; end?: unknown } | undefined;
    const validWindow = validIsoRange(timeWindow?.start, timeWindow?.end);
    if (!validWindow) return { ok: false, error: "invalid_time_window" };
    const durationMinutes = Number(a.durationMinutes ?? 60);
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 24 * 60) {
      return { ok: false, error: "invalid_duration_minutes" };
    }
    if (durationMinutes * 60_000 > Date.parse(validWindow.end) - Date.parse(validWindow.start)) {
      return { ok: false, error: "duration_exceeds_time_window" };
    }

    const preference = a.preference ? String(a.preference).slice(0, 280) : undefined;
    const idempotencyKey = newId("sch");
    const facts: { freeBusyWindows?: BusyWindow[]; timezone?: string } = {};
    let calendarEvidence: "explicit" | "google" | "none" | "too_dense" = "none";

    if (Array.isArray(a.freeBusyWindows) && a.freeBusyWindows.length > 0) {
      if (a.freeBusyWindows.length > 20) return { ok: false, error: "too_many_free_busy_windows" };
      const normalized: BusyWindow[] = [];
      for (const raw of a.freeBusyWindows as Array<{ start?: unknown; end?: unknown; status?: unknown }>) {
        const range = validIsoRange(raw.start, raw.end);
        if (!range || (raw.status !== "free" && raw.status !== "busy")) {
          return { ok: false, error: "invalid_free_busy_window" };
        }
        normalized.push({ ...range, status: raw.status });
      }
      facts.freeBusyWindows = normalized;
      calendarEvidence = "explicit";
    } else {
      try {
        const { withConnectorCall } = await import("../connectors/token-mark");
        const { calendarList } = await import("../connectors/google");
        const googleRes = await withConnectorCall(
          ctx.env,
          { workspaceId: ctx.workspaceId, provider: "google", taskId: ctx.taskId },
          "read",
          "calendar_list",
          (token: string) => calendarList(token, validWindow.start, validWindow.end, 250),
        );
        if (googleRes.ok && Array.isArray(googleRes.data)) {
          const rawBusy: Array<{ start: string; end: string }> = [];
          for (const ev of googleRes.data as Array<{ start?: unknown; end?: unknown }>) {
            const range = validIsoRange(ev.start, ev.end);
            if (range) rawBusy.push(range);
          }
          const merged = mergeBusyWindows(rawBusy);
          // serializeDisclosure intentionally caps to 20. Never silently truncate calendar facts,
          // because dropping later busy periods would make the owner look falsely available.
          if (merged.length <= 20 && (googleRes.data as unknown[]).length < 250) {
            facts.freeBusyWindows = merged;
            calendarEvidence = "google";
          } else {
            calendarEvidence = "too_dense";
          }
        }
      } catch {
        // No authorized Google calendar or a transient connector failure: omit calendar facts.
      }
    }

    if (a.timezone) facts.timezone = String(a.timezone).slice(0, 64);

    const res = await startScheduleCoordination(ctx.env, {
      workspaceId: ctx.workspaceId,
      peers,
      facts,
      timeWindow: validWindow,
      durationMinutes,
      preference,
      idempotencyKey,
    });
    if (!res.ok) return { ok: false, error: res.error ?? "schedule_coordination_failed", results: res.results };

    const note = calendarEvidence === "explicit"
      ? "已使用你提供的 free/busy 约束。"
      : calendarEvidence === "google"
        ? "已读取并仅附带 Google Calendar 的 busy 时间段。"
        : calendarEvidence === "too_dense"
          ? "日历事件过多，未发送可能被截断的忙闲数据；对方不会收到不完整的可用性。"
          : "未能取得可靠的本地日历 busy 数据，因此本次没有声称你的实时可用性。";
    return {
      ok: true,
      message: `已向受信任 Agent 发起日程协调请求。对方会按其授权与配置决定是否返回可用时间；${note}`,
      results: res.results,
      calendarEvidence,
    };
  },
};

export const TOOL_trusted_people_remove: Tool = {
  name: "trusted_people_remove",
  effect: "destructive",
  description: "解除与某人的受信任关系（对方将无法再与你的 Agent 协调日程）。",
  parameters: obj({ target: str("对方的 edgeId 或 Agent Mail 地址") }, ["target"]),
  run: async (ctx, a) => {
    const target = String(a.target ?? "").trim();
    const res = await removeTrustPerson(ctx.env, { workspaceId: ctx.workspaceId, edgeIdOrPeerAddress: target });
    if (!res.ok) return { ok: false, error: res.error ?? "remove_failed" };
    return { ok: true, message: `已成功解除与 ${target} 的受信任关系。` };
  },
};

export const TOOL_trusted_people_block: Tool = {
  name: "trusted_people_block",
  effect: "destructive",
  description: "拉黑某人（完全拒绝其 Agent 的任何通信与邀请）。",
  parameters: obj({ target: str("对方的 edgeId 或 Agent Mail 地址") }, ["target"]),
  run: async (ctx, a) => {
    const target = String(a.target ?? "").trim();
    const res = await blockTrustPeer(ctx.env, { workspaceId: ctx.workspaceId, edgeIdOrPeerAddress: target });
    if (!res.ok) return { ok: false, error: res.error ?? "block_failed" };
    return { ok: true, message: `已成功拉黑 ${target}。` };
  },
};

export const TOOL_trusted_people_unblock: Tool = {
  name: "trusted_people_unblock",
  effect: "write",
  needsApproval: true,
  description: "解除对某人的拉黑；只恢复再次发起邀请的资格，不会自动恢复受信任状态。",
  parameters: obj({ target: str("对方的 edgeId 或 Agent Mail 地址") }, ["target"]),
  run: async (ctx, a) => {
    const target = String(a.target ?? "").trim();
    const res = await unblockTrustPeer(ctx.env, { workspaceId: ctx.workspaceId, edgeIdOrPeerAddress: target });
    if (!res.ok) return { ok: false, error: res.error ?? "unblock_failed" };
    return {
      ok: true,
      message: `已解除对 ${target} 的拉黑。受信任关系没有自动恢复；如需重新连接，请重新发送邀请并等待对方确认。`,
    };
  },
};






export const TOOL_trusted_people_introduce: Tool = {
  name: "trusted_people_introduce",
  effect: "write",
  description: "可信网络介绍协议尚未开放；不要声称已发送介绍。",
  parameters: obj({
    friendAddress: str("受信任朋友的 Agent Mail 地址"),
    targetAddress: str("希望被介绍的 Agent Mail 地址"),
    targetDisplayName: { type: "string" },
    reason: { type: "string" },
  }, ["friendAddress", "targetAddress"]),
  run: async () => ({
    ok: false,
    error: "trusted_introduction_not_available",
    message: "可信网络 Introduction 还没有完成真实签名协议与双方同意流程，因此没有发送任何介绍请求。",
  }),
};

export const TRUSTED_PEOPLE_TOOLS: Tool[] = [
  TOOL_trusted_people_list,
  TOOL_trusted_people_requests,
  TOOL_trusted_people_invite,
  TOOL_trusted_people_respond,
  TOOL_trusted_people_schedule,
  TOOL_trusted_people_remove,
  TOOL_trusted_people_block,
  TOOL_trusted_people_unblock,
];
