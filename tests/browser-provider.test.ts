//
// C1 provider adapter tests (spec §14.10): capability gating on the §24.2
// credential, readonly/interactive view minting, TTL clamping, error
// normalization, and the recorded absent capabilities (handoff/revoke).
//
import assert from "node:assert/strict";
import { RestBrowserLiveViewProvider } from "../src/browser/provider";

console.log("▶ Browser Live View provider adapter");

const NOW = 1_000_000_000_000;
function makeProvider(opts: { token?: string; respond?: (url: string, init: any) => { status: number; body: unknown } }) {
  const calls: Array<{ url: string; init: any }> = [];
  const provider = new RestBrowserLiveViewProvider({
    accountId: "acc123",
    apiToken: opts.token,
    apiBase: "https://api.test/client/v4",
    now: () => NOW,
  });
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const r = opts.respond?.(url, init) ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  return {
    provider,
    calls,
    restore() { (globalThis as any).fetch = realFetch; },
  };
}

const viewInput = {
  workspaceId: "ws1",
  taskId: "t1",
  sessionId: "624e2202-0b29-4023-b509-97b956fb55cd",
  targetId: "90AD1A631CF95CB728060533FF88CCFB",
  connectBeforeMs: NOW + 5 * 60_000,
};

{
  console.log("  [1] capabilities default to false without the §24.2 credential");
  const { provider, restore } = makeProvider({});
  const caps = await provider.capabilities();
  assert.equal(caps.readonlyView, false);
  assert.equal(caps.interactiveView, false);
  assert.equal(caps.structuredHandoff, false);
  assert.equal(caps.revokeInteractiveView, false);
  assert.equal(caps.readonlySurface, "unavailable");
  await assert.rejects(() => provider.createReadonlyView(viewInput), /browser_token_not_configured/);
  restore();
}

{
  console.log("  [2] readonly view: guardrails minted, TTL clamped to provider min, URL returned");
  const { provider, calls, restore } = makeProvider({
    token: "tok",
    respond: () => ({ status: 200, body: { webSocketDebuggerUrl: "wss://live/browser/1", devtoolsFrontendUrl: "https://live/ui/view?1", id: "target1" } }),
  });
  const view = await provider.createReadonlyView({ ...viewInput, connectBeforeMs: NOW + 5_000 });
  assert.equal(view.access, "readonly");
  assert.equal(view.providerViewUrl, "https://live/ui/view?1");
  assert.equal(view.connectExpiresAt, NOW + 60_000, "TTL clamped to the provider minimum (60s)");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.guardrails.mode, "readonly");
  assert.equal(sent.mode, "tab");
  assert.equal(sent.expiresInMs, 60_000);
  assert.ok(calls[0].url.includes("/accounts/acc123/browser-rendering/devtools/browser/624e2202-0b29-4023-b509-97b956fb55cd/live_view"));
  assert.ok(!calls[0].init.body.includes("tok"), "token never appears in any body");
  restore();
}

{
  console.log("  [3] interactive view: no guardrails, short connect window");
  const { provider, calls, restore } = makeProvider({
    token: "tok",
    respond: () => ({ status: 200, body: { webSocketDebuggerUrl: "wss://live/browser/2", id: "target1" } }),
  });
  const view = await provider.createInteractiveView({
    ...viewInput,
    connectBeforeMs: NOW + 60 * 60_000,
    handoff: { workspaceId: "ws1", taskId: "t1", sessionId: viewInput.sessionId, targetId: viewInput.targetId, handoffId: "h1", controlEpoch: 1 },
  });
  assert.equal(view.access, "interactive");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.guardrails, undefined, "interactive mints without guardrails");
  assert.equal(sent.expiresInMs, 30 * 60_000, "interactive TTL capped at 30 minutes (no provider revoke)");
  restore();
}

{
  console.log("  [4] provider errors are normalized, raw bodies never forwarded");
  const { provider, restore } = makeProvider({
    token: "tok",
    respond: () => ({ status: 401, body: { errors: [{ code: 10000, message: "Authentication error" }] } }),
  });
  await assert.rejects(() => provider.createReadonlyView(viewInput), /browser_token_rejected/);
  restore();
}

{
  console.log("  [5] handoff capabilities are honestly absent");
  const { provider, restore } = makeProvider({ token: "tok" });
  await assert.rejects(() => provider.beginHandoff(), /structured_handoff_unavailable/);
  await assert.rejects(() => provider.subscribeHandoff({}, async () => {}), /structured_handoff_unavailable/);
  assert.deepEqual(await provider.getHandoffState(), { active: false });
  restore();
}

{
  console.log("  [6] malformed session/target ids are rejected before any call");
  const { provider, calls, restore } = makeProvider({ token: "tok" });
  await assert.rejects(
    () => provider.createReadonlyView({ ...viewInput, sessionId: "bad id; drop table" }),
    /session_id_invalid/,
  );
  await assert.rejects(
    () => provider.createReadonlyView({ ...viewInput, targetId: "x" }),
    /target_id_invalid/,
  );
  assert.equal(calls.length, 0);
  restore();
}

console.log("✅ browser-provider passed");
