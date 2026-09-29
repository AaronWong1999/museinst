


import type { Env } from "../env";
import { getHostHooks, type TaskContext } from "../hooks";
import { maxContextTokens } from "./call";
import { getWorkspaceModelConfig, CLOUDFLARE_PRESETS } from "./config";

export interface EffectiveModel {
  provider: "workers-ai" | "custom";
  id: string;
  name?: string;
  /** Infinity means provider-managed / unknown to this runtime, so no local context trimming is imposed. */
  maxContext: number;
  /** Undefined means provider-managed: callModel must omit its completion cap. */
  maxTokens?: number;
  enableTools: boolean;
  baseUrl?: string;
  apiKey?: string;
  protocol?: "chat_completions" | "anthropic";
}

export async function resolveEffectiveModel(
  env: Env,
  ctx: TaskContext,
  role: "root" | "worker" = "root",
): Promise<EffectiveModel> {
  const wsCfg = await getWorkspaceModelConfig(env, ctx.workspaceId);
  const hostOverride = await getHostHooks().resolveModel?.(env, ctx, role).catch(() => null);

  if (hostOverride) {
    const preset = CLOUDFLARE_PRESETS.find((p) => p.id === hostOverride);
    return {
      provider: preset?.provider ?? "workers-ai",
      id: hostOverride,
      name: preset?.name ?? hostOverride,
      // Hosted plan model overrides choose identity only. Capacity remains owned by the provider,
      // unless the deployment operator supplied an explicit MODEL_MAX_CONTEXT safety override.
      maxContext: maxContextTokens(env),
      maxTokens: undefined,
      enableTools: wsCfg.enableTools !== false,
    };
  }

  return {
    provider: wsCfg.provider,
    id: wsCfg.model,
    name: wsCfg.name ?? wsCfg.model,
    maxContext: wsCfg.maxContext ?? maxContextTokens(env),
    maxTokens: wsCfg.maxTokens,
    enableTools: wsCfg.enableTools !== false,
    baseUrl: wsCfg.baseUrl,
    apiKey: wsCfg.apiKey,
    protocol: wsCfg.protocol,
  };
}
