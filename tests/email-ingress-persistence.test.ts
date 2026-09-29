





import assert from "node:assert/strict";
import { handleInboundEmail } from "../src/channels/email/ingress";
import { consumeEmailDispatchEnvelope } from "../src/channels/email/dispatch-queue";
import { readEmailMessage } from "../src/channels/email/mailbox";
import { setHostHooks, resetHostHooks } from "../src/hooks";
import { createTestD1, d1Get, type TestD1 } from "./helpers/d1";

console.log("▶ Email ingress persistence & kill switch");

const FROM = "sender@example.net";
const TO = "agent@mail.example.com";

function makeR2() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer) => {
      store.set(String(k), v);
    },
    get: async (k: string) => {
      const v = store.get(String(k));
      return v ? { arrayBuffer: async () => v } : null;
    },
  };
}

function seedWorkspace(d1: TestD1, opts: { workspaceId?: string; strangerAutoreply?: 0 | 1; dailyInCap?: number; dailyOutCap?: number } = {}): string {
  const ws = opts.workspaceId ?? "w1";
  d1.db.prepare(`INSERT OR IGNORE INTO users (id, created_at) VALUES ('u1', 0)`).run();
  d1.db.prepare(`INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, 'u1', 0)`).run(ws);
  d1.db
    .prepare(
      `INSERT OR REPLACE INTO agent_mailboxes (workspace_id, local_part, domain, address, status, daily_out_cap, daily_in_cap, stranger_autoreply, created_at, updated_at)
       VALUES (?, 'agent', 'mail.example.com', ?, 'active', ?, ?, ?, 0, 0)`,
    )
    .run(ws, TO, opts.dailyOutCap ?? 100, opts.dailyInCap ?? 300, opts.strangerAutoreply ?? 1);
  return ws;
}

function rawEmail(o: { subject?: string; body: string; contentType?: string; messageId?: string; extraHeaders?: string[] }): ArrayBuffer {
  const headers = [
    `From: ${FROM}`,
    `To: ${TO}`,
    `Message-ID: ${o.messageId ?? "<m1@example.net>"}`,
    `Subject: ${o.subject ?? "hello"}`,
    `Content-Type: ${o.contentType ?? "text/plain; charset=utf-8"}`,
    ...(o.extraHeaders ?? []),
  ].join("\r\n");
  return new TextEncoder().encode(`${headers}\r\n\r\n${o.body}`).buffer as ArrayBuffer;
}

interface EnvOpts {
  flags?: Record<string, string | undefined>;
  agentCalls?: { n: number };
  doReply?: string[] | null;
  hook?: { beforeExternalEvent?: () => Promise<{ allow: boolean }> };
  breakInsert?: boolean;
}

function makeEnv(d1: TestD1, o: EnvOpts = {}): any {
  const calls = o.agentCalls ?? { n: 0 };
  const env: any = {
    DB: d1,
    ARTIFACTS: makeR2(),
    AGENT_EMAIL_ENABLED: "1",
    AGENT_EMAIL_OUTBOUND_ENABLED: "1",
    STRANGER_AUTOREPLY_GLOBAL: "1",
    ...(o.flags ?? {}),
    AGENT: {
      idFromName: (x: string) => x,
      get: () => ({
        fetch: async () => {
          calls.n++;
          return Response.json({ replies: o.doReply === null ? [] : (o.doReply ?? ["auto reply"]), taskId: "t1" });
        },
      }),
    },
  };
  // Test Queue deliberately drives the real consumer. Production must never inline when
  // EMAIL_DISPATCH_QUEUE is missing; these legacy ingress tests remain end-to-end by
  // providing the queue explicitly.
  env.EMAIL_DISPATCH_QUEUE = {
    send: async (envelope: any) => {
      const outcome = await consumeEmailDispatchEnvelope(env, envelope);
      if (outcome.kind === "retry") throw new Error("test_email_dispatch_retry");
    },
  };
  if (o.breakInsert) {
    const real = d1.prepare.bind(d1);
    env.DB = {
      prepare: (sql: string) => {
        if (sql.includes("INSERT INTO email_messages")) throw new Error("d1_unavailable");
        return real(sql);
      },
      batch: d1.batch,
    };
  }
  if (o.hook?.beforeExternalEvent) {
    setHostHooks({ beforeExternalEvent: o.hook.beforeExternalEvent });
  } else {
    resetHostHooks();
  }
  return env;
}

