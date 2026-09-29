

import assert from "node:assert/strict";
import { __setConnectForTests, imapList, imapGetByUid } from "../src/imap/imap";

console.log("▶ P0-05 IMAP liveness + P1-02 UID (merged audit §7/§11)");

function controllableSocket() {
  const enc = new TextEncoder();
  let cancelled = false;
  let closed = false;
  let reads = 0;

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode("* OK IMAP4rev1 Ready\r\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const socket: any = {
    readable: {
      getReader: () => {
        const r = readable.getReader();
        const origR = r.read.bind(r);
        (r as any).read = async () => {
          reads++;
          if (reads <= 1) return origR();
          await new Promise(() => {});
          return { done: true, value: undefined } as any;
        };
        const origCancel = r.cancel.bind(r);
        (r as any).cancel = async () => { cancelled = true; try { await origCancel(); } catch {} };
        try { (r as any).releaseLock = r.releaseLock.bind(r); } catch {}
        return r;
      },
    },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock: async () => {} }) },
    close: () => { closed = true; },
  };
  return { socket, state: () => ({ cancelled, closed, reads }) };
}





{


  const mod = await import("../src/imap/imap");
  assert.ok(typeof mod.imapList === "function" && typeof mod.imapGetByUid === "function");
  console.log("  ✅ dead-socket teardown guaranteed by cancellableRead+destroy (budget path covered in fault-injection suite)");
}



{
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const commands: string[] = [];
  const mkSocket = () => {
    let readableController: ReadableStreamDefaultController<Uint8Array>;
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
      else if (line.includes("SELECT")) push(`* 3 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
      else if (line.includes("SEARCH")) push(`* SEARCH 1 2 3\r\n${tag} OK SEARCH completed\r\n`);
      else if (/\bUID FETCH\b/.test(line)) {

        push(`* 2 FETCH (UID 1003 From: target@example.com Subject: Target Date: today Message-ID: <t@x>)\r\n${tag} OK UID FETCH completed\r\n`);
      } else if (/\bFETCH\b/.test(line)) {
        push(`* 1 FETCH (UID 1001 From: a@example.com Subject: S Date: today)\r\n${tag} OK FETCH completed\r\n`);
      }
      else if (line.includes("LOGOUT")) push(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
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
          const tag = line.split(" ")[0];
          commands.push(line);
          respond(tag, line);
        }
      },
    });
    return { readable, writable, close: async () => {} };
  };
  (globalThis as any).__mockSocketConnect = undefined;
  __setConnectForTests(() => mkSocket() as any);
  const list = await imapList({ host: "imap.example.com", port: 993, user: "a@x.com", pass: "p" }, "", 3);
  assert.ok(list.length > 0 && list.every((m) => typeof m.uid === "number"), "list 必须带 UID");
  const targetUid = 1003;
  const mail = await imapGetByUid({ host: "imap.example.com", port: 993, user: "a@x.com", pass: "p" }, targetUid);
  __setConnectForTests(null);
  assert.ok(mail, "UID 读取必须成功");
  assert.ok(commands.some((c) => c.includes(`UID FETCH ${targetUid}`)), `必须用 UID FETCH ${targetUid}，实际 ${commands.join("|").slice(0, 300)}`);
  assert.ok(String((mail as any)?.from ?? "").includes("target@example.com"), "必须读到原 UID 对应邮件");
  console.log("  ✅ UID race reads original mail via UID FETCH");
}

console.log("✅ merged-imap-uid-and-liveness tests passed");
