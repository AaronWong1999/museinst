
import assert from "node:assert/strict";
import {
  buildResumeMessage,
  firstWaitingConnector,
  isConnectorResumeText,
  pendingStateOf,
} from "../src/agent/pending-resume";

console.log("▶ pending/resume state machine (Step 9 §9)");


{
  const ledger = [
    { tool: "github_issues_list", provider: "github", operation: "read", ok: false, errorCode: "not_connected" },
  ];
  const w = firstWaitingConnector(ledger);
  assert.ok(w);
  assert.equal(w!.provider, "github");
  assert.equal(firstWaitingConnector([{ tool: "x", provider: "github", operation: "read", ok: false, errorCode: "permission_missing" }]), null, "permission_missing 不是可恢复的未连接");
  assert.equal(firstWaitingConnector([{ tool: "memory_save", provider: "local", operation: "read", ok: false, errorCode: "not_connected" }]), null, "local 工具不产生 connector 等待");
  console.log("  ✅ resumable not_connected detected; other failures and local tools excluded");
}


{
  assert.equal(isConnectorResumeText("已经连接好了，继续刚才的任务。"), true);
  assert.equal(isConnectorResumeText("已连接 GitHub，继续"), true);
  assert.equal(isConnectorResumeText("继续"), true);
  assert.equal(isConnectorResumeText("resume"), true);
  assert.equal(isConnectorResumeText("帮我创建一个 issue"), false, "普通任务请求不是恢复语义");
  assert.equal(isConnectorResumeText("继续写一首诗"), false, "继续+新任务不是恢复语义");
  assert.equal(isConnectorResumeText(""), false);
  console.log("  ✅ resume text detection is explicit-only");
}


{
  const merged = buildResumeMessage("读取我仓库最近 5 个 Issue", "已经连接好了，继续");
  assert.ok(merged.includes("读取我仓库最近 5 个 Issue"), "必须保留原目标");
  assert.ok(merged.includes("已经连接好了"), "必须带上用户新信息");
  const pure = buildResumeMessage("读取我仓库最近 5 个 Issue", "已经连接好了");
  assert.equal(pure.includes("（用户确认前置条件已满足"), true, "纯确认走引导分支");
  console.log("  ✅ resume message merges facts without duplicating the task");
}


{
  assert.equal(pendingStateOf({ kind: "connector", status: "pending" }), "waiting_for_connector");
  assert.equal(pendingStateOf({ kind: "approval", status: "pending" }), "waiting_for_approval");
  assert.equal(pendingStateOf({ kind: "conversational_goal", status: "pending" }), "waiting_for_user_input");
  assert.equal(pendingStateOf({ kind: "connector", status: "resolved" }), "completed");
  assert.equal(pendingStateOf({ kind: "connector", status: "abandoned" }), "cancelled");
  console.log("  ✅ plan states map onto the single task state model");
}

console.log("✅ pending/resume tests passed");
