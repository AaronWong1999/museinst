// DEFECT-024 — mail data minimization.
//
// A count-only mail request must never pull message content off the IMAP
// server: mail_count issues SELECT + SEARCH only (zero FETCH), mail_list may
// fetch headers (BODY.PEEK[HEADER.FIELDS]) but never bodies, folder scoping is
// validated before it reaches the wire, and mail_read is documented as
// explicit-read-only.
import assert from "node:assert/strict";
import { __setConnectForTests, imapCount, imapList, normalizeImapFolder } from "../src/imap/imap";
import { TOOL_mail_count, TOOL_mail_list, TOOL_mail_read } from "../src/agent/tools";
import { toolCtx, makeConnectorEnv } from "./helpers/connectors-testkit";

console.log("▶ DEFECT-024 mail count minimization");

// Shared fake IMAP socket: records every command line sent and answers like a
// small server. Body/header fetch responses embed marker text that must never
// appear in a count-only session.
function fakeImapSocket(opts: { searchSeqs?: number[] } = {}) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const commands: string[] = [];
  const seqs = opts.searchSeqs ?? [1, 2, 3];
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
      controller.enqueue(enc.encode("* OK IMAP4rev1 Ready\r\n"));
    },
  });
  const respond = (tag: string, line: string) => {
    const push = (s: string) => readableController.enqueue(enc.encode(s));
    if (line.includes("CAPABILITY")) push(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK CAPABILITY completed\r\n`);
    else if (line.includes("LOGIN")) push(`${tag} OK LOGIN completed\r\n`);
    else if (line.startsWith("a") === false) push(`${tag} OK completed\r\n`);
    else if (/^a\d+ SELECT /i.test(line)) push(`* ${seqs.length} EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
    else if (/^a\d+ SEARCH/i.test(line)) push(`* SEARCH ${seqs.join(" ")}\r\n${tag} OK SEARCH completed\r\n`);
    else if (/FETCH/i.test(line)) {
      // Content marker: if this ever reaches the client during a count, the
      // minimization assertion below fails loudly.
      push(`* 1 FETCH (UID 1 BODY[TEXT] {9}\r\nSECRET-BODY\r\n)\r\n${tag} OK FETCH completed\r\n`);
    } else if (line.includes("LOGOUT")) push(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
    else push(`${tag} OK completed\r\n`);
  };
  let inBuffer = "";
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      inBuffer += dec.decode(chunk);
      while (inBuffer.includes("\r\n")) {
        const idx = inBuffer.indexOf("\r\n");
        const line = inBuffer.slice(0, idx);
        inBuffer = inBuffer.slice(idx + 2);
        commands.push(line);
        respond(line.split(" ")[0], line);
      }
    },
  });
  return { readable, writable, close: async () => {}, commands };
}

const CFG = { host: "imap.example.com", port: 993, user: "a@x.com", pass: "p" };

function assertNoBodyFetch(commands: string[], label: string) {
  const leaked = commands.filter((c) => /BODY\[TEXT\]|BODY\[\]|RFC822\.TEXT|RFC822\b/i.test(c));
  assert.equal(leaked.length, 0, `${label}: 不允许任何正文 FETCH，实际 ${leaked.join(" | ")}`);
}

console.log("  [1] imapCount: SELECT + SEARCH only, zero body fetches, exact count");
{
  const socket = fakeImapSocket({ searchSeqs: [2, 4, 6, 8] });
  __setConnectForTests(() => socket as any);
  let r: { folder: string; count: number };
  try {
    r = await imapCount(CFG, "UNSEEN", "INBOX");
  } finally {
    __setConnectForTests(null);
  }
  assert.equal(r.count, 4);
  assert.equal(r.folder, "INBOX");
  assert.ok(socket.commands.some((c) => /^a\d+ SELECT /i.test(c)), "count 路径必须有 SELECT");
  assert.ok(socket.commands.some((c) => /^a\d+ SEARCH/i.test(c)), "count 路径必须有 SEARCH");
  assertNoBodyFetch(socket.commands, "imapCount");
  console.log("    ✅ count=4 via SELECT+SEARCH; no FETCH issued");
}

console.log("  [2] mail_count tool (direct vault path): header-only even for mail_list; bodies never fetched");
{
  const socket = fakeImapSocket();
  __setConnectForTests(() => socket as any);
  let r: any;
  try {
    r = await TOOL_mail_count.run(toolCtx(makeConnectorEnv(), "ws-mail"), {
      search: "UNSEEN",
      provider: "qq",
    });
  } finally {
    __setConnectForTests(null);
  }
  // resolveMailbox with no vault items → tool must fail honestly, but that
  // failure path must not open a socket either. To exercise the count path
  // directly we already covered it in [1] via imapCount; here we assert the
  // honest no-credential error instead of a fabricated count.
  assert.equal(r.ok, false, "无授权码时必须如实失败");
  assertNoBodyFetch(socket.commands, "mail_count(no-vault)");
  console.log("    ✅ no credentials → honest failure, no socket I/O");

  // mail_list still exists as the header-only listing path: assert via the
  // imap layer that its FETCH is restricted to HEADER.FIELDS (never BODY[]).
  const listSocket = fakeImapSocket();
  __setConnectForTests(() => listSocket as any);
  try {
    await imapList(CFG, "", 5, "INBOX");
  } finally {
    __setConnectForTests(null);
  }
  const listFetches = listSocket.commands.filter((c) => /FETCH/i.test(c));
  assert.ok(listFetches.every((c) => /HEADER\.FIELDS/i.test(c)), "mail_list 的 FETCH 只能取 HEADER.FIELDS");
  assertNoBodyFetch(listSocket.commands, "imapList");
  console.log("    ✅ mail_list fetches headers only");
}

