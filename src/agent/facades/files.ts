import type { Tool } from "../tool-types";
import { type FacadeLookup, actionEnum, accountHint, approvalFor, int, obj, runFirst, str, withoutAction } from "./shared";

export function buildFilesFacade(lookup: FacadeLookup): Tool {
  return {
    name: "files",
    effect: "write",
    description: "统一云文件工具：搜索/列出 MuseInst 可访问文件，读取元数据/内容，重命名、移入回收站或创建文件夹。Hosted 当前遵守 Google drive.file：只访问用户明确授权或 MuseInst 创建的文件。",
    parameters: obj({
      action: actionEnum(["search", "list", "get", "read", "rename", "delete", "create_folder"], "文件动作"),
      query: str("文件名关键词（search）"), max: int("最多返回条数（可选）"),
      fileId: str("文件 id（get/read/rename/delete）"), name: str("新名称或文件夹名称"),
      parentId: str("父文件夹 id（create_folder，可选且必须已授权）"), account: accountHint,
    }, ["action"]),
    requiresApproval: approvalFor(["delete"]),
    run: async (ctx, a) => {
      const target: Record<string, string[]> = {
        search: ["google_drive_search"], list: ["google_drive_granted_files_list"],
        get: ["google_drive_get", "google_drive_file_metadata"], read: ["google_drive_file_read"],
        rename: ["google_drive_file_rename"], delete: ["google_drive_file_delete"], create_folder: ["google_drive_create_folder"],
      };
      const names = target[String(a.action ?? "")];
      if (!names) return { ok: false, error: "invalid_files_action" };
      return runFirst(lookup, names, ctx, withoutAction(a));
    },
  };
}
