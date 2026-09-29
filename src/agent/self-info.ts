


import type { Tool } from "./tool-types";
import { resolveEffectiveModel } from "../model/effective";
import { listBindings } from "../identity";

export const TOOL_get_self_info: Tool = {
  name: "get_self_info",
  effect: "read",
  scheduledAllowed: true,
  description:
    "查询当前 MuseInst 实例自身状态，包括当前运行环境、实际使用的模型和已连接的通信渠道。当用户询问“你现在用什么模型”“当前连了哪些渠道”“这是哪种部署方式”时调用。（连接态权威查询由各 semantic tool 在执行时自行完成；本工具不做外部调用前置。）",
  parameters: {
    type: "object",
    properties: {
      aspect: {
        type: "string",
        enum: ["all", "model", "channels", "runtime"],
        description: "查询切面：all（全部，默认）、model（模型）、channels（渠道）、runtime（运行环境）",
      },
    },
  },
  run: async (ctx, args) => {
    try {
      const aspect = String(args.aspect ?? "all").toLowerCase();
      const taskCtx = {
        workspaceId: ctx.workspaceId,
        channel: ctx.channel,
        userId: ctx.userId,
        taskId: ctx.taskId,
        lang: ctx.lang,
      };

      const effectiveModel = await resolveEffectiveModel(ctx.env, taskCtx, "root");
      const rawBindings = await listBindings(ctx.env, ctx.workspaceId).catch(() => []);
      const hasContextOverride = Number.isFinite(effectiveModel.maxContext);
      const hasOutputOverride = typeof effectiveModel.maxTokens === "number";

      const modelInfo = {
        id: effectiveModel.id,
        name: effectiveModel.name ?? effectiveModel.id,
        provider: effectiveModel.provider,
        limits_mode: hasContextOverride || hasOutputOverride ? "manual_override" : "provider_managed",
        // null means MuseInst is deliberately not inventing a number; the provider/model is authoritative.
        max_context_tokens: hasContextOverride ? effectiveModel.maxContext : null,
        max_output_tokens: hasOutputOverride ? effectiveModel.maxTokens : null,
        tools_enabled: effectiveModel.enableTools,
      };

      let mailboxRow: { address: string; domain: string; stranger_autoreply: number } | null = null;
      try {
        mailboxRow = await ctx.env.DB.prepare(
          `SELECT address, domain, stranger_autoreply FROM agent_mailboxes WHERE workspace_id=? AND status='active'`,
        )
          .bind(ctx.workspaceId)
          .first<{ address: string; domain: string; stranger_autoreply: number }>();
      } catch {
        mailboxRow = null;
      }

      const agentMailInfo = {
        configured: !!mailboxRow,
        address: mailboxRow?.address ?? null,
        domain: mailboxRow?.domain ?? null,
        stranger_autoreply: mailboxRow ? mailboxRow.stranger_autoreply === 1 : null,
      };

      const channelsInfo = {
        current_channel: ctx.channel,
        bindings: rawBindings.map((b) => ({
          channel: b.channel,
          display_name: b.display_name || undefined,
          is_current: b.channel === ctx.channel,
        })),
        agent_mail: agentMailInfo,
      };

      const runtimeInfo = {
        type: "self_hosted",
        name: "MuseInst Self-Hosted",
      };

      if (aspect === "model") {
        return { ok: true, data: { model: modelInfo } };
      }
      if (aspect === "channels") {
        return { ok: true, data: { channels: channelsInfo } };
      }
      if (aspect === "runtime") {
        return { ok: true, data: { edition: runtimeInfo } };
      }

      return {
        ok: true,
        data: {
          edition: runtimeInfo,
          model: modelInfo,
          channels: channelsInfo,
        },
      };
    } catch (e: any) {
      return { ok: false, error: `failed_to_get_self_info: ${e?.message ?? String(e)}` };
    }
  },
};
