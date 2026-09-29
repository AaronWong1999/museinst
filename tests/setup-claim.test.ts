import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/d1";
import worker from "../src/worker";

console.log("▶ Browser claim for keyless Deploy-button instances");

const SECRET = "secret-setup-claim-1234567890123456789";

function makeEnv(extra: Record<string, unknown> = {}): any {
  return { DB: createTestD1(), OPENINST_SECRET: SECRET, ...extra };
}

async function call(env: any, path: string, init: RequestInit = {}) {
  const res = await worker.fetch(new Request(`https://agent.example${path}`, init), env, {} as never);
  return { res, body: (await res.json().catch(() => ({}))) as any };
}

const post = (headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: "{}",
});

{
  const env = makeEnv({ SETUP_CLAIM_UNTIL: new Date(Date.now() + 60_000).toISOString() });
  const status = await call(env, "/api/setup/status");
  assert.equal(status.body.claimable, true);

  const claim = await call(env, "/api/setup", post());
  assert.equal(claim.res.status, 200);
  assert.match(claim.body.recoveryKey, /^mi_[0-9a-f]{48}$/);
  assert.ok(claim.res.headers.get("set-cookie"));
  console.log("  ✅ first visit claims the instance and gets a recovery key");

  const again = await call(env, "/api/setup", post());
  assert.equal(again.res.status, 401);
  assert.equal((await call(env, "/api/setup/status")).body.claimable, false);
  console.log("  ✅ a second keyless claim is refused");

  const recovered = await call(env, "/api/setup", post({ "x-admin-key": claim.body.recoveryKey }));
  assert.equal(recovered.res.status, 200);
  assert.equal(recovered.body.recoveryKey, undefined);
  const wrong = await call(env, "/api/setup", post({ "x-admin-key": "mi_" + "0".repeat(48) }));
  assert.equal(wrong.res.status, 401);
  console.log("  ✅ the recovery key reopens the owner session; a wrong key does not");

  const admin = await call(env, "/admin/wechat/status", { headers: { "x-admin-key": claim.body.recoveryKey } });
  assert.equal(admin.res.status, 200);
  const cookie = claim.res.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await call(env, "/admin/wechat/status", { headers: { cookie } })).res.status, 200);
  assert.equal((await call(env, "/admin/wechat/status")).res.status, 401);
  console.log("  ✅ the recovery key and the owner session authorize admin routes; anonymous does not");
}

{
  const env = makeEnv({ SETUP_CLAIM_UNTIL: new Date(Date.now() - 1).toISOString() });
  assert.equal((await call(env, "/api/setup/status")).body.claimable, false);
  assert.equal((await call(env, "/api/setup", post())).res.status, 401);
  console.log("  ✅ an expired claim window refuses keyless setup");
}

{
  const env = makeEnv({ ADMIN_KEY: "k".repeat(32), SETUP_CLAIM_UNTIL: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await call(env, "/api/setup/status")).body.claimable, false);
  assert.equal((await call(env, "/api/setup", post())).res.status, 401);
  assert.equal((await call(env, "/api/setup", post({ "x-admin-key": "k".repeat(32) }))).res.status, 200);
  console.log("  ✅ with ADMIN_KEY configured the claim window never opens");
}

{
  // An orphan marker from an interrupted claim (no workspace behind it) must not
  // lock the instance: status and POST agree, and the next claim succeeds.
  const env = makeEnv({ SETUP_CLAIM_UNTIL: new Date(Date.now() + 60_000).toISOString() });
  await env.DB.prepare(`INSERT INTO settings (workspace_id, key, value) VALUES ('__global', 'owner_claimed_at', '1')`).run();
  await env.DB.prepare(`INSERT INTO settings (workspace_id, key, value) VALUES ('__global', 'owner_recovery_key_sha256', 'stale')`).run();
  assert.equal((await call(env, "/api/setup/status")).body.claimable, true);
  const claim = await call(env, "/api/setup", post());
  assert.equal(claim.res.status, 200);
  assert.match(claim.body.recoveryKey, /^mi_[0-9a-f]{48}$/);
  console.log("  ✅ an orphan claim marker is cleared and the claim succeeds");
}

{
  // A failure after the claim transaction releases the claim so the visitor can retry.
  const env = makeEnv({ SETUP_CLAIM_UNTIL: new Date(Date.now() + 60_000).toISOString() });
  const realPrepare = env.DB.prepare.bind(env.DB);
  let failSessions = true;
  env.DB.prepare = (sql: string) => {
    if (failSessions && /INSERT INTO sessions/.test(sql)) throw new Error("d1: write failed");
    return realPrepare(sql);
  };
  const first = await call(env, "/api/setup", post());
  assert.equal(first.res.status, 500);
  const ws = await realPrepare(`SELECT COUNT(*) AS n FROM workspaces`).first();
  const marker = await realPrepare(`SELECT COUNT(*) AS n FROM settings WHERE workspace_id='__global'`).first();
  assert.equal(ws.n, 0);
  assert.equal(marker.n, 0);
  assert.equal((await call(env, "/api/setup/status")).body.claimable, true);
  failSessions = false;
  const retry = await call(env, "/api/setup", post());
  assert.equal(retry.res.status, 200);
  assert.match(retry.body.recoveryKey, /^mi_[0-9a-f]{48}$/);
  console.log("  ✅ a failed claim leaves no marker and the retry succeeds");
}

{
  // Once ADMIN_KEY is configured, it supersedes a previously issued recovery key.
  const env = makeEnv({ SETUP_CLAIM_UNTIL: new Date(Date.now() + 60_000).toISOString() });
  const claim = await call(env, "/api/setup", post());
  env.ADMIN_KEY = "admin-key-abcdefghijklmnopqrstuvwxyz";
  assert.equal((await call(env, "/api/setup", post({ "x-admin-key": claim.body.recoveryKey }))).res.status, 401);
  assert.equal((await call(env, "/api/setup", post({ "x-admin-key": env.ADMIN_KEY }))).res.status, 200);
  console.log("  ✅ ADMIN_KEY revokes the recovery key");
}
