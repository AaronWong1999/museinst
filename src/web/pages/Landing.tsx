// Landing — open-source edition home page. Single copy source: src/copy (shared with the hosted site SSR).
// Page scope: product in 30 seconds + two paths + password-security visualization + honest tiers. No commercial components.
import React from "react";
import { IconTelegram, IconWeChat } from "../icons";
import { useLang, LangToggle } from "../i18n";
import {
  advantagesCopy, compareTableCopy, landingCopy, navCopy, securityChecksCopy, securityFlowCopy,
} from "../../copy";

interface Props {
  nav: (to: string) => void;
  bindCode?: string;
}

const SELF_TIERS: Array<[string, string, string]> = [
  ["试一试、自己玩", "Cloudflare 免费账号，零外部 key", "@cf/google/gemma-4-26b-a4b-it"],
  ["日常认真用", "Cloudflare Workers Paid（$5/月）", "@cf/zai-org/glm-5.3-flash"],
  ["用自己的模型", "任意 OpenAI 兼容端点", "智谱 / DeepSeek / OpenRouter / 本地"],
];

const SELF_TIERS_EN: Array<[string, string, string]> = [
  ["Try it out", "Cloudflare free account, zero external keys", "@cf/google/gemma-4-26b-a4b-it"],
  ["Daily serious use", "Cloudflare Workers Paid ($5/mo)", "@cf/zai-org/glm-5.3-flash"],
  ["Your own model", "Any OpenAI-compatible endpoint", "Zhipu / DeepSeek / OpenRouter / local"],
];

