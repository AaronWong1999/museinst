
//





import type { Env } from "../env";
import { getReceiptBySlug, type ReceiptData } from "./tasks";
import puppeteer from "@cloudflare/puppeteer";

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ReceiptImageOpts {
  edition?: string;
  watermark?: boolean;
  baseUrl: string;
}

export function buildReceiptHtml(data: ReceiptData, slug: string, opts: ReceiptImageOpts): string {
  const watermarkLine = opts.watermark === false
    ? ""
    : opts.edition === "hosted"
      ? `<div style="margin-top:28px;padding-top:20px;border-top:1px solid #efefef;font-size:15px;color:#a3a3a3">MuseInst 托管版 · ${esc(opts.baseUrl.replace(/^https?:\/\//, ""))}</div>`
      : `<div style="margin-top:28px;padding-top:20px;border-top:1px solid #efefef;font-size:15px;color:#a3a3a3">由 MuseInst 自部署版完成 · ${esc(opts.baseUrl.replace(/^https?:\/\//, ""))}</div>`;
  const steps = data.steps.map((s, i) => `
    <div style="display:flex;gap:14px;align-items:flex-start;margin-top:${i === 0 ? 0 : 18}px">
      <div style="width:28px;height:28px;border-radius:50%;background:#16a34a;color:#fff;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0">✓</div>
      <div style="font-size:21px;line-height:1.5;color:#171717;padding-top:1px">${esc(s)}</div>
    </div>`).join("");
  const evidence = data.evidence.length
    ? `<div style="margin-top:30px;padding:18px;background:#fafafa;border-radius:12px">
        <div style="font-size:13px;color:#a3a3a3;letter-spacing:.08em;margin-bottom:8px">机器可验证证据（已脱敏）</div>
        ${data.evidence.map((e) => `<div style="font-size:14px;color:#737373;font-family:monospace;margin-top:4px;word-break:break-all">${esc(e.type)}: ${esc(e.value)}</div>`).join("")}
      </div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#fff;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="width:750px;padding:64px 56px;box-sizing:border-box;background:#fff">
  <div style="font-size:26px;color:#737373">MuseInst 完成了</div>
  <div style="font-size:40px;font-weight:700;line-height:1.3;margin-top:14px;color:#171717">${esc(data.title)}</div>
  <div style="margin-top:44px">${steps}</div>
  ${evidence}
  <div style="margin-top:36px;font-size:17px;color:#737373">用时 ${fmtDuration(data.durationMs)} · ${data.steps.length} 个步骤</div>
  ${watermarkLine}
</div>
</body></html>`;
}






export async function renderReceiptPng(
  env: Env,
  slug: string,
  opts: ReceiptImageOpts,
): Promise<{ bytes: Uint8Array; cached: boolean } | { error: string }> {
  const key = `receipts/${slug}.jpg`;
  const cached = await env.ARTIFACTS.get(key);
  if (cached) return { bytes: new Uint8Array(await cached.arrayBuffer()), cached: true };

  const data = await getReceiptBySlug(env, slug);
  if (!data) return { error: "not_found" };

  const html = buildReceiptHtml(data, slug, opts);
  const height = Math.min(Math.max(320 + data.steps.length * 64 + data.evidence.length * 90, 500), 2000);

  let lastErr = "";
  for (let i = 0; i < 2; i++) {
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
    try {
      browser = await puppeteer.launch(env.BROWSER, { keep_alive: 60_000 });
      const page = await browser.newPage();
      await page.setViewport({ width: 750, height });
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 300));
      const buf = (await page.screenshot({ type: "jpeg", quality: 85 })) as unknown as Uint8Array;
      if (buf.length < 1000) {
        lastErr = "screenshot_too_small";
      } else {
        await env.ARTIFACTS.put(key, buf, {
          httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=86400" },
        });
        return { bytes: buf, cached: false };
      }
    } catch (e) {
      lastErr = String(e).slice(0, 160);
    } finally {
      try {
        await browser?.close();
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return { error: lastErr || "render_failed" };
}


export function buildReceiptPageHtml(data: ReceiptData, slug: string, baseUrl: string): string {
  const secs = Math.round(data.durationMs / 1000);
  const steps = data.steps
    .map((s, i) => `<div class="step"><div class="chk">✓</div><div>${esc(s)}</div></div>`)
    .join("");
  const evidence = data.evidence.length
    ? `<div class="evidence"><div class="ev-title">机器可验证证据（已脱敏）</div>${data.evidence
        .map((e) => `<div class="ev">${esc(e.type)}: ${esc(e.value)}</div>`)
        .join("")}</div>`
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.title)} — MuseInst 任务凭证</title>
<meta name="description" content="MuseInst 真实完成的任务凭证：${esc(data.title)}。用时 ${secs} 秒，含机器可验证证据。">
<meta property="og:title" content="${esc(data.title)} — MuseInst 真实完成的任务">
<meta property="og:description" content="用时 ${secs} 秒 · ${data.steps.length} 个步骤 · 机器可验证证据。一个在微信/Telegram 里替你办事的开源个人 Agent。">
<meta property="og:image" content="${baseUrl}/r/${slug}/og.png">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<style>
body{margin:0;background:#fafafa;font-family:system-ui,-apple-system,'PingFang SC',sans-serif;color:#171717}
header{display:flex;justify-content:center;align-items:center;height:56px;background:#fff;border-bottom:1px solid #efefef}
header a{font-family:Georgia,serif;font-size:20px;color:#171717;text-decoration:none}
main{max-width:520px;margin:0 auto;padding:48px 16px}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:16px;padding:32px}
h1{font-family:Georgia,serif;font-size:26px;line-height:1.3;margin:0}
.meta{color:#737373;font-size:13px;margin-top:10px}
.step{display:flex;gap:12px;align-items:flex-start;margin-top:16px;font-size:14px;line-height:1.6}
.chk{width:22px;height:22px;border-radius:50%;background:#16a34a1a;color:#16a34a;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0}
.evidence{margin-top:24px;border-top:1px solid #efefef;padding-top:18px}
.ev-title{font-size:11px;color:#a3a3a3;letter-spacing:.08em;text-transform:uppercase}
.ev{font-family:monospace;font-size:12px;color:#737373;margin-top:6px;word-break:break-all}
.cta{margin-top:28px;border:1px solid #e5e5e5;border-radius:12px;padding:18px;text-align:center}
.cta a.btn{display:inline-block;margin-top:10px;background:#171717;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:14px}
.cta .dl{font-size:12px;color:#737373;margin-top:10px}
.cta .dl a{color:#737373}
</style></head><body>
<header><a href="/">MuseInst</a></header>
<main><div class="card">
<h1>${esc(data.title)}</h1>
<div class="meta">MuseInst 完成 · 用时 ${secs} 秒 · ${data.steps.length} 个步骤</div>
<div style="margin-top:24px">${steps}</div>
${evidence}
<div class="cta">
  <div style="font-size:13px;color:#737373">这是 AI 真实完成的外部任务的脱敏凭证。想要一个替你办事的 Agent？</div>
  <a class="btn" href="/">了解 MuseInst →</a>
  <div class="dl"><a href="/r/${slug}/og.png" download="museinst-receipt-${slug}.jpg">↓ 保存分享长图</a></div>
</div>
</div></main></body></html>`;
}
