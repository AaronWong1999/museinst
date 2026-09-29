



import { clampText, now } from "../util";

export interface WebFetchOptions {
  maxChars?: number;
  offset?: number;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  contentType: string;
  fetchedAt: number;
  truncated: boolean;
  nextOffset?: number;
  text: string;
}

// DEFECT-014 honesty marker: static HTML may carry text hidden with CSS that a
// real browser would not show (and JavaScript was not executed). When such
// patterns exist in the source, say so instead of letting the model treat
// hidden/static text as rendered page content.
const HIDDEN_CONTENT_RE = /display\s*:\s*none|visibility\s*:\s*hidden/i;
export const HIDDEN_STATIC_CONTENT_NOTE = "[note: page contains hidden/static content; JavaScript was not executed]";






function isPrivateIpv4(ipNum: number): boolean {
  const match = (mask: number, target: number) => ((ipNum & mask) >>> 0) === target;


  if (match(0xff000000, 0x00000000)) return true;

  if (match(0xff000000, 0x0a000000)) return true;

  if (match(0xffc00000, 0x64400000)) return true;

  if (match(0xff000000, 0x7f000000)) return true;

  if (match(0xffff0000, 0xa9fe0000)) return true;

  if (match(0xfff00000, 0xac100000)) return true;

  if (match(0xffffff00, 0xc0000000)) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (match(0xffffff00, 0xc0000200)) return true;

  if (match(0xffff0000, 0xc0a80000)) return true;

  if (match(0xfffe0000, 0xc6120000)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (match(0xffffff00, 0xc6336400)) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (match(0xffffff00, 0xcb007100)) return true;

  if (match(0xf0000000, 0xe0000000)) return true;

  if (match(0xf0000000, 0xf0000000)) return true;

  return false;
}





function parseIpv4(host: string): number | null {

  if (/^\d+$/.test(host)) {
    const num = Number(host);
    return num >= 0 && num <= 0xffffffff ? num : null;
  }


  if (/^0x[0-9a-f]+$/i.test(host)) {
    const num = Number(host);
    return num >= 0 && num <= 0xffffffff ? num : null;
  }


  const parts = host.split(".");
  if (parts.length === 4) {
    let result = 0;
    for (let i = 0; i < 4; i++) {
      const p = parts[i];
      let val: number;
      if (/^0x[0-9a-f]+$/i.test(p)) {
        val = parseInt(p, 16);
      } else if (/^0[0-7]+$/.test(p)) {
        val = parseInt(p, 8);
      } else if (/^\d+$/.test(p)) {
        val = parseInt(p, 10);
      } else {
        return null;
      }
      if (isNaN(val) || val < 0 || val > 255) return null;
      result = (result << 8) | val;
    }
    return result >>> 0;
  }

  return null;
}




export function validatePublicUrl(rawUrl: string): { ok: boolean; error?: string; parsedUrl?: URL } {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL syntax" };
  }


  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `Protocol '${u.protocol}' forbidden; only http/https allowed` };
  }


  if (u.username || u.password) {
    return { ok: false, error: "URLs containing embedded credentials are forbidden" };
  }

  const hostname = u.hostname.toLowerCase().trim();


  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    hostname === "instance-data"
  ) {
    return { ok: false, error: `Access to local/internal host '${hostname}' is forbidden` };
  }


  const ipv4Num = parseIpv4(hostname);
  if (ipv4Num !== null) {
    if (isPrivateIpv4(ipv4Num)) {
      return { ok: false, error: `Access to private/loopback IPv4 address '${hostname}' is forbidden` };
    }
  }



  const cleanIpv6 = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (cleanIpv6.includes(":")) {
    const v6 = cleanIpv6.toLowerCase();

    if (v6 === "::1" || v6 === "::") {
      return { ok: false, error: "Access to IPv6 loopback is forbidden" };
    }

    if (v6.startsWith("fc") || v6.startsWith("fd")) {
      return { ok: false, error: "Access to IPv6 unique local address is forbidden" };
    }

    if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) {
      return { ok: false, error: "Access to IPv6 link-local address is forbidden" };
    }

    if (v6.startsWith("ff")) {
      return { ok: false, error: "Access to IPv6 multicast address is forbidden" };
    }

    if (v6.startsWith("::ffff:")) {
      const mapped = v6.slice(7);
      let mappedIpv4: number | null = null;
      if (mapped.includes(":")) {
        const hexParts = mapped.split(":");
        if (hexParts.length === 2) {
          const hi = parseInt(hexParts[0], 16);
          const lo = parseInt(hexParts[1], 16);
          if (!isNaN(hi) && !isNaN(lo) && hi >= 0 && hi <= 0xffff && lo >= 0 && lo <= 0xffff) {
            mappedIpv4 = ((hi << 16) | lo) >>> 0;
          }
        }
      } else {
        mappedIpv4 = parseIpv4(mapped);
      }
      if (mappedIpv4 !== null && isPrivateIpv4(mappedIpv4)) {
        return { ok: false, error: "Access to private IPv4-mapped IPv6 address is forbidden" };
      }
    }
  }

  return { ok: true, parsedUrl: u };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rsquo;/g, "’")
    .replace(/&mdash;/g, "—");
}




