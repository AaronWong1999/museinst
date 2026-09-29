




export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  score?: number;
}

export interface EngineSearchResponse {
  engine: string;
  status: "ok" | "empty" | "blocked" | "timeout" | "error";
  items: SearchResultItem[];
  elapsedMs: number;
}

export interface WebSearchOptions {
  max?: number;
  lang?: "zh" | "en";
  timeoutMs?: number;
}

export interface WebSearchResult {
  status: "ok" | "empty" | "degraded_all_blocked";
  query: string;
  results: SearchResultItem[];
  engineStatuses: Record<string, string>;
}





export interface EngineHealth {
  consecutiveBlocks: number;
  blockedUntil: number;
}

export const engineHealthMap: Record<string, EngineHealth> = {
  bing: { consecutiveBlocks: 0, blockedUntil: 0 },
  duckduckgo: { consecutiveBlocks: 0, blockedUntil: 0 },
  wikipedia: { consecutiveBlocks: 0, blockedUntil: 0 },
};

export function isEngineHealthy(name: string): boolean {
  const h = engineHealthMap[name];
  if (!h) return true;
  if (h.blockedUntil > 0 && Date.now() < h.blockedUntil) {
    return false;
  }
  return true;
}

export function recordEngineResult(name: string, status: "ok" | "empty" | "blocked" | "timeout" | "error") {
  const h = engineHealthMap[name];
  if (!h) return;
  if (status === "ok") {
    h.consecutiveBlocks = 0;
    h.blockedUntil = 0;
  } else if (status === "blocked") {
    h.consecutiveBlocks++;
    if (h.consecutiveBlocks >= 3) {

      h.blockedUntil = Date.now() + 5 * 60 * 1000;
    }
  }
  // status === "empty" does not reset consecutiveBlocks to prevent parser failure from clearing count
}



const KNOWN_TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "igshid",
  "spm_id_from",
  "from_source",
]);





export function sanitizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    for (const key of Array.from(u.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (KNOWN_TRACKING_PARAMS.has(lower) || lower.startsWith("utm_")) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}




export function getDedupeKey(cleanUrl: string): string {
  try {
    const u = new URL(cleanUrl);
    let path = u.pathname;
    if (path.endsWith("/") && path.length > 1) {
      path = path.slice(0, -1);
    }
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return cleanUrl.toLowerCase();
  }
}


const TWO_LEVEL_TLDS = new Set([
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "ne.jp", "ac.jp", "go.jp", "or.jp",
  "com.hk", "org.hk", "edu.hk", "gov.hk", "net.hk",
  "com.tw", "org.tw", "edu.tw", "gov.tw", "idv.tw",
  "co.nz", "net.nz", "org.nz",
  "com.sg", "edu.sg", "gov.sg",
  "co.kr", "ne.kr", "or.kr", "re.kr",
  "co.za", "com.mx", "com.br",
]);




export function getDomain(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const parts = u.hostname.toLowerCase().split(".");
    if (parts.length >= 3) {
      const twoLevel = parts.slice(-2).join(".");
      if (TWO_LEVEL_TLDS.has(twoLevel)) {
        return parts.slice(-3).join(".");
      }
    }
    if (parts.length >= 2) {
      return parts.slice(-2).join(".");
    }
    return u.hostname.toLowerCase();
  } catch {
    return "";
  }
}






export function decodeBingRedirectUrl(bingUrl: string): string {
  if (!bingUrl.includes("bing.com/ck/a?")) return bingUrl;
  try {
    const u = new URL(bingUrl.replace(/&amp;/g, "&"));
    const uParam = u.searchParams.get("u");
    if (!uParam || !uParam.startsWith("a1")) return bingUrl;

    const base64Str = uParam.substring(2);

    const decoded =
      typeof atob === "function"
        ? atob(base64Str)
        : Buffer.from(base64Str, "base64").toString("utf-8");
    return decoded || bingUrl;
  } catch {
    return bingUrl;
  }
}

