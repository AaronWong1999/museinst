import React from "react";
import { useLang } from "../i18n";

interface SetupStatus {
  initialized: boolean;
  authenticated: boolean;
  claimable?: boolean;
}

type Phase = "loading" | "claim" | "key" | "recovery" | "claimed" | "error";

export default function Setup(): React.ReactElement {
  const { lang } = useLang();
  const zh = lang === "zh";
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [adminKey, setAdminKey] = React.useState("");
  const [recoveryKey, setRecoveryKey] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    fetch("/api/setup/status", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`http_${response.status}`);
        return response.json() as Promise<SetupStatus>;
      })
      .then((data) => {
        if (data.authenticated) {
          location.replace("/workspace");
          return;
        }
        setPhase(data.initialized ? "recovery" : data.claimable ? "claim" : "key");
      })
      .catch(() => setPhase("error"));
  }, []);

  const openOwnerSession = async (key: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "x-admin-key": key } : {}) },
        body: "{}",
      });
      const data = await response.json().catch(() => ({})) as { error?: string; recoveryKey?: string };
      if (!response.ok) {
        if (response.status === 409) throw new Error(zh ? "这个 Agent 刚刚已经被认领了。" : "This agent was just claimed.");
        if (response.status === 401) throw new Error(zh ? "密钥不正确。" : "That key is not correct.");
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      if (data.recoveryKey) {
        setRecoveryKey(data.recoveryKey);
        setPhase("claimed");
        setBusy(false);
        return;
      }
      location.replace("/workspace");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
    } catch { /* ignore */ }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <main className="w-full max-w-[440px] text-center">
        <div className="wordmark text-[42px]">MuseInst</div>
        {children}
      </main>
    </div>
  );

  if (phase === "loading") {
    return shell(<div className="mt-3 text-[13px] text-[#737373]">{zh ? "正在唤醒…" : "Waking up…"}</div>);
  }

  if (phase === "error") {
    return shell(
      <>
        <div className="mt-4 text-[14px] text-[#DC2626]">
          {zh ? "读不到部署状态。数据库迁移可能还在进行，稍等几秒再试。" : "Could not read this deployment yet. The database migration may still be running; try again in a few seconds."}
        </div>
        <button onClick={() => location.reload()} className="mt-5 h-10 px-4 rounded-lg bg-[#171717] text-white text-[13px]">
          {zh ? "重试" : "Retry"}
        </button>
      </>,
    );
  }

  if (phase === "claim") {
    return shell(
      <>
        <div className="mt-3 text-[15px] text-[#737373]">
          {zh ? "部署好了。它在等它的主人。" : "Deployed. It is waiting for its owner."}
        </div>
        <button
          onClick={() => void openOwnerSession("")}
          disabled={busy}
          className="mt-10 w-full h-14 rounded-2xl bg-[#171717] text-white text-[16px] font-medium hover:bg-black disabled:opacity-50 transition-transform active:scale-[.98]"
        >
          {busy ? (zh ? "正在认领…" : "Claiming…") : (zh ? "认领我的 Agent" : "Claim my agent")}
        </button>
        {message && <div className="mt-3 text-[13px] text-[#DC2626]">{message}</div>}
        <div className="mt-4 text-[12px] text-[#A3A3A3]">
          {zh ? "数据和密钥都在你自己的 Cloudflare 账号里。" : "Data and keys stay in your own Cloudflare account."}
        </div>
      </>,
    );
  }

  if (phase === "claimed") {
    return shell(
      <>
        <div className="mt-3 text-[15px] text-[#737373]">{zh ? "它现在是你的了。" : "It's yours."}</div>
        <div className="mt-8 border border-[#E5E5E5] rounded-2xl p-5 text-left">
          <div className="text-[13px] font-semibold">{zh ? "恢复密钥" : "Recovery key"}</div>
          <div className="mt-1 text-[12.5px] leading-5 text-[#737373]">
            {zh ? "换浏览器或清了 Cookie 时用它找回。只显示这一次，存进密码管理器。" : "Use it on another browser or after clearing cookies. Shown once; keep it in your password manager."}
          </div>
          <button onClick={() => void copyKey()} className="mt-3 w-full text-left font-mono text-[12.5px] break-all bg-[#FAFAFA] border border-[#EFEFEF] rounded-lg px-3 py-2.5 hover:border-[#D4D4D4]">
            {recoveryKey}
          </button>
          <div className="mt-1.5 text-[12px] text-[#A3A3A3]">{copied ? (zh ? "已复制" : "Copied") : (zh ? "点一下复制" : "Tap to copy")}</div>
        </div>
        <button
          onClick={() => location.replace("/chat")}
          className="mt-5 w-full h-12 rounded-xl bg-[#171717] text-white text-[15px] font-medium hover:bg-black"
        >
          {zh ? "开始对话 →" : "Start talking →"}
        </button>
      </>,
    );
  }

  const recovery = phase === "recovery";
  return shell(
    <>
      <div className="mt-3 text-[14px] text-[#737373]">
        {recovery
          ? (zh ? "输入 ADMIN_KEY 或恢复密钥，回到你的 Agent。" : "Enter your ADMIN_KEY or recovery key to get back in.")
          : (zh ? "认领时间已过。输入 ADMIN_KEY，或在 Cloudflare 里重新部署一次再打开这个页面。" : "The claim window has closed. Enter your ADMIN_KEY, or redeploy in Cloudflare and open this page again.")}
      </div>
      <input
        value={adminKey}
        onChange={(event) => setAdminKey(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !busy && adminKey.trim()) void openOwnerSession(adminKey.trim()); }}
        type="password"
        autoComplete="off"
        placeholder={zh ? "ADMIN_KEY 或恢复密钥" : "ADMIN_KEY or recovery key"}
        className="mt-8 w-full h-12 px-3 border border-[#E5E5E5] rounded-xl text-[14px] font-mono outline-none focus:border-black"
      />
      <button
        onClick={() => adminKey.trim() && void openOwnerSession(adminKey.trim())}
        disabled={busy || !adminKey.trim()}
        className="mt-3 w-full h-12 rounded-xl bg-[#171717] text-white text-[15px] font-medium disabled:opacity-40"
      >
        {busy ? (zh ? "正在打开…" : "Opening…") : (zh ? "进入" : "Open")}
      </button>
      {message && <div className="mt-3 text-[13px] text-[#DC2626]">{message}</div>}
    </>,
  );
}
