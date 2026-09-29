


import type { Env } from "../env";
import type { ToolExternalAttachment } from "../external/result";

export interface ToolContext {
  env: Env;
  workspaceId: string;
  userId: string;
  channel: string;
  lang: "zh" | "en";

  taskId?: string;

  channelExternalId?: string;
  channelContextToken?: string;

  channelMessageId?: string;

  say(text: string): Promise<void>;

  hasActiveBrowserTask(): boolean;

  browserDelegations?: number;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;

  userNotice?: string;




  external?: ToolExternalAttachment;
}

export type ToolEffect = "read" | "write" | "local" | "external_send" | "destructive";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  needsApproval?: boolean;

  effect: ToolEffect;

  requiresApproval?: (args: Record<string, unknown>) => boolean;

  scheduledAllowed?: boolean;

  terminal?: boolean;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}
