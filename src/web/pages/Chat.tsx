import React from "react";
import { api, post } from "../api";
import { Sidebar, type Me } from "./Workspace";
import { LangToggle } from "../i18n";

// Web Chat (spec §9/§10): the browser session is the identity — no binding
// gate. The durable projection (DO SQLite) is the source of truth; SSE is a
// notification transport and reconnects replay from the last event cursor.

interface ThreadRow {
  id: string;
  title: string;
  status: "active" | "archived";
  queue_state: "active" | "paused";
  updated_at: number;
}

interface ChatMessage {
  sequence: number;
  id: string;
  createdAt: number;
  canonical: {
    version: number;
    id: string;
    threadId: string;
    role: "user" | "assistant" | "system";
    text: string;
    cards?: Array<{ type: string; version: number; id: string }>;
    origin?: { channel: string };
    createdAt: number;
  } | null;
}

interface FollowupRow {
  id: string;
  thread_id: string;
  text: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
}

interface FollowupsResponse {
  threadId: string;
  queueState: "active" | "paused";
  followups: FollowupRow[];
  activeRun: string | null;
}

const ORIGIN_LABEL: Record<string, string> = {
  wechat: "微信",
  telegram: "Telegram",
  web: "Web",
};

const CHAT_COMPOSER_MAX = 8000;

function newClientMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "wm_" + [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("");
}

export default function Chat({ nav }: { nav: (to: string) => void }): React.ReactElement {
  const [me, setMe] = React.useState<Me | null>(null);
  React.useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(() => nav("/"));
  }, [nav]);
  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar nav={nav} me={me} active="chat" />
      <main className="flex-1 min-w-0">
        <div className="h-14 border-b border-[#E5E5E5] flex items-center px-6 gap-3">
          <span className="text-[14px]">Chat</span>
          <span className="text-[12px] text-[#737373]">微信、Telegram 和网页里的对话都在这里</span>
          <span className="ml-auto"><LangToggle /></span>
        </div>
        <ChatBody />
      </main>
    </div>
  );
}

