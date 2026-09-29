import assert from "node:assert/strict";
import {
  sanitizeUrl,
  getDedupeKey,
  decodeBingRedirectUrl,
  decodeDdgUrl,
  parseBingHtml,
  parseDdgHtml,
  fuseWithRrf,
  getDomain,
  recordEngineResult,
  isEngineHealthy,
  engineHealthMap,
  type EngineSearchResponse,
} from "../src/agent/web-search";

console.log("▶ Testing Web Search 2.0 Engine (Sanitization, Bing/DDG HTML Parsing, RRF & Diversity)...");

// 1. URL Sanitization: Remove tracking params, preserve ports & business params
const testUrl1 = "https://example.com:8443/products?reference=item_99&utm_source=twitter&utm_medium=cpc&fbclid=xyz#section2";
const cleanUrl1 = sanitizeUrl(testUrl1);
assert.equal(cleanUrl1, "https://example.com:8443/products?reference=item_99");

const testUrl2 = "https://news.ycombinator.com/item?id=12345&source=digest&_ga=GA1.2.3";
const cleanUrl2 = sanitizeUrl(testUrl2);
assert.equal(cleanUrl2, "https://news.ycombinator.com/item?id=12345&source=digest");

// 2. Dedupe Key generation
assert.equal(
  getDedupeKey("https://example.com/foo/"),
  getDedupeKey("https://example.com/foo"),
  "Trailing slashes should produce identical dedupe keys"
);
assert.equal(
  getDedupeKey("https://EXAMPLE.COM/path"),
  getDedupeKey("https://example.com/path"),
  "Domain casing should be normalized"
);

// 3. Bing Base64 Redirect Unwrapping
const targetRealUrl = "https://developers.cloudflare.com/workers/";
const b64 = Buffer.from(targetRealUrl, "utf-8").toString("base64");
const bingMockUrl = `https://www.bing.com/ck/a?!&&p=abc&u=a1${b64}&ntb=1`;
assert.equal(decodeBingRedirectUrl(bingMockUrl), targetRealUrl);
assert.equal(decodeBingRedirectUrl("https://example.com"), "https://example.com");

// 4. DuckDuckGo Redirect Unwrapping
const ddgRedirect = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F&rut=123";
assert.equal(decodeDdgUrl(ddgRedirect), "https://www.typescriptlang.org/docs/");

// 5. Bing HTML Parsing
const mockBingHtml = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://example.com/guide?utm_source=bing">TypeScript <strong>Handbook</strong></a></h2>
    <div class="b_caption"><p>The official guide to learning TypeScript and static typing.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://example.com/intro">Node.js Introduction</a></h2>
    <p class="b_algoSlug">Node.js is an open-source, cross-platform JavaScript runtime environment.</p>
  </li>
</ol>
`;
const bingItems = parseBingHtml(mockBingHtml);
assert.equal(bingItems.length, 2);
assert.equal(bingItems[0].title, "TypeScript Handbook");
assert.equal(bingItems[0].url, "https://example.com/guide");
assert.equal(bingItems[0].engine, "bing");
assert.match(bingItems[0].snippet, /The official guide to learning TypeScript/);
assert.equal(bingItems[1].title, "Node.js Introduction");
assert.equal(bingItems[1].engine, "bing");

// 6. DuckDuckGo HTML Parsing
const mockDdgHtml = `
<div class="results">
  <div class="result results_links">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Flearn">Quick Start – <b>React</b></a>
    <a class="result__snippet">Learn React with interactive examples and component concepts.</a>
  </div>
