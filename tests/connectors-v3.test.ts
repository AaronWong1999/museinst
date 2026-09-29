
import assert from "node:assert/strict";
import { allTools, findTool } from "../src/agent/tools.ts";
import { connectorSlotKey, normalizeAccountLabel } from "../src/connectors/account-label.ts";
import { ConnectorCallError, httpStatusToKind, oauthTokenErrorKind } from "../src/connectors/types.ts";
import { codeChallengeS256, newCodeVerifier } from "../src/connectors/pkce.ts";

console.log("▶ Testing Connectors V3 kernel invariants...");


for (const t of allTools()) {
  assert.ok((t as any).effect, t.name + " must have effect");
  assert.ok(["read","write","local","external_send","destructive"].includes((t as any).effect), t.name + " effect invalid");
}
const gmailSend = findTool("gmail_send")!;
assert.equal((gmailSend as any).effect, "external_send");
assert.ok(gmailSend.needsApproval, "gmail_send needsApproval");
const calDel = findTool("calendar_delete")!;
assert.equal((calDel as any).effect, "destructive");

const calCreate = findTool("calendar_create")!;
assert.ok(typeof (calCreate as any).requiresApproval === "function", "calendar_create requiresApproval fn");
assert.equal((calCreate as any).requiresApproval({ attendees: ["a@x.com"] }), true);
assert.equal((calCreate as any).requiresApproval({}), true, "写外部状态无条件审批");
assert.equal((calCreate as any).effect, "external_send");


const sched = allTools(undefined, { workspaceId: "w", channel: "web", scheduled: true } as any);
const schedNames = new Set(sched.map((t) => t.name));
assert.equal(schedNames.has("browser_task"), false, "scheduled must not expose browser_task");
assert.equal(schedNames.has("schedule_create"), false, "scheduled must not expose schedule_create");
assert.equal(schedNames.has("slack_search"), false, "scheduled must not expose slack");
assert.equal(schedNames.has("linear_issues"), false, "scheduled must not expose linear");
assert.ok(schedNames.has("gmail_search"), "scheduled keeps read tools");
for (const t of sched) assert.equal((t as any).scheduledAllowed, true, t.name + " in scheduled must be opt-in");

const def = new Set(allTools().map((t) => t.name));
assert.equal(def.has("slack_search"), false, "default hides slack");
assert.equal(def.has("linear_issues"), false, "default hides linear");


assert.equal(httpStatusToKind(401), "auth");
assert.equal(httpStatusToKind(403), "permission");
assert.equal(httpStatusToKind(429), "rate_limit");
assert.equal(httpStatusToKind(404), "not_found");
assert.equal(oauthTokenErrorKind("invalid_grant"), "auth");
assert.ok(new ConnectorCallError("permission", "x", 403) instanceof Error);


assert.equal(connectorSlotKey("google", "User@Gmail.com "), "oauth:google:user@gmail.com");
assert.equal(connectorSlotKey("mailbox", "User@QQ.com"), "mailbox:user@qq.com");
assert.equal(normalizeAccountLabel("github", "OctoCat"), "octocat");


for (const n of ["gmail_search","gmail_send","calendar_list","calendar_create","feishu_mail_list"]) {
  const t = findTool(n)!;
  const props = (t.parameters as any)?.properties ?? {};
  assert.ok("account" in props, n + " must have account param");
}

// 6. PKCE S256
const v = await newCodeVerifier();
const c = await codeChallengeS256(v);
assert.ok(v.length >= 40 && !/[+/=]/.test(c), "pkce b64url");
const c2 = await codeChallengeS256(v);
assert.equal(c, c2, "pkce deterministic");

console.log("✔ Connectors V3 kernel invariants passed!");
