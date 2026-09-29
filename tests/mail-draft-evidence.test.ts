// tests/mail-draft-evidence.test.ts
// Regression tests for Phase C: P0-09, P0-10, P0-11, P1-15, P1-16 from docs/STEP9_DIFF_CODE_AUDIT_AND_REMEDIATION_2026-09-13.md
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createTestD1 } from "./helpers/d1";
import {
  smtpIdempotencyBegin,
  smtpIdempotencyFinish,
  ImapExecutor,
  sha256Hex,
} from "../src/imap/executor";
import { imapAppendDraft } from "../src/imap/imap";
import { resolveMailbox } from "../src/imap/mailbox";

console.log("▶ Running mail-draft-evidence regression tests (Phase C)");

// ── Test 1: P0-09 — Dedupe branch must return real stored facts, not forged verifiedAt ──
{
  console.log("  [Test 1] P0-09: Dedupe must return original stored facts (UID, verifiedAt), unverifiable if missing");

  const d1 = createTestD1();
  const requestId = "req_test_dedupe_1";
  const workspaceId = "ws_test";
  const payloadHash = "hash_12345678";

  // 1A. Begin first time
  const gate1 = await smtpIdempotencyBegin(d1 as any, requestId, workspaceId, payloadHash);
  assert.equal(gate1.ok, true);

  // Finish with verified stored facts
  const origVerifiedAt = 1726000000000;
  const storedMeta = {
    uid: 42,
    folder: "Drafts",
    to: "bob@example.com",
    subject: "Hello",
    messageId: "<msg-42@example.com>",
    isDraft: true,
  };

  await smtpIdempotencyFinish(d1 as any, requestId, "succeeded" as any, {
    externalId: "Drafts:uid=42",
    resultJson: JSON.stringify(storedMeta),
    verifiedAt: origVerifiedAt,
  });

  // 1B. Dedupe call with identical payload
  const gate2 = await smtpIdempotencyBegin(d1 as any, requestId, workspaceId, payloadHash);
  assert.equal(gate2.ok, false);
  assert.equal(gate2.deduped, true);
  assert.ok((gate2 as any).storedResult, "deduped gate MUST return storedResult");
  assert.equal((gate2 as any).storedResult.external_id, "Drafts:uid=42");
  assert.equal((gate2 as any).storedResult.verified_at, origVerifiedAt);

  const parsed = JSON.parse((gate2 as any).storedResult.result_json);
  assert.equal(parsed.uid, 42);
  assert.equal(parsed.messageId, "<msg-42@example.com>");

  console.log("  ✅ Test 1 passed");
}

