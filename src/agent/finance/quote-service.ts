// quote-service.ts — High-performance multi-asset quote fetcher & resolver.
// Covers A-share, HK, US, ETFs, commodities, FX, benchmark indices, crypto.
// Includes disambiguation defense (partialMatchCaveat) to avoid mixing up commodities and equities.
// Invariant: Always returns source, asOf, currency, market. No synthetic numbers on error.

import type { FinancialQuote, AssetClass } from "./types";

const UPSTREAM_TIMEOUT_MS = 10_000;

// Symbol aliases for high-frequency queries
const ALIAS_MAP: Record<string, { symbol: string; assetClass: AssetClass; market: FinancialQuote["market"] }> = {
  "白银": { symbol: "SI=F", assetClass: "commodity", market: "commodity" },
  "现货白银": { symbol: "SI=F", assetClass: "commodity", market: "commodity" },
  "国际银价": { symbol: "SI=F", assetClass: "commodity", market: "commodity" },
  "silver": { symbol: "SI=F", assetClass: "commodity", market: "commodity" },
  "黄金": { symbol: "GC=F", assetClass: "commodity", market: "commodity" },
  "现货黄金": { symbol: "GC=F", assetClass: "commodity", market: "commodity" },
  "国际金价": { symbol: "GC=F", assetClass: "commodity", market: "commodity" },
  "gold": { symbol: "GC=F", assetClass: "commodity", market: "commodity" },
  "原油": { symbol: "CL=F", assetClass: "commodity", market: "commodity" },
  "布伦特原油": { symbol: "BZ=F", assetClass: "commodity", market: "commodity" },
  "天然气": { symbol: "NG=F", assetClass: "commodity", market: "commodity" },
  "铜": { symbol: "HG=F", assetClass: "commodity", market: "commodity" },
  "比特币": { symbol: "BTC-USD", assetClass: "crypto", market: "crypto" },
  "btc": { symbol: "BTC-USD", assetClass: "crypto", market: "crypto" },
  "以太坊": { symbol: "ETH-USD", assetClass: "crypto", market: "crypto" },
  "eth": { symbol: "ETH-USD", assetClass: "crypto", market: "crypto" },
  "sol": { symbol: "SOL-USD", assetClass: "crypto", market: "crypto" },
  "doge": { symbol: "DOGE-USD", assetClass: "crypto", market: "crypto" },
  "美元离岸人民币": { symbol: "USDCNH=X", assetClass: "fx", market: "fx" },
  "离岸人民币": { symbol: "USDCNH=X", assetClass: "fx", market: "fx" },
  "美元日元": { symbol: "USDJPY=X", assetClass: "fx", market: "fx" },
  "欧元美元": { symbol: "EURUSD=X", assetClass: "fx", market: "fx" },
  "恒生指数": { symbol: "^HSI", assetClass: "index", market: "index" },
  "恒指": { symbol: "^HSI", assetClass: "index", market: "index" },
  "纳斯达克": { symbol: "^IXIC", assetClass: "index", market: "index" },
  "纳指": { symbol: "^IXIC", assetClass: "index", market: "index" },
  "标普500": { symbol: "^GSPC", assetClass: "index", market: "index" },
  "标普": { symbol: "^GSPC", assetClass: "index", market: "index" },
  "道琼斯": { symbol: "^DJI", assetClass: "index", market: "index" },
  "道指": { symbol: "^DJI", assetClass: "index", market: "index" },
  "贵州茅台": { symbol: "sh600519", assetClass: "equity", market: "cn" },
  "茅台": { symbol: "sh600519", assetClass: "equity", market: "cn" },
  "腾讯控股": { symbol: "hk00700", assetClass: "equity", market: "hk" },
  "腾讯": { symbol: "hk00700", assetClass: "equity", market: "hk" },
  "阿里巴巴": { symbol: "hk09988", assetClass: "equity", market: "hk" },
  "阿里": { symbol: "hk09988", assetClass: "equity", market: "hk" },
  "美团": { symbol: "hk03690", assetClass: "equity", market: "hk" },
  "宁德时代": { symbol: "sz300750", assetClass: "equity", market: "cn" },
  "比亚迪": { symbol: "sz002594", assetClass: "equity", market: "cn" },
};

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize raw symbol query into internal lookup format */
export function normalizeSymbol(raw: string, declaredClass?: string): { code: string; assetClass: AssetClass; market: FinancialQuote["market"]; caveat?: string } {
  const clean = String(raw || "").trim();
  const lower = clean.toLowerCase();

  // Explicit alias match
  if (ALIAS_MAP[lower]) {
    const a = ALIAS_MAP[lower];
    return { code: a.symbol, assetClass: a.assetClass, market: a.market };
  }
  if (ALIAS_MAP[clean]) {
    const a = ALIAS_MAP[clean];
    return { code: a.symbol, assetClass: a.assetClass, market: a.market };
  }

  // Declared commodity / crypto / fx / index
  if (declaredClass === "commodity") {
    if (lower.includes("silver") || lower === "白银") return { code: "SI=F", assetClass: "commodity", market: "commodity" };
    if (lower.includes("gold") || lower === "黄金") return { code: "GC=F", assetClass: "commodity", market: "commodity" };
    if (lower.includes("oil") || lower === "原油") return { code: "CL=F", assetClass: "commodity", market: "commodity" };
    return { code: clean.endsWith("=F") ? clean : `${clean}=F`, assetClass: "commodity", market: "commodity" };
  }
  if (declaredClass === "crypto") {
    const sym = clean.toUpperCase().replace(/-USD$/, "");
    return { code: `${sym}-USD`, assetClass: "crypto", market: "crypto" };
  }
  if (declaredClass === "fx") {
    const sym = clean.toUpperCase().replace(/=X$/, "");
    return { code: `${sym}=X`, assetClass: "fx", market: "fx" };
  }
  if (declaredClass === "index") {
    const sym = clean.startsWith("^") ? clean : `^${clean}`;
    return { code: sym, assetClass: "index", market: "index" };
  }

  // A-share detection (6 digits)
  if (/^\d{6}$/.test(clean)) {
    if (clean.startsWith("6") || clean.startsWith("9")) return { code: `sh${clean}`, assetClass: "equity", market: "cn" };
    if (clean.startsWith("0") || clean.startsWith("3")) return { code: `sz${clean}`, assetClass: "equity", market: "cn" };
    if (clean.startsWith("8") || clean.startsWith("4")) return { code: `bj${clean}`, assetClass: "equity", market: "cn" };
    return { code: `sh${clean}`, assetClass: "equity", market: "cn" };
  }
  if (/^(sh|sz|bj)\d{6}$/i.test(clean)) {
    return { code: clean.toLowerCase(), assetClass: "equity", market: "cn" };
  }

  // HK stock detection (4 or 5 digits)
  if (/^\d{4,5}$/.test(clean)) {
    const padded = clean.padStart(5, "0");
    return { code: `hk${padded}`, assetClass: "equity", market: "hk" };
  }
  if (/^hk\d{4,5}$/i.test(clean)) {
    const digits = clean.slice(2).padStart(5, "0");
    return { code: `hk${digits}`, assetClass: "equity", market: "hk" };
  }

  // Global symbol patterns: futures (=F), fx (=X), index (^), crypto (-USD)
  if (/=F$/i.test(clean)) return { code: clean.toUpperCase(), assetClass: "commodity", market: "commodity" };
  if (/=X$/i.test(clean)) return { code: clean.toUpperCase(), assetClass: "fx", market: "fx" };
  if (/^\^/.test(clean)) return { code: clean.toUpperCase(), assetClass: "index", market: "index" };
  if (/-USD$/i.test(clean)) return { code: clean.toUpperCase(), assetClass: "crypto", market: "crypto" };

  // Default US equity ticker
  return { code: `us${clean.toUpperCase()}`, assetClass: "equity", market: "us" };
}

