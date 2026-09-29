
//



//



import type { Env } from "../env";
import { getHostHooks, type TaskContext } from "../hooks";
import { DEADLINE_BUDGETS_MS, DeadlineExceededError, fetchWithDeadline, withDeadline } from "../util/deadlines";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}


export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number };
}

/**
 * Local context safety override. Infinity means "provider managed": do not invent a model
 * window in the runtime. The provider remains the authority and will reject oversized input.
 */
export function maxContextTokens(env: Env): number {
  const v = Number(env.MODEL_MAX_CONTEXT);
  return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY;
}

export function roleModel(env: Env, role: "root" | "worker"): string {
  return role === "root" ? env.MODEL_ROOT : env.MODEL_WORKER;
}

/**
 * Provider transcript safety net.
 *
 * A resumed approval used to append a synthetic tool result ("USER_APPROVED") and then the
 * actual tool result with the same tool_call_id. OpenAI-style tool protocols expect exactly one
 * result per tool call; some providers reject the duplicate while others become confused and
 * call the same side-effect tool again. Keep only the last (authoritative) result for each id.
 *
 * This is deliberately provider-boundary normalization, so a stale Durable Object transcript
 * cannot poison every later model call. New orchestration code should still avoid creating the
 * duplicate in the first place.
 */
export function normalizeToolTranscript(messages: ModelMessage[]): ModelMessage[] {
  const lastToolResult = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && m.tool_call_id) lastToolResult.set(m.tool_call_id, i);
  }
  if (lastToolResult.size === 0) return messages;
  let changed = false;
  const normalized = messages.filter((m, i) => {
    if (m.role !== "tool" || !m.tool_call_id) return true;
    const keep = lastToolResult.get(m.tool_call_id) === i;
    if (!keep) changed = true;
    return keep;
  });
  return changed ? normalized : messages;
}















const RETRYABLE_AI_CODES = new Set([3046, 8005, 9000, 9502, 9503]);

export interface CustomModelConfig {
  provider: "workers-ai" | "custom";
  model: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  protocol?: "chat_completions" | "anthropic";
  /** auto = provider/model owns limits; manual = use explicitly supplied overrides. */
  limitsMode?: "auto" | "manual";
  maxContext?: number;
  maxTokens?: number;
  enableTools?: boolean;
}

export async function callModel(
  env: Env,
  role: "root" | "worker",
  messages: ModelMessage[],
  opts: { tools?: ToolDef[]; maxTokens?: number; temperature?: number; modelConfig?: CustomModelConfig; taskCtx?: TaskContext; timeoutMs?: number } = {},
): Promise<ModelResult> {
  const normalizedMessages = normalizeToolTranscript(messages);
  const attempts = 3;
  // The old implementation put one 60s deadline around the *whole* retry loop. A hung first
  // Workers AI request therefore consumed the entire budget and retries never happened. Give
  // each attempt its own quarantine boundary, plus a bounded total wall-clock budget.
  const attemptBudgetMs = opts.timeoutMs ?? DEADLINE_BUDGETS_MS.modelRequest;
  const totalBudgetMs = opts.timeoutMs !== undefined
    ? Math.max(attemptBudgetMs, Math.min(attemptBudgetMs * attempts + 2_500, 3 * 60_000))
    : Math.max(attemptBudgetMs, DEADLINE_BUDGETS_MS.foregroundTurn - 1_000);

  return withDeadline((async () => {
    let lastErr: unknown = new Error("model_retry_exhausted");
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await withDeadline(
          callModelOnce(env, role, normalizedMessages, opts),
          {
            operation: `model:${role}:attempt_${attempt + 1}`,
            budgetMs: attemptBudgetMs,
            onLateResult: () => {},
          },
        );
      } catch (e) {
        lastErr = e;
        const retryable = isRetryableModelError(e) || e instanceof DeadlineExceededError;
        if (!retryable || attempt === attempts - 1) throw e;
        const detail = String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 180);
        console.warn(`[model] retry role=${role} attempt=${attempt + 1}/${attempts} reason=${detail}`);
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 200));
      }
    }
    throw lastErr;
  })(), {
    operation: `model:${role}:total`,
    budgetMs: totalBudgetMs,
    onLateResult: () => {},
  });
}