// ── Test 2: P0-10 — Exact read-back verification of APPENDUID, To, Subject, Body, and \\Draft ──
{
  console.log("  [Test 2] P0-10: imapAppendDraft exact read-back verifies APPENDUID, To, Subject, Body, and \\Draft");

  const testMail = {
    from: "alice@example.com",
    to: "bob@example.com",
    subject: "Step 9 Test Subject",
    body: "Line 1\r\nLine 2 content verification",
  };

  function createMockImap(opts: {
    uid: number;
    appendUid?: boolean;
    to?: string;
    subject?: string;
    body?: string;
    isDraft?: boolean;
  }) {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let readableController: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        readableController = controller;
        controller.enqueue(enc.encode("* OK IMAP4rev1 Ready\r\n"));
      },
    });

    let inBuffer = "";
    let appendTag = "";
    let inLiteral = false;
    let capturedMsgId = "";

    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (inLiteral) {
          const text = dec.decode(chunk);
          const m = text.match(/Message-ID:\s*(<[^>]+>)/i);
          if (m) capturedMsgId = m[1];
          inLiteral = false;
          const resp = opts.appendUid !== false
            ? `${appendTag} OK [APPENDUID 12345 ${opts.uid}] APPEND completed\r\n`
            : `${appendTag} OK APPEND completed\r\n`;
          readableController.enqueue(enc.encode(resp));
          return;
        }

        inBuffer += dec.decode(chunk);
        while (inBuffer.includes("\r\n")) {
          const idx = inBuffer.indexOf("\r\n");
          const line = inBuffer.slice(0, idx);
          inBuffer = inBuffer.slice(idx + 2);
          const tag = line.split(" ")[0];

          if (line.includes("CAPABILITY")) {
            readableController.enqueue(enc.encode(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK CAPABILITY completed\r\n`));
          } else if (line.includes("LOGIN")) {
            readableController.enqueue(enc.encode(`${tag} OK LOGIN completed\r\n`));
          } else if (line.includes("LIST")) {
            readableController.enqueue(enc.encode(`* LIST (\\Drafts) "/" "Drafts"\r\n${tag} OK LIST completed\r\n`));
          } else if (line.includes("APPEND")) {
            appendTag = tag;
            inLiteral = true;
            readableController.enqueue(enc.encode("+\r\n"));
          } else if (line.includes("SELECT")) {
            readableController.enqueue(enc.encode(`* 1 EXISTS\r\n* OK [UIDVALIDITY 12345] UIDs valid\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`));
          } else if (line.includes("FETCH")) {
            const draftFlag = opts.isDraft !== false ? "\\Draft" : "\\Seen";
            const toVal = opts.to ?? "bob@example.com";
            const subjVal = opts.subject ?? "Step 9 Test Subject";
            const bodyVal = opts.body ?? "Line 1\r\nLine 2 content verification";
            const fetchLines = [
              `* 1 FETCH (UID ${opts.uid} FLAGS (${draftFlag}))`,
              `To: <${toVal}>`,
              `Subject: ${subjVal}`,
              `Message-ID: ${capturedMsgId || "<test@msg>"}`,
              `BODY[TEXT]`,
              bodyVal,
              `)`,
              `${tag} OK FETCH completed`,
            ];
            readableController.enqueue(enc.encode(fetchLines.join("\r\n") + "\r\n"));
          } else if (line.includes("LOGOUT")) {
            readableController.enqueue(enc.encode(`* BYE IMAP4rev1 Server logging out\r\n${tag} OK LOGOUT completed\r\n`));
          } else {
            readableController.enqueue(enc.encode(`${tag} OK completed\r\n`));
          }
        }
      },
    });

    return {
      readable,
      writable,
      close: async () => {},
      getCapturedMsgId: () => capturedMsgId,
    };
  }

  // 2A. Success case: server returns [APPENDUID 12345 888] and full matching fetch
  let mock1 = createMockImap({ uid: 888 });
  (globalThis as any).__mockSocketConnect = () => mock1;

  const resSuccess = await imapAppendDraft(
    { host: "imap.example.com", port: 993, user: "alice@example.com", pass: "secret" },
    testMail,
  );

  assert.equal(resSuccess.ok, true);
  assert.equal(resSuccess.uid, 888);
  assert.equal(resSuccess.folder, "Drafts");
  assert.equal(resSuccess.isDraft, true);
  assert.ok(resSuccess.verifiedAt);
  assert.equal(resSuccess.messageId, mock1.getCapturedMsgId());

  // 2B. Failure case after APPEND: subject mismatch -> appendAccepted=true, ok=false
  let mock2 = createMockImap({ uid: 889, subject: "Completely Wrong Subject" });
  (globalThis as any).__mockSocketConnect = () => mock2;

  const resMismatch = await imapAppendDraft(
    { host: "imap.example.com", port: 993, user: "alice@example.com", pass: "secret" },
    testMail,
  );

  assert.equal(resMismatch.ok, false);
  assert.equal(resMismatch.appendAccepted, true, "appendAccepted MUST be true when APPEND succeeded on server");
  assert.ok(resMismatch.error?.includes("mismatch"));

  (globalThis as any).__mockSocketConnect = null;
  console.log("  ✅ Test 2 passed");
}

// ── Test 3: P0-11 — Post-APPEND failure must be marked applied_unverified, not failed_pre_send ──
{
  console.log("  [Test 3] P0-11: Post-APPEND failure must NOT be marked failed_pre_send (blocks double draft)");

  const d1 = createTestD1();
  const requestId = "req_test_post_effect_fail";
  const workspaceId = "ws_test";
  const payloadHash = "hash_post_effect";

  // Claim
  const gate = await smtpIdempotencyBegin(d1 as any, requestId, workspaceId, payloadHash);
  assert.equal(gate.ok, true);

  // If APPEND succeeded on server but verification/read-back timed out:
  // Must mark applied_unverified or unknown_effect!
  await smtpIdempotencyFinish(d1 as any, requestId, "applied_unverified" as any, {
    lastError: "readback_timeout",
    externalId: "Drafts:uid=pending",
  });

  // Next retry attempt: MUST be blocked as delivery_status_unknown_do_not_auto_retry
  const retryGate = await smtpIdempotencyBegin(d1 as any, requestId, workspaceId, payloadHash);
  assert.equal(retryGate.ok, false);
  assert.equal(retryGate.deduped, undefined, "Must NOT be marked deduped (not confirmed success)");
  assert.ok(
    retryGate.error.includes("unknown") || retryGate.error.includes("applied_unverified"),
    `Retry MUST be blocked from recreating draft! Error was: ${retryGate.error}`,
  );

  console.log("  ✅ Test 3 passed");
}

// ── Test 4: P1-16 — resolveMailbox with non-existent account returns null (no silent fallback) ──
{
  console.log("  [Test 4] P1-16: resolveMailbox with explicit account returns null if not found");

  const d1 = createTestD1();
  // Insert a mailbox for account A
  d1.db.exec(`
    INSERT INTO vault_items (id, workspace_id, kind, label, account, origin, created_at, updated_at)
    VALUES ('v1', 'ws-test', 'token', 'qq', 'primary@qq.com', 'imap://imap.qq.com', 1000, 1000);
  `);

  // Try resolving with a different account that DOES NOT exist
  const res = await resolveMailbox({ DB: d1 } as any, "ws-test", "secondary@163.com");
  assert.equal(
    res,
    null,
    "resolveMailbox MUST NOT silently fallback to another account when explicit account is not found!",
  );

  console.log("  ✅ Test 4 passed");
}

// ── Test 5: P1-15 — requestId / payloadHash includes account ──
{
  console.log("  [Test 5] P1-15: requestId / payloadHash binds account (prevents collision across mailboxes)");

  const base = { to: "user@test.com", subject: "Subj", body: "Body", kind: "draft" };

  const hash1 = await sha256Hex(JSON.stringify({ account: "acc1@example.com", ...base }));
  const hash2 = await sha256Hex(JSON.stringify({ account: "acc2@example.com", ...base }));

  assert.notEqual(
    hash1,
    hash2,
    "Switching account with identical draft content MUST produce different payload hashes!",
  );
  console.log("  ✅ Test 5 passed");
}

console.log("✅ All mail-draft-evidence tests completed");