</div>
`;
const ddgItems = parseDdgHtml(mockDdgHtml);
assert.equal(ddgItems.length, 1);
assert.equal(ddgItems[0].title, "Quick Start – React");
assert.equal(ddgItems[0].url, "https://react.dev/learn");
assert.equal(ddgItems[0].engine, "duckduckgo");
assert.match(ddgItems[0].snippet, /Learn React with interactive examples/);

// 7. RRF Score Fusion & Domain Diversity
const engine1: EngineSearchResponse = {
  engine: "bing",
  status: "ok",
  items: [
    { title: "Shared Doc", url: "https://docs.example.com/guide", snippet: "Bing snippet", engine: "bing" },
    { title: "Example Page 1", url: "https://example.com/page1", snippet: "P1", engine: "bing" },
    { title: "Example Page 2", url: "https://example.com/page2", snippet: "P2", engine: "bing" },
    { title: "Example Page 3", url: "https://example.com/page3", snippet: "P3", engine: "bing" },
  ],
  elapsedMs: 120,
};

const engine2: EngineSearchResponse = {
  engine: "duckduckgo",
  status: "ok",
  items: [
    { title: "Shared Doc", url: "https://docs.example.com/guide", snippet: "Longer DDG snippet for shared doc", engine: "duckduckgo" },
    { title: "Independent Page", url: "https://other-domain.org/about", snippet: "About other", engine: "duckduckgo" },
  ],
  elapsedMs: 150,
};

const fused = fuseWithRrf([engine1, engine2], 5, 60);

// Shared Doc should rank first because it appeared in both engines
assert.equal(fused[0].url, "https://docs.example.com/guide");
assert.equal(fused[0].snippet, "Longer DDG snippet for shared doc", "Should retain more descriptive snippet");

// Domain diversity: example.com had 3 pages (page1, page2, page3).
// Only at most 2 should be included in final results
const exampleDotComCount = fused.filter((r) => r.url.includes("example.com/page")).length;
assert.equal(exampleDotComCount <= 2, true, `Expected at most 2 items from example.com/page, got ${exampleDotComCount}`);

// 8. ccSLD Domain Extraction & Diversity Differentiation
assert.equal(getDomain("https://news.bbc.co.uk/world"), "bbc.co.uk");
assert.equal(getDomain("https://finance.sina.com.cn/stock"), "sina.com.cn");
assert.equal(getDomain("https://docs.github.com/en"), "github.com");
assert.equal(getDomain("https://sub.tokyo.co.jp/index"), "tokyo.co.jp");

// bbc.co.uk and theguardian.co.uk must be distinct domains, not merged into co.uk
const ccSldResponse: EngineSearchResponse = {
  engine: "bing",
  status: "ok",
  items: [
    { title: "BBC 1", url: "https://news.bbc.co.uk/p1", snippet: "b1", engine: "bing" },
    { title: "BBC 2", url: "https://news.bbc.co.uk/p2", snippet: "b2", engine: "bing" },
    { title: "Guardian 1", url: "https://www.theguardian.co.uk/p1", snippet: "g1", engine: "bing" },
    { title: "Guardian 2", url: "https://www.theguardian.co.uk/p2", snippet: "g2", engine: "bing" },
  ],
  elapsedMs: 100,
};
const ccSldFused = fuseWithRrf([ccSldResponse], 10, 60);
assert.equal(ccSldFused.length, 4, "bbc.co.uk and theguardian.co.uk should both be preserved (2 each)");

// 9. Circuit Breaker: empty does not clear consecutiveBlocks, only ok clears it
engineHealthMap.bing.consecutiveBlocks = 0;
engineHealthMap.bing.blockedUntil = 0;

recordEngineResult("bing", "blocked");
assert.equal(engineHealthMap.bing.consecutiveBlocks, 1);

recordEngineResult("bing", "empty");
assert.equal(engineHealthMap.bing.consecutiveBlocks, 1, "empty should not clear consecutiveBlocks");

recordEngineResult("bing", "blocked");
assert.equal(engineHealthMap.bing.consecutiveBlocks, 2);

recordEngineResult("bing", "blocked");
assert.equal(engineHealthMap.bing.consecutiveBlocks, 3);
assert.equal(isEngineHealthy("bing"), false, "Engine should be tripped after 3 consecutive blocks");

recordEngineResult("bing", "ok");
assert.equal(engineHealthMap.bing.consecutiveBlocks, 0);
assert.equal(engineHealthMap.bing.blockedUntil, 0);
assert.equal(isEngineHealthy("bing"), true, "ok should reset consecutiveBlocks and restore health");

console.log("✔ Web Search 2.0 tests passed!");
