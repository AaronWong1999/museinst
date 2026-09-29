import React from "react";
import { LangToggle } from "../i18n";

async function adminApi<T = any>(path: string, init?: RequestInit): Promise<T> {
  const key = localStorage.getItem("oi_admin") ?? "";
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-key": key,
      ...(init?.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as any).error ?? `http_${response.status}`);
  return data as T;
}

export default function Admin(): React.ReactElement {
  const [key, setKey] = React.useState(localStorage.getItem("oi_admin") ?? "");
  const [message, setMessage] = React.useState("");
  const [telegramStatus, setTelegramStatus] = React.useState("");
  const [qrSvg, setQrSvg] = React.useState<string | null>(null);
  const [qrId, setQrId] = React.useState("");
  const [wechatStatus, setWechatStatus] = React.useState("");
  const [polling, setPolling] = React.useState(false);

  const flash = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 4000);
  };

  const loadTelegramStatus = async () => {
    try {
      const status = await adminApi<any>("/admin/telegram/status");
      if (!status.configured) {
        setTelegramStatus("未启用。请在 config/openinst.config.json 中开启 Telegram 后重新部署。");
        return;
      }
      setTelegramStatus(
        `bot ${status.botId ?? "?"} @${status.username ?? "?"} · ` +
        `webhook ${status.healthy ? "healthy" : `drift(${status.webhookUrl || "unset"})`} · ` +
        `pending ${status.pendingUpdateCount ?? "-"} · queue ${status.queueDepth ?? 0}` +
        (status.lastTelegramError ? ` · lastError: ${status.lastTelegramError}` : ""),
      );
    } catch (error: any) {
      setTelegramStatus(`查询失败：${error.message}`);
    }
  };

  const repairTelegram = async () => {
    try {
      const result = await adminApi<any>("/admin/telegram/repair", { method: "POST" });
      flash(`✅ Telegram @${result.username ?? "bot"} 已重新初始化`);
      await loadTelegramStatus();
    } catch (error: any) {
      flash(`Telegram 修复失败：${error.message}`);
    }
  };

  const startWechat = async () => {
    try {
      const result = await adminApi<{ id: string; svg: string }>("/admin/wechat/qr", {
        method: "POST",
      });
      setQrSvg(result.svg);
      setQrId(result.id);
      setPolling(true);
    } catch (error: any) {
      flash(`获取二维码失败：${error.message}`);
    }
  };

  React.useEffect(() => {
    if (!polling || !qrId) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await adminApi<{ status: string; botId?: string }>(
          `/admin/wechat/poll/${qrId}`,
        );
        if (result.status === "confirmed") {
          setPolling(false);
          setQrSvg(null);
          flash("✅ 微信账号已连接，WeChatPoller 已启动");
        } else if (result.status === "expired") {
          setPolling(false);
          setQrSvg(null);
          flash("二维码已过期，请重新生成");
        }
      } catch {
        return;
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [polling, qrId]);

  return (
    <div className="min-h-screen bg-white">
      <header className="flex items-center justify-between h-14 border-b border-[#EFEFEF] px-6">
        <span className="wordmark text-[22px]">MuseInst · Deployment</span>
        <div className="flex items-center gap-4">
          <a href="/workspace" className="text-[14px] text-[#737373] hover:text-black">Workspace</a>
          <LangToggle />
        </div>
      </header>

      <main className="max-w-[620px] mx-auto px-4 py-12 pb-24">
        <section className="border border-[#E5E5E5] rounded-xl p-5">
          <div className="text-[14px] font-semibold">ADMIN_KEY</div>
          <div className="text-[13px] text-[#737373] mt-1 leading-relaxed">
            这里仅用于浏览器向本实例的管理接口证明你是部署者。ADMIN_KEY 的真实来源仍然是
            <span className="font-mono"> config/openinst.config.json</span>，不会在网页中修改 Cloudflare 配置。
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              type="password"
              placeholder="ADMIN_KEY"
              className="flex-1 h-10 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black"
            />
            <button
              onClick={() => {
                localStorage.setItem("oi_admin", key);
                flash("已保存在当前浏览器");
              }}
              className="h-10 px-4 text-[14px] font-medium bg-[#171717] text-white rounded-lg"
            >
              保存
            </button>
          </div>
        </section>

        <section className="mt-6 border border-[#E5E5E5] rounded-xl p-5">
          <div className="text-[14px] font-semibold">Telegram</div>
          <div className="text-[13px] text-[#737373] mt-1 leading-relaxed">
            Bot Token 和 webhook secret 只在 <span className="font-mono">config/openinst.config.json</span> 中配置。
            <span className="font-mono"> npm run deploy</span> 会自动执行 getMe、保存 bot identity 并设置 webhook；这里不再保存第二份 token。
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={loadTelegramStatus}
              className="h-10 px-4 text-[14px] font-medium border border-[#E5E5E5] rounded-lg hover:bg-[#FAFAFA]"
            >
              查看状态
            </button>
            <button
              onClick={repairTelegram}
              className="h-10 px-4 text-[14px] font-medium bg-[#171717] text-white rounded-lg"
            >
              重设 Bot / Webhook
            </button>
          </div>
          {telegramStatus && (
            <div className="mt-3 text-[12px] font-mono text-[#737373] break-all">{telegramStatus}</div>
          )}
        </section>

        <section className="mt-6 border border-[#E5E5E5] rounded-xl p-5">
          <div className="text-[14px] font-semibold">微信（iLink）</div>
          <div className="text-[13px] text-[#737373] mt-1 leading-relaxed">
            这是单实例自托管模式。部署者用自己的微信号扫码一次，该账号由你自己的 Cloudflare
            Durable Object <span className="font-mono">WeChatPoller</span> 轮询；没有企业版 Container 网关或平台共享号池。
          </div>
          {!qrSvg && (
            <button
              onClick={startWechat}
              className="mt-3 h-10 px-4 text-[14px] font-medium bg-[#171717] text-white rounded-lg"
            >
              登录 / 重新绑定微信
            </button>
          )}
          {qrSvg && (
            <div className="mt-4 flex flex-col items-center">
              <div
                className="w-[240px] h-[240px] border border-[#E5E5E5] rounded-xl p-2"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
              <div className="text-[13px] text-[#737373] mt-3">微信扫码并在手机上确认</div>
            </div>
          )}
          <button
            onClick={async () => {
              try {
                const status = await adminApi<any>("/admin/wechat/status");
                if (status.configured === false) {
                  setWechatStatus("未登录微信");
                  return;
                }
                setWechatStatus(JSON.stringify(status));
              } catch (error: any) {
                setWechatStatus(`查询失败：${error.message}`);
              }
            }}
            className="mt-3 text-[13px] text-[#737373] hover:text-black underline"
          >
            查看 WeChatPoller 状态
          </button>
          {wechatStatus && (
            <div className="text-[12px] font-mono text-[#737373] mt-2 break-all">{wechatStatus}</div>
          )}
        </section>

        <section className="mt-6 border border-[#E5E5E5] rounded-xl p-5">
          <div className="text-[14px] font-semibold">OAuth / Model providers</div>
          <div className="text-[13px] text-[#737373] mt-1 leading-relaxed">
            Google、Feishu、Lark、GitHub 和自定义模型 Provider 的部署级凭据都在
            <span className="font-mono"> config/openinst.config.json</span> 配置，然后重新执行
            <span className="font-mono"> npm run deploy</span>。不要去修改生成的 Wrangler，也不要在 Cloudflare Dashboard 再维护第二套值。
          </div>
        </section>

        {message && <div className="mt-6 text-[14px]">{message}</div>}
      </main>
    </div>
  );
}
