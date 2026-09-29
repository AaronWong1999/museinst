import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/d1";
import worker from "../src/worker";
import { createSession } from "../src/session";
import { createReceipt } from "../src/tasks/tasks";

console.log("▶ Task receipts are private until the owner shares them");

const SECRET = "secret-receipt-privacy-1234567890123";
const d1 = createTestD1();
const objects = new Map<string, Uint8Array>();
const env: any = {
  DB: d1,
  OPENINST_SECRET: SECRET,
  ARTIFACTS: {
    get: async (k: string) => (objects.has(k) ? { arrayBuffer: async () => objects.get(k)!.buffer } : null),
    put: async (k: string, v: Uint8Array) => { objects.set(k, v); },
    delete: async (k: string) => { objects.delete(k); },
    list: async () => ({ objects: [], truncated: false }),
  },
};
await d1.prepare(`INSERT INTO users (id, created_at) VALUES ('u1', 0)`).run();
await d1.prepare(`INSERT INTO workspaces (id, owner_user_id, created_at) VALUES ('w1', 'u1', 0)`).run();
await d1.prepare(
  `INSERT INTO tasks (id, workspace_id, channel, class, title, status, started_at, completed_at)
   VALUES ('t1', 'w1', 'web', 'browser', 'Pick up keys at 12 Secret Lane, call 13800138000', 'verified_success', 1, 2)`,
).run();

const slug = (await createReceipt(env, "t1"))!;
assert.ok(slug);
const cookie = `oi=${(await createSession(env, "u1", "w1")).cookie}`;
const get = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://agent.example${path}`, { headers }), env, {} as never);

assert.equal((await get(`/api/receipt/${slug}`)).status, 404);
assert.equal((await get(`/r/${slug}`)).status, 404);
assert.equal((await get(`/r/${slug}/og.png`)).status, 404);
console.log("  ✅ a new receipt is not readable anonymously");

const own = await get(`/api/receipt/${slug}`, { cookie });
assert.equal(own.status, 200);
const body = await own.json() as any;
assert.doesNotMatch(body.title, /13800138000/);
console.log("  ✅ the owner can read it, and the title is redacted");

const share = await worker.fetch(new Request(`https://agent.example/api/receipts/${slug}/visibility`, {
  method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ public: true }),
}), env, {} as never);
assert.equal(share.status, 200);
assert.equal((await get(`/api/receipt/${slug}`)).status, 200);
console.log("  ✅ once shared, anyone with the link can read it");

objects.set(`receipts/${slug}.jpg`, new Uint8Array([1, 2, 3]));
const del = await worker.fetch(new Request(`https://agent.example/api/privacy/delete`, {
  method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ mode: "disconnect_and_delete" }),
}), env, {} as never);
assert.equal(del.status, 200);
assert.equal(objects.has(`receipts/${slug}.jpg`), false);
assert.equal((await get(`/r/${slug}/og.png`)).status, 404);
console.log("  ✅ disconnect-and-delete removes the cached share image too");
