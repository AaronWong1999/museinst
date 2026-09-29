import assert from "node:assert/strict";
import {
  deriveSecurityContext,
  OWNER_GLOBAL_SCOPE,
  emailScopeKey,
  doIdempotencyKey,
  normalizeParkedState,
  type SecurityClaims,
} from "../src/security/context";
import { verifyApprovalDecision } from "../src/security/approval-route";

console.log("▶ V3 §5/§7 Context & Authority boundary tests...");

// 1. owner_chat → authenticatedOwner=true, owner:global, owner_full
{
  const claims: SecurityClaims = { source: "owner_chat", workspaceId: "w1", scopeKey: OWNER_GLOBAL_SCOPE };
  const sec = deriveSecurityContext({ claims, identity: null, approvalRoute: { channel: "web" } });
  assert.equal(sec.authenticatedOwner, true);
  assert.equal(sec.scopeKey, OWNER_GLOBAL_SCOPE);
  assert.equal(sec.promptProfile, "owner_full");
  assert.equal(sec.allowPrivateContext, true);
  assert.equal(sec.allowAccountStateDisclosure, true);
}


{
  const claims: SecurityClaims = { source: "email", workspaceId: "w1", scopeKey: emailScopeKey("ab".repeat(32), "th_x") };
  const sec = deriveSecurityContext({
    claims,
    identity: { peerAddress: "spoof@evil.com", contactClass: "known", addressVerifiedByOwner: true, messageAuth: "none" },
    approvalRoute: { channel: "web" },
  });
  assert.equal(sec.authenticatedOwner, false);
  assert.equal(sec.messageAuth, "none");
  assert.deepEqual(sec.allowTools, []);
  assert.equal(sec.allowPrivateContext, false);
  assert.equal(sec.allowAccountStateDisclosure, false);
  assert.equal(sec.promptProfile, "external_minimal");
}


{
  const claims: SecurityClaims = { source: "email", workspaceId: "w1", scopeKey: "email:x:th_1", capabilityId: "cap_1" };
  const sec = deriveSecurityContext({
    claims,
    identity: { peerAddress: "a@b.com", contactClass: "known", addressVerifiedByOwner: false, messageAuth: "thread_capability", capabilityId: "cap_1" },
    approvalRoute: { channel: "web" },
  });
  assert.equal(sec.authenticatedOwner, false);
  assert.deepEqual(sec.allowTools, []);
  assert.equal(sec.allowPrivateContext, false);
}


{
  const claims: SecurityClaims = { source: "a2a", workspaceId: "w1", scopeKey: "human-a2a:cv_1" };
  const sec = deriveSecurityContext({
    claims,
    identity: { peerAddress: "x@mail.openinst.com", contactClass: "unknown", addressVerifiedByOwner: false, messageAuth: "a2a_signature" },
    approvalRoute: { channel: "web" },
    a2aState: "negotiating",
  });
  assert.equal(sec.promptProfile, "a2a_structured");
  assert.deepEqual(sec.allowTools, []);
  assert.equal(sec.authenticatedOwner, false);
}


{
  const a = doIdempotencyKey("email", "email:h1:th_1", "mid1");
  const b = doIdempotencyKey("email", "email:h1:th_2", "mid1");
  const c = doIdempotencyKey("owner_chat", OWNER_GLOBAL_SCOPE, "mid1");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.ok(!a.includes("undefined"));
}


{
  const legacy = normalizeParkedState<{ taskId: string }>({ taskId: "t1" } as never);
  assert.deepEqual(Object.keys(legacy), [OWNER_GLOBAL_SCOPE]);
  assert.deepEqual(normalizeParkedState(null), {});
  assert.deepEqual(normalizeParkedState({ [OWNER_GLOBAL_SCOPE]: { taskId: "t2" } }), { [OWNER_GLOBAL_SCOPE]: { taskId: "t2" } });
}


{
  const binding = { workspaceId: "w1", taskId: "t1", toolCallId: "c1", scopeKey: OWNER_GLOBAL_SCOPE, routeChannel: "web", expiresAt: Date.now() + 60000, singleUseNonce: "n1" };
  const approval = { workspace_id: "w1", task_id: "t1", decision: null, created_at: Date.now() };
  assert.equal(verifyApprovalDecision({ approval, binding, authenticatedOwner: false, workspaceId: "w1", routeChannel: "web" }).ok, false);
  assert.equal(verifyApprovalDecision({ approval, binding, authenticatedOwner: true, workspaceId: "w1", routeChannel: "web" }).ok, true);
  assert.equal(verifyApprovalDecision({ approval, binding, authenticatedOwner: true, workspaceId: "w2", routeChannel: "web" }).ok, false);
}

console.log("✔ Context & authority tests passed!");