async function ingest(env: any, raw: ArrayBuffer, to = TO): Promise<{ result: any; rejects: string[] }> {
  const rejects: string[] = [];
  const pending: Promise<unknown>[] = [];
  const result = await handleInboundEmail(
    { from: FROM, to, raw, rawSize: raw.byteLength, headers: new Headers(), setReject: (r: string) => rejects.push(r) },
    env,
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return { result, rejects };
}

process.on("exit", () => resetHostHooks());


for (const flag of [undefined, "0"]) {
  const d1 = createTestD1();
  seedWorkspace(d1);
  const calls = { n: 0 };
  const env = makeEnv(d1, { flags: { AGENT_EMAIL_ENABLED: flag }, agentCalls: calls });
  const { result, rejects } = await ingest(env, rawEmail({ body: "hello world" }));
  assert.equal(result.handled, false);
  assert.equal(result.reason, "disabled");
  assert.equal(rejects.length, 1, "disabled must reject at SMTP level");
  assert.equal(calls.n, 0, "no model dispatch when disabled");
  assert.equal(d1.db.prepare(`SELECT COUNT(*) AS c FROM email_messages`).get()!["c"], 0);
  assert.equal(d1.db.prepare(`SELECT COUNT(*) AS c FROM email_outbox`).get()!["c"], 0);
}
console.log("  ✅ AGENT_EMAIL_ENABLED unset/0 → identical disabled behavior");


{
  const d1 = createTestD1();
  seedWorkspace(d1);
  const env = makeEnv(d1);
  const body = "x".repeat(1499) + "MARKER-1500" + "y".repeat(500);
  const raw = rawEmail({ body, messageId: "<long@example.net>" });
  const { result } = await ingest(env, raw);
  assert.equal(result.handled, true);
  const row = await d1Get<any>(d1, `SELECT id, ingest_state, body_text, snippet, raw_r2_key, from_addr, to_addr FROM email_messages`);
  assert.ok(row, "message persisted");
  assert.equal(row.ingest_state, "processed", "dispatch path completed");
  assert.equal(row.body_text.length, body.length, "full cleaned body persisted");
  assert.equal(row.body_text.slice(1499, 1499 + 11), "MARKER-1500", "char 1500 readable");
  assert.equal(row.snippet.length <= 201, true, "list still uses snippet");
  assert.ok(row.raw_r2_key && String(row.raw_r2_key).includes("email/raw/w1/"), "raw MIME key stored");

  const full = await readEmailMessage(env, "w1", row.id);
  assert.ok(full, "read returns row for its workspace");
  assert.equal(full!.bodyText!.slice(1499, 1499 + 11), "MARKER-1500");
  assert.equal(full!.bodyAvailable, true);
  const other = await readEmailMessage(env, "w2", row.id);
  assert.equal(other, null, "cross-workspace read must fail");
  console.log("  ✅ 2000-char mail readable at char 1500 (workspace isolated)");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1);
  const env = makeEnv(d1);
  const html = `<html><head><style>p{color:red}</style></head><body><script>alert(1)</script><p>Hello <b>HTML</b> world</p><p>Second line</p></body></html>`;
  const { result } = await ingest(env, rawEmail({ body: html, contentType: "text/html; charset=utf-8", messageId: "<html@example.net>" }));
  assert.equal(result.handled, true);
  const row = await d1Get<any>(d1, `SELECT body_text, body_html FROM email_messages`);
  assert.ok(row.body_text.includes("Hello HTML world"), `html text extracted, got: ${row.body_text}`);
  assert.ok(row.body_text.includes("Second line"));
  assert.ok(!row.body_text.includes("alert(1)"), "script content must not leak into text");
  assert.ok(row.body_html && !row.body_html.includes("<script"), "stored html is sanitized");
  console.log("  ✅ HTML-only mail readable, script stripped");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1, { dailyOutCap: 1 });
  const off = makeEnv(d1, { flags: { AGENT_EMAIL_OUTBOUND_ENABLED: undefined } });
  const r1 = await ingest(off, rawEmail({ body: "first", messageId: "<o1@example.net>" }));
  assert.equal(r1.result.handled, true);
  assert.equal(d1.db.prepare(`SELECT COUNT(*) AS c FROM email_outbox`).get()!["c"], 0, "outbound disabled → no outbox row");

  const on = makeEnv(d1);
  await ingest(on, rawEmail({ body: "second", messageId: "<o2@example.net>" }));
  await ingest(on, rawEmail({ body: "third", messageId: "<o3@example.net>" }));
  const rows = d1.db.prepare(`SELECT COUNT(*) AS c FROM email_outbox`).get()!["c"];
  assert.equal(rows, 1, "daily_out_cap=1 → only one outbound row, over-cap produces none");
  console.log("  ✅ auto-reply respects outbound flag + daily_out_cap (no outbox over cap)");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1);
  const calls = { n: 0 };
  const env = makeEnv(d1, { agentCalls: calls });
  const raw = rawEmail({ body: "Please reply.", messageId: "<once@example.net>" });
  await ingest(env, raw);
  assert.equal(calls.n, 1);
  const again = await ingest(env, raw);
  assert.equal(again.result.reason, "duplicate", "processed replay → duplicate");
  assert.equal(calls.n, 1, "processed replay must not re-run the model");


  d1.db.prepare(`UPDATE email_messages SET ingest_state='dispatch_failed', processing_finished_at=NULL`).run();
  const third = await ingest(env, raw);
  assert.notEqual(third.result.reason, "duplicate", "failed row must be recoverable, not permanently duplicate");
  assert.equal(calls.n, 2, "recovery runs exactly once more");
  const row = await d1Get<any>(d1, `SELECT ingest_state, ingest_attempts FROM email_messages`);
  assert.equal(row.ingest_state, "processed");
  assert.equal(Number(row.ingest_attempts), 2, "attempts counted per claim (duplicate replay does not claim)");
  console.log("  ✅ processed replay no-op; dispatch_failed recovery works once");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1);
  const calls = { n: 0 };
  const env = makeEnv(d1, { agentCalls: calls });
  const raw = rawEmail({ body: "lease me", messageId: "<lease@example.net>" });

  await ingest(env, raw);
  const row = await d1Get<any>(d1, `SELECT id, fingerprint FROM email_messages`);
  d1.db.prepare(`UPDATE email_messages SET ingest_state='processing', processing_started_at=?`).run(Date.now());
  const r = await ingest(env, raw);
  assert.equal(r.result.reason, "in_progress", "valid processing lease must not be stolen");
  assert.equal(calls.n, 1, "no re-run while another instance holds the lease");
  void row;
  console.log("  ✅ valid processing lease → in_progress (no steal, no re-run)");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1);
  const env = makeEnv(d1, { breakInsert: true });
  await assert.rejects(
    () => ingest(env, rawEmail({ body: "db down", messageId: "<db@example.net>" })),
    /d1_unavailable/,
    "reserve DB error must propagate to platform handler",
  );
  console.log("  ✅ reserve DB error propagates (never acked as duplicate)");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1);
  const env = makeEnv(d1);
  env.DB = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("d1_read_failed"); }, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) }) };
  await assert.rejects(() => ingest(env, rawEmail({ body: "x", messageId: "<r@example.net>" })), /d1_read_failed/);
  console.log("  ✅ mailbox resolve DB error propagates (not unknown_recipient)");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1);
  const calls = { n: 0 };
  const env = makeEnv(d1, {
    agentCalls: calls,
    hook: { beforeExternalEvent: async () => { throw new Error("abuse_db_down"); } },
  });
  const { result } = await ingest(env, rawEmail({ body: "stranger mail", messageId: "<gate@example.net>" }));
  assert.equal(result.handled, true);
  const row = await d1Get<any>(d1, `SELECT ingest_state, body_text FROM email_messages`);
  assert.equal(row.ingest_state, "stored_gate_error", "gate failure → store-only marker");
  assert.ok(row.body_text.includes("stranger mail"), "mail data preserved");
  assert.equal(calls.n, 0, "gate error must not run the model");
  console.log("  ✅ stranger gate error → stored_gate_error, no model");
}


{
  const d1 = createTestD1();
  seedWorkspace(d1, { strangerAutoreply: 0 });
  const calls = { n: 0 };
  const env = makeEnv(d1, { agentCalls: calls });
  const { result } = await ingest(env, rawEmail({ body: "no opt-in", messageId: "<optin@example.net>" }));
  assert.equal(result.reason, "stored_stranger_autoreply_off");
  assert.equal(calls.n, 0);
  console.log("  ✅ stranger autoreply requires workspace opt-in + global flag");
}

console.log("✅ email-ingress-persistence.test.ts passed");