function cleanHtmlToText(html: string): string {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");


  cleaned = cleaned
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|article|section|main)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "· ");


  cleaned = cleaned.replace(/<\/?(strong|b|em|i|u|span|a|code)[^>]*>/gi, "");


  cleaned = cleaned.replace(/<[^>]+>/g, " ");


  cleaned = decodeHtmlEntities(cleaned);


  const lines = cleaned
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0);

  return lines.join("\n");
}

/**
 * DEFECT-014 main-content extraction: when the page marks its primary region
 * with <article>, <main> or <div role="main">, prefer that region so nav /
 * aside / footer boilerplate never crowds out the actual content.
 */
function sliceElementInner(html: string, tag: string, openIndex: number, openLength: number): string | null {
  const tokenRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tokenRe.lastIndex = openIndex + openLength;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return html.slice(openIndex + openLength, m.index);
    } else if (!m[0].endsWith("/>")) {
      depth += 1;
    }
  }
  return null;
}

function extractMainContentHtml(html: string): string | null {
  const candidates: Array<{ open: RegExp; tag: string }> = [
    { open: /<article\b[^>]*>/i, tag: "article" },
    { open: /<main\b[^>]*>/i, tag: "main" },
    { open: /<div\b[^>]*\brole=["']?main["']?[^>]*>/i, tag: "div" },
  ];
  for (const c of candidates) {
    const m = html.match(c.open);
    if (!m || m.index === undefined) continue;
    const inner = sliceElementInner(html, c.tag, m.index, m[0].length);
    if (inner && inner.trim()) return inner;
  }
  return null;
}



export function extractTextFromHtml(html: string): { title: string; text: string } {

  let title = "";
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  }


  const mainHtml = extractMainContentHtml(html);
  const text = cleanHtmlToText(mainHtml ?? html);
  return { title, text };
}




export async function executeWebFetch(
  targetUrl: string,
  options: WebFetchOptions = {},
): Promise<WebFetchResult> {
  // DEFECT-014: default window raised 4000 → 12000 so research reads get a
  // usable amount of text; hard cap 50000 unchanged.
  const maxChars = Math.min(Math.max(Number(options.maxChars || 12000), 100), 50000);
  const rawOffset = Number(options.offset ?? 0);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const maxBytes = options.maxBytes || 5 * 1024 * 1024;
  const maxRedirects = options.maxRedirects || 5;
  const timeoutMs = options.timeoutMs || 15000;

  let currentUrl = targetUrl;
  let redirectCount = 0;
  let finalResponse: Response | null = null;

  while (redirectCount <= maxRedirects) {
    const val = validatePublicUrl(currentUrl);
    if (!val.ok || !val.parsedUrl) {
      throw new Error(`SSRF validation blocked request: ${val.error}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 museinst-bot/1.0 (+https://github.com/AaronWong1999/museinst)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }


    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location");
      if (!location) {
        throw new Error(`Redirect HTTP ${res.status} returned without Location header`);
      }
      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
      }

      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    finalResponse = res;
    break;
  }

  if (!finalResponse) {
    throw new Error("Failed to obtain HTTP response");
  }

  const contentType = finalResponse.headers.get("Content-Type") || "";


  let totalBytes = 0;
  const chunks: Uint8Array[] = [];

  if (finalResponse.body) {
    const reader = finalResponse.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }


  const combined = new Uint8Array(totalBytes > maxBytes ? maxBytes : totalBytes);
  let bytesWritten = 0;
  for (const chunk of chunks) {
    if (bytesWritten + chunk.byteLength > combined.byteLength) {
      const remain = combined.byteLength - bytesWritten;
      combined.set(chunk.subarray(0, remain), bytesWritten);
      break;
    }
    combined.set(chunk, bytesWritten);
    bytesWritten += chunk.byteLength;
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const rawBody = decoder.decode(combined);


  const { title, text: fullText } = extractTextFromHtml(rawBody);

  // DEFECT-014 offset windowing: slice [offset, offset+maxChars) of the
  // extracted text so the model can page through long articles via
  // web_fetch(offset=nextOffset) instead of losing everything past 4000 chars.
  let text = fullText.slice(offset, offset + maxChars);
  const truncated = offset + maxChars < fullText.length;
  const nextOffset = truncated ? offset + text.length : undefined;

  if (HIDDEN_CONTENT_RE.test(rawBody)) {
    text = text.length > 0 ? `${text}\n${HIDDEN_STATIC_CONTENT_NOTE}` : HIDDEN_STATIC_CONTENT_NOTE;
  }

  return {
    url: targetUrl,
    finalUrl: currentUrl,
    status: finalResponse.status,
    title,
    contentType,
    fetchedAt: now(),
    truncated,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    text,
  };
}
