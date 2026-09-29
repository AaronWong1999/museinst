// profile-service.ts — Financial profile and fundamentals service.
// Unifies A-share, HK, and US equities valuation, profitability, and consensus.
// Invariant: Always returns source, asOf, market, currency. No fabricated numbers.

import type { StockProfile } from "./types";
import { normalizeSymbol } from "./quote-service";

const UPSTREAM_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Get A-share company profile from Eastmoney Datacenter */
async function getAshareProfile(code: string): Promise<StockProfile | null> {
  const rawCode = code.replace(/^(sh|sz|bj)/i, "");
  try {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=(SECURITY_CODE%3D%22${rawCode}%22)&pageNumber=1&pageSize=1&sortColumns=REPORTDATE&sortTypes=-1`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const row = json.result?.data?.[0];
    if (!row) return null;

    return {
      symbol: rawCode,
      code,
      name: row.SECURITY_NAME_ABBR || rawCode,
      market: "cn",
      currency: "CNY",
      asOf: row.REPORTDATE ? String(row.REPORTDATE).slice(0, 10) : new Date().toISOString().slice(0, 10),
      source: "eastmoney_datacenter",
      eps: Number(row.BASIC_EPS) || undefined,
      roe: Number(row.WEIGHTED_ROE) || undefined,
      grossMarginPct: Number(row.GROSS_MARGIN) || undefined,
      netMarginPct: Number(row.NET_MARGIN) || undefined,
      revenueGrowthPct: Number(row.OPERATE_INCOME_YOY) || undefined,
      profitGrowthPct: Number(row.PARENT_NETPROFIT_YOY) || undefined,
    };
  } catch {
    return null;
  }
}

/** Get HK company profile from Eastmoney Datacenter */
async function getHkProfile(code: string): Promise<StockProfile | null> {
  const rawCode = code.replace(/^hk/i, "");
  try {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL&filter=(SECURITY_CODE%3D%22${rawCode}%22)&pageNumber=1&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const row = json.result?.data?.[0];
    if (!row) return null;

    return {
      symbol: rawCode,
      code,
      name: row.SECURITY_NAME_ABBR || rawCode,
      market: "hk",
      currency: "HKD",
      asOf: row.REPORT_DATE ? String(row.REPORT_DATE).slice(0, 10) : new Date().toISOString().slice(0, 10),
      source: "eastmoney_datacenter",
      eps: Number(row.BASIC_EPS) || undefined,
      roe: Number(row.ROE_AVG) || undefined,
      revenueGrowthPct: Number(row.OPERATE_INCOME_YOY) || undefined,
      profitGrowthPct: Number(row.NETPROFIT_YOY) || undefined,
    };
  } catch {
    return null;
  }
}

/** Get US / Global company profile via Yahoo Finance quoteSummary */
async function getYahooProfile(symbol: string): Promise<StockProfile | null> {
  try {
    const ticker = symbol.replace(/^us/i, "").toUpperCase();
    const modules = "financialData,defaultKeyStatistics,summaryDetail";
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const result = json.quoteSummary?.result?.[0];
    if (!result) return null;

    const fd = result.financialData || {};
    const ks = result.defaultKeyStatistics || {};
    const sd = result.summaryDetail || {};

    const _v = (d: any, key: string) => {
      const v = d?.[key];
      return typeof v === "object" && v?.raw !== undefined ? v.raw : v;
    };

    return {
      symbol: ticker,
      code: `us${ticker}`,
      name: ticker,
      market: "us",
      currency: String(fd.financialCurrency || "USD").toUpperCase(),
      asOf: new Date().toISOString(),
      source: "yahoo_quote_summary",
      peTtm: _v(sd, "trailingPE") ? Number(_v(sd, "trailingPE")) : undefined,
      peDynamic: _v(ks, "forwardPE") ? Number(_v(ks, "forwardPE")) : undefined,
      pb: _v(ks, "priceToBook") ? Number(_v(ks, "priceToBook")) : undefined,
      peg: _v(ks, "pegRatio") ? Number(_v(ks, "pegRatio")) : undefined,
      roe: _v(fd, "returnOnEquity") ? Number(_v(fd, "returnOnEquity")) * 100 : undefined,
      grossMarginPct: _v(fd, "grossMargins") ? Number(_v(fd, "grossMargins")) * 100 : undefined,
      netMarginPct: _v(fd, "profitMargins") ? Number(_v(fd, "profitMargins")) * 100 : undefined,
      revenueGrowthPct: _v(fd, "revenueGrowth") ? Number(_v(fd, "revenueGrowth")) * 100 : undefined,
      analystConsensus: {
        targetPriceAvg: _v(fd, "targetMeanPrice") ? Number(_v(fd, "targetMeanPrice")) : undefined,
        rating: String(fd.recommendationKey || ""),
      },
    };
  } catch {
    return null;
  }
}

/** Main entry: get stock financial profile */
export async function getStockProfile(rawSymbol: string): Promise<{ ok: boolean; data?: StockProfile; error?: string }> {
  const norm = normalizeSymbol(rawSymbol);
  let profile: StockProfile | null = null;

  if (norm.market === "cn") {
    profile = await getAshareProfile(norm.code);
  } else if (norm.market === "hk") {
    profile = await getHkProfile(norm.code);
  } else {
    profile = await getYahooProfile(norm.code);
  }

  if (!profile) {
    return { ok: false, error: `no_profile_data_for_${rawSymbol}` };
  }

  return { ok: true, data: profile };
}
