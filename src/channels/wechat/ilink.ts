


//



//


const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const APP_ID = "bot";

const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const BASE_INFO = { channel_version: "2.4.6", bot_agent: "openinst/1.0" };

function protocolCode(json: Record<string, unknown>): number {

  return Number(json.ret ?? json.errcode ?? 0);
}

export interface QrCodeResult {
  ok: true;
  qrcode: string;
  qrcodeImgContent: string;
}

export interface QrStatusResult {
  status: string;
  token?: string;
  identity?: Record<string, unknown>;
  raw: Record<string, unknown> | null;
}


function wechatUin(): string {
  return btoa(String(Math.floor(Math.random() * 0xffffffff)));
}

function ilinkHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": wechatUin(),
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ilinkFetch(
  method: "GET" | "POST",
  endpoint: string,
  opts: { body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetch(`${ILINK_BASE}/${endpoint}`, {
      method,
      headers: ilinkHeaders(opts.token),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctl.signal,
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}


export async function fetchLoginQrCode(): Promise<
  QrCodeResult | { ok: false; error: string; status: number }
> {
  const r = await ilinkFetch("POST", `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, {
    body: { local_token_list: [] },
  });
  const j = r.json;
  if (r.status !== 200 || !j) return { ok: false, error: "qrcode_http_error", status: r.status };
  if (typeof j.ret === "number" && j.ret !== 0)
    return { ok: false, error: `qrcode_ret_${j.ret}`, status: r.status };
  const qrcode = String(j.qrcode ?? "");
  const img = String(j.qrcode_img_content ?? j.qrcode_url ?? "");
  if (!qrcode || !img) return { ok: false, error: "qrcode_missing_fields", status: r.status };
  return { ok: true, qrcode, qrcodeImgContent: img };
}


export async function pollQrStatus(qrcode: string, timeoutMs = 20000): Promise<QrStatusResult> {
  try {
    const r = await ilinkFetch(
      "GET",
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { timeoutMs },
    );
    const j = (r.json?.data as Record<string, unknown>) ?? r.json ?? {};
    const status = String(
      (r.json?.status as string) ?? (j.status as string) ?? `http_${r.status}`,
    );
    const token = (j.token ?? j.bot_token) as string | undefined;
    const identity: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j)) {
      if (/user_id|uin|openid|unionid|ilink_user/i.test(k)) identity[k] = v;
    }
    return {
      status: token ? "confirmed" : status,
      token,
      identity: Object.keys(identity).length ? identity : undefined,
      raw: r.json,
    };
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return { status: "wait", raw: null };
    return { status: "error", raw: null };
  }
}


const DEAD_RET_CODES = new Set([-14, -1, -3, -4, 301, 302]);

export interface GetUpdatesResult {
  ok: boolean;
  messages: Array<Record<string, unknown>>;
  cursor: string;
  error?: string;
  dead?: boolean;
}





export async function ilinkGetUpdates(
  token: string,
  cursor: string,
  timeoutMs = 40000,
): Promise<GetUpdatesResult> {
  try {
    const r = await ilinkFetch("POST", "ilink/bot/getupdates", {
      token,
      timeoutMs,
      body: { get_updates_buf: cursor || "", base_info: BASE_INFO },
    });
    const j = r.json;
    if (!j) return { ok: false, messages: [], cursor, error: `http_${r.status}` };
    const ret = protocolCode(j);
    const successShape =
      !("errcode" in j) &&
      (j.ret === 0 || "get_updates_buf" in j || Array.isArray(j.msgs) || Array.isArray(j.msg_list));
    if (r.status < 200 || r.status >= 300 || ret !== 0 || !successShape) {
      return {
        ok: false,
        messages: [],
        cursor,
        error: `code_${Number.isFinite(ret) ? ret : "missing"}:${String(j.errmsg ?? "")}`,
        dead: DEAD_RET_CODES.has(ret),
      };
    }
    const msgs =
      (j.msgs as Array<Record<string, unknown>>) ??
      (j.msg_list as Array<Record<string, unknown>>) ??
      [];
    return { ok: true, messages: Array.isArray(msgs) ? msgs : [], cursor: String(j.get_updates_buf ?? cursor ?? "") };
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return { ok: true, messages: [], cursor };
    return { ok: false, messages: [], cursor, error: String(e) };
  }
}

export const MSG_TYPE_BOT = 2;
export const MSG_STATE_FINISH = 2;
export const ITEM_TYPE_TEXT = 1;





export async function ilinkSendMessage(
  token: string,
  opts: { toUserId: string; contextToken: string; text: string; clientId?: string },
): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
  try {
    const r = await ilinkFetch("POST", "ilink/bot/sendmessage", {
      token,
      timeoutMs: 15000,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: opts.toUserId,
          client_id: opts.clientId ?? `openinst-${crypto.randomUUID()}`,
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: opts.text } }],
          ...(opts.contextToken ? { context_token: opts.contextToken } : {}),
        },
        base_info: BASE_INFO,
      },
    });
    const ret = r.json ? protocolCode(r.json) : Number.NaN;
    return r.status >= 200 && r.status < 300 && ret === 0
      ? { ok: true }
      : {
          ok: false,
          error: `ret_${ret}:${String(r.json?.errmsg ?? "")}`,
          retryable:
            r.status === 429 || r.status >= 500 || (!DEAD_RET_CODES.has(ret) && ret !== -2),
        };
  } catch (e) {
    return { ok: false, error: String(e), retryable: true };
  }
}


export async function ilinkGetConfig(
  token: string,
  opts: { ilinkUserId: string; contextToken?: string },
): Promise<{ ok: boolean; typingTicket?: string }> {
  const r = await ilinkFetch("POST", "ilink/bot/getconfig", {
    token,
    timeoutMs: 10000,
    body: {
      ilink_user_id: opts.ilinkUserId,
      context_token: opts.contextToken ?? "",
      base_info: BASE_INFO,
    },
  });
  const j = r.json ?? {};
  const ticket =
    (j.typing_ticket as string) ??
    ((j.data as Record<string, unknown>)?.typing_ticket as string) ??
    ((j.config as Record<string, unknown>)?.typing_ticket as string);
  return { ok: protocolCode(j) === 0, typingTicket: ticket };
}

export async function ilinkSendTyping(
  token: string,
  opts: { ilinkUserId: string; typingTicket: string; status: 1 | 2 },
): Promise<{ ok: boolean }> {
  const r = await ilinkFetch("POST", "ilink/bot/sendtyping", {
    token,
    timeoutMs: 10000,
    body: {
      ilink_user_id: opts.ilinkUserId,
      typing_ticket: opts.typingTicket,
      status: opts.status,
      base_info: BASE_INFO,
    },
  });
  return { ok: r.json !== null && protocolCode(r.json) === 0 };
}

export function mapQrStatusToBotStatus(
  apiStatus: string,
): "pending" | "scanned" | "active" | "expired" {
  const s = apiStatus.toLowerCase();
  if (s === "confirmed" || s === "success") return "active";
  if (s.includes("scan")) return "scanned";
  if (s.includes("expire") || s.includes("timeout")) return "expired";
  return "pending";
}
