const ACCOUNT_ID = process.env.OPENINST_CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || "";
const API_TOKEN = process.env.OPENINST_CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  process.exit(1);
}

const SITES: Array<{ name: string; url: string; expect: RegExp; intl: boolean }> = [
  { name: "example", url: "https://example.com/", expect: /example/i, intl: true },
  { name: "wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page", expect: /wikipedia/i, intl: true },
  { name: "hackernews", url: "https://news.ycombinator.com/", expect: /hacker|hnrgr|y combinator/i, intl: true },
  { name: "github_trending", url: "https://github.com/trending", expect: /trending|github/i, intl: true },
  { name: "npm", url: "https://www.npmjs.com/search?q=wrangler", expect: /wrangler/i, intl: true },
  { name: "cloudflare_docs", url: "https://developers.cloudflare.com/workers/", expect: /workers/i, intl: true },
  { name: "bbc", url: "https://www.bbc.com/news", expect: /news|bbc/i, intl: true },
  { name: "booking", url: "https://www.booking.com/", expect: /booking|hotel/i, intl: true },
  { name: "airbnb", url: "https://www.airbnb.com/", expect: /airbnb|stay/i, intl: true },
  { name: "amazon", url: "https://www.amazon.com/", expect: /amazon/i, intl: true },
  { name: "ctrip", url: "https://www.ctrip.com/", expect: /携程|ctrip|hotel|酒店/i, intl: false },
  { name: "jd", url: "https://www.jd.com/", expect: /京东|jd/i, intl: false },
  { name: "taobao", url: "https://www.taobao.com/", expect: /淘宝|taobao/i, intl: false },
  { name: "12306", url: "https://www.12306.cn/mormhweb/", expect: /12306|铁路|车票/i, intl: false },
  { name: "meituan", url: "https://www.meituan.com/", expect: /美团|meituan/i, intl: false },
  { name: "dianping", url: "https://www.dianping.com/", expect: /点评|dianping/i, intl: false },
  { name: "bilibili", url: "https://www.bilibili.com/", expect: /bilibili|哔哩/i, intl: false },
  { name: "zhihu", url: "https://www.zhihu.com/hot", expect: /知乎|热榜|zhihu/i, intl: false },
  { name: "qq_mail_landing", url: "https://mail.qq.com/", expect: /qq|邮箱/i, intl: false },
  { name: "gov_beijing", url: "https://www.beijing.gov.cn/", expect: /北京|政府/i, intl: false },
];

const CONCURRENCY = 3;

async function markdown(url: string): Promise<{ ok: boolean; status: number; ms: number; chars: number; head: string; blocked: boolean }> {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/browser-rendering/markdown`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url, rejectResourceTypes: ["image", "font"] }),
        signal: ctl.signal,
      },
    );
    const j = (await res.json()) as any;
    const text = typeof j?.result === "string" ? j.result : String(j?.result?.markdown ?? "");
    const ms = Date.now() - t0;
    const blocked = /captcha|验证码|access denied|forbidden|are you a human|安全验证/i.test(text.slice(0, 2000)) && text.length < 3000;
    return { ok: res.ok && !!text, status: res.status, ms, chars: text.length, head: text.slice(0, 300), blocked };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, chars: 0, head: String(e), blocked: false };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  console.log(`benchmark：${SITES.length} 站点，并发 ${CONCURRENCY}，输出 docs/bench-browser-result.json\n`);
  const results: Array<any> = [];
  let idx = 0;
  const worker = async () => {
    while (idx < SITES.length) {
      const site = SITES[idx++];
      const r = await markdown(site.url);
      const matched = r.ok && site.expect.test(r.head) && !r.blocked;
      const row = { name: site.name, url: site.url, intl: site.intl, matched, blocked: r.blocked, httpStatus: r.status, ms: r.ms, markdownChars: r.chars, sample: r.head.slice(0, 120) };
      results.push(row);
      console.log(`${matched ? "✅" : r.blocked ? "🚫" : "❌"} ${site.name.padEnd(16)} ${r.ms}ms ${r.chars}ch${r.blocked ? "  [疑似 bot 拦截]" : ""}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const ok = results.filter((r) => r.matched).length;
  const blocked = results.filter((r) => r.blocked).length;
  const intl = results.filter((r) => r.intl);
  const cn = results.filter((r) => !r.intl);
  const summary = {
    date: new Date().toISOString(),
    total: results.length,
    matched: ok,
    successRate: +(ok / results.length).toFixed(2),
    blocked,
    intlSuccess: `${intl.filter((r) => r.matched).length}/${intl.length}`,
    chinaSuccess: `${cn.filter((r) => r.matched).length}/${cn.length}`,
    p50ms: results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)],
    results: results.sort((a, b) => a.name.localeCompare(b.name)),
  };
  console.log(`\n成功率 ${summary.successRate * 100}%（国际 ${summary.intlSuccess}，中国 ${summary.chinaSuccess}），疑似拦截 ${blocked}`);
  console.log(`退出条件：meaningful task success ≥ 70% —— 本轮 ${summary.successRate >= 0.7 ? "达标 ✅" : "不达标 ⚠️  考虑改定位为连接器优先"}`);
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/bench-browser-result.json", JSON.stringify(summary, null, 2));
  console.log("已写 docs/bench-browser-result.json");
}

main();
