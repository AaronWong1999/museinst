//
// Conversation threads, canonical timeline, durable event log and the
// follow-up queue (spec §9.1, §10.3-§10.6). All conversation truth lives in
// the PersonalAgent DO SQLite so a single-user chat needs no extra central
// database. These helpers take the DO's tagged `sql` executor so they run in
// production and in tests against the same statements.
//
import type { CanonicalMessage } from "../channels/message-contract";

export const MAIN_THREAD_ID = "main";

/** Conversation tables appended to the PersonalAgent DO schema (spec §10.3/§10.6). */
export const CONVERSATIONS_SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  queue_state TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 0,
  linked_workstream_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  origin_channel TEXT NOT NULL,
  origin_message_id TEXT,
  task_id TEXT,
  text TEXT NOT NULL,
  canonical_json TEXT,
  security_scope_key TEXT NOT NULL DEFAULT 'owner:global',
  sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(thread_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread_seq ON conversation_messages(thread_id, sequence);
CREATE TABLE IF NOT EXISTS conversation_followups (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  client_message_id TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conversation_followups_thread ON conversation_followups(thread_id, status, created_at);
CREATE TABLE IF NOT EXISTS conversation_events (
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_revision INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(thread_id, seq)
);
`;


export interface ConversationThreadRow {
  id: string;
  title: string;
  status: "active" | "archived";
  queue_state: "active" | "paused";
  revision: number;
  linked_workstream_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface ConversationMessageRow {
  id: string;
  thread_id: string;
  role: CanonicalMessage["role"];
  origin_channel: string;
  origin_message_id: string | null;
  task_id: string | null;
  text: string;
  canonical_json: string | null;
  security_scope_key: string;
  sequence: number;
  revision: number;
  created_at: number;
}

export interface ConversationEventRow {
  thread_id: string;
  seq: number;
  event_id: string;
  kind: string;
  object_id: string;
  object_revision: number;
  payload_json: string;
  created_at: number;
}

export interface ConversationFollowupRow {
  id: string;
  thread_id: string;
  client_message_id: string | null;
  text: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export type SqlValue = string | number | boolean | null;
export type SqlFn = <T = Record<string, SqlValue>>(strings: TemplateStringsArray, ...values: SqlValue[]) => T[];

// ── Threads ────────────────────────────────────────────────────────────────

/** The main thread is idempotently created — every workspace has exactly one. */
export function ensureMainThread(sql: SqlFn, nowMs: number): void {
  sql`INSERT INTO conversation_threads (id, title, status, queue_state, revision, created_at, updated_at)
      VALUES (${MAIN_THREAD_ID}, ${"主线程"}, 'active', 'active', 0, ${nowMs}, ${nowMs})
      ON CONFLICT(id) DO NOTHING`;
}

export function getThread(sql: SqlFn, threadId: string): ConversationThreadRow | null {
  const rows = sql`SELECT id, title, status, queue_state, revision, linked_workstream_id, created_at, updated_at, archived_at
                   FROM conversation_threads WHERE id = ${threadId}` as ConversationThreadRow[];
  return rows[0] ?? null;
}

/**
 * Resolve a conversation thread for ingress. The main thread is created on
 * demand; side threads must already exist and be active — an archived or
 * unknown side thread is never silently rerouted to main (spec §9.1).
 */
export function resolveWritableThread(
  sql: SqlFn,
  threadId: string | undefined,
  nowMs: number,
): { ok: true; thread: ConversationThreadRow } | { ok: false; error: "thread_not_found" | "thread_archived" } {
  ensureMainThread(sql, nowMs);
  const id = threadId && threadId.trim() ? threadId.trim() : MAIN_THREAD_ID;
  const thread = getThread(sql, id);
  if (!thread) return { ok: false, error: "thread_not_found" };
  if (thread.status === "archived") return { ok: false, error: "thread_archived" };
  return { ok: true, thread };
}

export function createThread(sql: SqlFn, input: { id?: string; title: string; nowMs: number }): ConversationThreadRow {
  const id = input.id && input.id.trim() ? input.id.trim() : newThreadRowId();
  sql`INSERT INTO conversation_threads (id, title, status, queue_state, revision, created_at, updated_at)
      VALUES (${id}, ${input.title.slice(0, 120)}, 'active', 'active', 0, ${input.nowMs}, ${input.nowMs})`;
  return getThread(sql, id)!;
}

export function newThreadRowId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const s = [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("");
  return `th_${s}`;
}

export function listThreads(sql: SqlFn, opts: { includeArchived?: boolean } = {}): ConversationThreadRow[] {
  const rows = (opts.includeArchived
    ? sql`SELECT id, title, status, queue_state, revision, linked_workstream_id, created_at, updated_at, archived_at
          FROM conversation_threads ORDER BY updated_at DESC`
    : sql`SELECT id, title, status, queue_state, revision, linked_workstream_id, created_at, updated_at, archived_at
          FROM conversation_threads WHERE status = 'active' ORDER BY updated_at DESC`) as ConversationThreadRow[];
  return rows;
}

export function updateThread(
  sql: SqlFn,
  threadId: string,
  patch: { title?: string; status?: "active" | "archived"; queueState?: "active" | "paused" },
  nowMs: number,
): void {
  const thread = getThread(sql, threadId);
  if (!thread) return;
  const title = patch.title !== undefined ? patch.title.slice(0, 120) : thread.title;
  const status = patch.status ?? thread.status;
  const queueState = patch.queueState ?? thread.queue_state;
  const archivedAt = patch.status === "archived" ? nowMs : patch.status === "active" ? null : thread.archived_at;
  sql`UPDATE conversation_threads
      SET title=${title}, status=${status}, queue_state=${queueState},
          archived_at=${archivedAt}, revision=revision+1, updated_at=${nowMs}
      WHERE id=${threadId}`;
}

/** Main thread is protected: it cannot be deleted or archived (spec §10.6). */
export function isProtectedThread(threadId: string): boolean {
  return threadId === MAIN_THREAD_ID;
}

/** Bump thread recency after activity. */
export function touchThread(sql: SqlFn, threadId: string, nowMs: number): void {
  sql`UPDATE conversation_threads SET updated_at=${nowMs} WHERE id=${threadId}`;
}

// ── Canonical timeline ─────────────────────────────────────────────────────

export function nextMessageSequence(sql: SqlFn, threadId: string): number {
  const rows = sql`SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM conversation_messages WHERE thread_id = ${threadId}` as Array<{ next: number }>;
  return rows[0]?.next ?? 1;
}

export interface InsertCanonicalInput {
  message: CanonicalMessage;
  securityScopeKey: string;
  originMessageId?: string;
}

/** Insert one canonical message into the thread timeline; returns its row. */
export function insertCanonicalMessage(sql: SqlFn, input: InsertCanonicalInput): ConversationMessageRow {
  const m = input.message;
  const sequence = nextMessageSequence(sql, m.threadId);
  const canonicalJson = JSON.stringify(m);
  sql`INSERT INTO conversation_messages
        (id, thread_id, role, origin_channel, origin_message_id, task_id, text,
         canonical_json, security_scope_key, sequence, revision, created_at)
      VALUES (${m.id}, ${m.threadId}, ${m.role}, ${m.origin?.channel ?? "web"}, ${input.originMessageId ?? null},
              ${m.taskId ?? null}, ${m.text}, ${canonicalJson}, ${input.securityScopeKey}, ${sequence}, 0, ${m.createdAt})`;
  return {
    id: m.id,
    thread_id: m.threadId,
    role: m.role,
    origin_channel: m.origin?.channel ?? "web",
    origin_message_id: input.originMessageId ?? null,
    task_id: m.taskId ?? null,
    text: m.text,
    canonical_json: canonicalJson,
    security_scope_key: input.securityScopeKey,
    sequence,
    revision: 0,
    created_at: m.createdAt,
  };
}

export function listCanonicalMessages(
  sql: SqlFn,
  threadId: string,
  opts: { afterSequence?: number; limit?: number } = {},
): ConversationMessageRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const after = opts.afterSequence ?? 0;
  return sql`SELECT id, thread_id, role, origin_channel, origin_message_id, task_id, text,
                    canonical_json, security_scope_key, sequence, revision, created_at
             FROM conversation_messages
             WHERE thread_id = ${threadId} AND sequence > ${after}
             ORDER BY sequence ASC LIMIT ${limit}` as ConversationMessageRow[];
}

// ── Durable event log ──────────────────────────────────────────────────────

export function appendEvent(
  sql: SqlFn,
  input: { threadId: string; eventId: string; kind: string; objectId: string; objectRevision?: number; payload: unknown; nowMs: number },
): number {
  const rows = sql`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM conversation_events WHERE thread_id = ${input.threadId}` as Array<{ next: number }>;
  const seq = rows[0]?.next ?? 1;
  sql`INSERT INTO conversation_events (thread_id, seq, event_id, kind, object_id, object_revision, payload_json, created_at)
      VALUES (${input.threadId}, ${seq}, ${input.eventId}, ${input.kind}, ${input.objectId}, ${input.objectRevision ?? 0}, ${JSON.stringify(input.payload ?? {})}, ${input.nowMs})`;
  return seq;
}

export function listEvents(sql: SqlFn, threadId: string, after = 0, limit = 200): ConversationEventRow[] {
  return sql`SELECT thread_id, seq, event_id, kind, object_id, object_revision, payload_json, created_at
             FROM conversation_events
             WHERE thread_id = ${threadId} AND seq > ${after}
             ORDER BY seq ASC LIMIT ${Math.min(limit, 500)}` as ConversationEventRow[];
}

// ── Follow-up queue ────────────────────────────────────────────────────────

export function enqueueFollowup(
  sql: SqlFn,
  input: { threadId: string; clientMessageId?: string; text: string; nowMs: number },
): ConversationFollowupRow {
  const id = newFollowupId();
  sql`INSERT INTO conversation_followups (id, thread_id, client_message_id, text, status, created_at)
      VALUES (${id}, ${input.threadId}, ${input.clientMessageId ?? null}, ${input.text}, 'queued', ${input.nowMs})`;
  return {
    id,
    thread_id: input.threadId,
    client_message_id: input.clientMessageId ?? null,
    text: input.text,
    status: "queued",
    created_at: input.nowMs,
    started_at: null,
    completed_at: null,
  };
}

export function newFollowupId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const s = [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("");
  return `fq_${s}`;
}

export function listFollowups(sql: SqlFn, threadId: string, limit = 50): ConversationFollowupRow[] {
  return sql`SELECT id, thread_id, client_message_id, text, status, created_at, started_at, completed_at
             FROM conversation_followups WHERE thread_id = ${threadId}
             ORDER BY created_at ASC LIMIT ${Math.min(limit, 200)}` as ConversationFollowupRow[];
}

/** FIFO: the next queued item for a thread whose queue is active. */
export function nextQueuedFollowup(sql: SqlFn, threadId: string): ConversationFollowupRow | null {
  const rows = sql`SELECT f.id, f.thread_id, f.client_message_id, f.text, f.status, f.created_at, f.started_at, f.completed_at
                   FROM conversation_followups f
                   JOIN conversation_threads t ON t.id = f.thread_id
                   WHERE f.thread_id = ${threadId} AND f.status = 'queued' AND t.queue_state = 'active'
                   ORDER BY f.created_at ASC LIMIT 1` as ConversationFollowupRow[];
  return rows[0] ?? null;
}

export function setFollowupStatus(
  sql: SqlFn,
  followupId: string,
  status: ConversationFollowupRow["status"],
  nowMs: number,
): void {
  if (status === "running") {
    sql`UPDATE conversation_followups SET status=${status}, started_at=${nowMs} WHERE id=${followupId}`;
  } else if (status === "completed" || status === "cancelled" || status === "failed") {
    sql`UPDATE conversation_followups SET status=${status}, completed_at=${nowMs} WHERE id=${followupId}`;
  } else {
    sql`UPDATE conversation_followups SET status=${status} WHERE id=${followupId}`;
  }
}

// ── Backfill (spec §10.6 migration rules) ──────────────────────────────────

/**
 * One-time idempotent backfill: create the main thread and project existing
 * owner-scope history onto it, preserving original IDs/timestamps. Already
 * trimmed rows are not fabricated. Side-thread/scope isolation (email, a2a)
 * is left untouched.
 */
export function backfillConversations(sql: SqlFn, workspaceId: string, nowMs: number): void {
  ensureMainThread(sql, nowMs);
  sql`INSERT OR IGNORE INTO conversation_messages
        (id, thread_id, role, origin_channel, origin_message_id, task_id, text,
         canonical_json, security_scope_key, sequence, revision, created_at)
      SELECT m.id, ${MAIN_THREAD_ID}, m.role, m.channel, NULL, NULL,
             COALESCE(json_extract(m.content_json, '$.text'), ''),
             json_object('version', 1, 'id', m.id, 'workspaceId', ${workspaceId}, 'threadId', ${MAIN_THREAD_ID}, 'role', m.role, 'text', COALESCE(json_extract(m.content_json, '$.text'), ''), 'createdAt', m.created_at),
             m.scope_key,
             (SELECT COALESCE(MAX(c.sequence), 0) FROM conversation_messages c WHERE c.thread_id = ${MAIN_THREAD_ID})
               + ROW_NUMBER() OVER (ORDER BY m.created_at, m.id),
             0, m.created_at
      FROM messages m
      WHERE m.scope_key = ${"owner:global"}
        AND m.role IN ('user', 'assistant')
        AND NOT EXISTS (SELECT 1 FROM conversation_messages c WHERE c.id = m.id)`;
}
