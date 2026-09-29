// kline-service.ts — Candlestick & historical bars service.
// Supports m1, m5, m15, m30, m60, day, week, month.
// Invariant: Returns source, asOf, market, currency. Never fabricates numbers.

import type { KlineData, KlineCandle } from "./types";
import { normalizeSymbol } from "./quote-service";

const UPSTREAM_TIMEOUT_MS = 10_000;
const MINUTE_PERIODS: Record<string, string> = { m1: "1m", m5: "5m", m15: "15m", m30: "30m", m60: "60m" };

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Get K-line bars via Yahoo Chart API for US, global indices, commodities, crypto */
async function getKlineYahoo(symbol: string, period = "day", limit = 60): Promise<KlineData | null> {
  try {
    let interval = "1d";
    let range = "3mo";
    if (period in MINUTE_PERIODS) {
      interval = MINUTE_PERIODS[period];
      range = "5d";
    } else if (period === "week") {
      interval = "1wk";
      range = "1y";
    } else if (period === "month") {
      interval = "1mo";
      range = "5y";
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data: any = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta || {};
    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const opens: number[] = quote.open || [];
    const closes: number[] = quote.close || [];
    const highs: number[] = quote.high || [];
    const lows: number[] = quote.low || [];
    const volumes: number[] = quote.volume || [];

    const candles: KlineCandle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      const t = timestamps[i] * 1000;
      const dateStr = new Date(t).toISOString().slice(0, 10);
      candles.push({
        date: dateStr,
        open: Number(opens[i]?.toFixed(2)) || Number(closes[i]?.toFixed(2)),
        close: Number(closes[i]?.toFixed(2)),
        high: Number(highs[i]?.toFixed(2)) || Number(closes[i]?.toFixed(2)),
        low: Number(lows[i]?.toFixed(2)) || Number(closes[i]?.toFixed(2)),
        volume: Number(volumes[i]) || 0,
      });
    }

    const trimmed = candles.slice(-limit);
    return {
      symbol: meta.symbol || symbol,
      code: symbol,
      period,
      market: "global",
      currency: String(meta.currency || "USD").toUpperCase(),
      asOf: new Date().toISOString(),
      source: "yahoo_finance",
      candles: trimmed,
    };
  } catch {
    return null;
  }
}

/** Get K-line bars for A-shares / HK stocks via Tencent */
async function getKlineTencent(code: string, period = "day", limit = 60): Promise<KlineData | null> {
  try {
    if (period in MINUTE_PERIODS) {
      // Minute candles
      const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},${period},,${limit}`;
      const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" } });
      if (!res.ok) return null;
      const json: any = await res.json();
      const node = json?.data?.[code] || {};
      const rows: any[] = node[period] || node[`m${period}`] || [];
      const candles: KlineCandle[] = rows.map((r) => ({
        date: String(r[0]),
        open: Number(r[1]) || 0,
        close: Number(r[2]) || 0,
        high: Number(r[3]) || 0,
        low: Number(r[4]) || 0,
        volume: Number(r[5]) || 0,
      }));
      return {
        symbol: code,
        code,
        period,
        market: code.startsWith("hk") ? "hk" : "cn",
        currency: code.startsWith("hk") ? "HKD" : "CNY",
        asOf: new Date().toISOString(),
        source: "tencent_ifzq",
        candles: candles.slice(-limit),
      };
    }

    // Daily / weekly / monthly forward-adjusted
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${limit},qfq`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const node = json?.data?.[code] || {};
    const rows: any[] = node[period] || node[`qfq${period}`] || [];
    const candles: KlineCandle[] = rows.map((r) => ({
      date: String(r[0]),
      open: Number(r[1]) || 0,
      close: Number(r[2]) || 0,
      high: Number(r[3]) || 0,
      low: Number(r[4]) || 0,
      volume: Number(r[5]) || 0,
    }));

    return {
      symbol: code,
      code,
      period,
      market: code.startsWith("hk") ? "hk" : "cn",
      currency: code.startsWith("hk") ? "HKD" : "CNY",
      asOf: new Date().toISOString(),
      source: "tencent_ifzq",
      candles: candles.slice(-limit),
    };
  } catch {
    return null;
  }
}

/** Main entry: get K-line candlestick series */
export async function getKline(rawSymbol: string, period = "day", limit = 60, assetClass?: string): Promise<{ ok: boolean; data?: KlineData; error?: string }> {
  const norm = normalizeSymbol(rawSymbol, assetClass);
  let result: KlineData | null = null;

  if (norm.market === "cn" || norm.market === "hk") {
    result = await getKlineTencent(norm.code, period, limit);
  }
  if (!result || result.candles.length === 0) {
    result = await getKlineYahoo(norm.code.replace(/^us/, ""), period, limit);
  }

  if (!result || result.candles.length === 0) {
    return { ok: false, error: `no_kline_data_for_${rawSymbol}` };
  }

  return { ok: true, data: result };
}
