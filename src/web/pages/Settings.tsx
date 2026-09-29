import React from "react";
import { api, patch, post } from "../api";
import { Sidebar, type Me } from "./Workspace";
import { LangToggle } from "../i18n";
import { IconWeChat, IconTelegram, IconCheck } from "../icons";

interface SettingsData {
  displayName: string;
  appearance: "light" | "dark" | "system";
  improveOptin: boolean;
  signInMethods: Array<{ channel: string; displayName: string }>;
}

interface ModelConfigData {
  provider: "workers-ai" | "custom";
  model: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  hasApiKey?: boolean;
  protocol?: "chat_completions" | "anthropic";
  limitsMode?: "auto" | "manual";
  maxContext?: number;
  maxTokens?: number;
  enableTools?: boolean;
}

interface ModelPreset {
  id: string;
  name: string;
  provider: "workers-ai";
  badge: string;
  description: string;
}

function applyTheme(mode: "light" | "dark" | "system"): void {
  const dark = mode === "dark" || (
    mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches
  );
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try {
    if (mode === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", mode);
  } catch {}
}

function Toggle({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }): React.ReactElement {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`w-11 rounded-full relative transition-colors shrink-0 ${on ? "bg-[#16A34A]" : "bg-[#D4D4D4]"}`}
      style={{ height: 26 }}
      aria-pressed={on}
    >
      <span
        className="absolute top-[3px] w-5 h-5 rounded-full bg-white transition-all"
        style={{ left: on ? 22 : 3 }}
      />
    </button>
  );
}

