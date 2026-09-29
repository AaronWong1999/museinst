import assert from "node:assert/strict";
import { getHostHooks, runBeforeTaskGate, setHostHooks } from "../src/hooks";

console.log("▶ beforeTask host policy fails closed");

const original = getHostHooks();
const ctx = { workspaceId: "w1", userId: "u1", channel: "web", taskClass: "turn", lang: "en" as const };

setHostHooks({ ...original, beforeTask: undefined });
assert.equal(await runBeforeTaskGate({} as any, ctx), null);
console.log("  ✅ no hook means no gate");

setHostHooks({ ...original, beforeTask: async () => ({ allow: true }) });
assert.deepEqual(await runBeforeTaskGate({} as any, ctx), { allow: true });
console.log("  ✅ an allowing hook allows the turn");

setHostHooks({ ...original, beforeTask: async () => { throw new Error("wallet lookup timeout"); } });
const blocked = await runBeforeTaskGate({} as any, ctx);
assert.equal(blocked?.allow, false);
assert.ok(blocked?.reason);
const zh = await runBeforeTaskGate({} as any, { ...ctx, lang: "zh" });
assert.equal(zh?.allow, false);
assert.match(zh!.reason!, /稍后/);
console.log("  ✅ a throwing hook blocks the turn instead of granting a free round");

setHostHooks(original);
