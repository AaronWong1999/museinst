import type { Env } from "../env";
import { decryptVaultPayload, encryptVaultPayload } from "../vault/service";
import { type CustomModelConfig, maxContextTokens } from "./call";

/**
 * Model presets are identity/UX metadata only. Capacity belongs to the provider/model,
 * so do not duplicate context/output limits here because those values change independently.
 * Optional never fields keep older callers type-compatible while guaranteeing that
 * presets cannot carry a product-authored capacity value.
 */
export interface CloudflareModelPreset {
  id: string;
  name: string;
  provider: "workers-ai";
  badge: string;
  description: string;
  maxContext?: never;
  maxTokens?: never;
}

export const CLOUDFLARE_PRESETS: CloudflareModelPreset[] = [
  {
    id: "@cf/zai-org/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    provider: "workers-ai",
    badge: "推荐",
    description: "超长上下文 · 强悍的工具调用与中文理解",
  },
  {
    id: "@cf/zai-org/glm-5.3",
    name: "GLM 5.3",
    provider: "workers-ai",
    badge: "旗舰",
    description: "更强的逻辑推理 · 适合多步操作与无头浏览器任务",
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    name: "Gemma 4",
    provider: "workers-ai",
    badge: "轻量",
    description: "Google 轻量高效架构 · 快速低延迟",
  },
];

export const DEFAULT_MODEL_CONFIG: CustomModelConfig = {
  provider: "workers-ai",
  model: "@cf/zai-org/glm-5.3-flash",
  name: "GLM 5.3 Flash (Workers AI)",
  limitsMode: "auto",
  enableTools: true,
};

const MODEL_SECRET_NAMESPACE = "model_provider";
const MODEL_SECRET_ID = "workspace_model_api_key";