/** Perform one provider request. Every provider/configuration path shares callModel's retry policy. */
async function callModelOnce(
  env: Env,
  role: "root" | "worker",
  messages: ModelMessage[],
  opts: { tools?: ToolDef[]; maxTokens?: number; temperature?: number; modelConfig?: CustomModelConfig; taskCtx?: TaskContext },
): Promise<ModelResult> {

  if (opts.modelConfig) {
    const cfg = opts.modelConfig;
    if (cfg.provider === "custom") {
      if (cfg.protocol === "anthropic") {
        return await callAnthropicMessages(cfg.baseUrl || "", cfg.apiKey || "", cfg.model, messages, opts);
      }
      return await callOpenAICompatible(env, cfg.model, messages, opts, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    }
    if (cfg.provider === "workers-ai" && cfg.model) {
      return await callWorkersAI(env, cfg.model, messages, opts);
    }
  }



  const ctx = opts.taskCtx ?? { workspaceId: "", channel: "" };
  const override = await getHostHooks().resolveModel?.(env, ctx, role);
  return env.MODEL_PROVIDER === "openai"
    ? await callOpenAICompatible(env, override ?? roleModel(env, role), messages, opts)
    : await callWorkersAI(env, override ?? roleModel(env, role), messages, opts);
}

function isRetryableModelError(error: unknown): boolean {


  const flagged = (error as { retryable?: unknown } | null)?.retryable;
  if (flagged === true) return true;
  if (flagged === false) return false;

  if ((error as Error)?.name === "DeadlineExceededError" || String(error).startsWith("DeadlineExceededError") || String(error).includes("deadline_exceeded")) return true;
  const message = String(error);
  return (
    /(?:model|anthropic)_http_(408|425|429|5\d\d)/i.test(message) ||
    /AiError\s*(?:3046|8005|9000|9502|9503)\b/i.test(message) ||
    /internal server error|overloaded|timeout|timed out|fetch failed|network/i.test(message)
  );
}


function assertWorkersAiBodyOk(resp: any): void {
  if (resp && typeof resp === "object" && resp.success === false) {
    const code = Number(resp.errors?.[0]?.code ?? 0);
    const message = String(resp.errors?.[0]?.message ?? "ai_error");
    const err = new Error(`AiError ${code} ${message}`.slice(0, 200));
    (err as any).retryable = RETRYABLE_AI_CODES.has(code) || /internal|overload|timeout/i.test(message);
    throw err;
  }
}

async function callWorkersAI(
  env: Env,
  model: string,
  messages: ModelMessage[],
  opts: { tools?: ToolDef[]; maxTokens?: number; temperature?: number },
): Promise<ModelResult> {

  const body: Record<string, unknown> = {
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    })),
    // Auto mode deliberately omits max_tokens. The selected model/provider owns the limit.
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),


    ...(opts.tools?.length
      ? { tools: opts.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
      : {}),
  };

  const resp = await (env.AI as any).run(model, body);
  assertWorkersAiBodyOk(resp);
  return normalizeWorkersAI(resp);
}

function normalizeWorkersAI(resp: any): ModelResult {


  const text: string =
    typeof resp?.response === "string"
      ? resp.response
      : resp?.choices?.[0]?.message?.content ?? "";
  const rawTools: any[] = resp?.tool_calls ?? resp?.choices?.[0]?.message?.tool_calls ?? [];
  const toolCalls: ToolCall[] = rawTools.map((tc, i) => {
    const argsRaw = tc?.arguments ?? tc?.function?.arguments ?? {};
    const args =
      typeof argsRaw === "string"
        ? safeParse(argsRaw)
        : (argsRaw as Record<string, unknown>);
    return {
      id: tc?.id ?? `call_${i}`,
      name: tc?.name ?? tc?.function?.name ?? "",
      args: args ?? {},
    };
  });
  const usage = resp?.usage
    ? {
        input: Number(resp.usage.prompt_tokens ?? 0),
        output: Number(resp.usage.completion_tokens ?? 0),
      }
    : undefined;
  return { text, toolCalls, usage };
}

export async function callOpenAICompatible(
  env: Env,
  model: string,
  messages: ModelMessage[],
  opts: { tools?: ToolDef[]; maxTokens?: number; temperature?: number; timeoutMs?: number },
  custom?: { baseUrl?: string; apiKey?: string },
): Promise<ModelResult> {
  const baseUrl = custom?.baseUrl || env.MODEL_BASE_URL;
  const apiKey = custom?.apiKey || env.MODEL_API_KEY;
  if (!baseUrl) throw new Error("MODEL_BASE_URL_required");
  const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const budgetMs = opts.timeoutMs ?? DEADLINE_BUDGETS_MS.modelRequest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
      // OpenAI-compatible providers do not expose one universal model-limit discovery contract.
      // Omitting max_tokens lets each selected model/provider apply its own supported behavior.
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools?.length ? { tools: opts.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new DeadlineExceededError("model:openai-compatible", budgetMs);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`model_http_${res.status}: ${await res.text().catch(() => "")}`.slice(0, 300));
  const j = (await res.json()) as any;
  if (j?.success === false) {

    const code = Number(j?.errors?.[0]?.code ?? 0);
    const message = String(j?.errors?.[0]?.message ?? "ai_error");
    const err = new Error(`AiError ${code} ${message}`.slice(0, 200));
    (err as any).retryable = RETRYABLE_AI_CODES.has(code) || /internal|overload|timeout/i.test(message);
    throw err;
  }
  const msg = j?.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map(
    (tc: any, i: number): ToolCall => ({
      id: tc?.id ?? `call_${i}`,
      name: tc?.function?.name ?? "",
      args: safeParse(tc?.function?.arguments ?? "{}"),
    }),
  );
  return {
    text: msg.content ?? "",
    toolCalls,
    usage: j?.usage
      ? { input: Number(j.usage.prompt_tokens ?? 0), output: Number(j.usage.completion_tokens ?? 0) }
      : undefined,
  };
}

