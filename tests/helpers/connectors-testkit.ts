
import { createTestD1, d1All, d1Exec, d1Get, type TestD1 } from "./d1";
import { upsertConnectedAccount } from "../../src/connectors/token-store";
import type { Env } from "../../src/env";
import type { ProviderDef } from "../../src/connectors/registry";

export interface TestEnv extends Env { DB: any }

export function makeConnectorEnv(over: Record<string, unknown> = {}): TestEnv {
  const d1 = createTestD1();
  return {
    DB: d1,
    OPENINST_SECRET: "test-secret-key-0123456789",
    WECHAT_TOKEN_KEY: "",
    PUBLIC_BASE_URL: "https://app.example.com",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    ...over,
  } as any;
}

export async function count(env: TestEnv, sql: string, ...args: unknown[]): Promise<number> {
  const row = (await d1Get<Record<string, number>>(env.DB as unknown as TestD1, sql, ...args)) ?? {};
  return Number(Object.values(row)[0] ?? 0);
}

export async function rows<T = any>(env: TestEnv, sql: string, ...args: unknown[]): Promise<T[]> {
  return d1All<T>(env.DB as unknown as TestD1, sql, ...args);
}

export function exec(env: TestEnv, sql: string, ...args: unknown[]): void {
  d1Exec(env.DB as unknown as TestD1, sql, ...args);
}

export interface SeedToken {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  scope?: string;

  expiresAtOverride?: number | null;
  needsReauth?: number;
  createdAt?: number;
}


export async function seedConnection(env: TestEnv, ws: string, provider: string, label: string, tok: SeedToken): Promise<void> {
  await upsertConnectedAccount(env, ws, provider, label, {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    accessExpiresAt: tok.expiresAtOverride === undefined ? tok.accessExpiresAt : (tok.expiresAtOverride ?? undefined),
    refreshExpiresAt: tok.refreshExpiresAt,
    scope: tok.scope,
  }, label);
  if (tok.expiresAtOverride === null) {
    exec(env, "UPDATE connections SET expires_at=NULL WHERE workspace_id=? AND provider=? AND account_label=?", ws, provider, label);
  }
  if (tok.needsReauth != null) {
    exec(env, "UPDATE connections SET needs_reauth=? WHERE workspace_id=? AND provider=? AND account_label=?", tok.needsReauth, ws, provider, label);
  }
  if (tok.createdAt != null) {
    exec(env, "UPDATE connections SET created_at=? WHERE workspace_id=? AND provider=? AND account_label=?", tok.createdAt, ws, provider, label);
  }
  exec(env, "INSERT OR REPLACE INTO connector_slots(workspace_id, slot_key, provider, account_label, created_at) VALUES (?, ?, ?, ?, ?)", ws, `${provider === "mailbox" ? "mailbox" : "oauth:" + provider}:${label}`, provider, label, tok.createdAt ?? 1);
}

export interface FetchCall { url: string; method: string; headers: Record<string, string>; body: string }

export interface FetchMock {
  calls: FetchCall[];
  callsTo: (needle: string) => FetchCall[];
  restore: () => void;
}

export type FetchReply = { status?: number; json?: any; raw?: Response } | "network_error";





export function mockConnectorFetch(
  routes: Array<{ match: string | RegExp; reply: (url: string, init: any) => FetchReply }>,
): FetchMock {
  const g = globalThis as any;
  const orig = g.fetch;
  const calls: FetchCall[] = [];
  g.fetch = async (url: any, init: any = {}) => {
    const u = String(url);
    for (const r of routes) {
      const hit = typeof r.match === "string" ? u.includes(r.match) : r.match.test(u);
      if (!hit) continue;
      calls.push({
        url: u,
        method: String(init?.method ?? "GET").toUpperCase(),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? init.body : (init?.body == null ? "" : String(init.body)),
      });
      const res = r.reply(u, init);
      if (res === "network_error") throw new Error("mock_network_error");
      if (res.raw) return res.raw;
      return new Response(JSON.stringify(res.json ?? {}), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
    }
    return orig(url, init);
  };
  return {
    calls,
    callsTo: (needle: string) => calls.filter((c) => c.url.includes(needle)),
    restore: () => { g.fetch = orig; },
  };
}

export interface MockProvider extends ProviderDef {
  exchangeCalls: number;
  identifyCalls: number;
  revokeCalls: number;
  lastRevokeToken?: string;
}

export function makeMockProvider(over: Partial<ProviderDef> & { id?: ProviderDef["id"] } = {}, behavior: { exchange?: any; identify?: any; revoke?: any } = {}): MockProvider {
  const def: MockProvider = {
    id: (over.id ?? "google") as ProviderDef["id"],
    kind: over.kind ?? "multi",
    isProduction: () => true,
    configured: () => true,
    authorizeUrl: () => "https://provider.example/authorize",
    exchangeCode: async () => {
      def.exchangeCalls++;
      if (behavior.exchange === "throw") throw new Error("exchange_boom");
      return behavior.exchange ?? { accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: Date.now() + 3600_000 };
    },
    identifyAccount: async () => {
      def.identifyCalls++;
      return behavior.identify ?? { label: "user@example.com", displayName: "User" };
    },
    supportsRevoke: over.supportsRevoke ?? false,
    defaultScopes: "test",
    exchangeCalls: 0,
    identifyCalls: 0,
    revokeCalls: 0,
    ...over,
  };
  if (behavior.revoke) {
    def.revoke = async (_env, tok) => {
      def.revokeCalls++;
      def.lastRevokeToken = tok.refreshToken || tok.accessToken;
      return behavior.revoke;
    };
    def.supportsRevoke = over.supportsRevoke ?? true;
  }
  return def;
}

export function toolCtx(env: TestEnv, ws = "ws1", taskId?: string): any {
  return {
    env,
    workspaceId: ws,
    userId: "u1",
    channel: "web",
    lang: "zh",
    taskId,
    say: async () => {},
    hasActiveBrowserTask: () => false,
  };
}
