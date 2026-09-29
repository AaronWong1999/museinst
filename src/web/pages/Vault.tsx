import React from "react";
import { api, post, del } from "../api";
import { navigate } from "../main";
import { Sidebar, type Me } from "./Workspace";
import { LangToggle } from "../i18n";
import { IconKey, IconCard } from "../icons";

interface VaultItem {
  id: string;
  kind: string;
  label: string;
  account: string;
  origin?: string;
  createdAt: number;
}

const KIND_LABEL: Record<string, string> = {
  login: "登录",
  payment: "支付卡",
  address: "地址",
  contact: "联系人",
  phone: "电话",
  identity: "证件",
  token: "邮箱授权码",
};

export default function VaultPage({ nav }: { nav: (to: string) => void }): React.ReactElement {
  const [me, setMe] = React.useState<Me | null>(null);
  const [items, setItems] = React.useState<VaultItem[] | null>(null);
  const [showAdd, setShowAdd] = React.useState(new URLSearchParams(location.search).get("add") === "mail" ? "mail" : "");
  const [csv, setCsv] = React.useState("");
  const [msg, setMsg] = React.useState("");

  const load = () => api<{ items: VaultItem[] }>("/api/vault/items").then((r) => setItems(r.items));
  React.useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(() => navigate("/"));
    load();
  }, []);

  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar nav={nav} me={me} active="vault" />
      <main className="flex-1 min-w-0">
        <div className="h-14 border-b border-[#E5E5E5] flex items-center px-6 gap-3">
          <span className="text-[14px]">Vault</span>
          <span className="ml-auto"><LangToggle /></span>
        </div>
        <div className="max-w-[620px] mx-auto px-4 pt-10 pb-24">
          <h1 className="wordmark text-[32px]">Vault</h1>
          <p className="text-[13px] text-[#737373] mt-2 leading-relaxed">
            AES-256-GCM per-workspace 加密，主密钥在你自己的 Cloudflare 账号里。Agent 只拿到不透明句柄，永远看不到明文。
          </p>

          <div className="mt-6 flex gap-2">
            <button onClick={() => setShowAdd(showAdd === "login" ? "" : "login")} className="h-8 px-3.5 text-[13px] font-medium border border-[#E5E5E5] rounded-lg hover:bg-[#FAFAFA] flex items-center gap-1.5">
              <IconKey size={14} /> 登录
            </button>
            <button onClick={() => setShowAdd(showAdd === "payment" ? "" : "payment")} className="h-8 px-3.5 text-[13px] font-medium border border-[#E5E5E5] rounded-lg hover:bg-[#FAFAFA] flex items-center gap-1.5">
              <IconCard size={14} /> 支付卡
            </button>
            <button onClick={() => setShowAdd(showAdd === "mail" ? "" : "mail")} className="h-8 px-3.5 text-[13px] font-medium border border-[#E5E5E5] rounded-lg hover:bg-[#FAFAFA] flex items-center gap-1.5">
              QQ/163 邮箱
            </button>
          </div>

          {showAdd === "login" && <AddLogin onDone={() => { setShowAdd(""); load(); }} />}
          {showAdd === "payment" && <AddPayment onDone={() => { setShowAdd(""); load(); }} />}
          {showAdd === "mail" && <AddMailbox onDone={() => { setShowAdd(""); load(); }} />}

          <div className="mt-6 border border-[#E5E5E5] rounded-xl p-4">
            <div className="text-[14px] font-medium">从 Chrome 导入密码（CSV）</div>
            <div className="text-[12px] text-[#737373] mt-1">{"chrome://password-manager/export"} 导出的 CSV 原样粘贴进来。导入后立即加密，明文不落库。</div>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={3}
              placeholder="name,url,username,password,…"
              className="mt-3 w-full text-[12px] font-mono border border-[#E5E5E5] rounded-lg p-2.5 outline-none focus:border-black"
            />
            <button
              onClick={async () => {
                if (!csv.trim()) return;
                const r = await post<{ imported: number }>("/api/vault/import-csv", { csv });
                setMsg(`✅ 已导入 ${r.imported} 条`);
                setCsv("");
                load();
              }}
              className="mt-2 h-8 px-3.5 text-[13px] font-medium bg-[#171717] text-white rounded-lg"
            >
              导入
            </button>
            {msg && <span className="ml-3 text-[13px] text-[#16A34A]">{msg}</span>}
          </div>

          <div className="mt-8 border border-[#E5E5E5] rounded-xl overflow-hidden">
            {(items ?? []).map((it, i) => (
              <div key={it.id} className={`p-4 flex items-center gap-3 ${i > 0 ? "border-t border-[#EFEFEF]" : ""}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium truncate">
                    {it.label}
                    <span className="ml-2 text-[11px] text-[#A3A3A3] font-normal">{KIND_LABEL[it.kind] ?? it.kind}</span>
                  </div>
                  <div className="text-[12px] text-[#737373] truncate">{it.account}{it.origin ? ` · ${it.origin}` : ""}</div>
                </div>
                <button
                  onClick={async () => { await del(`/api/vault/items/${it.id}`); load(); }}
                  className="text-[12px] text-[#737373] hover:text-[#DC2626]"
                >
                  删除
                </button>
              </div>
            ))}
            {items !== null && items.length === 0 && (
              <div className="p-8 text-center text-[13px] text-[#A3A3A3]">Vault 是空的。加一条登录或邮箱授权码就能开始。</div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function AddLogin({ onDone }: { onDone: () => void }): React.ReactElement {
  const [f, setF] = React.useState({ label: "", origin: "", identifier: "", password: "" });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="mt-4 border border-[#E5E5E5] rounded-xl p-4 space-y-3">
      <input value={f.label} onChange={set("label")} placeholder="名称（如 携程）" className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      <input value={f.origin} onChange={set("origin")} placeholder="站点 https://…（防钓鱼注入，必填）" className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      <input value={f.identifier} onChange={set("identifier")} placeholder="账号 / 手机号 / 邮箱" className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      <input value={f.password} onChange={set("password")} type="password" placeholder="密码" className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      <button
        onClick={async () => {
          await post("/api/vault/items", { kind: "login", label: f.label, account: f.identifier, origin: f.origin, fields: { identifier: f.identifier, password: f.password } });
          onDone();
        }}
        className="h-9 px-4 text-[13px] font-medium bg-[#171717] text-white rounded-lg"
      >
        保存
      </button>
    </div>
  );
}

function AddPayment({ onDone }: { onDone: () => void }): React.ReactElement {
  const [f, setF] = React.useState({ label: "", cardholderName: "", number: "", expirationMonth: "", expirationYear: "", securityCode: "", billingPostalCode: "" });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const last4 = f.number.replace(/\D/g, "").slice(-4);
  return (
    <div className="mt-4 border border-[#E5E5E5] rounded-xl p-4 space-y-3">
      <input value={f.label} onChange={set("label")} placeholder="备注（如 招行信用卡）" className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      <input value={f.cardholderName} onChange={set("cardholderName")} placeholder="持卡人" className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      <input value={f.number} onChange={set("number")} type="password" placeholder="卡号" className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      <div className="grid grid-cols-4 gap-2">
        <input value={f.expirationMonth} onChange={set("expirationMonth")} placeholder="月" className="h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
        <input value={f.expirationYear} onChange={set("expirationYear")} placeholder="年" className="h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
        <input value={f.securityCode} onChange={set("securityCode")} type="password" placeholder="CVV" className="h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
        <input value={f.billingPostalCode} onChange={set("billingPostalCode")} placeholder="邮编" className="h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      </div>
      <button
        onClick={async () => {
          await post("/api/vault/items", { kind: "payment", label: f.label, account: last4 ? `**** ${last4}` : "", fields: f });
          onDone();
        }}
        className="h-9 px-4 text-[13px] font-medium bg-[#171717] text-white rounded-lg"
      >
        保存
      </button>
    </div>
  );
}

function AddMailbox({ onDone }: { onDone: () => void }): React.ReactElement {
  const [f, setF] = React.useState({ provider: "qq", email: "", authCode: "" });
  const [err, setErr] = React.useState("");
  return (
    <div className="mt-4 border border-[#E5E5E5] rounded-xl p-4 space-y-3">
      <div className="text-[13px] text-[#737373]">
        QQ/163 个人邮箱没有 OAuth，唯一路径是 IMAP + 授权码。开启方法：QQ 邮箱 设置 → 账户 → 开启 IMAP → 生成授权码。
      </div>
      <select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none bg-white">
        <option value="qq">QQ 邮箱（imap.qq.com）</option>
        <option value="163">163 邮箱（imap.163.com）</option>
        <option value="126">126 邮箱（imap.126.com）</option>
        <option value="icloud">iCloud（imap.mail.me.com）</option>
      </select>
      <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="邮箱地址" className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      <input value={f.authCode} onChange={(e) => setF({ ...f, authCode: e.target.value })} type="password" placeholder="16 位授权码" className="w-full h-9 px-3 text-[14px] border border-[#E5E5E5] rounded-lg outline-none focus:border-black" />
      {err && <div className="text-[13px] text-[#DC2626]">{err}</div>}
      <button
        onClick={async () => {
          setErr("");
          try {
            await post("/api/connectors/mailbox", f);
            onDone();
          } catch (e: any) {
            setErr(String(e.message ?? e));
          }
        }}
        className="h-9 px-4 text-[13px] font-medium bg-[#171717] text-white rounded-lg"
      >
        验证并保存
      </button>
    </div>
  );
}
