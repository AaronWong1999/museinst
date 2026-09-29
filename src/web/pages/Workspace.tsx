import React from "react";
import { api, post } from "../api";
import { LangToggle } from "../i18n";
import {
  IconWeChat,
  IconTelegram,
  IconGoogle,
  IconGitHub,
  IconFeishu,
  IconMail,
  IconWorkspace,
  IconVault,
  IconTasks,
  IconRecipes,
  IconSettings,
  IconChevron,
  IconCheck,
  IconLocation,
} from "../icons";

export interface Me {
  userId: string;
  workspaceId: string;
  displayName: string;
  createdAt?: number;
  bindings: Array<{ channel: string; external_id: string; display_name: string | null }>;
  channels: {
    telegram: { configured: boolean; username: string | null };
    wechat: { configured: boolean };
  };
  connections: Array<{
    provider: string;
    account_label: string;
    expires_at: number | null;
    scopes?: string;
  }>;
  googleEmail: string | null;
  vaultCount: number;
  bindCode: string;
  connectorsAvailable: {
    google: boolean;
    feishu: boolean;
    lark: boolean;
    github: boolean;
  };
}

interface UsageData {
  month: string;
  currentModel?: {
    name: string;
    id: string;
    provider: "workers-ai" | "custom";
    maxContext?: number;
    status?: string;
  };
  totals: {
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
    browserMs: number;
    tasksOk: number;
    tasksFail: number;
    totalTasks: number;
  };
}

export function Sidebar({
  nav,
  me,
  active,
}: {
  nav: (to: string) => void;
  me: Me | null;
  active: string;
}): React.ReactElement {
  const items = [
    { id: "chat", label: "Chat", icon: IconWorkspace, to: "/chat" },
    { id: "workspace", label: "Workspace", icon: IconWorkspace, to: "/workspace" },
    { id: "vault", label: "Vault", icon: IconVault, to: "/vault" },
    { id: "tasks", label: "Tasks", icon: IconTasks, to: "/tasks" },
    { id: "recipes", label: "Recipes", icon: IconRecipes, to: "/recipes" },
    { id: "settings", label: "Settings", icon: IconSettings, to: "/settings" },
  ];
  const channelLabel = me?.bindings.some((binding) => binding.channel === "wechat")
    ? "微信已绑定"
    : me?.bindings.some((binding) => binding.channel === "telegram")
      ? "Telegram 已绑定"
      : "未绑定渠道";

  return (
    <aside className="w-[240px] shrink-0 bg-[#FAFAFA] border-r border-[#E5E5E5] h-screen sticky top-0 flex flex-col">
      <div className="px-6 pt-5 pb-4">
        <span className="wordmark text-[26px]">MuseInst</span>
      </div>
      <nav className="px-3 space-y-0.5">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => nav(item.to)}
            className={`w-full flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[14px] ${
              active === item.id
                ? "bg-[#F0F0F0] font-medium"
                : "text-[#171717] hover:bg-[#F0F0F0]/60"
            }`}
          >
            <item.icon size={17} />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="mt-auto p-4">
        <button
          onClick={async () => {
            await fetch("/api/session/logout", { method: "POST" }).catch(() => {});
            location.href = "/";
          }}
          className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-[#F0F0F0]/60 text-left"
        >
          <div className="w-8 h-8 rounded-full bg-[#171717] text-white flex items-center justify-center text-[13px]">
            {(me?.displayName || "A").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium truncate">{me?.displayName || "我"}</div>
            <div className="text-[12px] text-[#737373] truncate">{channelLabel}</div>
          </div>
          <IconChevron size={16} />
        </button>
      </div>
    </aside>
  );
}

function SectionTitle({ title, right }: { title: string; right?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="text-[14px] font-semibold">{title}</span>
      {right}
    </div>
  );
}

function ConnectorRow({
  icon,
  title,
  detail,
  connected,
  enabled,
  onConnect,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  connected: boolean;
  enabled: boolean;
  onConnect: () => void;
}): React.ReactElement {
  return (
    <div className="p-4 flex items-center gap-3 border-b border-[#EFEFEF] last:border-b-0">
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold">{title}</div>
        <div className="text-[13px] text-[#737373] truncate">{detail}</div>
      </div>
      {connected ? (
        <span className="text-[12px] text-[#16A34A] flex items-center gap-1">
          <IconCheck size={14} /> 已连接
        </span>
      ) : (
        <button
          onClick={onConnect}
          disabled={!enabled}
          className="h-8 px-3.5 text-[13px] font-medium border border-[#E5E5E5] rounded-lg hover:bg-[#FAFAFA] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {enabled ? "Connect" : "未配置"}
        </button>
      )}
    </div>
  );
}

function LocationCard(): React.ReactElement {
  const [state, setState] = React.useState<{
    hasLocation: boolean;
    last?: { place?: string; ageMinutes?: number };
  } | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api<any>("/api/locations").then(setState).catch(() => setState({ hasLocation: false }));
  }, []);

  const share = () => {
    if (!navigator.geolocation) return;
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          await post("/api/locations", {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
          setState(await api<any>("/api/locations"));
        } finally {
          setBusy(false);
        }
      },
      () => setBusy(false),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  return (
    <div className="mt-10">
      <SectionTitle title="Location" />
      <div className="border border-[#E5E5E5] rounded-xl p-4 flex items-center gap-3">
        <IconLocation size={19} />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-medium">
            {state?.hasLocation ? state.last?.place || "已共享最近位置" : "尚未共享位置"}
          </div>
          <div className="text-[12px] text-[#737373] mt-0.5">
            {state?.hasLocation && state.last?.ageMinutes !== undefined
              ? `${state.last.ageMinutes} 分钟前更新`
              : "只保存在你自己的 Cloudflare 实例中"}
          </div>
        </div>
        <button
          onClick={share}
          disabled={busy}
          className="h-8 px-3 text-[13px] border border-[#E5E5E5] rounded-lg disabled:opacity-50"
        >
          {busy ? "定位中…" : "共享当前位置"}
        </button>
      </div>
    </div>
  );
}

