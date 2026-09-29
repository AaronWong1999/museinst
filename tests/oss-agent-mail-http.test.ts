
import assert from "node:assert/strict";
import { createTestD1, d1Exec, d1Get, type TestD1 } from "./helpers/d1";
import worker from "../src/worker";
import { createSession } from "../src/session";

console.log("▶ OSS Agent Mail HTTP contract (V2 §28)");

const WS = "w_oss_http";
const USER = "u_oss_http";
const SECRET = "secret-oss-http-12345678901234567890";

function seed(d1: TestD1) {
  d1Exec(d1, `INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 0)`, USER);
  d1Exec(d1, `INSERT OR IGNORE INTO workspaces (id, owner_user_id, created_at) VALUES (?, ?, 0)`, WS, USER);
}

const d1 = createTestD1();
seed(d1);

const env: any = {
  DB: d1,
  OPENINST_SECRET: SECRET,
  AGENT_EMAIL_ENABLED: "0",
  AGENT_EMAIL_OUTBOUND_ENABLED: "0",
  EMAIL_DOMAIN: "mail.openinst.com",
};

const session = await createSession(env, USER, WS);
const cookie = `oi=${session.cookie}`;


{
  const resDisabled = await worker.fetch(
    new Request("https://openinst.example/api/agent-email/mailbox", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ prefix: "osstest" }),
    }),
    env,
    {} as never,
  );
  assert.equal(resDisabled.status, 403);
  assert.deepEqual(await resDisabled.json(), { error: "email_disabled" });


  env.AGENT_EMAIL_ENABLED = "1";
  const resEnabled = await worker.fetch(
    new Request("https://openinst.example/api/agent-email/mailbox", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ prefix: "osstest" }),
    }),
    env,
    {} as never,
  );
  assert.equal(resEnabled.status, 200);
  const data = (await resEnabled.json()) as any;
  assert.equal(data.ok, true);
  assert.equal(data.email, "osstest@mail.openinst.com");
  console.log("  ✅ POST /api/agent-email/mailbox checks AGENT_EMAIL_ENABLED and registers mailbox");
}

// ── 2. GET & PATCH /api/agent-email/mailbox ──────────────────────────────────
{
  const getRes = await worker.fetch(
    new Request("https://openinst.example/api/agent-email/mailbox", {
      headers: { cookie },
    }),
    env,
    {} as never,
  );
  assert.equal(getRes.status, 200);
  const data = (await getRes.json()) as any;
  assert.equal(data.mailbox.address, "osstest@mail.openinst.com");
  assert.equal(data.mailbox.strangerAutoreply, true);
  assert.equal(data.mailbox.notifyChannel, "wechat");


  const patchRes = await worker.fetch(
    new Request("https://openinst.example/api/agent-email/mailbox", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ strangerAutoreply: false, notifyChannel: "telegram" }),
    }),
    env,
    {} as never,
  );
  assert.equal(patchRes.status, 200);

  const getAgain = await worker.fetch(
    new Request("https://openinst.example/api/agent-email/mailbox", { headers: { cookie } }),
    env,
    {} as never,
  );
  const updated = (await getAgain.json()) as any;
  assert.equal(updated.mailbox.strangerAutoreply, false);
  assert.equal(updated.mailbox.notifyChannel, "telegram");
  console.log("  ✅ GET & PATCH /api/agent-email/mailbox reads and updates mailbox settings");
}

// ── 3. GET /api/agent-email/availability ─────────────────────────────────────
{
  const availRes = await worker.fetch(
    new Request("https://openinst.example/api/agent-email/availability?prefix=osstest", {
      headers: { cookie },
    }),
    env,
    {} as never,
  );
  assert.equal(availRes.status, 200);
  assert.equal((await availRes.json() as any).available, true, "own mailbox remains available for same workspace");
  console.log("  ✅ GET /api/agent-email/availability resolves correctly");
}

console.log("✅ oss-agent-mail-http: all assertions passed");
