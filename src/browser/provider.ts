//
// Capability-driven Cloudflare Live View provider (spec §14.10, §29).
//
// Cloudflare Browser Rendering behavior verified during provider integration:
//  - readonlyView: PROVEN via REST `devtools/browser/{sessionId}/live_view`
//    with `guardrails:{mode:"readonly"}` — the provider rejects all write
//    commands server-side (-32601) while reads (screenshots) succeed.
//  - interactiveView: PROVEN — the same endpoint without guardrails executes
//    writes; read + write connections coexist (§14.5 watch semantics).
//  - structuredHandoff / revokeInteractiveView: ABSENT in the provider
//    (404) — recorded false; takeover uses the kernel's parked browser_input
//    turn and revocation relies on the short connect TTL (min 60s, enforced)
//    plus the app-level lease.
//  - The provider does NOT validate targetId — this adapter must only mint
//    URLs for targets observed via CDP (caller contract) and clamps TTLs.
//
// The REST credential is the §24.2 server-side secret (BROWSER_API_TOKEN):
// least-privilege, account-scoped, never in HTML/cards/grants/logs. Without
// the secret every capability is false — capabilities never guess from
// edition names.
//

export interface BrowserProviderCapabilities {
  readonlyView: boolean;
  interactiveView: boolean;
  structuredHandoff: boolean;
  recording: boolean;
  revokeInteractiveView: boolean;
  readonlySurface: "binding" | "rest" | "unavailable";
}

export interface ViewInput {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  targetId: string;
  connectBeforeMs: number;
}

export interface ProviderView {
  providerViewUrl: string;
  sessionId: string;
  targetId: string;
  connectExpiresAt: number;
  access: "readonly" | "interactive";
  viewRef?: string;
}

export interface HandoffRef {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  targetId: string;
  handoffId: string;
  controlEpoch: number;
}

const MIN_TTL_MS = 60_000; // provider-rejected below this (400, proven in C0)
const MAX_TTL_MS = 30 * 60_000;

export class RestBrowserLiveViewProvider {
  private readonly apiBase: string;
  private readonly accountId: string;
  private readonly apiToken: string | undefined;
  private readonly nowFn: () => number;

  constructor(opts: { accountId: string; apiToken?: string; apiBase?: string; now?: () => number }) {
    this.accountId = opts.accountId;
    this.apiToken = opts.apiToken;
    this.apiBase = opts.apiBase || "https://api.cloudflare.com/client/v4";
    this.nowFn = opts.now ?? Date.now;
  }

  capabilities(): Promise<BrowserProviderCapabilities> {
    const configured = !!this.apiToken && !!this.accountId;
    // C0-proven facts, gated on the §24.2 credential being configured.
    return Promise.resolve({
      readonlyView: configured,
      interactiveView: configured,
      structuredHandoff: false, // provider has no handoff API (C0 evidence)
      recording: false, // P1, untested
      revokeInteractiveView: false, // provider has no revoke (C0 evidence)
      readonlySurface: configured ? "rest" : "unavailable",
    });
  }

  private clampTtl(connectBeforeMs: number): { ttl: number; expiresAt: number } {
    const remaining = Math.max(1000, connectBeforeMs - this.nowFn());
    const ttl = Math.min(Math.max(remaining, MIN_TTL_MS), MAX_TTL_MS);
    return { ttl, expiresAt: this.nowFn() + ttl };
  }

  private async createView(input: ViewInput, guardrails: { mode: "readonly" } | undefined): Promise<ProviderView> {
    if (!this.apiToken) throw new Error("browser_token_not_configured");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(input.sessionId)) throw new Error("session_id_invalid");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(input.targetId)) throw new Error("target_id_invalid");
    const { ttl, expiresAt } = this.clampTtl(input.connectBeforeMs);
    const res = await fetch(
      `${this.apiBase}/accounts/${encodeURIComponent(this.accountId)}/browser-rendering/devtools/browser/${encodeURIComponent(input.sessionId)}/live_view`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ targetId: input.targetId, mode: "tab", expiresInMs: ttl, ...(guardrails ? { guardrails } : {}) }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      webSocketDebuggerUrl?: string;
      devtoolsFrontendUrl?: string;
      id?: string;
      errors?: Array<{ code?: number | string; message?: string }>;
    };
    if (!res.ok || !body.webSocketDebuggerUrl) {
      const code = body.errors?.[0]?.code;
      const message = body.errors?.[0]?.message || `http_${res.status}`;
      // Provider errors are normalized; raw provider bodies are not forwarded.
      if (res.status === 401 || res.status === 403) throw new Error("browser_token_rejected");
      if (res.status === 429) throw new Error("browser_rate_limited");
      throw new Error(`live_view_failed: ${code ?? res.status}: ${String(message).slice(0, 120)}`);
    }
    const access: "readonly" | "interactive" = guardrails ? "readonly" : "interactive";
    return {
      providerViewUrl: String(body.devtoolsFrontendUrl || body.webSocketDebuggerUrl),
      sessionId: input.sessionId,
      targetId: input.targetId,
      connectExpiresAt: expiresAt,
      access,
      viewRef: String(body.id || input.targetId),
    };
  }

  createReadonlyView(input: ViewInput): Promise<ProviderView> {
    return this.createView(input, { mode: "readonly" });
  }

  createInteractiveView(
    input: ViewInput & { handoff: HandoffRef },
  ): Promise<ProviderView> {
    // Caller contract (§14.10): a control lease exists and the agent is frozen
    // before an interactive URL is minted. The provider cannot revoke, so the
    // interactive TTL stays short (connect window) — enforced here.
    return this.createView({ ...input, connectBeforeMs: Math.min(input.connectBeforeMs, this.nowFn() + MAX_TTL_MS) }, undefined);
  }

  async beginHandoff(): Promise<HandoffRef> {
    throw new Error("structured_handoff_unavailable");
  }

  async getHandoffState(): Promise<{ active: boolean; outcome?: "success" | "failed" | "timeout" | "cancelled" }> {
    return { active: false };
  }

  async subscribeHandoff(
    _input: unknown,
    _onEvent: (event: { handoffId: string; success: boolean; reason?: string }) => Promise<void>,
  ): Promise<() => void> {
    throw new Error("structured_handoff_unavailable");
  }
}
