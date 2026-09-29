import assert from "node:assert/strict";
import { __setConnectForTests, smtpSend } from "../src/imap/imap";

let connects = 0;
__setConnectForTests((() => {
  connects++;
  throw new Error("connect_reached");
}) as any);

// RFC-valid one-character local parts must pass the injection/shape gate and reach transport.
{
  const r = await smtpSend(
    { host: "smtp.test", port: 465, user: "a@test.com", pass: "x" },
    { from: "a@test.com", to: "b@example.com", subject: "x", body: "x" },
  );
  assert.equal(connects, 1, "single-character local parts must not be rejected before transport");
  assert.match(r.error ?? "", /connect_reached/);
  assert.doesNotMatch(r.error ?? "", /smtp_invalid_/);
}

// CRLF remains blocked before any socket is opened.
{
  const before = connects;
  const r = await smtpSend(
    { host: "smtp.test", port: 465, user: "a@test.com", pass: "x" },
    { from: "a@test.com\r\nBcc:evil@example.com", to: "b@example.com", subject: "x", body: "x" },
  );
  assert.equal(connects, before, "injection-shaped addresses must fail before transport");
  assert.match(r.error ?? "", /smtp_invalid_from/);
}

__setConnectForTests(null);
console.log("smtp-email-address-validation: ok");
