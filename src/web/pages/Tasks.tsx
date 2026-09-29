import React from "react";
import { api } from "../api";
import { navigate } from "../main";
import { Sidebar, type Me } from "./Workspace";
import { LangToggle } from "../i18n";

interface TaskRow {
  id: string;
  class: string;
  title: string | null;
  status: string;
  channel: string;
  started_at: number;
  completed_at: number | null;
  trace_id: string | null;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: "进行中", cls: "text-[#737373]" },
  verified_success: { label: "✅ 可验证成功", cls: "text-[#16A34A]" },
  failed: { label: "失败", cls: "text-[#DC2626]" },
  cancelled: { label: "对话", cls: "text-[#A3A3A3]" },
};

export default function Tasks({ nav, taskId }: { nav: (to: string) => void; taskId?: string }): React.ReactElement {
  const [me, setMe] = React.useState<Me | null>(null);
  React.useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(() => navigate("/"));
  }, []);
  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar nav={nav} me={me} active="tasks" />
      <main className="flex-1 min-w-0">
        <div className="h-14 border-b border-[#E5E5E5] flex items-center px-6 gap-3">
          <span className="text-[14px]">Tasks</span>
          <span className="ml-auto"><LangToggle /></span>
        </div>
        <div className="max-w-[680px] mx-auto px-4 pt-10 pb-24">
          {taskId ? <TaskDetail id={taskId} nav={nav} /> : <TaskList nav={nav} />}
        </div>
      </main>
    </div>
  );
}

function TaskList({ nav }: { nav: (to: string) => void }): React.ReactElement {
  const [tasks, setTasks] = React.useState<TaskRow[] | null>(null);
  React.useEffect(() => {
    api<{ tasks: TaskRow[] }>("/api/tasks").then((r) => setTasks(r.tasks)).catch(() => setTasks([]));
  }, []);
  return (
    <>
      <h1 className="wordmark text-[32px]">Tasks</h1>
      <p className="text-[13px] text-[#737373] mt-2">每个任务记录步骤、证据和执行状态；普通对话不会伪装成任务。</p>
      <div className="mt-6 border border-[#E5E5E5] rounded-xl overflow-hidden">
        {(tasks ?? []).map((t, i) => (
          <button
            key={t.id}
            onClick={() => nav(`/tasks/${t.id}`)}
            className={`w-full text-left p-4 hover:bg-[#FAFAFA] ${i > 0 ? "border-t border-[#EFEFEF]" : ""}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium flex-1 truncate">{t.title || t.class}</span>
              <span className={`text-[12px] ${STATUS[t.status]?.cls ?? ""}`}>{STATUS[t.status]?.label ?? t.status}</span>
            </div>
            <div className="text-[12px] text-[#A3A3A3] mt-1">
              {new Date(t.started_at).toLocaleString()} · {t.channel}
              {t.completed_at ? ` · ${((t.completed_at - t.started_at) / 1000).toFixed(1)}s` : ""}
            </div>
          </button>
        ))}
        {tasks !== null && tasks.length === 0 && (
          <div className="p-8 text-center text-[13px] text-[#A3A3A3]">还没有任务。去微信/Telegram 里给它派一个。</div>
        )}
      </div>
    </>
  );
}

function TaskDetail({ id, nav }: { id: string; nav: (to: string) => void }): React.ReactElement {
  const [data, setData] = React.useState<any>(null);
  React.useEffect(() => {
    api(`/api/tasks/${id}`).then(setData).catch(() => nav("/tasks"));
  }, [id]);
  if (!data) return <div className="text-[14px] text-[#A3A3A3]">加载中…</div>;
  const { task, steps, evidence, receipt } = data;
  return (
    <>
      <button onClick={() => nav("/tasks")} className="text-[13px] text-[#737373] hover:text-black mb-3">← 全部任务</button>
      <h1 className="wordmark text-[28px]">{task.title || task.class}</h1>
      <div className="flex items-center gap-3 mt-2 text-[13px]">
        <span className={STATUS[task.status]?.cls}>{STATUS[task.status]?.label ?? task.status}</span>
        <span className="text-[#A3A3A3]">{new Date(task.started_at).toLocaleString()}</span>
        {task.trace_id && <span className="font-mono text-[#A3A3A3]">trace {task.trace_id}</span>}
      </div>

      {receipt && (
        <div className="mt-5 border border-[#E5E5E5] rounded-xl p-4 flex items-center justify-between gap-4">
          <a href={`/r/${receipt.share_slug}`} className="min-w-0 hover:opacity-80">
            <div className="text-[14px] font-medium">🗂 脱敏任务凭证</div>
            <div className="text-[13px] text-[#737373] mt-1">
              /r/{receipt.share_slug} —— {receipt.public ? "已公开，拿到链接的人都能看" : "私密，只有你能看"}
            </div>
          </a>
          <button
            onClick={async () => {
              const next = !receipt.public;
              await api(`/api/receipts/${receipt.share_slug}/visibility`, { method: "POST", body: JSON.stringify({ public: next }) });
              setData({ ...data, receipt: { ...receipt, public: next ? 1 : 0 } });
            }}
            className="shrink-0 text-[13px] border border-[#E5E5E5] rounded-lg px-3 py-1.5 hover:bg-[#FAFAFA]"
          >
            {receipt.public ? "设为私密" : "设为公开"}
          </button>
        </div>
      )}

      <div className="mt-8">
        <div className="text-[14px] font-semibold mb-3">时间线</div>
        <div className="border border-[#E5E5E5] rounded-xl divide-y divide-[#EFEFEF]">
          {(steps ?? []).map((s: any) => (
            <div key={s.seq} className="p-3.5 flex gap-3">
              <div className="w-5 h-5 rounded-full bg-[#F0F0F0] text-[11px] flex items-center justify-center shrink-0 mt-0.5">{s.seq}</div>
              <div className="min-w-0">
                <div className="text-[13px]">{s.desc}</div>
                <div className="text-[11px] text-[#A3A3A3] mt-0.5">{new Date(s.ts).toLocaleTimeString()}</div>
              </div>
            </div>
          ))}
          {(!steps || steps.length === 0) && <div className="p-4 text-[13px] text-[#A3A3A3]">（对话类任务没有步骤记录）</div>}
        </div>
      </div>

      {evidence?.length > 0 && (
        <div className="mt-8">
          <div className="text-[14px] font-semibold mb-3">机器可验证证据</div>
          <div className="border border-[#E5E5E5] rounded-xl divide-y divide-[#EFEFEF]">
            {evidence.map((e: any, i: number) => (
              <div key={i} className="p-3.5 text-[13px] flex gap-3">
                <span className="text-[#737373] shrink-0 w-36">{e.type}</span>
                <span className="font-mono break-all">{e.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