export function parseBingHtml(html: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];

  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRe.exec(html)) !== null) {
    const block = blockMatch[1];

    const linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    let targetUrl = decodeBingRedirectUrl(linkMatch[1]);
    const title = linkMatch[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();


    let snippet = "";
    const snippetMatch =
      block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<p class="b_algoSlug"[^>]*>([\s\S]*?)<\/p>/i);
    if (snippetMatch) {
      snippet = snippetMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    }

    if (title && targetUrl && targetUrl.startsWith("http")) {
      results.push({
        title,
        url: sanitizeUrl(targetUrl),
        snippet: snippet.slice(0, 800),
        engine: "bing",
      });
    }
  }

  return results;
}

export async function fetchBing(
  query: string,
  signal: AbortSignal,
  lang: "zh" | "en" = "zh",
): Promise<EngineSearchResponse> {
  const start = Date.now();
  if (!isEngineHealthy("bing")) {
    return { engine: "bing", status: "blocked", items: [], elapsedMs: 0 };
  }

  try {
    const setlang = lang === "en" ? "en-US" : "zh-Hans";
    const acceptLang = lang === "en" ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9,en;q=0.8";
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=${setlang}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": acceptLang,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
      signal,
    });

    if (res.status === 403 || res.status === 429) {
      recordEngineResult("bing", "blocked");
      return { engine: "bing", status: "blocked", items: [], elapsedMs: Date.now() - start };
    }

    const html = await res.text();
    if (html.includes("challenge") || html.includes("captcha")) {
      recordEngineResult("bing", "blocked");
      return { engine: "bing", status: "blocked", items: [], elapsedMs: Date.now() - start };
    }

    const items = parseBingHtml(html);
    const status = items.length > 0 ? "ok" : "empty";
    recordEngineResult("bing", status);
    return { engine: "bing", status, items, elapsedMs: Date.now() - start };
  } catch (err: any) {
    const status = err?.name === "AbortError" ? "timeout" : "error";
    return { engine: "bing", status, items: [], elapsedMs: Date.now() - start };
  }
}



export function decodeDdgUrl(ddgLink: string): string {
  try {
    if (ddgLink.includes("uddg=")) {
      const match = ddgLink.match(/uddg=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    return ddgLink;
  } catch {
    return ddgLink;
  }
}

export function parseDdgHtml(html: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const rawUrl = decodeDdgUrl(m[1]);
    const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const snippet = m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

    if (title && rawUrl && rawUrl.startsWith("http")) {
      results.push({
        title,
        url: sanitizeUrl(rawUrl),
        snippet: snippet.slice(0, 800),
        engine: "duckduckgo",
      });
    }
  }

  return results;
}

export async function fetchDuckDuckGo(
  query: string,
  signal: AbortSignal,
  lang: "zh" | "en" = "zh",
): Promise<EngineSearchResponse> {
  const start = Date.now();
  if (!isEngineHealthy("duckduckgo")) {
    return { engine: "duckduckgo", status: "blocked", items: [], elapsedMs: 0 };
  }

  try {

    const safeQuery = query.slice(0, 480);
    const kl = lang === "en" ? "us-en" : "wt-wt";
    const acceptLang = lang === "en" ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9,en;q=0.8";
    const body = new URLSearchParams({
      q: safeQuery,
      b: "",
      kl,
    });

    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": acceptLang,
        Origin: "https://html.duckduckgo.com",
        Referer: "https://html.duckduckgo.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
      },
      signal,
    });

    if (res.status === 403 || res.status === 429) {
      recordEngineResult("duckduckgo", "blocked");
      return { engine: "duckduckgo", status: "blocked", items: [], elapsedMs: Date.now() - start };
    }

    const html = await res.text();
    if (html.includes('id="challenge-form"') || html.includes("captcha")) {
      recordEngineResult("duckduckgo", "blocked");
      return { engine: "duckduckgo", status: "blocked", items: [], elapsedMs: Date.now() - start };
    }

    const items = parseDdgHtml(html);
    const status = items.length > 0 ? "ok" : "empty";
    recordEngineResult("duckduckgo", status);
    return { engine: "duckduckgo", status, items, elapsedMs: Date.now() - start };
  } catch (err: any) {
    const status = err?.name === "AbortError" ? "timeout" : "error";
    return { engine: "duckduckgo", status, items: [], elapsedMs: Date.now() - start };
  }
}