function positiveFinite(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function loadWorkspaceModelApiKey(env: Env, workspaceId: string): Promise<string | undefined> {
  const row = await env.DB.prepare(
    `SELECT ciphertext FROM encrypted_secrets
       WHERE workspace_id=? AND namespace=? AND id=?`,
  )
    .bind(workspaceId, MODEL_SECRET_NAMESPACE, MODEL_SECRET_ID)
    .first<{ ciphertext: string }>();
  if (!row?.ciphertext) return undefined;
  try {
    const json = await decryptVaultPayload(env, workspaceId, MODEL_SECRET_ID, row.ciphertext);
    const parsed = JSON.parse(json) as { apiKey?: unknown };
    return typeof parsed.apiKey === "string" && parsed.apiKey.length > 0 ? parsed.apiKey : undefined;
  } catch (error) {
    console.error("Failed to decrypt workspace model credential:", error);
    return undefined;
  }
}

async function storeWorkspaceModelApiKey(env: Env, workspaceId: string, apiKey: string): Promise<void> {
  const ciphertext = await encryptVaultPayload(
    env,
    workspaceId,
    MODEL_SECRET_ID,
    JSON.stringify({ apiKey }),
  );
  await env.DB.prepare(
    `INSERT INTO encrypted_secrets (workspace_id, namespace, id, ciphertext, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, namespace, id)
     DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`,
  )
    .bind(workspaceId, MODEL_SECRET_NAMESPACE, MODEL_SECRET_ID, ciphertext, Date.now())
    .run();
}

async function deleteWorkspaceModelApiKey(env: Env, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM encrypted_secrets WHERE workspace_id=? AND namespace=? AND id=?`,
  )
    .bind(workspaceId, MODEL_SECRET_NAMESPACE, MODEL_SECRET_ID)
    .run();
}

/**
 * Existing rows written before provider-managed limits may contain guessed 4K/16K caps.
 * They are ignored unless the row explicitly marks limitsMode="manual".
 * Legacy rows may also contain a plaintext apiKey; it is migrated to encrypted storage on read.
 */
export async function getWorkspaceModelConfig(env: Env, workspaceId: string): Promise<CustomModelConfig> {
  if (!workspaceId) return { ...DEFAULT_MODEL_CONFIG };
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM settings WHERE workspace_id=? AND key='model_config'`,
    ).bind(workspaceId).first<{ value: string }>();

    if (row?.value) {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        let apiKey = await loadWorkspaceModelApiKey(env, workspaceId);
        const legacyApiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : undefined;
        if (legacyApiKey) {
          await storeWorkspaceModelApiKey(env, workspaceId, legacyApiKey);
          apiKey = legacyApiKey;
          delete parsed.apiKey;
          await env.DB.prepare(
            `UPDATE settings SET value=? WHERE workspace_id=? AND key='model_config'`,
          ).bind(JSON.stringify(parsed), workspaceId).run();
        }

        const limitsMode: "auto" | "manual" = parsed.limitsMode === "manual" ? "manual" : "auto";
        return {
          provider: parsed.provider === "custom" ? "custom" : "workers-ai",
          model: typeof parsed.model === "string" && parsed.model ? parsed.model : DEFAULT_MODEL_CONFIG.model,
          name: typeof parsed.name === "string" ? parsed.name : undefined,
          baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
          apiKey,
          protocol: parsed.protocol === "anthropic" ? "anthropic" : "chat_completions",
          limitsMode,
          ...(limitsMode === "manual"
            ? {
                maxContext: positiveFinite(parsed.maxContext),
                maxTokens: positiveFinite(parsed.maxTokens),
              }
            : {}),
          enableTools: parsed.enableTools !== false,
        };
      }
    }
  } catch (error) {
    console.error("Failed to load workspace model config:", error);
  }

  const fallbackModel = env.MODEL_ROOT || DEFAULT_MODEL_CONFIG.model;
  const operatorContextOverride = maxContextTokens(env);
  if (env.MODEL_PROVIDER === "openai") {
    return {
      provider: "custom",
      model: fallbackModel,
      name: fallbackModel,
      baseUrl: env.MODEL_BASE_URL,
      apiKey: env.MODEL_API_KEY,
      protocol: "chat_completions",
      limitsMode: Number.isFinite(operatorContextOverride) ? "manual" : "auto",
      ...(Number.isFinite(operatorContextOverride) ? { maxContext: operatorContextOverride } : {}),
      enableTools: true,
    };
  }

  return {
    provider: "workers-ai",
    model: fallbackModel,
    name: fallbackModel,
    limitsMode: Number.isFinite(operatorContextOverride) ? "manual" : "auto",
    ...(Number.isFinite(operatorContextOverride) ? { maxContext: operatorContextOverride } : {}),
    enableTools: true,
  };
}

export async function saveWorkspaceModelConfig(env: Env, workspaceId: string, config: CustomModelConfig): Promise<void> {
  const stored: CustomModelConfig = { ...config };
  const apiKey = typeof stored.apiKey === "string" ? stored.apiKey.trim() : "";
  delete stored.apiKey;

  if (stored.limitsMode !== "manual") {
    stored.limitsMode = "auto";
    delete stored.maxContext;
    delete stored.maxTokens;
    config.limitsMode = "auto";
    delete config.maxContext;
    delete config.maxTokens;
  } else {
    const maxContext = positiveFinite(stored.maxContext);
    const maxTokens = positiveFinite(stored.maxTokens);
    stored.maxContext = maxContext;
    stored.maxTokens = maxTokens;
    config.maxContext = maxContext;
    config.maxTokens = maxTokens;
  }

  await env.DB.prepare(
    `INSERT INTO settings (workspace_id, key, value) VALUES (?, 'model_config', ?)
     ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value`,
  ).bind(workspaceId, JSON.stringify(stored)).run();

  if (apiKey) {
    await storeWorkspaceModelApiKey(env, workspaceId, apiKey);
  } else if (stored.provider !== "custom") {
    await deleteWorkspaceModelApiKey(env, workspaceId);
  }
}
