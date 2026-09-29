import React from "react";
import { api } from "../api";
import { LangToggle } from "../i18n";

interface ReceiptData {
  title: string;
  steps: string[];
  evidence: Array<{ type: string; value: string }>;
  durationMs: number;
  channel: string;
  taskClass: string;
}

export default function Receipt({ slug }: { slug: string }): React.ReactElement {
  const [data, setData] = React.useState<ReceiptData | null>(null);
  const [err, setErr] = React.useState("");
  React.useEffect(() => {
    api<ReceiptData>(`/api/receipt/${slug}`).then(setData).catch((e) => setErr(String(e.message ?? e)));
  }, [slug]);

  const secs = data ? (data.durationMs / 1000).toFixed(1) : "";

  return (
    <div className="min-h-screen bg-[#FAFAFA]">
      <header className="flex items-center justify-between h-14 border-b border-[#EFEFEF] bg-white px-6">
        <span />
        <span className="wordmark text-[20px]">MuseInst</span>
        <LangToggle />
      </header>
      <main className="max-w-[520px] mx-auto px-4 py-12">
        {err && <div className="text-center text-[14px] text-[#737373]">凭证不存在或已下架。</div>}
        {data && (
          <div className="bg-white border border-[#E5E5E5] rounded-2xl p-8">
            <div className="wordmark text-[28px] text-center leading-tight">{data.title}</div>
            <div className="text-center text-[13px] text-[#737373] mt-2">
              MuseInst 完成 · 用时 {secs} 秒 · 敏感信息已脱敏
            </div>
            <div className="mt-8 space-y-3">
              {data.steps.map((s, i) => (
                <div key={i} className="flex gap-3 items-start">
                  <div className="w-6 h-6 rounded-full bg-[#16A34A]/10 text-[#16A34A] flex items-center justify-center text-[12px] shrink-0">✓</div>
                  <div className="text-[14px] leading-relaxed pt-0.5">{s}</div>
                </div>
              ))}
            </div>
            {data.evidence.length > 0 && (
              <div className="mt-8 border-t border-[#EFEFEF] pt-6">
                <div className="text-[12px] text-[#A3A3A3] uppercase tracking-wide">机器可验证证据（已脱敏）</div>
                <div className="mt-3 space-y-1.5">
                  {data.evidence.map((e, i) => (
                    <div key={i} className="text-[12px] font-mono text-[#737373] break-all">
                      {e.type}: {e.value}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-8 border border-[#E5E5E5] rounded-xl p-4 text-center">
              <div className="text-[13px] text-[#737373]">
                这是本实例生成的外部任务完成凭证，默认隐藏敏感信息。
              </div>
              <a href="/workspace" className="mt-3 inline-block h-9 leading-[36px] px-5 text-[14px] font-medium bg-[#171717] text-white rounded-lg">
                返回 Workspace →
              </a>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
