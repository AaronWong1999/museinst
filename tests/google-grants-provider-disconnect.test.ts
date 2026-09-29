import assert from "node:assert/strict";
import { disconnectProviderStatements } from "../src/wipe";

function fakeEnv() {
  const prepared: Array<{ sql: string; binds: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      const row = { sql, binds: [] as unknown[] };
      prepared.push(row);
      return {
        bind(...args: unknown[]) {
          row.binds = args;
          return { sql, binds: args } as any;
        },
      } as any;
    },
  };
  return { env: { DB } as any, prepared };
}

{
  const { env, prepared } = fakeEnv();
  disconnectProviderStatements(env, "ws_1", "google");
  const grantDeletes = prepared.filter((x) => /DELETE FROM google_file_grants/.test(x.sql));
  assert.equal(grantDeletes.length, 1, "provider-wide Google disconnect must clear file grants");
  assert.deepEqual(grantDeletes[0].binds, ["ws_1"]);
}

{
  const { env, prepared } = fakeEnv();
  disconnectProviderStatements(env, "ws_1", "github");
  assert.equal(prepared.some((x) => /DELETE FROM google_file_grants/.test(x.sql)), false,
    "non-Google disconnect must not touch Google file grants");
}

console.log("google-grants-provider-disconnect: ok");
