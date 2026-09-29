// news-service.ts — 7x24 Macro & stock financial news service.
// Strict timezone normalization (ISO 8601 with explicit offset) to eliminate recency hallucinations.

import type { FinanceNewsItem } from "./types";

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

/** Convert raw time string/epoch to explicit ISO 8601 with timezone */
export function normalizeNewsTime(raw: unknown, defaultZone: "UTC" | "Asia/Shanghai" = "Asia/Shanghai"): string {
  const str = String(raw ?? "").trim();
  if (!str) return "";

  if (/^\d{10}$/.test(str)) {
    return new Date(Number(str) * 1000).toISOString();
  }
  if (/^\d{13}$/.test(str)) {
    return new Date(Number(str)).toISOString();
  }

  // Format: "YYYY-MM-DD HH:mm:ss" or "YYYY/MM/DD HH:mm:ss"
  const m = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/);
  if (m) {
    const isoDate = `${m[1]}-${m[2]}-${m[3]}T${m[4]}`;
    return defaultZone === "Asia/Shanghai" ? `${isoDate}+08:00` : `${isoDate}Z`;
  }

  return str;
}

/** Fetch Eastmoney 7x24 fast macro news */
export async function getEastmoneyFastNews(limit = 10): Promise<FinanceNewsItem[]> {
  try {
    const url = `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html`;
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://kuaixun.eastmoney.com/" },
    });
    if (!res.ok) return [];
    const text = await res.text();
    const jsonText = text.replace(/^[^{]*?(\{)/, "$1");
    const json: any = JSON.parse(jsonText);
    const list: any[] = json.LivesList || [];

    return list.slice(0, limit).map((it) => ({
      title: it.title || it.simtitle || "",
      digest: it.digest || it.simdigest || "",
      source: "东方财富7x24快讯",
      time: normalizeNewsTime(it.showtime || it.ordertime, "Asia/Shanghai"),
      url: it.url_m || it.url_w || "",
    })).filter((n) => n.title);
  } catch {
    return [];
  }
}

/** Fetch stock news via Yahoo Finance */
export async function getYahooStockNews(symbol: string, limit = 5): Promise<FinanceNewsItem[]> {
  try {
    const ticker = symbol.replace(/^(us|hk|sh|sz)/i, "").toUpperCase();
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=${limit}&quotesCount=0`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const json: any = await res.json();
    const list: any[] = json.news || [];

    return list.slice(0, limit).map((it) => ({
      title: it.title || "",
      digest: "",
      source: it.publisher || "Yahoo Finance",
      time: it.providerPublishTime ? new Date(it.providerPublishTime * 1000).toISOString() : "",
      url: it.link || "",
    })).filter((n) => n.title);
  } catch {
    return [];
  }
}

/** Main entry: get news for symbol or keyword or macro stream */
export async function getNews(opts: { symbol?: string; query?: string; limit?: number }): Promise<{ ok: boolean; news: FinanceNewsItem[]; error?: string }> {
  const limit = opts.limit ?? 8;
  const items: FinanceNewsItem[] = [];

  if (opts.symbol) {
    const stockNews = await getYahooStockNews(opts.symbol, limit);
    items.push(...stockNews);
  }

  if (items.length < limit) {
    const fastNews = await getEastmoneyFastNews(limit);
    if (opts.query) {
      const q = opts.query.toLowerCase();
      const filtered = fastNews.filter((n) => n.title.toLowerCase().includes(q) || (n.digest && n.digest.toLowerCase().includes(q)));
      items.push(...filtered);
    } else if (!opts.symbol) {
      items.push(...fastNews);
    }
  }

  const deduped: FinanceNewsItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.title)) continue;
    seen.add(it.title);
    deduped.push(it);
    if (deduped.length >= limit) break;
  }

  if (deduped.length === 0) {
    return { ok: false, news: [], error: "no_news_found" };
  }

  return { ok: true, news: deduped };
}
