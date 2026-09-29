


import assert from "node:assert/strict";
import {
  TOOL_calendar_freebusy, TOOL_calendar_update,
  TOOL_todo_get, TOOL_todo_update, TOOL_todo_complete, TOOL_todo_delete,
  TOOL_contact_get, TOOL_contact_create, TOOL_contact_update, TOOL_contact_delete,
  TOOL_mail_thread, TOOL_mail_update,
  TOOL_code_search, TOOL_code_issue_read,
  TOOL_mail_search,
  buildFullCatalog, defaultToolSession, toolDefsForSession,
} from "../src/agent/tools";
import { isEffectivelyHidden } from "../src/agent/tool-catalog";

console.log("▶ P0-06 semantic honesty (merged audit §8)");

function toolCtx(): any {
  return {
    env: { DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } },
    workspaceId: "ws-sem",
    userId: "u",
    channel: "web",
    lang: "zh",
    taskId: "t1",
    say: async () => {},
    hasActiveBrowserTask: () => false,
  };
}


{
  const cases: Array<[string, any, Record<string, unknown>]> = [
    ["calendar_freebusy", TOOL_calendar_freebusy, { timeMin: "2026-09-14T00:00:00+08:00", timeMax: "2026-09-14T01:00:00+08:00" }],
    ["calendar_update", TOOL_calendar_update, { eventId: "e1" }],
    ["todo_get", TOOL_todo_get, { taskId: "x" }],
    ["todo_update", TOOL_todo_update, { taskId: "x", title: "y" }],
    ["todo_complete", TOOL_todo_complete, { taskId: "x" }],
    ["todo_delete", TOOL_todo_delete, { taskId: "x" }],
    ["contact_get", TOOL_contact_get, { id: "c1" }],
    ["contact_create", TOOL_contact_create, { name: "n" }],
    ["contact_update", TOOL_contact_update, { id: "c1" }],
    ["contact_delete", TOOL_contact_delete, { id: "c1" }],
    ["mail_thread", TOOL_mail_thread, { threadId: "abc" }],
    ["mail_update", TOOL_mail_update, { id: "1", action: "mark_read" }],
    ["code_search", TOOL_code_search, { query: "x" }],
    ["code_issue_read", TOOL_code_issue_read, { repo: "a/b", number: 1 }],
  ];
  for (const [name, tool, args] of cases) {
    const r = await tool.run(toolCtx(), args);
    assert.equal(r.ok, false, `${name} 必须 fail-closed，不得合成成功`);
  }
  console.log("  ✅ all incomplete wrappers fail closed");
}


{
  const r = await TOOL_mail_thread.run(toolCtx(), { threadId: "not-a-number-thread" });
  assert.equal(r.ok, false);
  console.log("  ✅ non-numeric threadId never degrades to first mail");
}


{
  const catalog = buildFullCatalog({} as any, { workspaceId: "w", channel: "web" } as any);
  const byName = new Map(catalog.map((e) => [e.tool.name, e]));
  for (const name of ["calendar_freebusy", "calendar_update", "todo_get", "todo_update", "todo_complete", "todo_delete", "contact_get", "contact_create", "contact_update", "contact_delete", "mail_thread", "mail_update", "code_search", "code_issue_read"]) {
    const e = byName.get(name);
    assert.ok(e && isEffectivelyHidden(e), `${name} 必须 hidden`);
  }
  const defs = toolDefsForSession(catalog, defaultToolSession(), { env: {} as any, taskCtx: { workspaceId: "w", channel: "web" } as any });
  for (const name of ["mail_thread", "mail_update", "code_search", "calendar_freebusy"]) {
    assert.ok(!defs.some((d) => d.name === name), `${name} 不得进默认 surface`);
  }

  for (const name of ["mail_search", "mail_draft", "calendar_list"]) {
    assert.ok(defs.some((d) => d.name === name), `${name} 必须默认可见`);
  }
  console.log("  ✅ hidden predicate unified; core mail/calendar default visible");
}


{
  assert.equal(TOOL_mail_update.effect, "write");
  console.log("  ✅ mail_update modeled as external write");
}

console.log("✅ merged-p0-06-semantic-honesty tests passed");
