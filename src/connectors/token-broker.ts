


import type { Env } from "../env";
import { DurableObject } from "cloudflare:workers";
import { refreshAndStore } from "./token-refresh";
import { tokenBrokerId } from "./account-label";
export { tokenBrokerId };
import type { AccessTokenResult } from "./types";

export class TokenBroker extends DurableObject<Env> {
  private inflight: Promise<AccessTokenResult> | null = null;
  declare env: Env;

  async fetch(req: Request): Promise<Response> {
    const body = await req.json() as { workspaceId: string; provider: string; accountLabel: string };
    if (this.inflight) return Response.json(await this.inflight);
    this.inflight = refreshAndStore(this.env, body.workspaceId, body.provider, body.accountLabel)
      .finally(() => { this.inflight = null; });
    return Response.json(await this.inflight);
  }
}

