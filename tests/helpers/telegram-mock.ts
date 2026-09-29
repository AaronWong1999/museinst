

export interface TgCall {
  url: string;
  body?: any;
}

export interface TgMock {
  calls: TgCall[];
  restore: () => void;
}

export interface TgMockReply {
  status?: number;
  json?: any;

  raw?: Response;
}

export function mockTelegramFetch(
  handler: (url: string, body: any) => TgMockReply | "network_error",
): TgMock {
  const calls: TgCall[] = [];
  const g = globalThis as any;
  const orig = g.fetch;
  g.fetch = async (url: any, init?: any) => {
    const u = String(url);
    if (!u.includes("api.telegram.org")) return orig(url, init);
    let body: any = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ url: u, body });
    const res = handler(u, body);
    if (res === "network_error") throw new Error("network_error");
    if (res.raw) return res.raw;
    return new Response(JSON.stringify(res.json ?? { ok: true, result: {} }), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => (g.fetch = orig) };
}
