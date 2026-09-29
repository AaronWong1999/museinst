//
// Canonical Message/Card contract tests (spec §8).
//
import assert from "node:assert/strict";
import {
  canonicalMessageFrom,
  isCanonicalMessage,
  sanitizeCards,
} from "../src/channels/message-contract";
import { renderCanonicalAsText } from "../src/channels/render-text";
import { createLinkResolver } from "../src/channels/link-resolver";

console.log("▶ canonical message contract");

const links = createLinkResolver({ baseUrl: "https://openinst.com" });

{
  console.log("  [1] versioned message with clean card set");
  const msg = canonicalMessageFrom({
    id: "cm_1",
    workspaceId: "ws",
    threadId: "main",
    role: "assistant",
    text: "找到 3 个航班。",
    cards: [
      {
        type: "browser_session",
        version: 1,
        id: "c1",
        revision: 0,
        taskId: "t1",
        threadId: "main",
        ref: { sessionRef: "grant:abc" },
        state: "agent_active",
        continuity: "same_session",
        actions: [{ id: "a1", kind: "browser_watch", label: "Watch" }],
      },
    ],
    createdAt: 1,
  });
  assert.equal(msg.version, 1);
  assert.ok(isCanonicalMessage(msg));
  assert.equal(msg.cards?.length, 1);
}

{
  console.log("  [2] malformed cards are dropped, never crash renderers");
  const msg = canonicalMessageFrom({
    id: "cm_2",
    workspaceId: "ws",
    threadId: "main",
    role: "assistant",
    text: "纯文本兜底。",
    cards: [null, "junk", { type: 42 }, { type: "file", version: 1, id: "ok" }],
    createdAt: 1,
  });
  // only the structurally valid file card survives
  assert.equal(msg.cards?.length, 1);
  assert.equal(msg.cards?.[0].type, "file");
}

{
  console.log("  [3] unknown card type falls back to canonical text");
  const text = renderCanonicalAsText(
    {
      version: 1,
      id: "cm_3",
      workspaceId: "ws",
      threadId: "main",
      role: "assistant",
      text: "这句话必须完整保留。",
      cards: [{ type: "brand_new_unknown", version: 1, id: "u1" } as never],
      createdAt: 1,
    },
    links,
  );
  assert.ok(text.includes("这句话必须完整保留。"), "canonical text must always survive");
}

{
  console.log("  [4] browser card text keeps a scoped OpenInst link, never a provider URL");
  const text = renderCanonicalAsText(
    canonicalMessageFrom({
      id: "cm_4",
      workspaceId: "ws",
      threadId: "main",
      role: "assistant",
      text: "已打开 Google。",
      cards: [
        {
          type: "browser_session",
          version: 1,
          id: "c4",
          revision: 0,
          taskId: "t4",
          threadId: "main",
          ref: { sessionRef: "grant_k7xq" },
          state: "agent_active",
          continuity: "same_session",
          actions: [],
        },
      ],
      createdAt: 1,
    }),
    links,
  );
  assert.ok(text.includes("https://openinst.com/b/grant_k7xq"));
  assert.ok(!text.includes("live.browser.run"));
  assert.ok(!text.includes("jwt"));
}

{
  console.log("  [5] isCanonicalMessage rejects payloads missing required fields");
  assert.equal(isCanonicalMessage({ version: 1, id: "x" }), false);
  assert.equal(isCanonicalMessage(null), false);
}

console.log("✅ canonical-message-contract passed");
