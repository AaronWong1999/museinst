import React from "react";
import { api } from "../api";
import { Sidebar, type Me } from "./Workspace";
import { IconWeChat, IconTelegram, IconCopy } from "../icons";
import { LangToggle } from "../i18n";

interface ChannelStatus {
  bound: boolean;
  channels: string[];
  wechatActive: boolean;
}

interface TelegramLink {
  configured: boolean;
  link?: string;
  svg?: string | null;
  bindCode: string;
}

interface WechatBind {
  bindCode: string;
  howTo: string;
}

export default function Connect({ nav }: { nav: (to: string) => void }): React.ReactElement {
  const initialTab = new URLSearchParams(location.search).get("tab") === "telegram"
    ? "telegram"
    : "wechat";
  const [tab, setTab] = React.useState<"wechat" | "telegram">(initialTab);
  const [me, setMe] = React.useState<Me | null>(null);
  const [status, setStatus] = React.useState<ChannelStatus | null>(null);
  const [telegram, setTelegram] = React.useState<TelegramLink | null>(null);
  const [wechat, setWechat] = React.useState<WechatBind | null>(null);
  const [copied, setCopied] = React.useState("");
  const [error, setError] = React.useState("");

  const refresh = React.useCallback(async () => {
    const next = await api<ChannelStatus>("/api/channels/status");
    setStatus(next);
    return next;
  }, []);

  React.useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(() => { location.href = "/"; });
    refresh().catch((err) => setError(String(err?.message ?? err)));
  }, [refresh]);

  React.useEffect(() => {
    if (tab === "telegram") {
      api<TelegramLink>("/api/channels/telegram-link")
        .then(setTelegram)
        .catch((err) => setError(String(err?.message ?? err)));
    } else {
      api<WechatBind>("/api/channels/wechat-bind")
        .then(setWechat)
        .catch((err) => setError(String(err?.message ?? err)));
    }
  }, [tab]);

  React.useEffect(() => {
    const timer = window.setInterval(() => refresh().catch(() => {}), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const copy = (value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopied(value);
    window.setTimeout(() => setCopied(""), 1500);
  };

  const wechatBound = status?.channels.includes("wechat") ?? false;
  const telegramBound = status?.channels.includes("telegram") ?? false;

  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar nav={nav} me={me} active="workspace" />
      <main className="flex-1 min-w-0">
        <div className="h-14 border-b border-[#E5E5E5] flex items-center px-6">
          <span className="text-[14px] font-medium">Channel binding</span>
          <span className="ml-auto"><LangToggle /></span>
        </div>

        <div className="max-w-[580px] mx-auto px-4 pt-10 pb-24 text-center">
          <h1 className="wordmark text-[36px]">Start texting MuseInst</h1>
          <p className="text-[14px] text-[#737373] mt-2">
            微信和 Telegram 都连接到同一个个人 Agent，共享记忆、任务和授权状态。
          </p>

          <div className="mt-7 grid grid-cols-2 border-b border-[#EFEFEF] max-w-[380px] mx-auto">
            <button
              onClick={() => setTab("wechat")}
              className={`h-11 flex items-center justify-center gap-2 text-[14px] relative ${tab === "wechat" ? "border-b-2 border-black font-semibold" : "text-[#737373]"}`}
            >
              <IconWeChat size={18} /> 微信
              {wechatBound && <span className="text-[11px] text-[#15803D]">已绑定</span>}
            </button>
            <button
              onClick={() => setTab("telegram")}
              className={`h-11 flex items-center justify-center gap-2 text-[14px] relative ${tab === "telegram" ? "border-b-2 border-black font-semibold" : "text-[#737373]"}`}
            >
              <IconTelegram size={18} /> Telegram
              {telegramBound && <span className="text-[11px] text-[#15803D]">已绑定</span>}
            </button>
          </div>

          {error && (
            <div className="mt-6 text-[13px] text-[#DC2626] border border-[#FECACA] bg-[#FEF2F2] rounded-lg p-3">
              {error}
            </div>
          )}

          {tab === "wechat" ? (
            <div className="mt-8">
              {!status?.wechatActive ? (
                <div className="border border-[#FDE68A] bg-[#FFFBEB] rounded-2xl p-6 text-left">
                  <div className="text-[15px] font-semibold text-[#92400E]">先让你的微信账号上线</div>
                  <div className="text-[13px] text-[#92400E] mt-2 leading-relaxed">
                    当前实例还没有活动的 WeChatPoller。打开 Deployment 页面，用部署者 ADMIN_KEY 登录后扫描一次微信二维码。
                    这只是让你自己的微信号连接到你自己的 Cloudflare Durable Object，不是平台共享机器人。
                  </div>
                  <a
                    href="/admin"
                    className="inline-flex mt-4 h-9 px-4 items-center rounded-lg bg-[#171717] text-white text-[13px]"
                  >
                    打开 Deployment →
                  </a>
                </div>
              ) : wechatBound ? (
                <div className="border border-[#BBF7D0] bg-[#F0FDF4] rounded-2xl p-7">
                  <div className="text-[24px] text-[#16A34A]">✓</div>
                  <div className="text-[15px] font-semibold text-[#15803D] mt-2">微信已绑定</div>
                  <div className="text-[13px] text-[#166534] mt-2">
                    直接在微信里给已登录的 MuseInst 账号发消息即可继续使用同一个 Agent。
                  </div>
                </div>
              ) : (
                <div className="border border-[#E5E5E5] rounded-2xl p-6">
                  <div className="text-[14px] font-semibold">发送绑定命令</div>
                  <div className="text-[13px] text-[#737373] mt-2">
                    在微信里向你刚刚登录的 MuseInst 账号发送下面这条消息：
                  </div>
                  <div className="mt-4 flex items-center gap-2 bg-[#FAFAFA] border border-[#E5E5E5] rounded-xl p-3">
                    <code className="flex-1 text-[14px] text-left break-all">/bind {wechat?.bindCode ?? "…"}</code>
                    {wechat?.bindCode && (
                      <button onClick={() => copy(`/bind ${wechat.bindCode}`)} className="text-[12px] flex items-center gap-1">
                        <IconCopy size={14} />{copied ? "已复制" : "复制"}
                      </button>
                    )}
                  </div>
                  <div className="text-[12px] text-[#A3A3A3] mt-3">
                    绑定成功后本页会自动更新；不需要重新登录微信。
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-8">
              {telegramBound ? (
                <div className="border border-[#BBF7D0] bg-[#F0FDF4] rounded-2xl p-7">
                  <div className="text-[24px] text-[#16A34A]">✓</div>
                  <div className="text-[15px] font-semibold text-[#15803D] mt-2">Telegram 已绑定</div>
                  <div className="text-[13px] text-[#166534] mt-2">
                    继续给你的自有 Bot 发消息即可。Bot token 只来自 config/openinst.config.json。
                  </div>
                </div>
              ) : telegram?.configured === false ? (
                <div className="border border-[#FDE68A] bg-[#FFFBEB] rounded-2xl p-6 text-left">
                  <div className="text-[15px] font-semibold text-[#92400E]">Telegram 尚未启用</div>
                  <div className="text-[13px] text-[#92400E] mt-2 leading-relaxed">
                    在 config/openinst.config.json 中设置 channels.telegram.enabled、botToken 和 webhookSecret，重新执行 npm run deploy。
                    部署脚本会自动 getMe 并设置 webhook，不需要在网页再填一遍 token。
                  </div>
                </div>
              ) : (
                <div className="border border-[#E5E5E5] rounded-2xl p-6">
                  {telegram?.svg && (
                    <div
                      className="w-[240px] h-[240px] mx-auto"
                      dangerouslySetInnerHTML={{ __html: telegram.svg }}
                    />
                  )}
                  <div className="text-[14px] font-semibold mt-4">打开你的 Bot 完成绑定</div>
                  {telegram?.link && (
                    <div className="mt-4 flex items-center gap-2 bg-[#FAFAFA] border border-[#E5E5E5] rounded-xl p-3">
                      <a href={telegram.link} target="_blank" rel="noreferrer" className="flex-1 text-[13px] text-blue-600 underline truncate text-left">
                        {telegram.link.replace("https://", "")}
                      </a>
                      <button onClick={() => copy(telegram.link!)} className="text-[12px] flex items-center gap-1">
                        <IconCopy size={14} />{copied ? "已复制" : "复制"}
                      </button>
                    </div>
                  )}
                  <div className="text-[12px] text-[#737373] mt-3">
                    Bot 收到 /start 后会消费一次性绑定码，并给你返回登录链接。
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
