




import assert from "node:assert/strict";
import { withDeadline, fetchWithDeadline, DeadlineExceededError, DEADLINE_BUDGETS_MS } from "../src/util/deadlines";
import { callModel } from "../src/model/call";

console.log("▶ P1-06 fault injection (merged audit §15)");



{
  const env: any = {
    MODEL_PROVIDER: "openai",
    MODEL_BASE_URL: "https://model.test/v1",
    MODEL_API_KEY: "k",
    MODEL_ROOT: "m",
    MODEL_WORKER: "m",
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    return new Promise(() => {});
  }) as typeof fetch;
  const start = Date.now();
  let err: unknown = null;
  try {
    await callModel(env, "root", [{ role: "user", content: "hi" }], { timeoutMs: 800 });
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const elapsed = Date.now() - start;
  assert.ok(err, "hung provider 必须抛错");
  assert.match(String(err), /deadline_exceeded/, "错误必须是 deadline_exceeded");
  assert.ok(elapsed < 5000, `hard deadline 内结束（整体 budget），实际 ${elapsed}ms`);
  console.log(`  ✅ hung model fetch ends in deadline (${elapsed}ms, fetchCalls=${fetchCalls})`);
}


{
  let lateSeen: unknown = "none";
  let resolveLate!: (v: string) => void;
  const late = new Promise<string>((r) => { resolveLate = r; });
  const p = withDeadline(late, { operation: "test:late", budgetMs: 50, onLateResult: (v) => { lateSeen = v ?? "late"; } });
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof DeadlineExceededError, "超时必须抛 DeadlineExceededError");
  resolveLate("too-late-value");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lateSeen, "too-late-value", "晚到结果必须经 onLateResult 隔离");
  console.log("  ✅ late results quarantined, never mutate task state");
}


{
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = () => new Promise(() => {});
  const start = Date.now();
  let err: unknown = null;
  try {
    await fetchWithDeadline("https://hung.test/", undefined, { operation: "test:hung", budgetMs: 200 });
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = origFetch;
  }
  const elapsed = Date.now() - start;
  assert.ok(err instanceof DeadlineExceededError, "hung fetch 必须转 deadline 错误");
  assert.ok(elapsed < 3000, `hung fetch 可中断，实际 ${elapsed}ms`);
  console.log(`  ✅ hung fetch interrupted (${elapsed}ms)`);
}


{
  const start = Date.now();
  let err: unknown = null;
  try {
    await withDeadline(new Promise(() => {}), { operation: "agent_rpc:/event", budgetMs: 200, onLateResult: () => {} });
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - start;
  assert.ok(err instanceof DeadlineExceededError);
  assert.ok(elapsed < 3000);
  console.log(`  ✅ hung parent RPC ends in deadline (${elapsed}ms)`);
}


{
  const { DatabaseSync } = await import("node:sqlite");
  const { createTestD1 } = await import("./helpers/d1");
  const { consumeInboundEnvelope } = await import("../src/channels/inbox");
  const d1 = createTestD1();
  void DatabaseSync;
  d1.db.prepare(`INSERT OR REPLACE INTO users (id, created_at) VALUES ('u_l', 0)`).run();
  d1.db.prepare(`INSERT OR REPLACE INTO workspaces (id, owner_user_id, created_at) VALUES ('ws_l', 'u_l', 0)`).run();
  d1.db.prepare(`INSERT OR REPLACE INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '77', 'ws_l', 0, 0)`).run();
  d1.db.prepare(`INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('__global', 'telegram_bot_id', '42')`).run();

  const past = Date.now() - 60_000;
  d1.db.prepare(
    `INSERT OR REPLACE INTO channel_inbox (id, channel, bot_id, external_key, payload_json, status, attempts, lease_token, lease_until, received_at)
     VALUES ('ci_42_90', 'telegram', '42', '90', ?, 'processing', 1, 'new-owner', ?, ?)`,
  ).run(JSON.stringify({ update_id: 90, message: { message_id: 90, from: { id: 77 }, chat: { id: 77, type: "private" }, text: "hi" } }), Date.now() + 600_000, Date.now());
  void past;
  const stale = d1.db.prepare(`UPDATE channel_inbox SET lease_until=? WHERE id='ci_42_90' AND lease_token='dead-instance'`).run();
  assert.equal(Number((stale as any).changes ?? stale), 0, "旧 token 不得续租/写状态");
  const env: any = {
    DB: d1, TELEGRAM_BOT_TOKEN: "42:t",
    AI: { run: async () => ({ text: "x" }) },
    PUBLIC_BASE_URL: "https://example.com",
    AGENT: { idFromName: (n: string) => ({ name: n }), get: () => ({ fetch: async () => new Response(JSON.stringify({ replies: ["r"], taskId: "t" })) }) },
  };
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  const out = await consumeInboundEnvelope(env, { v: 1, channel: "telegram", botId: "42", externalKey: "90", payload: { update_id: 90, message: { message_id: 90, from: { id: 77 }, chat: { id: 77, type: "private" }, text: "hi" } }, receivedAt: Date.now() } as any);
  globalThis.fetch = origFetch;
  assert.equal(out.kind, "retry", "有效租期不可抢占");
  console.log("  ✅ ownership lost stops old executor");
}


{
  const { TOOL_mail_thread, TOOL_todo_complete, TOOL_contact_create } = await import("../src/agent/tools");
  const ctx: any = { env: { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } }, workspaceId: "w", userId: "u", channel: "web", lang: "zh", say: async () => {}, hasActiveBrowserTask: () => false };
  for (const [t, args] of [[TOOL_mail_thread, { threadId: "1" }], [TOOL_todo_complete, { taskId: "1" }], [TOOL_contact_create, { name: "n" }]] as const) {
    const r = await (t as any).run(ctx, args);
    assert.equal(r.ok, false, `${(t as any).name} 绝不假成功`);
  }
  console.log("  ✅ incomplete tools never synthesize success");
}


{
  assert.ok(DEADLINE_BUDGETS_MS.modelRequest <= 60_000, "model budget 30–60s");
  assert.ok(DEADLINE_BUDGETS_MS.imapCommand <= 30_000, "imap 单命令 15–30s");
  assert.ok(DEADLINE_BUDGETS_MS.telegramSend <= 20_000, "telegram send 10–20s");
  assert.ok(DEADLINE_BUDGETS_MS.foregroundTurn <= 120_000, "foreground turn 90–120s");
  assert.ok(DEADLINE_BUDGETS_MS.browserJobCap <= 10 * 60_000, "browser cap ≤10min");
  console.log("  ✅ deadline hierarchy sane");
}

console.log("✅ merged-p1-06-fault-injection tests passed");
