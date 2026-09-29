// agent-operational-claim-guard.test.ts — unsupported current-state claims.
import assert from "node:assert/strict";
import {
  findOperationalClaimViolations,
  isAccountStateQuestion,
  stripUnsupportedOperationalClaims,
  type OperationalClaimContext,
} from "../src/agent/operational-claim-guard";

console.log("▶ operational claim guard");

const base: OperationalClaimContext = {
  currentUserText: "记住我的测试暗号：蓝色企鹅 731",
  channel: "wechat",
  source: "owner_chat",
  duplicateConfirmed: false,
  currentAccountEvidence: false,
  currentConnectorEvidence: false,
};

{
  const violations = findOperationalClaimViolations(
    "已记住。你连发了两条相同消息，我合并处理只存了一次。你当前账号存在欠费（欠额 3.53 点）或处于账单冻结状态。",
    base,
  );
  assert.deepEqual(
    [...new Set(violations.map((violation) => violation.type))].sort(),
    ["billing_state", "duplicate_input"],
  );
  console.log("  ✅ rejects unsupported duplicate and billing claims");
}

{
  const violations = findOperationalClaimViolations(
    "我没有证据证明你发了两次，也不能确认当前账户是否欠费。",
    base,
  );
  assert.equal(violations.length, 0, "careful uncertainty is not a false state claim");
  console.log("  ✅ allows negated/uncertain wording");
}

{
  const violations = findOperationalClaimViolations(
    "当前账户欠费 3.53 点，已处于计费冻结。",
    { ...base, currentAccountEvidence: true },
  );
  assert.equal(violations.length, 0, "current account evidence permits billing claims");
  console.log("  ✅ permits billing claims with current trusted evidence");
}

{
  const transformContext = { ...base, currentUserText: "帮我润色这句话：你发了两次，我只处理一次。" };
  assert.equal(findOperationalClaimViolations("你发了两次，我只处理一次。", transformContext).length, 0);
  assert.equal(findOperationalClaimViolations("解释 billing hold 这个英文术语。", base).length, 0);
  console.log("  ✅ avoids rewrite/quote/term-explanation false positives");
}

{
  const sanitized = stripUnsupportedOperationalClaims(
    "已记住蓝色企鹅 731。你连发了两条相同消息，我合并处理只存了一次。",
    base,
  );
  assert.equal(sanitized.text, "已记住蓝色企鹅 731。");
  assert.deepEqual(sanitized.claimTypes, ["duplicate_input"]);
}

assert.equal(isAccountStateQuestion("我现在还有多少点数？"), true);
assert.equal(isAccountStateQuestion("解释 billing hold 这个英文术语"), false);
console.log("  ✅ account-state questions are detected without treating explanations as lookups");

console.log("✅ agent-operational-claim-guard.test.ts passed");
