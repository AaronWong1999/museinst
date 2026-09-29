/**
 * core/capabilities.ts — Unified Capability Registry for MuseInst.
 *
 * Section 4.5 of OSS & Enterprise Architecture Plan:
 * Single authoritative source for whether a feature is both configured (enabled)
 * and operationally ready with required bindings/secrets (available).
 */

import type { Env } from "../env";
import { isFlagOn } from "../util";
import { telegramConfigured, wechatConfigured } from "../channels/config";
import { googleConfigured } from "../connectors/google";
import { githubConfigured } from "../connectors/github";
import { feishuConfigured, larkConfigured } from "../connectors/feishu";
import { githubAppConfigured } from "../connectors/github-app";

export interface CapabilityState {
  id: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
  publicConfig?: Record<string, unknown>;
}

export interface CapabilityContext {
  env: Env;
  workspaceId?: string;
}

export interface CapabilityResolver {
  id: string;
  resolve(context: CapabilityContext): Promise<CapabilityState> | CapabilityState;
}

const standardResolvers: Map<string, CapabilityResolver> = new Map();

export function registerCapabilityResolver(resolver: CapabilityResolver): void {
  standardResolvers.set(resolver.id, resolver);
}

// Built-in core resolvers
registerCapabilityResolver({
  id: "browser",
  resolve(ctx) {
    const hasBinding = !!ctx.env.BROWSER;
    const enabled = (ctx.env as any).BROWSER_DISABLED !== "1";
    return {
      id: "browser",
      enabled,
      available: hasBinding,
      reason: !hasBinding ? "Cloudflare BROWSER binding not attached" : undefined,
    };
  },
});

registerCapabilityResolver({
  id: "telegram",
  async resolve(ctx) {
    const configured = await telegramConfigured(ctx.env);
    return {
      id: "telegram",
      enabled: configured,
      available: configured,
      reason: !configured ? "Telegram bot token or webhook unconfigured" : undefined,
    };
  },
});

registerCapabilityResolver({
  id: "wechat",
  async resolve(ctx) {
    const configured = await wechatConfigured(ctx.env);
    return {
      id: "wechat",
      enabled: configured,
      available: configured,
      reason: !configured ? "WeChat channel unconfigured" : undefined,
    };
  },
});

registerCapabilityResolver({
  id: "agentMail",
  resolve(ctx) {
    const enabled = isFlagOn(ctx.env.AGENT_EMAIL_ENABLED);
    const available = enabled && !!ctx.env.DB;
    return {
      id: "agentMail",
      enabled,
      available,
      reason: !enabled ? "Agent mail disabled by flag" : undefined,
    };
  },
});

registerCapabilityResolver({
  id: "a2a",
  resolve(ctx) {
    const enabled = isFlagOn(ctx.env.A2A_ENABLED);
    return {
      id: "a2a",
      enabled,
      available: enabled,
      reason: !enabled ? "A2A disabled by flag" : undefined,
    };
  },
});

registerCapabilityResolver({
  id: "trustedPeople",
  resolve(ctx) {
    const enabled = isFlagOn(ctx.env.TRUSTED_PEOPLE_ENABLED);
    return {
      id: "trustedPeople",
      enabled,
      available: enabled,
      reason: !enabled ? "Trusted People disabled by flag" : undefined,
    };
  },
});

registerCapabilityResolver({
  id: "google",
  resolve(ctx) {
    const configured = googleConfigured(ctx.env);
    return {
      id: "google",
      enabled: configured,
      available: configured,
      reason: !configured ? "Google Client ID/secret unconfigured" : undefined,
      publicConfig: { configured },
    };
  },
});

registerCapabilityResolver({
  id: "github",
  resolve(ctx) {
    const oauth = githubConfigured(ctx.env);
    const app = githubAppConfigured(ctx.env);
    const configured = oauth || app;
    return {
      id: "github",
      enabled: configured,
      available: configured,
      reason: !configured ? "GitHub OAuth/App unconfigured" : undefined,
      publicConfig: { configured, mode: app ? "app" : oauth ? "oauth" : "none" },
    };
  },
});

registerCapabilityResolver({
  id: "feishu",
  resolve(ctx) {
    const configured = feishuConfigured(ctx.env);
    return {
      id: "feishu",
      enabled: configured,
      available: configured,
      reason: !configured ? "Feishu credentials unconfigured" : undefined,
      publicConfig: { configured },
    };
  },
});

registerCapabilityResolver({
  id: "lark",
  resolve(ctx) {
    const configured = larkConfigured(ctx.env);
    return {
      id: "lark",
      enabled: configured,
      available: configured,
      reason: !configured ? "Lark credentials unconfigured" : undefined,
      publicConfig: { configured },
    };
  },
});

registerCapabilityResolver({
  id: "customModels",
  resolve() {
    return {
      id: "customModels",
      enabled: true,
      available: true,
    };
  },
});

export const capabilityRegistry = {
  async resolve(id: string, context: CapabilityContext): Promise<CapabilityState> {
    const resolver = standardResolvers.get(id);
    if (!resolver) {
      return {
        id,
        enabled: false,
        available: false,
        reason: `Unknown capability ${id}`,
      };
    }
    return resolver.resolve(context);
  },

  async list(context: CapabilityContext): Promise<CapabilityState[]> {
    const list: CapabilityState[] = [];
    for (const resolver of standardResolvers.values()) {
      list.push(await resolver.resolve(context));
    }
    return list;
  },
};
