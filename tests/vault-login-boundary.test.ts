

import assert from "node:assert/strict";
import { TaskSecretScrubber } from "../src/agent/secret-scrub";

console.log("▶ vault login boundary (Step 9 §10)");


{
  const s = new TaskSecretScrubber();
  s.register("sup3r-secret-password");
  s.register("otp-881233");
  assert.equal(s.scrub("密码是 sup3r-secret-password 请查收"), "密码是 *** 请查收");
  assert.equal(s.scrub("验证码 otp-881233 已注入"), "验证码 *** 已注入");
  assert.equal(
    s.scrub("文本同时包含 sup3r-secret-password 和 otp-881233"),
    "文本同时包含 *** 和 ***",
  );
  assert.equal(s.size, 2);

  const short = new TaskSecretScrubber();
  short.register("ab");
  assert.equal(short.size, 0, "长度<4 的值不登记（避免误伤普通短词）");

  const prefix = new TaskSecretScrubber();
  prefix.register("abcdefgh");
  prefix.register("abcdefghij");
  assert.equal(prefix.scrub("xabcdefghijy"), "x***y", "长秘密先替换，绝不被短前缀拆散");
  console.log("  ✅ secret scrubbing (multi-secret, ordering, short-value exclusion)");
}


{
  const s = new TaskSecretScrubber();
  s.register("old-task-password");
  s.clear();
  assert.equal(s.scrub("old-task-password"), "old-task-password", "clear 后必须不再替换（新任务无此秘密）");
  console.log("  ✅ per-task lifetime: secrets cleared on new task");
}


{
  const s = new TaskSecretScrubber();
  const entries = [
    { type: "observed_text", value: "Dashboard - Example App" },
    { type: "final_url", value: "https://app.example.com/dashboard" },
    { type: "authenticated", value: "yes" },
    { type: "observed_at", value: new Date().toISOString() },
  ];
  s.setLoginVerification(entries);
  const taken = s.takeLoginVerification();
  assert.ok(taken);
  assert.equal(taken!.find((e) => e.type === "authenticated")?.value, "yes");
  const serialized = JSON.stringify(taken);
  for (const banned of ["password", "token", "sup3r"]) {
    assert.equal(serialized.toLowerCase().includes(banned), false, `登录证据不得包含 ${banned}`);
  }
  console.log("  ✅ login verification evidence is sanitized (no secrets, page-level signals only)");
}


{
  const s = new TaskSecretScrubber();
  s.setLoginVerification([
    { type: "observed_text", value: "Sign in - Example" },
    { type: "final_url", value: "https://app.example.com/login?error=1" },
    { type: "authenticated", value: "no" },
  ]);
  const auth = s.takeLoginVerification()!.find((e) => e.type === "authenticated")!.value;
  assert.equal(auth, "no");


  const { findExternalCompletionViolations } = await import("../src/agent/external-completion-guard");
  const violations = findExternalCompletionViolations("已经成功登录你的账号。", { ledger: [] });
  assert.ok(violations.length > 0, "空台账下的登录声明必须被拦");
  console.log("  ✅ unauthenticated result surfaces truthfully; guard blocks empty-ledger login claims");
}

console.log("✅ vault login boundary tests passed");
