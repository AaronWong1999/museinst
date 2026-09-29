import assert from "node:assert/strict";
import { validatePublicUrl, extractTextFromHtml } from "../src/agent/web-fetch";

console.log("▶ Testing Web Fetch Security Guards (SSRF, IPv4/IPv6, Metadata & Text Extraction)...");

// 1. SSRF Interception: Loopback and Private IPv4
const blockedIpv4 = [
  "http://127.0.0.1",
  "http://127.0.0.1:8080/test",
  "http://127.0.0.2",
  "http://0x7f000001", // Hex 127.0.0.1
  "http://2130706433", // Integer 127.0.0.1
  "http://10.0.0.1/secret",
  "http://10.255.255.254",
  "http://172.16.0.1",
  "http://172.31.255.255",
  "http://192.168.0.1",
  "http://192.168.1.100:3000",
  "http://169.254.169.254/latest/meta-data/", // AWS/GCP/Azure metadata
  "http://0.0.0.0",
];

for (const url of blockedIpv4) {
  const res = validatePublicUrl(url);
  assert.equal(res.ok, false, `Expected ${url} to be blocked by SSRF filter`);
}

// 2. SSRF Interception: Localhost, Internal Hostnames, Protocols & Credentials
const blockedHostnamesAndSchemes = [
  "http://localhost",
  "http://localhost:3000",
  "http://foo.localhost",
  "http://server.local",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://instance-data",
  "ftp://example.com/file",
  "file:///etc/passwd",
  "gopher://127.0.0.1:70",
  "javascript:alert(1)",
  "http://user:password@example.com",
];

for (const url of blockedHostnamesAndSchemes) {
  const res = validatePublicUrl(url);
  assert.equal(res.ok, false, `Expected ${url} to be blocked`);
}

// 3. SSRF Interception: IPv6 Loopback, ULA, Link-Local
const blockedIpv6 = [
  "http://[::1]/",
  "http://[::]/",
  "http://[fc00::1]/",
  "http://[fd12:3456:789a::1]/",
  "http://[fe80::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:10.0.0.1]/",
];

for (const url of blockedIpv6) {
  const res = validatePublicUrl(url);
  assert.equal(res.ok, false, `Expected IPv6 ${url} to be blocked`);
}

// 4. Valid Public URLs Allowed
const allowedUrls = [
  "https://www.cloudflare.com",
  "https://en.wikipedia.org/wiki/Cloudflare",
  "http://example.com:8443/docs/index.html?reference=abc&page=2",
  "https://api.github.com/repos/cloudflare/workers-sdk",
];

for (const url of allowedUrls) {
  const res = validatePublicUrl(url);
  assert.equal(res.ok, true, `Expected public URL ${url} to be permitted`);
}

// 5. HTML Text Extraction & Noise Stripping
const sampleHtml = `
<!DOCTYPE html>
<html>
<head>
  <title> Cloudflare Workers &amp; Edge Computing </title>
  <style> body { font-family: sans-serif; } </style>
  <script> console.log("tracking code"); </script>
</head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <header>Header Banner</header>
  <main>
    <h1>Introduction to Workers</h1>
    <p>Cloudflare Workers allows running serverless code at the <strong>edge</strong>.</p>
    <p>Supports &ldquo;ultra-fast&rdquo; execution &amp; SQLite DO storage.</p>
  </main>
  <footer>&copy; 2026 Cloudflare. All rights reserved.</footer>
</body>
</html>
`;

const extracted = extractTextFromHtml(sampleHtml);
assert.equal(extracted.title, "Cloudflare Workers & Edge Computing");
assert.match(extracted.text, /Introduction to Workers/);
assert.match(extracted.text, /Cloudflare Workers allows running serverless code at the edge\./);
assert.match(extracted.text, /Supports “ultra-fast” execution & SQLite DO storage\./);
assert.equal(extracted.text.includes("console.log"), false, "Scripts must be stripped");
assert.equal(extracted.text.includes("body {"), false, "Styles must be stripped");
assert.equal(extracted.text.includes("<main>"), false, "HTML tags must be stripped");

console.log("✔ Web Fetch security & extraction tests passed!");
