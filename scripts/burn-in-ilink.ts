

//




//



const BASE = process.env.BASE_URL || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "";
const HOURS = Number(process.argv.find((a) => a.startsWith("--duration="))?.split("=")[1] ?? 1);
const SAMPLE_MS = 60_000;

if (!KEY) {
  console.error("需要 ADMIN_KEY");
  process.exit(1);
}

interface Sample {
  at: number;
  ok: boolean;
  tokens: number;
  alive: number;
  rounds: number;
  messages: number;
  lastError: string | null;
}

const samples: Sample[] = [];

async function sample(): Promise<Sample | null> {
  try {
    const health = (await (await fetch(`${BASE}/healthz`)).json()) as any;
    const poller = (await (await fetch(`${BASE}/admin/wechat/status`, { headers: { "x-admin-key": KEY } })).json()) as any;
    return {
      at: Date.now(),
      ok: !!health.ok,
      tokens: poller.tokens ?? 0,
      alive: poller.alive ?? 0,
      rounds: poller.diag?.rounds ?? 0,
      messages: poller.diag?.messages ?? 0,
      lastError: poller.diag?.lastError ?? null,
    };
  } catch {
    return null;
  }
}

async function mainBurnIn(): Promise<void> {
  const deadline = Date.now() + HOURS * 3600_000;
  console.log(`burn-in 开始：${BASE}，时长 ${HOURS}h，采样 ${SAMPLE_MS / 1000}s\n`);
  let lastRounds = 0;
  while (Date.now() < deadline) {
    const s = await sample();
    if (s) {
      samples.push(s);
      const stalled = s.rounds === lastRounds && s.tokens > 0;
      console.log(
        `${new Date(s.at).toISOString()} tokens=${s.tokens} alive=${s.alive} rounds=${s.rounds} msgs=${s.messages}${s.lastError ? ` err=${s.lastError.slice(0, 80)}` : ""}${stalled ? "  ⚠️ 轮询停滞" : ""}`,
      );
      lastRounds = s.rounds;
    } else {
      console.log(`${new Date().toISOString()} ❌ 请求失败`);
      samples.push({ at: Date.now(), ok: false, tokens: -1, alive: -1, rounds: -1, messages: -1, lastError: "request_failed" });
    }
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
  await writeReport();
}

async function writeReport(): Promise<void> {
  const okRate = samples.filter((s) => s.ok).length / samples.length;
  const stalledCount = samples.filter((s, i) => i > 0 && s.rounds === samples[i - 1].rounds && s.tokens > 0).length;
  const report = {
    base: BASE,
    durationHours: HOURS,
    samples: samples.length,
    healthOkRate: +okRate.toFixed(4),
    stalledSamples: stalledCount,
    finalMessages: samples.at(-1)?.messages ?? 0,
    errors: [...new Set(samples.map((s) => s.lastError).filter(Boolean))],
  };
  console.log(`\n可用性 ${(okRate * 100).toFixed(2)}%，轮询停滞样本 ${stalledCount}，累计消息 ${report.finalMessages}`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`docs/burn-in-ilink-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(report, null, 2));
  console.log("报告已写 docs/");
  if (okRate < 0.99 || stalledCount > samples.length * 0.05) process.exit(2);
}

mainBurnIn();
