import type { Tool } from "../tool-types";
import {
  type FacadeLookup, actionEnum, accountHint, approvalFor, chooseProvider, int, obj, providerHint, runFirst, str, withoutAction,
} from "./shared";

export function buildContentFacades(lookup: FacadeLookup): Tool[] {
  const documents: Tool = {
    name: "documents",
    effect: "write",
    description: "统一文档工具：搜索、读取、创建、追加和编辑文档。模型不需要选择 Google Docs/Lark/飞书底层 API；运行时按已连接服务和资源归属路由。",
    parameters: obj({
      action: actionEnum(["search", "read", "create", "append", "insert_text", "replace_text", "delete_range"], "文档动作"),
      query: str("搜索词（search）"), max: int("最多返回条数（可选）"),
      documentId: str("文档 id/token（read/append/edit）"), title: str("文档标题（create）"), text: str("文本（append/insert_text）"),
      index: int("插入位置（insert_text）"), find: str("查找文本（replace_text）"), replace: str("替换文本（replace_text）"),
      startIndex: int("删除起始 index（delete_range）"), endIndex: int("删除结束 index（delete_range）"),
      provider: providerHint, account: accountHint,
    }, ["action"]),
    requiresApproval: approvalFor(["delete_range"]),
    run: async (ctx, a) => {
      const action = String(a.action ?? "");
      const p = await chooseProvider(ctx, a, ["google", "lark", "feishu"], a.documentId ? String(a.documentId) : undefined);
      if (!p.ok) return { ok: false, error: p.error };
      const fwd: Record<string, unknown> = { ...withoutAction(a), provider: p.provider };
      if (p.provider === "google") {
        const target: Record<string, string[]> = {
          search: ["google_drive_search"], read: ["google_docs_read"], create: ["google_docs_create"],
          append: ["google_docs_append"], insert_text: ["google_docs_insert_text"], replace_text: ["google_docs_replace_text"],
          delete_range: ["google_docs_delete_range"],
        };
        const names = target[action];
        if (!names) return { ok: false, error: "invalid_documents_action" };
        return runFirst(lookup, names, ctx, fwd);
      }
      const target: Record<string, string[]> = {
        search: ["document_search"], read: ["document_read"], create: ["document_create"], append: ["document_append"],
      };
      const names = target[action];
      if (!names) return { ok: false, error: `（${p.provider} 当前未实现 documents.${action}；不会伪装成功。）` };
      return runFirst(lookup, names, ctx, fwd);
    },
  };

  const spreadsheet: Tool = {
    name: "spreadsheet",
    effect: "write",
    description: "统一表格工具：创建、读取、写入、追加、清空或管理工作表。Google Sheets/Lark/飞书由运行时路由。",
    parameters: obj({
      action: actionEnum(["create", "get", "read", "update", "append_rows", "clear", "add_sheet", "delete_sheet"], "表格动作"),
      spreadsheetId: str("Google spreadsheet id"), spreadsheetToken: str("Lark/飞书 spreadsheet token"),
      title: str("表格或工作表标题"), range: str("单元格范围"),
      values: { type: "array", items: { type: "array", items: {} }, description: "二维数组数据" },
      sheetId: int("工作表 sheetId（delete_sheet）"), provider: providerHint, account: accountHint,
    }, ["action"]),
    requiresApproval: approvalFor(["clear", "delete_sheet"]),
    run: async (ctx, a) => {
      const action = String(a.action ?? "");
      const resource = a.spreadsheetId ?? a.spreadsheetToken;
      const p = await chooseProvider(ctx, a, ["google", "lark", "feishu"], resource ? String(resource) : undefined);
      if (!p.ok) return { ok: false, error: p.error };
      const fwd: Record<string, unknown> = { ...withoutAction(a), provider: p.provider };
      if (p.provider === "google") {
        if (!fwd.spreadsheetId && fwd.spreadsheetToken) fwd.spreadsheetId = fwd.spreadsheetToken;
        const target: Record<string, string[]> = {
          create: ["google_sheets_create"], get: ["google_sheets_get"], read: ["google_sheets_read"], update: ["google_sheets_update"],
          append_rows: ["google_sheets_append_rows"], clear: ["google_sheets_clear"], add_sheet: ["google_sheets_add_sheet"], delete_sheet: ["google_sheets_delete_sheet"],
        };
        const names = target[action];
        if (!names) return { ok: false, error: "invalid_spreadsheet_action" };
        return runFirst(lookup, names, ctx, fwd);
      }
      if (!fwd.spreadsheetToken && fwd.spreadsheetId) fwd.spreadsheetToken = fwd.spreadsheetId;
      const target: Record<string, string[]> = {
        create: ["spreadsheet_create"], get: ["spreadsheet_get"], read: ["spreadsheet_read"], append_rows: ["spreadsheet_append_rows"],
      };
      const names = target[action];
      if (!names) return { ok: false, error: `（${p.provider} 当前未实现 spreadsheet.${action}；不会伪装成功。）` };
      return runFirst(lookup, names, ctx, fwd);
    },
  };

  const presentation: Tool = {
    name: "presentation",
    effect: "write",
    description: "统一演示文稿工具：创建、读取、加页、写文本、替换文本、删页或获取缩略图。当前 Hosted 真实实现为 Google Slides，模型不需要选择底层 API。",
    parameters: obj({
      action: actionEnum(["create", "read", "add_slide", "add_text_slide", "add_text", "replace_text", "delete_slide", "thumbnail"], "演示文稿动作"),
      presentationId: str("presentation id"), slideId: str("slide id（需要时）"), title: str("演示文稿标题（create）"),
      text: str("文本"), find: str("查找文本（replace_text）"), replace: str("替换文本（replace_text）"), account: accountHint,
    }, ["action"]),
    requiresApproval: approvalFor(["delete_slide"]),
    run: async (ctx, a) => {
      const target: Record<string, string[]> = {
        create: ["google_slides_create"], read: ["google_slides_read"], add_slide: ["google_slides_add_slide"],
        add_text_slide: ["google_slides_add_text_slide"], add_text: ["google_slides_add_text"], replace_text: ["google_slides_replace_text"],
        delete_slide: ["google_slides_delete_slide"], thumbnail: ["google_slides_get_thumbnail"],
      };
      const names = target[String(a.action ?? "")];
      if (!names) return { ok: false, error: "invalid_presentation_action" };
      return runFirst(lookup, names, ctx, withoutAction(a));
    },
  };

  return [documents, spreadsheet, presentation];
}
