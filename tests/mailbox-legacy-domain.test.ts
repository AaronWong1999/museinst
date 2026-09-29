// mailbox-legacy-domain.test.ts — a mailbox domain move keeps old addresses receiving.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resolveMailbox } from "../src/channels/email/mailbox";

console.log("▶ agent mailbox legacy domains");

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE agent_mailboxes (workspace_id TEXT, local_part TEXT, domain TEXT, address TEXT UNIQUE, status TEXT)`);
db.prepare(`INSERT INTO agent_mailboxes VALUES ('w1','alice','bot.museinst.com','alice@bot.museinst.com','active')`).run();
db.prepare(`INSERT INTO agent_mailboxes VALUES ('w2','bob','bot.museinst.com','bob@bot.museinst.com','disabled')`).run();

const d1 = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => (db.prepare(sql).all(...(args as never[]))[0] ?? null),
    }),
  }),
};

const moved = { DB: d1, EMAIL_DOMAIN: "bot.museinst.com", EMAIL_LEGACY_DOMAINS: "mail.openinst.com" } as any;
assert.equal((await resolveMailbox(moved, "alice@bot.museinst.com"))?.workspaceId, "w1");
assert.equal((await resolveMailbox(moved, "Alice+thread@mail.openinst.com"))?.workspaceId, "w1", "old address still routes to the same mailbox");
assert.equal(await resolveMailbox(moved, "alice@other.example"), null, "unrelated domains never match by local part");
assert.equal(await resolveMailbox(moved, "bob@mail.openinst.com"), null, "inactive mailboxes stay closed");
assert.equal(await resolveMailbox({ DB: d1, EMAIL_DOMAIN: "bot.museinst.com" } as any, "alice@mail.openinst.com"), null, "legacy matching needs an explicit legacy domain");
console.log("  ✅ legacy domain routes by local part; other domains and inactive boxes do not");
console.log("✅ mailbox-legacy-domain.test.ts passed");

{
  const { currentMailboxAddress } = await import("../src/channels/email/mailbox");
  const env = { EMAIL_DOMAIN: "bot.museinst.com", EMAIL_LEGACY_DOMAINS: "mail.openinst.com" } as any;
  assert.equal(currentMailboxAddress(env, "Alice@mail.openinst.com"), "alice@bot.museinst.com");
  assert.equal(currentMailboxAddress(env, "alice@bot.museinst.com"), "alice@bot.museinst.com");
  assert.equal(currentMailboxAddress(env, "alice@gmail.com"), "alice@gmail.com");
  assert.equal(currentMailboxAddress({} as any, "alice@mail.openinst.com"), "alice@mail.openinst.com");
  console.log("  ✅ legacy peer addresses canonicalize to the current mailbox domain");
}