export default function Workspace({ nav }: { nav: (to: string) => void }): React.ReactElement {
  const [me, setMe] = React.useState<Me | null>(null);
  const [usage, setUsage] = React.useState<UsageData | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    api<Me>("/api/me").then(setMe).catch((err) => setError(String(err?.message ?? err)));
    api<UsageData>("/api/usage").then(setUsage).catch(() => {});
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center max-w-[420px] px-4">
          <div className="wordmark text-[28px]">MuseInst</div>
          <div className="text-[14px] text-[#737373] mt-3">Owner Session 已失效或当前浏览器尚未登录。</div>
          <button onClick={() => nav("/")} className="mt-4 text-[14px] underline">
            使用 ADMIN_KEY 恢复 Owner Session
          </button>
        </div>
      </div>
    );
  }

  const hasConnection = (provider: string) =>
    Boolean(me?.connections.some((connection) => connection.provider === provider));
  const wechatBound = Boolean(me?.bindings.some((binding) => binding.channel === "wechat"));
  const telegramBound = Boolean(me?.bindings.some((binding) => binding.channel === "telegram"));

  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar nav={nav} me={me} active="workspace" />
      <main className="flex-1 min-w-0">
        <div className="h-14 border-b border-[#E5E5E5] flex items-center px-6 gap-3">
          <span className="text-[14px]">Workspace</span>
          <span className="ml-auto"><LangToggle /></span>
        </div>

        <div className="max-w-[620px] mx-auto px-4 pt-10 pb-24">
          <div className="wordmark text-[40px] text-center">MuseInst</div>

          {me && me.bindings.length === 0 && (
            <button
              onClick={() => nav("/workspace/connect")}
              className="mt-6 w-full text-left bg-[#FFFBEB] border border-[#FDE68A] rounded-xl p-4 text-[13.5px] text-[#92400E] hover:bg-[#FEF3C7]"
            >
              先绑定微信或 Telegram。两个渠道会连接到同一个个人 Agent，并共享记忆和任务状态。
            </button>
          )}

          <div className="mt-10">
            <SectionTitle
              title="Contact"
              right={(
                <button
                  onClick={() => nav("/workspace/connect")}
                  className="text-[13px] text-[#737373] hover:text-black"
                >
                  管理绑定
                </button>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => nav("/workspace/connect?tab=wechat")}
                className="h-[52px] border border-[#E5E5E5] rounded-[10px] flex items-center justify-center gap-3 text-[14px] font-medium hover:bg-[#FAFAFA]"
              >
                <IconWeChat />
                {wechatBound ? "微信 · 已绑定 ✓" : "绑定微信 +"}
              </button>
              <button
                onClick={() => nav("/workspace/connect?tab=telegram")}
                className="h-[52px] border border-[#E5E5E5] rounded-[10px] flex items-center justify-center gap-3 text-[14px] font-medium hover:bg-[#FAFAFA]"
              >
                <IconTelegram />
                {telegramBound ? "Telegram · 已绑定 ✓" : "绑定 Telegram +"}
              </button>
            </div>
          </div>

          <LocationCard />

          <div className="mt-10">
            <SectionTitle title="Connectors" />
            <div className="border border-[#E5E5E5] rounded-xl overflow-hidden">
              <ConnectorRow
                icon={<IconGoogle />}
                title="Google Workspace"
                detail={me?.googleEmail || "Gmail、日历、Drive、Docs、Sheets 等"}
                connected={hasConnection("google")}
                enabled={Boolean(me?.connectorsAvailable.google)}
                onConnect={() => { location.href = "/api/connectors/google/start"; }}
              />
              <ConnectorRow
                icon={<IconFeishu />}
                title="Feishu"
                detail="日历、任务、文档、表格、Base 与联系人"
                connected={hasConnection("feishu")}
                enabled={Boolean(me?.connectorsAvailable.feishu)}
                onConnect={() => { location.href = "/api/connectors/feishu/start"; }}
              />
              <ConnectorRow
                icon={<IconFeishu />}
                title="Lark"
                detail="国际版 Lark 日历、任务、文档、表格与 Base"
                connected={hasConnection("lark")}
                enabled={Boolean(me?.connectorsAvailable.lark)}
                onConnect={() => { location.href = "/api/connectors/lark/start"; }}
              />
              <ConnectorRow
                icon={<IconGitHub />}
                title="GitHub"
                detail="仓库、Issue、Pull Request 与代码读取"
                connected={hasConnection("github")}
                enabled={Boolean(me?.connectorsAvailable.github)}
                onConnect={() => { location.href = "/api/connectors/github/start"; }}
              />
              <ConnectorRow
                icon={<IconMail />}
                title="QQ / 163 / IMAP Mail"
                detail={me?.vaultCount ? `Vault 中已有 ${me.vaultCount} 条凭据` : "使用邮箱授权码，通过 Vault 加密保存"}
                connected={Boolean(me?.vaultCount)}
                enabled={true}
                onConnect={() => nav("/vault?add=mail")}
              />
            </div>
          </div>

          <div className="mt-10">
            <SectionTitle
              title="Usage"
              right={(
                <button
                  onClick={() => nav("/settings")}
                  className="text-[13px] text-[#737373] hover:text-black"
                >
                  模型设置
                </button>
              )}
            />
            <div className="border border-[#E5E5E5] rounded-xl p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[14px] font-medium">
                    {usage?.currentModel?.name || "Loading model…"}
                  </div>
                  <div className="text-[12px] text-[#737373] mt-1">
                    {usage?.currentModel?.provider || ""}
                    {usage?.currentModel?.maxContext
                      ? ` · 手动上下文上限 ${usage.currentModel.maxContext.toLocaleString()}`
                      : " · Provider-managed limits"}
                  </div>
                </div>
                <div className="text-[12px] text-[#737373]">{usage?.month || ""}</div>
              </div>
              <div className="grid grid-cols-4 gap-3 mt-4 text-center">
                <div className="rounded-lg bg-[#FAFAFA] py-3">
                  <div className="text-[15px] font-semibold">{(usage?.totals.tokensIn ?? 0).toLocaleString()}</div>
                  <div className="text-[11px] text-[#737373] mt-1">Input tokens</div>
                </div>
                <div className="rounded-lg bg-[#FAFAFA] py-3">
                  <div className="text-[15px] font-semibold">{(usage?.totals.tokensOut ?? 0).toLocaleString()}</div>
                  <div className="text-[11px] text-[#737373] mt-1">Output tokens</div>
                </div>
                <div className="rounded-lg bg-[#FAFAFA] py-3">
                  <div className="text-[15px] font-semibold">{Math.round((usage?.totals.browserMs ?? 0) / 60_000)}</div>
                  <div className="text-[11px] text-[#737373] mt-1">Browser min</div>
                </div>
                <div className="rounded-lg bg-[#FAFAFA] py-3">
                  <div className="text-[15px] font-semibold">{usage?.totals.totalTasks ?? 0}</div>
                  <div className="text-[11px] text-[#737373] mt-1">Tasks</div>
                </div>
              </div>
              <div className="text-[12px] text-[#737373] mt-3">
                这里只统计实际使用量，不做套餐、点数或余额门槛；Cloudflare / Provider 的账单以你的账号为准。
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
