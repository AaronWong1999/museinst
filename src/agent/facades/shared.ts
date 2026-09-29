import type { Tool, ToolContext, ToolResult } from "../tool-types";
import { resolveProvider } from "../provider-resolver";
import { listAccounts } from "../../connectors/token-store";

export type FacadeLookup = (name: string, ctx: ToolContext) => Tool | undefined;

export const str = (description: string) => ({ type: "string", description });
export const int = (description: string) => ({ type: "integer", description });
export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
export const actionEnum = (values: string[], description: string) => ({ type: "string", enum: values, description });
export const providerHint = {
  type: "string",
  enum: ["google", "lark", "feishu", "github", "mailbox"],
  description: "通常不要填写。只有用户明确指定服务商时才填；否则由运行时根据已连接账号和资源归属选择。",
};
export const accountHint = { type: "string", description: "账号 label（可选；仅多账号且需要精确选择时填写）" };

export function withoutAction(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  delete out.action;
  return out;
}

export function approvalFor(actions: string[]) {
  const set = new Set(actions);
  return (args: Record<string, unknown>) => set.has(String(args.action ?? ""));
}

export async function runFirst(
  lookup: FacadeLookup,
  names: string[],
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  for (const name of names) {
    const tool = lookup(name, ctx);
    if (tool) return tool.run(ctx, args);
  }
  return { ok: false, error: `（该能力当前部署未提供可执行实现：${names.join(" / ")}）` };
}

export async function chooseProvider(
  ctx: ToolContext,
  args: Record<string, unknown>,
  candidates: string[],
  resourceRef?: string,
): Promise<{ ok: true; provider: string } | { ok: false; error: string }> {
  const capable: string[] = [];
  for (const provider of candidates) {
    try {
      const rows = await listAccounts(ctx.env, ctx.workspaceId, provider);
      if (rows.some((r) => r.needs_reauth !== 1)) capable.push(provider);
    } catch {
      // Unsupported/missing connector table means this provider is not currently capable.
    }
  }
  const resolved = resolveProvider({
    explicitProvider: args.provider ? String(args.provider) : undefined,
    resourceRef,
    connectedCapableProviders: capable,
    accountLabel: args.account ? String(args.account) : undefined,
  });
  if (resolved.ok) return resolved;
  if (resolved.error === "provider_ambiguous") {
    return { ok: false, error: `（有多个已连接服务都能完成该操作：${resolved.choices.join("、")}。请让用户明确选择一次服务商。）` };
  }
  return { ok: false, error: "（没有已连接且支持该能力的服务。请先在 Workspace 中连接对应服务。）" };
}
