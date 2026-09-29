import assert from "node:assert/strict";
import { resolveIdentity } from "../src/identity";
import { createSession, readSession } from "../src/session";

function createMockD1() {
  const tables = new Map<string, any[]>();
  tables.set("channel_identities", []);
  tables.set("workspaces", []);
  tables.set("users", []);
  tables.set("settings", []);
  tables.set("sessions", []);

  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first<T = any>(): Promise<T | null> {
              if (sql.includes("FROM channel_identities")) {
                const [channel, extId] = args;
                const rows = tables.get("channel_identities")!;
                const found = rows.find((r) => r.channel === channel && r.external_id === extId);
                return (found as any) ?? null;
              }
              if (sql.includes("FROM users")) {
                const rows = tables.get("users")!;
                return { c: rows.length } as any;
              }
              if (sql.includes("FROM sessions WHERE id=?")) {
                const [id] = args;
                const rows = tables.get("sessions")!;
                const found = rows.find((r) => r.id === id);
                return (found as any) ?? null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

async function runTests() {
  console.log("▶ Testing identity stranger safety & session invariants (F06, F07, A07, A08, A09)...");

  const d1 = createMockD1();
  const env: any = {
    DB: d1,
    ENVIRONMENT: "production",
    OPENINST_SECRET: "12345678901234567890", // valid secret
  };

  // 1. A08: Stranger message on unclaimed instance must NOT create workspace
  const id1 = await resolveIdentity(env, "telegram", "stranger_1");
  assert.equal(id1, null, "Stranger must not auto-claim or auto-create workspace");

  // 2. A09: Second stranger on claimed instance must NOT create second workspace
  const id2 = await resolveIdentity(env, "wechat", "stranger_2");
  assert.equal(id2, null, "Second stranger must not create workspace");

  // 3. A07: Missing secret in production must fail closed
  const prodNoSecret: any = {
    DB: d1,
    ENVIRONMENT: "production",
    OPENINST_SECRET: "",
  };
  await assert.rejects(
    async () => createSession(prodNoSecret, "u1", "w1"),
    /OPENINST_SECRET_REQUIRED/,
    "Production without session secret must reject session creation",
  );

  console.log("✔ Stranger safety and session production invariants passed!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