export async function fetchWikipedia(
  query: string,
  signal: AbortSignal,
  lang: "zh" | "en" = "zh",
): Promise<EngineSearchResponse> {
  const start = Date.now();
  try {

    const domain = lang === "en" ? "en.wikipedia.org" : "zh.wikipedia.org";
    const siteSuffix = lang === "en" ? "Wikipedia" : "维基百科";
    const url = `https://${domain}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query,
    )}&utf8=&format=json&srlimit=2`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "museinst-search/1.0 (+https://github.com/AaronWong1999/museinst)",
        Accept: "application/json",
      },
      signal,
    });

    if (!res.ok) {
      return { engine: "wikipedia", status: "error", items: [], elapsedMs: Date.now() - start };
    }

    const data = (await res.json()) as any;
    const items: SearchResultItem[] = [];
    const searchList = data?.query?.search || [];

    for (const s of searchList) {
      const title = s.title || "";
      const snippet = (s.snippet || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const pageUrl = `https://${domain}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
      items.push({
        title: `${title} - ${siteSuffix}`,
        url: pageUrl,
        snippet,
        engine: "wikipedia",
      });
    }

    return {
      engine: "wikipedia",
      status: items.length > 0 ? "ok" : "empty",
      items,
      elapsedMs: Date.now() - start,
    };
  } catch (err: any) {
    const status = err?.name === "AbortError" ? "timeout" : "error";
    return { engine: "wikipedia", status, items: [], elapsedMs: Date.now() - start };
  }
}



export function fuseWithRrf(
  engineResponses: EngineSearchResponse[],
  maxResults = 8,
  k = 60,
): SearchResultItem[] {
  const scoreMap = new Map<string, { item: SearchResultItem; score: number; engines: Set<string> }>();

  for (const resp of engineResponses) {
    if (resp.status !== "ok" || !resp.items) continue;


    const seenInEngine = new Set<string>();
    resp.items.forEach((item, index) => {
      const key = getDedupeKey(item.url);
      if (seenInEngine.has(key)) return;
      seenInEngine.add(key);

      const rank = index + 1;
      const rrfScore = 1 / (k + rank);

      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
        existing.engines.add(resp.engine);

        if (item.snippet.length > existing.item.snippet.length) {
          existing.item.snippet = item.snippet;
        }
      } else {
        scoreMap.set(key, {
          item: { ...item },
          score: rrfScore,
          engines: new Set([resp.engine]),
        });
      }
    });
  }


  const sorted = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);


  const domainCount = new Map<string, number>();
  const finalResults: SearchResultItem[] = [];

  for (const entry of sorted) {
    const domain = getDomain(entry.item.url);
    const count = domainCount.get(domain) || 0;
    if (count >= 2) continue;

    domainCount.set(domain, count + 1);
    entry.item.score = Math.round(entry.score * 10000) / 10000;
    finalResults.push(entry.item);
    if (finalResults.length >= maxResults) break;
  }

  return finalResults;
}



export async function executeWebSearch(
  query: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResult> {
  const max = Math.min(Math.max(Number(options.max || 5), 1), 10);
  const timeoutMs = options.timeoutMs || 3500;
  const lang = options.lang === "en" ? "en" : "zh";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let responses: EngineSearchResponse[] = [];
  try {

    responses = await Promise.all([
      fetchBing(query, controller.signal, lang),
      fetchDuckDuckGo(query, controller.signal, lang),
      fetchWikipedia(query, controller.signal, lang),
    ]);
  } finally {
    clearTimeout(timer);
  }

  const engineStatuses: Record<string, string> = {};
  let anyEngineSucceeded = false;
  let allLightweightBlocked = true;

  for (const r of responses) {
    engineStatuses[r.engine] = r.status;
    if (r.status === "ok") anyEngineSucceeded = true;
    if (r.engine !== "wikipedia" && r.status !== "blocked") {
      allLightweightBlocked = false;
    }
  }

  const fused = fuseWithRrf(responses, max);

  if (fused.length > 0) {
    return {
      status: "ok",
      query,
      results: fused,
      engineStatuses,
    };
  }

  if (allLightweightBlocked && responses.some((r) => r.engine !== "wikipedia" && r.status === "blocked")) {
    return {
      status: "degraded_all_blocked",
      query,
      results: [],
      engineStatuses,
    };
  }

  return {
    status: "empty",
    query,
    results: [],
    engineStatuses,
  };
}
