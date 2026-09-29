import type { Tool } from "../tool-types";
import { type FacadeLookup, actionEnum, accountHint, approvalFor, int, obj, runFirst, str, withoutAction } from "./shared";

export function buildCodeFacade(lookup: FacadeLookup): Tool {
  return {
    name: "code",
    effect: "write",
    description: "统一代码仓库工具：读取仓库/文件/搜索/Issue/PR/commit/CI，或创建 Issue、评论、PR。模型不需要挑选 github_* 底层工具。",
    parameters: obj({
      action: actionEnum([
        "repo_list", "repo_read", "issue_list", "issue_read", "search", "tree", "read",
        "pr_list", "pr_read", "pr_diff", "commits", "commit_read", "actions_runs", "action_run_read",
        "api_read", "issue_create", "comment", "pr_create",
      ], "代码仓库动作"),
      repo: str("仓库 owner/name"), number: int("Issue/PR 编号"), query: str("搜索词"),
      path: str("文件路径或 GitHub API path"), ref: str("branch/tag/commit（可选）"), branch: str("分支（可选）"),
      sha: str("commit sha"), runId: int("Actions run id"), title: str("标题（创建 Issue/PR）"), body: str("正文/评论"),
      head: str("PR head 分支"), base: str("PR base 分支"), limit: int("结果上限（可选）"), max: int("结果上限（兼容参数）"), account: accountHint,
    }, ["action"]),
    requiresApproval: approvalFor(["issue_create", "comment", "pr_create"]),
    run: async (ctx, a) => {
      const target: Record<string, string[]> = {
        repo_list: ["github_repos", "code_repo_list"], repo_read: ["github_repo_read"],
        issue_list: ["github_issues_list"], issue_read: ["github_issue_read", "code_issue_read"],
        search: ["github_code_search", "code_search"], tree: ["github_tree"], read: ["github_file_read"],
        pr_list: ["github_pr_list"], pr_read: ["github_pr_read"], pr_diff: ["github_pr_diff"],
        commits: ["github_commits"], commit_read: ["github_commit_read"], actions_runs: ["github_actions_runs"], action_run_read: ["github_action_run_read"],
        api_read: ["github_api_read"], issue_create: ["github_create_issue", "code_issue_create"],
        comment: ["github_comment", "code_comment"], pr_create: ["github_pr_create"],
      };
      const names = target[String(a.action ?? "")];
      if (!names) return { ok: false, error: "invalid_code_action" };
      return runFirst(lookup, names, ctx, withoutAction(a));
    },
  };
}