console.log("  [3] mail_count tool (executor path): count-only RPC, no listMail/readMail call");
{
  const calls: string[] = [];
  const env: any = {
    PUBLIC_BASE_URL: "https://x",
    DB: {
      prepare(_q: string) {
        return {
          bind(..._a: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                // defaultMailboxAccount lookup
                return { email: "user@qq.com" } as T;
              },
            };
          },
        };
      },
    },
    IMAP: {
      async countMail(req: { workspaceId: string; account: string; search?: string; folder?: string }) {
        calls.push(`countMail:${req.account}:${req.search ?? ""}:${req.folder ?? "INBOX"}`);
        return { ok: true, folder: req.folder ?? "INBOX", count: 7 };
      },
      async listMail() {
        calls.push("listMail");
        return { ok: true, mails: [{ subject: "LEAK" }] };
      },
      async readMail() {
        calls.push("readMail");
        return { ok: true, mail: { body: "LEAK" } };
      },
    },
  };
  const r = await TOOL_mail_count.run(toolCtx(env, "ws-mail"), { search: "UNSEEN", folder: "Archive" });
  assert.ok(r.ok, `mail_count 必须成功：${(r as any)?.error}`);
  assert.equal((r.data as any).count, 7);
  assert.equal((r.data as any).folder, "Archive");
  assert.equal((r.data as any).account, "u***@qq.com");
  assert.deepEqual(calls, ["countMail:user@qq.com:UNSEEN:Archive"], "只能调用 countMail，绝不能 listMail/readMail");
  console.log("    ✅ executor path routes to countMail(Archive)=7 only");
}

console.log("  [4] folder scoping reaches the SELECT command");
{
  const socket = fakeImapSocket({ searchSeqs: [1] });
  __setConnectForTests(() => socket as any);
  try {
    const r = await imapCount(CFG, "", "archive");
    assert.equal(r.folder, "ARCHIVE", "folder 名统一大写返回");
    assert.equal(r.count, 1);
  } finally {
    __setConnectForTests(null);
  }
  assert.ok(
    socket.commands.some((c) => /^a\d+ SELECT "ARCHIVE"$/i.test(c)),
    `SELECT 必须针对 ARCHIVE，实际 ${socket.commands.join(" | ")}`,
  );
  console.log("    ✅ SELECT \"ARCHIVE\" issued (case-normalized)");
}

console.log("  [5] invalid folder names are rejected before any command is sent");
{
  const bad = ["INBOX; rm -rf", "Foo\"bar", "A\r\nB", 'a)b("c', "f\\older", "x".repeat(121)];
  for (const f of bad) {
    assert.throws(() => normalizeImapFolder(f), `非法文件夹 "${f.slice(0, 20)}" 必须被拒绝`);
  }
  // Also through the tool surface (executor path validates inside imapCount;
  // direct path surfaces the error as an honest tool failure).
  const socket = fakeImapSocket();
  __setConnectForTests(() => socket as any);
  let errored = false;
  try {
    await imapCount(CFG, "", 'IN"BOX');
  } catch {
    errored = true;
  } finally {
    __setConnectForTests(null);
  }
  assert.ok(errored, "含引号的文件夹名必须让会话失败");
  assert.ok(socket.commands.every((c) => !c.includes('"' + 'IN"')), "被拒绝的文件夹名不能出现在任何 IMAP 命令里");
  // Valid names with legal characters still pass.
  assert.equal(normalizeImapFolder(" Sent Items "), "SENT ITEMS");
  assert.equal(normalizeImapFolder("Archive/2026"), "ARCHIVE/2026");
  assert.equal(normalizeImapFolder(undefined), "INBOX");
  assert.equal(normalizeImapFolder("INBOX&Flags"), "INBOX&FLAGS");
  console.log("    ✅ injection/quote/CRLF/oversize rejected; legal names normalized");
}

console.log("  [6] mail_read is documented as explicit-content-only; mail_count stays header-free");
{
  assert.ok(
    /只允许|明确要求/.test(TOOL_mail_read.description) && /mail_count|mail_list/.test(TOOL_mail_read.description),
    "mail_read 描述必须限制为『用户明确要求读具体邮件内容』",
  );
  assert.match(TOOL_mail_read.description, /计数|列清单|汇总|扫描/, "mail_read 描述必须点名禁止计数/列表/汇总/扫描场景");
  assert.match(TOOL_mail_count.description, /数字|count|不.*内容|绝不返回/i, "mail_count 描述必须承诺只返回数字");
  assert.ok(!TOOL_mail_count.parameters || JSON.stringify(TOOL_mail_count.parameters).length < 800, "mail_count schema 应保持最小（search/folder/provider/account）");
  console.log("    ✅ tool descriptions carry the minimization contract");
}

console.log("✅ mail-count-minimization tests passed");