function ModelSettingsSection({ onFlash }: { onFlash: (message: string) => void }): React.ReactElement {
  const [config, setConfig] = React.useState<ModelConfigData | null>(null);
  const [presets, setPresets] = React.useState<ModelPreset[]>([]);
  const [mode, setMode] = React.useState<"workers-ai" | "custom">("workers-ai");
  const [selectedCfModel, setSelectedCfModel] = React.useState("@cf/zai-org/glm-5.3-flash");
  const [customName, setCustomName] = React.useState("");
  const [customBaseUrl, setCustomBaseUrl] = React.useState("");
  const [customApiKey, setCustomApiKey] = React.useState("");
  const [customProtocol, setCustomProtocol] = React.useState<"chat_completions" | "anthropic">("chat_completions");
  const [customModel, setCustomModel] = React.useState("");
  const [customEnableTools, setCustomEnableTools] = React.useState(true);
  const [manualLimits, setManualLimits] = React.useState(false);
  const [maxContext, setMaxContext] = React.useState("");
  const [maxTokens, setMaxTokens] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);
  const [saving, setSaving] = React.useState(false);

  const loadConfig = React.useCallback(() => {
    api<{ config: ModelConfigData; presets: ModelPreset[] }>("/api/model/config")
      .then((data) => {
        if (data.config) {
          setConfig(data.config);
          setMode(data.config.provider);
          setManualLimits(data.config.limitsMode === "manual");
          setMaxContext(data.config.maxContext ? String(data.config.maxContext) : "");
          setMaxTokens(data.config.maxTokens ? String(data.config.maxTokens) : "");
          if (data.config.provider === "workers-ai") {
            setSelectedCfModel(data.config.model);
          } else {
            setCustomName(data.config.name || "");
            setCustomBaseUrl(data.config.baseUrl || "");
            setCustomApiKey(data.config.apiKey || "");
            setCustomProtocol(data.config.protocol || "chat_completions");
            setCustomModel(data.config.model || "");
            setCustomEnableTools(data.config.enableTools !== false);
          }
        }
        setPresets(data.presets ?? []);
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => loadConfig(), [loadConfig]);

  const limitPayload = (): Partial<ModelConfigData> => {
    if (!manualLimits) return { limitsMode: "auto" };
    const context = Number(maxContext);
    const output = Number(maxTokens);
    return {
      limitsMode: "manual",
      ...(Number.isFinite(context) && context > 0 ? { maxContext: context } : {}),
      ...(Number.isFinite(output) && output > 0 ? { maxTokens: output } : {}),
    };
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const payload: Partial<ModelConfigData> = {
        provider: mode,
        model: mode === "custom" ? customModel : selectedCfModel,
        baseUrl: mode === "custom" ? customBaseUrl : undefined,
        apiKey: mode === "custom" ? customApiKey : undefined,
        protocol: mode === "custom" ? customProtocol : undefined,
      };
      setTestResult(await post("/api/model/test", payload));
    } catch (error: any) {
      setTestResult({ ok: false, error: error.message || String(error) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      let payload: Partial<ModelConfigData>;
      if (mode === "workers-ai") {
        payload = {
          provider: "workers-ai",
          model: selectedCfModel,
          enableTools: true,
          ...limitPayload(),
        };
      } else {
        if (!customModel.trim()) throw new Error("请填写模型名称 / ID");
        if (!customBaseUrl.trim()) throw new Error("请填写 Base URL");
        payload = {
          provider: "custom",
          name: customName.trim() || customModel.trim(),
          baseUrl: customBaseUrl.trim(),
          apiKey: customApiKey.trim(),
          protocol: customProtocol,
          model: customModel.trim(),
          enableTools: customEnableTools,
          ...limitPayload(),
        };
      }
      const result = await post<{ ok: boolean; config: ModelConfigData }>("/api/model/config", payload);
      if (result.ok) {
        setConfig(result.config);
        onFlash("模型配置已保存");
        loadConfig();
      }
    } catch (error: any) {
      setTestResult({ ok: false, error: error.message || String(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-10">
      <div className="text-[14px] font-semibold mb-3">Model provider</div>
      <div className="border border-[#E5E5E5] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[#EFEFEF]">
          <div className="grid grid-cols-2 gap-2 max-w-[360px]">
            <button
              onClick={() => setMode("workers-ai")}
              className={`h-9 rounded-lg text-[13px] ${mode === "workers-ai" ? "bg-[#171717] text-white" : "bg-[#F5F5F5]"}`}
            >
              Cloudflare Workers AI
            </button>
            <button
              onClick={() => setMode("custom")}
              className={`h-9 rounded-lg text-[13px] ${mode === "custom" ? "bg-[#171717] text-white" : "bg-[#F5F5F5]"}`}
            >
              Custom provider
            </button>
          </div>
          <div className="text-[12px] text-[#737373] mt-2">
            自托管版不做套餐限制。Custom provider 默认开放，API key 使用 Vault 加密后存储。
          </div>
        </div>

        {mode === "workers-ai" ? (
          <div className="p-4 space-y-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                onClick={() => setSelectedCfModel(preset.id)}
                className={`w-full text-left rounded-lg border p-3 ${selectedCfModel === preset.id ? "border-black" : "border-[#E5E5E5]"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium">{preset.name}</span>
                  <span className="text-[11px] bg-[#F5F5F5] rounded-full px-2 py-0.5">{preset.badge}</span>
                </div>
                <div className="text-[12px] text-[#737373] mt-1">{preset.description}</div>
                <div className="text-[11px] font-mono text-[#A3A3A3] mt-1">{preset.id}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="p-4 grid gap-3">
            <input
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder="Display name (optional)"
              className="h-10 border border-[#E5E5E5] rounded-lg px-3 text-[13px] outline-none focus:border-black"
            />
            <input
              value={customBaseUrl}
              onChange={(event) => setCustomBaseUrl(event.target.value)}
              placeholder="Base URL, e.g. https://openrouter.ai/api/v1"
              className="h-10 border border-[#E5E5E5] rounded-lg px-3 text-[13px] font-mono outline-none focus:border-black"
            />
            <input
              value={customApiKey}
              onChange={(event) => setCustomApiKey(event.target.value)}
              placeholder={config?.hasApiKey ? "已有密钥；留空或保留掩码表示不修改" : "API key"}
              type="password"
              className="h-10 border border-[#E5E5E5] rounded-lg px-3 text-[13px] font-mono outline-none focus:border-black"
            />
            <input
              value={customModel}
              onChange={(event) => setCustomModel(event.target.value)}
              placeholder="Model ID"
              className="h-10 border border-[#E5E5E5] rounded-lg px-3 text-[13px] font-mono outline-none focus:border-black"
            />
            <select
              value={customProtocol}
              onChange={(event) => setCustomProtocol(event.target.value as "chat_completions" | "anthropic")}
              className="h-10 border border-[#E5E5E5] rounded-lg px-3 text-[13px] bg-white"
            >
              <option value="chat_completions">OpenAI-compatible chat completions</option>
              <option value="anthropic">Anthropic Messages</option>
            </select>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">Tool calling</div>
                <div className="text-[12px] text-[#737373]">关闭后模型只用于纯文本任务。</div>
              </div>
              <Toggle on={customEnableTools} onChange={setCustomEnableTools} />
            </div>
          </div>
        )}

        <div className="p-4 border-t border-[#EFEFEF]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13px] font-medium">Manual limits</div>
              <div className="text-[12px] text-[#737373] mt-0.5">
                默认关闭，由 Provider / 模型决定上下文和最大输出；只有你明确需要安全上限时才打开。
              </div>
            </div>
            <Toggle on={manualLimits} onChange={setManualLimits} />
          </div>
          {manualLimits && (
            <div className="grid grid-cols-2 gap-2 mt-3">
              <input
                value={maxContext}
                onChange={(event) => setMaxContext(event.target.value)}
                placeholder="Max context (optional)"
                inputMode="numeric"
                className="h-10 border border-[#E5E5E5] rounded-lg px-3 text-[13px]"
              />
              <input
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
                placeholder="Max output (optional)"
                inputMode="numeric"
                className="h-10 border border-[#E5E5E5] rounded-lg px-3 text-[13px]"
              />
            </div>
          )}
        </div>

        <div className="p-4 border-t border-[#EFEFEF] flex items-center gap-2">
          <button
            onClick={handleTest}
            disabled={testing}
            className="h-9 px-4 border border-[#E5E5E5] rounded-lg text-[13px] disabled:opacity-50"
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="h-9 px-4 bg-[#171717] text-white rounded-lg text-[13px] disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save model"}
          </button>
          {testResult && (
            <span className={`text-[12px] ${testResult.ok ? "text-[#16A34A]" : "text-[#DC2626]"}`}>
              {testResult.ok
                ? `✓ ${testResult.latencyMs ?? ""}${testResult.latencyMs ? "ms" : ""}`
                : testResult.error || "连接失败"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage({ nav }: { nav: (to: string) => void }): React.ReactElement {
  const [me, setMe] = React.useState<Me | null>(null);
  const [settings, setSettings] = React.useState<SettingsData | null>(null);
  const [nameDraft, setNameDraft] = React.useState("");
  const [saved, setSaved] = React.useState("");
  const [confirmText, setConfirmText] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(() => { location.href = "/"; });
    api<SettingsData>("/api/settings").then((data) => {
      setSettings(data);
      setNameDraft(data.displayName);
      applyTheme(data.appearance);
    }).catch(() => {});
  }, []);

  const flash = (message: string) => {
    setSaved(message);
    setTimeout(() => setSaved(""), 1600);
  };

  const save = async (part: Partial<SettingsData>) => {
    setSettings((previous) => previous ? { ...previous, ...part } : previous);
    await patch("/api/settings", part);
    if (part.appearance) applyTheme(part.appearance);
    flash("已保存");
  };

  const deleteAccount = async () => {
    setDeleting(true);
    const response = await fetch("/api/me?confirm=DELETE", { method: "DELETE" });
    if (response.ok) location.href = "/";
    else setDeleting(false);
  };

  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar nav={nav} me={me} active="settings" />
      <main className="flex-1 min-w-0">
        <div className="h-14 border-b border-[#E5E5E5] flex items-center px-6 gap-3">
          <span className="text-[14px]">Settings</span>
          <span className="ml-auto"><LangToggle /></span>
          {saved && (
            <span className="text-[13px] text-[#16A34A] flex items-center gap-1">
              <IconCheck size={14} />{saved}
            </span>
          )}
        </div>
        <div className="max-w-[620px] mx-auto px-4 pt-10 pb-24">
          <h1 className="wordmark text-[40px]">Settings</h1>

          <div className="mt-10">
            <div className="text-[14px] font-semibold mb-3">Name</div>
            <div className="flex gap-2">
              <input
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                placeholder="怎么称呼你"
                maxLength={40}
                className="flex-1 h-11 border border-[#E5E5E5] rounded-[10px] px-3.5 text-[14px] outline-none focus:border-black"
              />
              <button
                onClick={() => save({ displayName: nameDraft })}
                className="h-11 px-4 text-[14px] font-medium bg-[#171717] text-white rounded-[10px]"
              >
                保存
              </button>
            </div>
          </div>

          <div className="mt-10">
            <div className="text-[14px] font-semibold mb-3">Sign-in methods</div>
            <div className="border border-[#E5E5E5] rounded-xl divide-y divide-[#EFEFEF]">
              {settings?.signInMethods?.length ? settings.signInMethods.map((method) => (
                <div key={`${method.channel}:${method.displayName}`} className="p-4 flex items-center gap-3">
                  {method.channel === "wechat" ? <IconWeChat size={18} /> : <IconTelegram size={18} />}
                  <div className="flex-1">
                    <div className="text-[14px] font-medium">
                      {method.channel === "wechat" ? "微信（iLink）" : method.channel}
                    </div>
                    <div className="text-[12px] text-[#737373]">{method.displayName || "已绑定"}</div>
                  </div>
                </div>
              )) : (
                <div className="p-4 text-[13px] text-[#737373]">还没有绑定渠道。</div>
              )}
              <div className="p-4">
                <button
                  onClick={() => nav("/workspace/connect")}
                  className="text-[13px] underline text-[#737373] hover:text-black"
                >
                  管理渠道 →
                </button>
              </div>
            </div>
          </div>

          <ModelSettingsSection onFlash={flash} />

          <div className="mt-10">
            <div className="text-[14px] font-semibold mb-3">Appearance</div>
            <div className="border border-[#E5E5E5] rounded-xl p-1.5 grid grid-cols-3 gap-1.5 max-w-[320px]">
              {(["light", "dark", "system"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => save({ appearance: mode })}
                  className={`h-9 rounded-lg text-[13px] ${settings?.appearance === mode ? "bg-[#171717] text-white font-medium" : "text-[#737373] hover:bg-[#F0F0F0]"}`}
                >
                  {mode === "light" ? "浅色" : mode === "dark" ? "深色" : "跟随系统"}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-10">
            <div className="text-[14px] font-semibold mb-3">Account management</div>
            <div className="border border-[#FEF2F2] rounded-xl p-4">
              <div className="text-[14px] font-medium text-[#DC2626]">Delete account</div>
              <div className="text-[13px] text-[#737373] mt-1">
                永久删除本实例中属于你的会话、记忆、渠道绑定、Vault、连接器授权、任务记录与位置历史。不可恢复。
              </div>
              {!deleting ? (
                <button
                  onClick={() => setDeleting(true)}
                  className="mt-3 h-9 px-4 text-[13px] font-medium rounded-lg bg-[#FEF2F2] text-[#DC2626]"
                >
                  删除我的账户…
                </button>
              ) : (
                <div className="mt-3 flex gap-2">
                  <input
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    placeholder="输入 DELETE 确认"
                    className="h-9 w-40 border border-[#E5E5E5] rounded-lg px-3 text-[13px] outline-none focus:border-[#DC2626]"
                  />
                  <button
                    disabled={confirmText !== "DELETE"}
                    onClick={deleteAccount}
                    className="h-9 px-4 text-[13px] font-medium rounded-lg bg-[#DC2626] text-white disabled:opacity-40"
                  >
                    永久删除
                  </button>
                  <button
                    onClick={() => { setDeleting(false); setConfirmText(""); }}
                    className="h-9 px-3 text-[13px] text-[#737373]"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
