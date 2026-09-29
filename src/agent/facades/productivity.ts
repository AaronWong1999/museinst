import type { Tool } from "../tool-types";
import {
  type FacadeLookup, actionEnum, accountHint, approvalFor, chooseProvider, int, obj, providerHint, runFirst, str, withoutAction,
} from "./shared";

export function buildProductivityFacades(lookup: FacadeLookup): Tool[] {
  const calendar: Tool = {
    name: "calendar",
    effect: "write",
    description: "统一日历工具：查看、创建、修改、删除日程或查询忙闲。不要挑 Google/Lark/飞书 API；运行时按真实连接自动路由，多服务无法判定时才请用户选择。",
    parameters: obj({
      action: actionEnum(["list", "create", "update", "delete", "freebusy"], "日历动作"),
      timeMin: str("查询开始时间 ISO（list/freebusy）"), timeMax: str("查询结束时间 ISO（list/freebusy）"),
      eventId: str("日程 id（update/delete）"), calendarId: str("calendar id（可选）"),
      summary: str("标题（create/update）"), startIso: str("开始时间 ISO（create/update）"), endIso: str("结束时间 ISO（create/update）"),
      description: str("描述（可选）"), location: str("地点（可选）"),
      attendees: { type: "array", items: { type: "string" }, description: "参会人邮箱（可选）" },
      provider: providerHint, account: accountHint, max: int("最多返回条数（可选）"),
    }, ["action"]),
    // Keep the facade at least as precise as the provider tools it replaces: creating/deleting
    // always needs approval, while an ordinary metadata/time update does not suddenly become
    // approval-gated merely because it is routed through a facade. Adding/replacing attendees is
    // an external-send-like change and still requires approval.
    requiresApproval: (a) => {
      const action = String(a.action ?? "");
      if (action === "create" || action === "delete") return true;
      return action === "update" && Array.isArray(a.attendees) && a.attendees.length > 0;
    },
    run: async (ctx, a) => {
      const action = String(a.action ?? "");
      const p = await chooseProvider(ctx, a, ["google", "lark", "feishu"]);
      if (!p.ok) return { ok: false, error: p.error };
      const fwd = { ...withoutAction(a), provider: p.provider };
      if (p.provider === "google") {
        const target: Record<string, string[]> = {
          list: ["google_calendar_list_events", "calendar_list"],
          create: ["google_calendar_create_event", "calendar_create"],
          update: ["google_calendar_update_event", "calendar_update"],
          delete: ["google_calendar_delete_event", "calendar_delete"],
        };
        if (action === "freebusy") return { ok: false, error: "（Google 当前最小权限仅支持 calendar.events，不提供 free/busy；可用 calendar.list 查看事件。）" };
        const names = target[action];
        if (!names) return { ok: false, error: "invalid_calendar_action" };
        return runFirst(lookup, names, ctx, fwd);
      }
      const semantic: Record<string, string> = {
        list: "calendar_list", create: "calendar_create", update: "calendar_update", delete: "calendar_delete", freebusy: "calendar_freebusy",
      };
      const name = semantic[action];
      if (!name) return { ok: false, error: "invalid_calendar_action" };
      return runFirst(lookup, [name], ctx, fwd);
    },
  };

  const todo: Tool = {
    name: "todo",
    effect: "write",
    description: "统一外部待办工具：查看、创建、修改、完成、删除 Tasks/Todo。服务商由运行时按真实连接自动选择。",
    parameters: obj({
      action: actionEnum(["list", "get", "create", "update", "complete", "delete"], "待办动作"),
      taskId: str("task id（get/update/complete/delete）"), tasklistId: str("task list id（可选）"),
      title: str("标题（create/update）"), notes: str("备注（可选）"), dueIso: str("截止时间 ISO（可选）"),
      showCompleted: { type: "boolean", description: "list 是否包含已完成" }, max: int("最多返回条数（可选）"),
      provider: providerHint, account: accountHint,
    }, ["action"]),
    requiresApproval: approvalFor(["delete"]),
    run: async (ctx, a) => {
      const action = String(a.action ?? "");
      const p = await chooseProvider(ctx, a, ["google", "lark", "feishu"]);
      if (!p.ok) return { ok: false, error: p.error };
      const fwd = { ...withoutAction(a), provider: p.provider };
      if (p.provider === "google") {
        const target: Record<string, string[]> = {
          list: ["google_tasks_list", "todo_list"], get: ["google_task_get", "todo_get"],
          create: ["google_task_create", "todo_create"], update: ["google_task_update", "todo_update"],
          complete: ["google_task_complete", "todo_complete"], delete: ["google_task_delete", "todo_delete"],
        };
        const names = target[action];
        if (!names) return { ok: false, error: "invalid_todo_action" };
        return runFirst(lookup, names, ctx, fwd);
      }
      const name = ({ list: "todo_list", get: "todo_get", create: "todo_create", update: "todo_update", complete: "todo_complete", delete: "todo_delete" } as Record<string, string>)[action];
      if (!name) return { ok: false, error: "invalid_todo_action" };
      return runFirst(lookup, [name], ctx, fwd);
    },
  };

  const contacts: Tool = {
    name: "contacts",
    effect: "read",
    scheduledAllowed: true,
    description: "统一联系人工具。当前只暴露真实支持的搜索/读取能力；不会假装支持联系人写入。服务商由运行时自动选择。",
    parameters: obj({
      action: actionEnum(["search", "get"], "联系人动作"), query: str("搜索词（search）"),
      resourceName: str("Google resourceName（get）"), id: str("Lark/飞书联系人 id（get）"),
      provider: providerHint, account: accountHint, max: int("最多返回条数（可选）"),
    }, ["action"]),
    run: async (ctx, a) => {
      const action = String(a.action ?? "");
      const p = await chooseProvider(ctx, a, ["google", "lark", "feishu"], a.resourceName ? String(a.resourceName) : undefined);
      if (!p.ok) return { ok: false, error: p.error };
      const fwd = { ...withoutAction(a), provider: p.provider };
      if (p.provider === "google") {
        if (action === "search") return runFirst(lookup, ["google_contacts_search", "contact_search"], ctx, fwd);
        if (action === "get") return runFirst(lookup, ["google_contact_get", "contact_get"], ctx, fwd);
      } else {
        if (action === "search") return runFirst(lookup, ["contact_search"], ctx, fwd);
        if (action === "get") return runFirst(lookup, ["contact_get"], ctx, { ...fwd, id: a.id ?? a.resourceName });
      }
      return { ok: false, error: "invalid_contacts_action" };
    },
  };

  return [calendar, todo, contacts];
}
