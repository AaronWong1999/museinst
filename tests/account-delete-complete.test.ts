import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/d1";
import worker from "../src/worker";
import { createSession } from "../src/session";

console.log("▶ Account deletion removes every piece of workspace content");

const d1 = createTestD1();
const calls: string[] = [];
const ns = (label: string) => ({
  idFromName: (name: string) => `${label}:${name}`,
  get: (id: string) => ({ fetch: async (url: string) => { calls.push(`${id} ${new URL(url).pathname}`); return Response.json({ ok: true }); } }),
});
const env: any = {
  DB: d1,
  OPENINST_SECRET: "secret-account-delete-12345678901234",
  AGENT: ns("agent"),
  BROWSER_WORKER: ns("browser"),
  WECHAT_POLLER: ns("poller"),
  ARTIFACTS: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ objects: [], truncated: false }) },
};
const run = (sql: string, ...args: unknown[]) => d1.prepare(sql).bind(...args).run();

await run(`INSERT INTO users (id, created_at, is_admin) VALUES ('u_self_host_owner', 0, 1)`);
await run(`INSERT INTO workspaces (id, owner_user_id, created_at) VALUES ('w_self_host_owner', 'u_self_host_owner', 0)`);
await run(`INSERT INTO settings (workspace_id, key, value) VALUES ('__global', 'owner_claimed_at', '1'), ('__global', 'owner_recovery_key_sha256', 'h')`);
await run(`INSERT INTO tasks (id, workspace_id, channel, class, title, status, started_at) VALUES ('t1', 'w_self_host_owner', 'web', 'browser', 'x', 'running', 1)`);
await run(`INSERT INTO task_goal_revisions (task_id, revision, goal, source, created_at) VALUES ('t1', 1, 'private goal', 'user', 1)`);
await run(`INSERT INTO goals (id, workspace_id, title, created_at, updated_at) VALUES ('g1', 'w_self_host_owner', 'run a marathon', 1, 1)`).catch(() => {});
await run(`INSERT INTO wechat_bots (id, token_enc, created_at, updated_at, workspace_id) VALUES ('bot1', 'enc', 1, 1, 'w_self_host_owner')`);

await run(`INSERT INTO channel_identities (channel, external_id, workspace_id, first_bound_at, last_seen_at) VALUES ('telegram', '42', 'w_self_host_owner', 1, 1)`);
await run(`INSERT INTO channel_inbox (id, channel, bot_id, external_key, payload_json, received_at) VALUES ('i1', 'telegram', 'b', 'k1', '{"message":{"chat":{"id":42},"text":"secret"}}', 1)`);
await run(`INSERT INTO channel_inbox (id, channel, bot_id, external_key, payload_json, received_at) VALUES ('i2', 'telegram', 'b', 'k2', '{"message":{"chat":{"id":99},"text":"someone else"}}', 1)`);
await run(`INSERT INTO channel_outbox (id, inbox_id, channel, destination_id, reply_index, chunk_index, text, created_at) VALUES ('o1', 'i1', 'telegram', '42', 0, 0, 'reply', 1)`);
await run(`INSERT INTO channel_outbox (id, inbox_id, channel, destination_id, reply_index, chunk_index, text, created_at) VALUES ('o2', 'i2', 'telegram', '99', 0, 0, 'other', 1)`);

const cookie = `oi=${(await createSession(env, "u_self_host_owner", "w_self_host_owner")).cookie}`;
const res = await worker.fetch(new Request("https://agent.example/api/me?confirm=DELETE", { method: "DELETE", headers: { cookie } }), env, {} as never);
assert.equal(res.status, 204);

const count = async (sql: string) => ((await d1.prepare(sql).first()) as any).n as number;
assert.equal(await count(`SELECT COUNT(*) AS n FROM task_goal_revisions`), 0);
assert.equal(await count(`SELECT COUNT(*) AS n FROM goals`), 0);
assert.equal(await count(`SELECT COUNT(*) AS n FROM wechat_bots`), 0);
assert.equal(await count(`SELECT COUNT(*) AS n FROM workspaces`), 0);
assert.equal(await count(`SELECT COUNT(*) AS n FROM settings WHERE workspace_id='__global'`), 0);
assert.deepEqual((await d1.prepare(`SELECT id FROM channel_inbox`).all() as any).results.map((r: any) => r.id), ["i2"]);
assert.deepEqual((await d1.prepare(`SELECT id FROM channel_outbox`).all() as any).results.map((r: any) => r.id), ["o2"]);
console.log("  ✅ D1 content, WeChat bots and the self-host claim lock are gone");

assert.ok(calls.includes("agent:w_self_host_owner /wipe"));
assert.ok(calls.includes("browser:w_self_host_owner /wipe"));
assert.ok(calls.includes("poller:bot1 /unregister"));
console.log("  ✅ the agent, browser worker and WeChat poller are wiped");