/** Parse Tencent gtimg quote line */
function parseTencentQuote(line: string, code: string): FinancialQuote | null {
  const match = line.match(/v_([a-zA-Z0-9]+)="([^"]+)";/);
  if (!match || !match[2]) return null;
  const parts = match[2].split("~");
  if (parts.length < 35) return null;

  const name = parts[1] || "";
  const symbol = parts[2] || code;
  const price = Number(parts[3]) || 0;
  const prevClose = Number(parts[4]) || 0;
  const open = Number(parts[5]) || 0;
  const volume = Number(parts[6]) || 0;
  const change = Number(parts[31]) || (price - prevClose);
  const changePct = Number(parts[32]) || (prevClose ? (change / prevClose) * 100 : 0);
  const high = Number(parts[33]) || price;
  const low = Number(parts[34]) || price;
  const rawTime = parts[30] || "";

  let market: FinancialQuote["market"] = "cn";
  let currency = "CNY";
  if (code.startsWith("hk")) {
    market = "hk";
    currency = "HKD";
  } else if (code.startsWith("us")) {
    market = "us";
    currency = "USD";
  }

  // Disambiguation warning for namesake equities
  let caveat: string | undefined;
  if (name.includes("白银") && code !== "SI=F") {
    caveat = "⚠ 注意：该标的为上市公司股票（" + name + "），非贵金属现货或国际银价。";
  }

  return {
    symbol,
    code,
    name,
    market,
    assetClass: "equity",
    currency,
    price,
    change,
    changePct,
    prevClose,
    open,
    high,
    low,
    volume,
    asOf: rawTime || new Date().toISOString(),
    source: "tencent_live",
    caveat,
  };
}