function ChatBody(): React.ReactElement {
  const [threads, setThreads] = React.useState<ThreadRow[] | null>(null);
  const [threadId, setThreadId] = React.useState<string>("main");
  const [messages, setMessages] = React.useState<ChatMessage[] | null>(null);
  const [queue, setQueue] = React.useState<FollowupsResponse | null>(null);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState("");
  const [sendError, setSendError] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const cursorRef = React.useRef(0);

  const refreshThreads = React.useCallback(() => {
    api<{ threads: ThreadRow[] }>("/api/chat/threads")
      .then((r) => setThreads(r.threads))
      .catch(() => setLoadFailed(true));
  }, []);

  const refreshMessages = React.useCallback((id: string, afterSeq = 0) => {
    api<{ messages: ChatMessage[]; cursor: { messageSeq: number } }>(
      `/api/chat/threads/${encodeURIComponent(id)}/messages${afterSeq ? `?afterMessageSeq=${afterSeq}` : ""}`,
    )
      .then((r) => {
        cursorRef.current = r.cursor.messageSeq;
        if (afterSeq) setMessages((prev) => mergeMessages(prev ?? [], r.messages));
        else setMessages(r.messages);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));
  }, []);

  const refreshQueue = React.useCallback((id: string) => {
    api<FollowupsResponse>(`/api/chat/threads/${encodeURIComponent(id)}/followups`)
      .then(setQueue)
      .catch(() => setQueue(null));
  }, []);

  React.useEffect(() => {
    refreshThreads();
  }, [refreshThreads]);

  React.useEffect(() => {
    setMessages(null);
    setError("");
    cursorRef.current = 0;
    refreshMessages(threadId);
    refreshQueue(threadId);
    // SSE notification transport: reconnect replays missed events from the
    // cursor, then each event triggers a durable-projection refresh.
    const es = new EventSource(`/api/chat/realtime?threadId=${encodeURIComponent(threadId)}`);
    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as { kind: string };
        if (/^(message\.created|run\.|followup\.|queue\.)/.test(data.kind)) {
          refreshMessages(threadId, data.kind === "message.created" ? cursorRef.current : 0);
          refreshQueue(threadId);
        }
      } catch {
        /* ignore malformed notification; durable reads remain authoritative */
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects with the last-seen cursor via after; a
      // missed replay still resolves through the next messages refresh.
    };
    return () => es.close();
  }, [threadId, refreshMessages, refreshQueue]);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages?.length]);

  const activeRun = queue?.activeRun ?? null;
  const running = activeRun !== null || thinking;

  const send = () => {
    const text = draft.trim();
    if (!text || running) return;
    setDraft("");
    setSendError("");
    setThinking(true);
    post<{ status: string; queueItemId?: string; threadId: string }>("/api/chat/messages", {
      clientMessageId: newClientMessageId(),
      threadId,
      text,
    })
      .then((r) => {
        refreshMessages(threadId);
        refreshQueue(threadId);
        if (r.status === "queued") setError("排队中 · 当前任务结束后按顺序处理");
      })
      .catch((e: Error) => {
        setDraft((prev) => prev || text);
        const reason = e.message === "thread_archived"
          ? "该对话已归档，恢复后才能继续发送。"
          : e.message === "text_too_long"
            ? "消息太长了，请分段发送。"
            : "发送失败，请稍后重试。";
        setSendError(reason);
      })
      .finally(() => setThinking(false));
  };

  const stopRun = () => {
    if (!activeRun) return;
    post(`/api/chat/runs/${encodeURIComponent(activeRun)}/stop`, {})
      .then(() => refreshQueue(threadId))
      .catch(() => setError("停止请求未被接受，请稍后重试。"));
  };

  const resumeQueue = () => {
    post(`/api/chat/threads/${encodeURIComponent(threadId)}/followups/run`, {})
      .then(() => refreshQueue(threadId))
      .catch(() => setError("无法恢复队列，请稍后重试。"));
  };

  const cancelFollowup = (id: string) => {
    post(`/api/chat/threads/${encodeURIComponent(threadId)}/followups/${encodeURIComponent(id)}/cancel`, {})
      .then(() => refreshQueue(threadId))
      .catch(() => {});
  };

  const newSideThread = () => {
    const title = window.prompt("旁聊主题（比如：投资）");
    if (title === null) return;
    post<{ thread: ThreadRow }>("/api/chat/threads", { title: title || "新旁聊" })
      .then((r) => {
        refreshThreads();
        setThreadId(r.thread.id);
      })
      .catch(() => setError("旁聊创建失败，请稍后重试。"));
  };

  const archiveThread = (id: string) => {
    if (id === "main") return;
    fetch(`/api/chat/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    })
      .then(() => {
        refreshThreads();
        if (id === threadId) setThreadId("main");
      })
      .catch(() => {});
  };

  const queueItems = (queue?.followups ?? []).filter((f) => f.status === "queued");
  const queuePaused = queue?.queueState === "paused";

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <aside className="w-60 border-r border-[#E5E5E5] flex flex-col overflow-y-auto">
        <div className="p-3 flex items-center justify-between">
          <span className="text-[12px] text-[#737373]">对话</span>
          <button onClick={newSideThread} className="text-[12px] text-[#171717] border border-[#E5E5E5] rounded-lg px-2 py-1 hover:bg-[#FAFAFA]">
            + 新旁聊
          </button>
        </div>
        {(threads ?? []).map((t) => (
          <div key={t.id} className={`group flex items-center ${t.id === threadId ? "bg-[#F5F5F5]" : ""} hover:bg-[#FAFAFA]`}>
            <button
              onClick={() => setThreadId(t.id)}
              className="flex-1 min-w-0 text-left px-4 py-2.5 text-[13.5px] truncate"
              title={t.title}
            >
              {t.id === "main" ? "主线程" : t.title}
              {t.id === "main" && <span className="ml-2 text-[11px] text-[#A3A3A3]">微信 · Telegram · Web</span>}
            </button>
            {t.id !== "main" && t.id === threadId && (
              <button onClick={() => archiveThread(t.id)} className="text-[11px] text-[#A3A3A3] px-2 group-hover:inline hidden" title="归档（不影响任务与文件）">
                归档
              </button>
            )}
          </div>
        ))}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4" aria-busy={running}>
          {loadFailed && (
            <div className="max-w-[560px] mx-auto border border-[#E5E5E5] rounded-xl p-6 text-center" role="alert">
              <p className="text-[14px] font-medium">这一页没加载出来</p>
              <p className="text-[13px] text-[#737373] mt-1">你的数据没有丢。刷新重试一次就好。</p>
              <button onClick={() => { setLoadFailed(false); refreshMessages(threadId); refreshQueue(threadId); }} className="mt-3 text-[13px] border border-[#E5E5E5] rounded-lg px-3 py-1.5 hover:bg-[#FAFAFA]">
                重试
              </button>
            </div>
          )}
          {!loadFailed && messages !== null && messages.length === 0 && threadId === "main" && (
            <div className="max-w-[560px] mx-auto pt-16 text-center">
              <p className="wordmark text-[28px]">你好，我是 MuseInst</p>
              <p className="text-[13.5px] text-[#737373] mt-2">
                你的私人 Agent。在这里、微信或 Telegram 跟我说话都行，我记得同一份上下文。
              </p>
            </div>
          )}
          {!loadFailed && messages !== null && messages.length === 0 && threadId !== "main" && (
            <div className="max-w-[560px] mx-auto pt-16 text-center">
              <p className="text-[14px] font-medium">按主题单独聊，不打断主线程。</p>
              <p className="text-[13px] text-[#737373] mt-1">微信和 Telegram 的消息仍然进主线程；这里的任务和文件照样出现在任务和 Computer 里。</p>
            </div>
          )}
          {(messages ?? []).map((m) => {
            if (!m.canonical) return null;
            const c = m.canonical;
            if (c.role === "system") {
              return (
                <div key={m.sequence} className="text-center text-[12px] text-[#A3A3A3]">{c.text}</div>
              );
            }
            const isUser = c.role === "user";
            const origin = c.origin?.channel ? ORIGIN_LABEL[c.origin.channel] : "";
            return (
              <div key={m.sequence} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[640px] rounded-xl px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap ${
                    isUser ? "bg-[#171717] text-white" : "border border-[#E5E5E5]"
                  }`}
                >
                  {c.text}
                  {(c.cards ?? []).length > 0 && (
                    <div className="mt-2 text-[12px] text-[#737373]">
                      {(c.cards ?? []).map((card) => (
                        <div key={card.id}>{card.type}</div>
                      ))}
                    </div>
                  )}
                  <div className={`mt-1 text-[11px] ${isUser ? "text-white/60" : "text-[#A3A3A3]"}`}>
                    {origin ? `${origin} · ` : ""}
                    {new Date(m.createdAt).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            );
          })}
          {running && (
            <div className="text-[13.5px] text-[#737373] animate-pulse">正在想…</div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-[#E5E5E5] px-6 py-3">
          {error && <div className="text-[12px] text-[#DC2626] mb-2" role="status">{error}</div>}
          {sendError && <div className="text-[12px] text-[#DC2626] mb-2" role="status">{sendError}</div>}
          {(queueItems.length > 0 || queuePaused) && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {queueItems.map((f, i) => (
                <span key={f.id} className="inline-flex items-center gap-2 bg-[#F5F5F5] border border-[#E5E5E5] rounded-full px-3 py-1 text-[12px]">
                  <span className="text-[#737373]">{String(i + 1).padStart(2, "0")}</span>
                  <span className="max-w-[280px] truncate">{f.text}</span>
                  <button onClick={() => cancelFollowup(f.id)} className="text-[#737373] hover:text-[#171717]" title="移出队列">✕</button>
                </span>
              ))}
              {queuePaused && (
                <button onClick={resumeQueue} className="text-[12px] border border-[#E5E5E5] rounded-full px-3 py-1 hover:bg-[#FAFAFA]">
                  继续队列
                </button>
              )}
              {queueItems.length > 0 && !queuePaused && (
                <span className="text-[11px] text-[#A3A3A3]">排队中 · 当前任务结束后按顺序处理</span>
              )}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={running ? "继续说，会排在当前任务之后…" : "给 MuseInst 发消息…"}
              rows={Math.min(4, draft.split("\n").length)}
              maxLength={CHAT_COMPOSER_MAX}
              className="flex-1 resize-none border border-[#E5E5E5] rounded-xl px-3.5 py-2.5 text-[14px] outline-none focus:border-[#171717]"
            />
            {running ? (
              <button
                onClick={stopRun}
                disabled={!activeRun}
                className="h-10 px-4 rounded-xl border border-[#E5E5E5] text-[13.5px] hover:bg-[#FAFAFA] disabled:opacity-40"
                title="停止当前任务；排队中的消息保留"
              >
                停止
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!draft.trim()}
                className="h-10 px-4 rounded-xl bg-[#171717] text-white text-[13.5px] disabled:opacity-30"
              >
                发送
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function mergeMessages(prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const bySeq = new Map<number, ChatMessage>();
  for (const m of prev) bySeq.set(m.sequence, m);
  for (const m of incoming) bySeq.set(m.sequence, m);
  return [...bySeq.values()].sort((a, b) => a.sequence - b.sequence);
}