export default function Landing({ nav, bindCode }: Props): React.ReactElement {
  const { lang } = useLang();
  const zh = lang === "zh";
  const t = landingCopy[lang];
  const n = navCopy[lang];
  const advs = advantagesCopy.map((a) => a[lang]);
  const flow = securityFlowCopy[lang];
  const checks = securityChecksCopy[lang];
  const cmp = compareTableCopy[lang];
  const tiers = zh ? SELF_TIERS : SELF_TIERS_EN;

  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-40 flex items-center justify-between px-6 h-14 border-b border-[#EFEFEF] bg-white/90 backdrop-blur">
        <span className="wordmark text-[22px]">MuseInst</span>
        <div className="flex items-center gap-5 text-[14px] text-[#737373]">
          <a href="https://github.com/AaronWong1999/museinst" target="_blank" rel="noreferrer" className="hover:text-black">GitHub ★</a>
          <a href="/recipes" className="hover:text-black">{n.recipes}</a>
          <a href="https://museinst.com" className="text-[#171717] font-medium hover:text-black">{zh ? "托管版 ↗" : "Hosted ↗"}</a>
          <LangToggle />
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="max-w-[760px] mx-auto px-4 pt-20 pb-10 text-center">
          <h1 className="wordmark text-[52px] leading-[1.15]">
            {zh ? (<>别问 AI 怎么做。<br />让它去做。</>) : (<>Don&apos;t ask AI how.<br />Make it do.</>)}
          </h1>
          <p className="text-[19px] text-[#737373] mt-6 leading-relaxed" dangerouslySetInnerHTML={{ __html: t.sub }} />
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a
              href="https://museinst.com"
              className="h-12 px-6 flex items-center text-[15px] font-medium bg-[#171717] text-white rounded-xl hover:bg-black"
            >
              {zh ? "打开 MuseInst 托管版" : "Open hosted MuseInst"}
              <span className="ml-2 text-[12px] opacity-70">{zh ? "邀请制" : "Invite only"}</span>
            </a>
            <a
              href="https://github.com/AaronWong1999/museinst"
              className="h-12 px-6 flex items-center text-[15px] font-medium border border-[#E5E5E5] rounded-xl hover:bg-[#FAFAFA]"
            >
              {t.ctaSelf}
              <span className="ml-2 text-[12px] text-[#737373]">{t.ctaSelfSub}</span>
            </a>
          </div>
          {bindCode && (
            <div className="mt-6 inline-block text-[13px] text-[#737373] bg-[#FAFAFA] rounded-lg px-4 py-2.5">
              {zh ? (<>你的绑定码 <span className="font-mono font-semibold text-black tracking-widest">{bindCode}</span>，把它发给 MuseInst 微信号：<span className="font-mono">/bind {bindCode}</span></>)
                : (<>Your bind code <span className="font-mono font-semibold text-black tracking-widest">{bindCode}</span> — send <span className="font-mono">/bind {bindCode}</span> to the MuseInst WeChat account</>)}
            </div>
          )}

          {/* conversation sample (honest illustration, not a screenshot) */}
          <div className="mt-12 max-w-[460px] mx-auto text-left border border-[#E5E5E5] rounded-2xl p-5 bg-[#FAFAFA]">
            <div className="flex items-center gap-2 text-[12px] text-[#A3A3A3] mb-3">
              <IconWeChat size={16} /> {t.demoTag}
            </div>
            <div className="space-y-2.5 text-[14px]">
              <div className="bg-white border border-[#EFEFEF] rounded-xl rounded-tl-sm px-3.5 py-2 max-w-[80%]">
                {t.demoUser}
              </div>
              <div className="bg-[#171717] text-white rounded-xl rounded-tr-sm px-3.5 py-2 max-w-[85%] ml-auto">
                {t.demoBot}
              </div>
              <div className="text-[12px] text-[#A3A3A3] pl-1">
                {t.demoFoot}
              </div>
            </div>
          </div>
        </section>

        {/* four competitive advantages */}
        <section className="max-w-[760px] mx-auto px-4 py-14 border-t border-[#EFEFEF]">
          <h2 className="wordmark text-[30px] text-center">{t.secAdv}</h2>
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {advs.map(([title, d], i) => (
              <div key={title} className="border border-[#E5E5E5] rounded-xl p-5">
                <div className="text-[13px] text-[#A3A3A3]">0{i + 1}</div>
                <div className="text-[15px] font-semibold mt-1">{title}</div>
                <div className="text-[13px] text-[#737373] mt-2 leading-relaxed">{d}</div>
              </div>
            ))}
          </div>
        </section>

        {/* where your password goes */}
        <section className="max-w-[760px] mx-auto px-4 py-14 border-t border-[#EFEFEF]">
          <h2 className="wordmark text-[30px] text-center">{t.secPwd}</h2>
          <p className="text-center text-[14px] text-[#737373] mt-3">{t.secPwdSub}</p>
          <div className="mt-8 max-w-[520px] mx-auto">
            {flow.map((s, i) => (
              <div key={i}>
                <div className="flex items-center gap-3 bg-[#FAFAFA] border border-[#EFEFEF] rounded-lg px-4 py-3 text-[14px]">
                  <span className="font-mono text-[12px] text-[#A3A3A3]">{i + 1}</span>
                  {s}
                </div>
                {i < flow.length - 1 && <div className="text-center text-[#C9C9C9] text-[13px] py-0.5">↓</div>}
              </div>
            ))}
            <div className="mt-6 space-y-2 text-[13px] text-[#737373]">
              {checks.map((c) => (<div key={c}>{c}</div>))}
            </div>
          </div>
        </section>

        {/* two paths */}
        <section className="max-w-[760px] mx-auto px-4 py-14 border-t border-[#EFEFEF]">
          <h2 className="wordmark text-[30px] text-center">{t.secPath}</h2>
          <p className="text-center text-[14px] text-[#737373] mt-3">{t.secPathSub}</p>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full text-[13px] border-collapse min-w-[560px]">
              <thead>
                <tr className="border-b border-[#E5E5E5] text-left">
                  <th className="py-2.5 pr-3 font-normal text-[#A3A3A3]"></th>
                  <th className="py-2.5 pr-3 font-semibold">{zh ? "打开 MuseInst（托管版）" : "Open MuseInst (hosted)"}</th>
                  <th className="py-2.5 font-semibold">{zh ? "部署到 Cloudflare（本页 · 开源版）" : "Deploy to Cloudflare (this page · open source)"}</th>
                </tr>
              </thead>
              <tbody>
                {cmp.map(([k, a, b]) => (
                  <tr key={k} className="border-b border-[#EFEFEF]">
                    <td className="py-2.5 pr-3 text-[#A3A3A3] whitespace-nowrap">{k}</td>
                    <td className="py-2.5 pr-3">{a}</td>
                    <td className="py-2.5">{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-center text-[13px] text-[#737373] mt-5">
            {zh ? "两个版本的 Agent 内核、Vault 安全模型、浏览器能力完全一样。托管版多的是多人运营需要的东西，不是能力。"
              : "Both editions share the same agent kernel, Vault security model and browser capabilities. Hosted adds what running for many people requires — not capabilities."}
          </p>
        </section>

        {/* honest tiers */}
        <section className="max-w-[760px] mx-auto px-4 py-14 border-t border-[#EFEFEF]">
          <h2 className="wordmark text-[30px] text-center">{zh ? "自部署需要什么" : "What self-hosting needs"}</h2>
          <div className="mt-8">
            <table className="w-full mt-3 text-[13px] border-collapse">
              <tbody>
                {tiers.map(([a, b, c2], i) => (
                  <tr key={i} className="border-t border-[#EFEFEF]">
                    <td className="py-2.5 pr-2 font-medium whitespace-nowrap">{a}</td>
                    <td className="py-2.5 pr-2 text-[#737373]">{b}</td>
                    <td className="py-2.5 text-[#737373] font-mono text-[12px]">{c2}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[12px] text-[#A3A3A3] mt-2">
              {zh ? "免费版每天 10 分钟浏览器时长、10,000 AI neurons，够跑 1–3 个真实浏览器任务。这是 Cloudflare 的额度，不是我们的限制。"
                : "The free tier gives 10 browser minutes and 10,000 AI neurons a day — enough for 1–3 real browser tasks. That's Cloudflare's quota, not ours."}
            </p>
          </div>
        </section>

        {/* bottom CTA */}
        <section className="max-w-[760px] mx-auto px-4 py-16 border-t border-[#EFEFEF] text-center">
          <div className="wordmark text-[28px]">{zh ? "十五分钟后，你就拥有一份自己的。" : "Fifteen minutes from now, you'll own yours."}</div>
          <div className="mt-6 flex items-center justify-center gap-3">
            <a href="https://github.com/AaronWong1999/museinst" className="h-11 px-5 inline-flex items-center text-[14px] font-medium bg-[#171717] text-white rounded-xl">
              {t.ctaSelf}
            </a>
            <a href="https://museinst.com" className="h-11 px-5 inline-flex items-center text-[14px] font-medium border border-[#E5E5E5] rounded-xl hover:bg-[#FAFAFA]">
              {zh ? "或者直接用托管版" : "Or use hosted directly"}
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-[#EFEFEF] py-8 text-center text-[12px] text-[#A3A3A3]">
        MuseInst · Apache 2.0 {zh ? "开源" : "open source"} · {zh ? "部署在你自己的 Cloudflare 账号" : "Your Cloudflare account"} ·{" "}
        <span className="inline-flex items-center gap-1">
          <IconTelegram size={12} /> Telegram
        </span>{" "}
        ·{" "}
        <span className="inline-flex items-center gap-1">
          <IconWeChat size={12} /> {zh ? "微信" : "WeChat"}
        </span>
      </footer>
    </div>
  );
}
