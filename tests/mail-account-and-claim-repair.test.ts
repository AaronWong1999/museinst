// mail-account-and-claim-repair.test.ts — hosted mailbox account matching and the
// unsupported-claim repair prompt.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resolveExecutorMailboxAccount } from "../src/agent/tools";
import { externalCorrectionInstruction } from "../src/agent/external-completion-guard";

console.log("▶ mailbox account matching and claim repair");

function envWith(rows: Array<[string, string]>) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE mailbox_accounts (workspace_id TEXT, email TEXT, provider TEXT, created_at INTEGER)`);
  rows.forEach(([email, provider], i) => db.prepare(`INSERT INTO mailbox_accounts VALUES ('w1', ?, ?, ?)`).run(email, provider, i));
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
          first: async () => db.prepare(sql).all(...(args as never[]))[0] ?? null,
        }),
      }),
    },
  };
}

{
  const one = envWith([["runwr@126.com", "126"]]);
  assert.equal(await resolveExecutorMailboxAccount(one, "w1", undefined), "runwr@126.com");
  assert.equal(await resolveExecutorMailboxAccount(one, "w1", "126"), "runwr@126.com", "provider name resolves");
  assert.equal(await resolveExecutorMailboxAccount(one, "w1", "RunWR@126.com"), "runwr@126.com");
  assert.equal(await resolveExecutorMailboxAccount(one, "w1", "126邮箱"), "runwr@126.com", "a single mailbox is used when the name does not match");

  const two = envWith([["a@126.com", "126"], ["b@qq.com", "qq"]]);
  assert.equal(await resolveExecutorMailboxAccount(two, "w1", "qq"), "b@qq.com");
  assert.equal(await resolveExecutorMailboxAccount(two, "w1", "gmail"), "gmail", "ambiguous names are not guessed");
  assert.equal(await resolveExecutorMailboxAccount(envWith([]), "w1", undefined), null);
  console.log("  ✅ hosted mailbox account resolves by address, provider, or the only mailbox");
}

{
  const zh = externalCorrectionInstruction("zh", [{ type: "external_send", text: "三封邮件都已发送成功。", required: "发送记录" } as any]);
  assert.match(zh, /现在就调用工具/);
  assert.match(zh, /三封邮件都已发送成功/);
  assert.match(zh, /不要道歉/);
  console.log("  ✅ claim repair asks for the real tool call and forbids apologizing for an unseen draft");
}
console.log("✅ mail-account-and-claim-repair.test.ts passed");