export async function callAnthropicMessages(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ModelMessage[],
  opts: { tools?: ToolDef[]; maxTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<ModelResult> {
  if (!baseUrl) throw new Error("Anthropic_Base_URL_required");
  // Anthropic's Messages API requires max_tokens, so unlike OpenAI-compatible/Workers AI
  // there is no honest provider-managed omission path. Require an explicit manual override
  // instead of silently inventing a product-wide number.
  if (!(typeof opts.maxTokens === "number" && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0)) {
    throw new Error("anthropic_max_tokens_required: configure an explicit manual max output for this provider");
  }
  const endpoint = baseUrl.endsWith("/v1/messages") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/v1/messages`;

  let systemPrompt = "";
  const anthropicMessages: any[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
            : "";
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
    } else if (m.role === "user" || m.role === "assistant") {
      let content: any = m.content;
      if (Array.isArray(m.content)) {
        content = m.content.map((p) => {
          if (p.type === "text") return { type: "text", text: p.text };
          if (p.type === "image_url") {
            const url = p.image_url.url;
            const match = url.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
            if (match) {
              return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
            }
          }
          return { type: "text", text: "" };
        });
      }
      if (m.tool_calls && m.tool_calls.length) {
        const toolUseBlocks = m.tool_calls.map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeParse(tc.function.arguments || "{}"),
        }));
        content =
          typeof content === "string"
            ? [{ type: "text", text: content }, ...toolUseBlocks]
            : [...(content || []), ...toolUseBlocks];
      }
      anthropicMessages.push({ role: m.role, content: content || "" });
    } else if (m.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
          },
        ],
      });
    }
  }

  const anthropicTools = opts.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const res = await fetchWithDeadline(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: anthropicMessages,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
    }),
  }, { operation: "model:anthropic", budgetMs: opts.timeoutMs ?? DEADLINE_BUDGETS_MS.modelRequest });

  if (!res.ok) {
    throw new Error(`anthropic_http_${res.status}: ${await res.text().catch(() => "")}`.slice(0, 300));
  }

  const j = (await res.json()) as any;
  const contentBlocks = Array.isArray(j?.content) ? j.content : [];
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const block of contentBlocks) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input ?? {},
      });
    }
  }

  const usage = j?.usage
    ? { input: Number(j.usage.input_tokens ?? 0), output: Number(j.usage.output_tokens ?? 0) }
    : undefined;

  return { text, toolCalls, usage };
}

export async function testModelConnection(
  config: CustomModelConfig,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const testMessages: ModelMessage[] = [{ role: "user", content: "Hi" }];
    let res: ModelResult;
    if (config.protocol === "anthropic") {
      // Connection test is intentionally tiny and explicit; this is not a runtime model cap.
      res = await callAnthropicMessages(config.baseUrl || "", config.apiKey || "", config.model, testMessages, {
        maxTokens: 10,
      });
    } else {
      res = await callOpenAICompatible(
        {} as any,
        config.model,
        testMessages,
        { maxTokens: 10 },
        { baseUrl: config.baseUrl, apiKey: config.apiKey },
      );
    }
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - start, error: e.message || String(e) };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    return {};
  }
}




export function estimateTokens(content: ModelMessage["content"]): number {
  if (content == null) return 0;
  if (typeof content === "string") return Math.ceil(content.length / 3.2);
  let n = 0;
  for (const part of content) {
    if (part.type === "text") n += Math.ceil(part.text.length / 3.2);
    else n += 300;
  }
  return n;
}

export function totalTokens(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(m.content);
    for (const tc of m.tool_calls ?? []) n += estimateTokens(tc.function.arguments) + 8;
  }
  return n;
}






export function fitToBudget(messages: ModelMessage[], budget: number): { messages: ModelMessage[]; dropped: number } {
  if (!Number.isFinite(budget) || totalTokens(messages) <= budget * 0.85) return { messages, dropped: 0 };
  const head = messages[0]?.role === "system" ? [messages[0]] : [];
  const rest = messages[0]?.role === "system" ? messages.slice(1) : [...messages];
  let dropped = 0;
  while (rest.length > 2 && totalTokens([...head, ...rest]) > budget * 0.85) {

    const idx = rest.findIndex((m) => m.role !== "assistant" || !(m.tool_calls?.length));
    const removeAt = idx === -1 ? 0 : idx;
    rest.splice(removeAt, 1);
    dropped++;
  }
  return { messages: [...head, ...rest], dropped };
}