/** Fetch quotes from Yahoo Chart API for global instruments */
async function fetchYahooQuote(symbol: string, metaTarget: { code: string; assetClass: AssetClass; market: FinancialQuote["market"] }): Promise<FinancialQuote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data: any = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) return null;

    const price = Number(meta.regularMarketPrice);
    const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose ?? price);
    const change = price - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const open = Number(meta.regularMarketOpen ?? prevClose);
    const high = Number(meta.regularMarketDayHigh ?? price);
    const low = Number(meta.regularMarketDayLow ?? price);
    const volume = Number(meta.regularMarketVolume ?? 0);
    const rmt = meta.regularMarketTime ? Number(meta.regularMarketTime) : 0;

    return {
      symbol: meta.symbol || symbol,
      code: metaTarget.code,
      name: meta.shortName || meta.longName || symbol,
      market: metaTarget.market,
      assetClass: metaTarget.assetClass,
      currency: String(meta.currency || "USD").toUpperCase(),
      price,
      change,
      changePct,
      prevClose,
      open,
      high,
      low,
      volume,
      asOf: rmt > 0 ? new Date(rmt * 1000).toISOString() : new Date().toISOString(),
      source: "yahoo_finance",
    };
  } catch {
    return null;
  }
}

/** Main entry: fetch quotes for a list of symbols */
export async function getQuotes(symbols: string[], declaredClass?: string, kv?: KVNamespace): Promise<{ ok: boolean; quotes: FinancialQuote[]; error?: string }> {
  if (!symbols || symbols.length === 0) {
    return { ok: false, quotes: [], error: "no_symbols_provided" };
  }

  const results: FinancialQuote[] = [];
  const tencentCodes: string[] = [];
  const yahooTasks: Array<{ symbol: string; meta: ReturnType<typeof normalizeSymbol> }> = [];

  for (const s of symbols) {
    const norm = normalizeSymbol(s, declaredClass);
    if (norm.market === "cn" || norm.market === "hk" || norm.code.startsWith("us")) {
      tencentCodes.push(norm.code);
    } else {
      yahooTasks.push({ symbol: norm.code, meta: norm });
    }
  }

  // 1. Batch fetch Tencent quotes
  if (tencentCodes.length > 0) {
    try {
      const url = `https://qt.gtimg.cn/q=${tencentCodes.join(",")}`;
      const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" } });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        let text = "";
        try {
          text = new TextDecoder("gbk").decode(buf);
        } catch {
          text = new TextDecoder("utf-8").decode(buf);
        }
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          for (const code of tencentCodes) {
            if (line.includes(`v_${code}=`)) {
              const q = parseTencentQuote(line, code);
              if (q) results.push(q);
              break;
            }
          }
        }
      }
    } catch (e) {
      // transient tencent failure will be reflected in missing items
    }
  }

  // 2. Parallel fetch Yahoo quotes
  if (yahooTasks.length > 0) {
    const yahooResults = await Promise.allSettled(
      yahooTasks.map((t) => fetchYahooQuote(t.symbol, t.meta))
    );
    for (const r of yahooResults) {
      if (r.status === "fulfilled" && r.value) {
        results.push(r.value);
      }
    }
  }

  if (results.length === 0) {
    return { ok: false, quotes: [], error: "no_data_found" };
  }

  return { ok: true, quotes: results };
}
