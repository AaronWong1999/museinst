// reliable-ingress.ts — platform facade for Email ingress (V2 §19).
// Model execution is handled asynchronously by Cloudflare Queue consumer, not ctx.waitUntil.

import type { Env } from "../../env";
import {
  handleInboundEmail as handleInboundEmailLegacy,
  type IngressResult,
} from "./ingress";

export { inboundFingerprint, APP_MAX_INBOUND_BYTES, readEmailMessage } from "./ingress";
export type { IngressResult } from "./ingress";

type InboundMessage = Parameters<typeof handleInboundEmailLegacy>[0];

/**
 * Platform-facing Email ingress facade.
 * Delegates to handleInboundEmailLegacy; does not block or wait for long model turns.
 */
export async function handleInboundEmail(
  message: InboundMessage,
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<IngressResult> {
  return await handleInboundEmailLegacy(message, env, ctx);
}
