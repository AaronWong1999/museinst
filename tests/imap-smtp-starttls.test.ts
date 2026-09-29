


import assert from "node:assert/strict";
import { __setConnectForTests, smtpSend, smtpVerify, type SmtpConfig } from "../src/imap/imap";

console.log("▶ SMTP STARTTLS state machine (audit §1)");

type Recorded = { sent: string[]; startTlsCalls: number; tlsUpgraded: boolean };


function makeMockServer(script: {
  ehloCapsBefore: string[];
  ehloCapsAfter: string[];
  starttlsReply?: string;
  startTlsFails?: boolean;
  authAccepts?: boolean;
}) {
  const rec: Recorded = { sent: [], startTlsCalls: 0, tlsUpgraded: false };
  const enc = new TextEncoder();
  const USER_B64 = btoa("user@test.com");
  const PASS_B64 = btoa("app-password");

  function makeSocket(): any {
    let greetingSent = false;
    let inData = false;
    const reader = {
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        const line = nextResponse();
        return { done: false, value: enc.encode(line + "\r\n") };
      },
    };
    const nextResponse = (): string => {
      const p = pending;
      if (inData) {
        inData = false;
        return "250 2.0.0 OK queued";
      }
      if (p === "") {
        if (!greetingSent) {
          greetingSent = true;
          return "220 mock.test ESMTP";
        }
        return "500 unknown command state";
      }
      if (p === "EHLO openinst.local") {
        const caps = phase === "plain" ? script.ehloCapsBefore : script.ehloCapsAfter;
        return caps.map((c, i) => (i === caps.length - 1 ? `250 ${c}` : `250-${c}`)).join("\r\n");
      }
      if (p === "STARTTLS") return script.starttlsReply ?? "220 2.0.0 Ready to start TLS";
      if (p === "AUTH LOGIN") return "334 VXNlcm5hbWU6";
      if (p === USER_B64) return "334 UGFzc3dvcmQ6";
      if (p === PASS_B64) return script.authAccepts === false ? "535 5.7.8 Bad credentials" : "235 2.7.0 Accepted";
      if (p.startsWith("MAIL FROM")) return "250 2.1.0 Sender OK";
      if (p.startsWith("RCPT TO")) return "250 2.1.5 Recipient OK";
      if (p === "DATA") {
        inData = true;
        return "354 End data with <CR><LF>.<CR><LF>";
      }
      if (p === "QUIT") return "221 2.0.0 Bye";
      return "500 unexpected command";
    };
    let pending = "";
    let phase: "plain" | "tls" = "plain";
    const writer = {
      write: async (chunk: Uint8Array) => {
        const text = new TextDecoder().decode(chunk);
        for (const l of text.split("\r\n").filter(Boolean)) rec.sent.push(l);
        pending = text.replace(/\r\n$/, "");
      },
      releaseLock: async () => {},
    };
    return {
      readable: { getReader: () => reader },
      writable: { getWriter: () => writer },
      startTls: async () => {
        rec.startTlsCalls++;
        if (script.startTlsFails) throw new Error("certificate verify failed");
        rec.tlsUpgraded = true;
        return makeSocket();
      },
      close: async () => {},
    };
  }

  return { connect: (_addr: unknown, _opts: unknown) => makeSocket(), rec };
}

const cfg465: SmtpConfig = { host: "smtp.test", port: 465, user: "user@test.com", pass: "app-password" };
const cfg587: SmtpConfig = { host: "smtp.test", port: 587, user: "user@test.com", pass: "app-password", starttls: true };


{
  const { connect, rec } = makeMockServer({
    ehloCapsBefore: ["mock.test ESMTP service ready", "STARTTLS", "AUTH LOGIN PLAIN"],
    ehloCapsAfter: ["mock.test ESMTP service ready", "AUTH LOGIN PLAIN"],
  });
  __setConnectForTests(connect as any);
  const r = await smtpVerify(cfg587);
  assert.equal(r.ok, true, `verify should pass: ${r.error}`);
  assert.equal(rec.startTlsCalls, 1, "startTls must be called exactly once");
  assert.equal(rec.tlsUpgraded, true);
  const ehloIdx = rec.sent.indexOf("EHLO openinst.local");
  const startIdx = rec.sent.indexOf("STARTTLS");
  const authIdx = rec.sent.indexOf("AUTH LOGIN");
  assert.ok(ehloIdx >= 0 && startIdx > ehloIdx, "EHLO precedes STARTTLS");
  assert.ok(authIdx > startIdx, "AUTH LOGIN must come after STARTTLS");
  assert.ok(rec.sent.lastIndexOf("EHLO openinst.local") > startIdx, "re-EHLO after upgrade");
  assert.equal(rec.sent[rec.sent.length - 1], "QUIT", "verify ends with QUIT, no test mail");
  const beforeStart = rec.sent.slice(0, startIdx).filter((l) => !l.startsWith("EHLO"));
  assert.deepEqual(beforeStart, [], "nothing but EHLO before STARTTLS");
  console.log("  ✅ 587 STARTTLS: upgrade before AUTH, new socket, re-EHLO, verify ends with QUIT");
}


{
  const { connect, rec } = makeMockServer({
    ehloCapsBefore: ["mock.test ready", "AUTH LOGIN PLAIN"],
    ehloCapsAfter: [],
  });
  __setConnectForTests(connect as any);
  const r = await smtpVerify(cfg465);
  assert.equal(r.ok, true, `verify should pass: ${r.error}`);
  assert.equal(rec.startTlsCalls, 0, "465 must not call startTls");
  assert.equal(rec.sent.includes("STARTTLS"), false, "465 must not send STARTTLS command");
  assert.equal(rec.sent.includes("AUTH LOGIN"), true);
  console.log("  ✅ 465 implicit TLS: no startTls, no STARTTLS command");
}


{
  const { connect, rec } = makeMockServer({
    ehloCapsBefore: ["mock.test ready", "AUTH LOGIN PLAIN"],
    ehloCapsAfter: [],
  });
  __setConnectForTests(connect as any);
  const r = await smtpVerify(cfg587);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /smtp_starttls_not_supported/);
  assert.equal(rec.sent.includes("AUTH LOGIN"), false, "no AUTH before successful STARTTLS");
  assert.equal(rec.startTlsCalls, 0);
  console.log("  ✅ missing STARTTLS capability fails closed before credentials");
}


{
  const { connect, rec } = makeMockServer({
    ehloCapsBefore: ["mock.test ready", "STARTTLS", "AUTH LOGIN PLAIN"],
    starttlsReply: "454 4.7.0 TLS not available due to temporary reason",
    ehloCapsAfter: [],
  });
  __setConnectForTests(connect as any);
  const r = await smtpVerify(cfg587);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /smtp_starttls_rejected/);
  assert.equal(rec.sent.includes("AUTH LOGIN"), false);
  assert.equal(rec.startTlsCalls, 0, "startTls must not run on non-220");
  console.log("  ✅ 454/5xx STARTTLS rejection fails closed before credentials");
}


{
  const { connect, rec } = makeMockServer({
    ehloCapsBefore: ["mock.test ready", "STARTTLS", "AUTH LOGIN PLAIN"],
    ehloCapsAfter: [],
    startTlsFails: true,
  });
  __setConnectForTests(connect as any);
  const r = await smtpVerify(cfg587);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /smtp_starttls_failed/);
  assert.equal(rec.sent.includes("AUTH LOGIN"), false);
  console.log("  ✅ startTls() failure fails closed before credentials");
}


{
  const { connect, rec } = makeMockServer({
    ehloCapsBefore: ["mock.test ESMTP service ready", "STARTTLS", "AUTH LOGIN PLAIN"],
    ehloCapsAfter: ["mock.test ESMTP service ready", "AUTH LOGIN PLAIN"],
  });
  __setConnectForTests(connect as any);
  const r = await smtpSend(cfg587, { from: "user@test.com", to: "dest@example.com", subject: "hi", body: "hello" });
  assert.equal(r.ok, true, `send should pass: ${r.error}`);
  assert.equal(r.phase, "sent");
  const authIdx = rec.sent.indexOf("AUTH LOGIN");
  const mailIdx = rec.sent.findIndex((l) => l.startsWith("MAIL FROM"));
  assert.ok(mailIdx > authIdx, "MAIL FROM only after AUTH");
  assert.equal(rec.startTlsCalls, 1);
  console.log("  ✅ smtpSend reuses the same handshake primitive");
}

__setConnectForTests(null);
console.log("✅ imap-smtp-starttls.test.ts passed");
