// DEFECT-021 — Agent file generation tool (files_create_text) + DEFECT-027-support
// (mail_draft evidence).
//
// The Files UI advertises an "Agent generated" collection; the Agent must
// be able to produce those artifacts through the files service with real
// stored bytes, task evidence, honest failures, and workspace isolation.
import assert from "node:assert/strict";
import { TOOL_files_create_text, TOOL_mail_draft } from "../src/agent/tools";
import { toolCtx, makeConnectorEnv, rows } from "./helpers/connectors-testkit";

console.log("▶ DEFECT-021 files_create_text + DEFECT-027-support mail_draft evidence");

function withR2(env: any): { env: any; objects: Map<string, { size: number; body: Uint8Array }> } {
  const objects = new Map<string, { size: number; body: Uint8Array }>();
  env.ARTIFACTS = {
    async put(key: string, value: ArrayBuffer) {
      const bytes = new Uint8Array(value);
      objects.set(key, { size: bytes.byteLength, body: bytes });
      return { key, size: bytes.byteLength };
    },
    async head(key: string) {
      const o = objects.get(key);
      return o ? { key, size: o.size } : null;
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(o.body);
          controller.close();
        },
      });
      return { ...o, body: stream };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return { env, objects };
}

console.log("  [1] happy path: artifact row (source=generated), exact stored bytes, evidence row");
{
  const env = withR2(makeConnectorEnv());
  const ctx = toolCtx(env.env, "ws-gen", "task-gen-1");
  const content = "# 周报\n\n- 修复 mail_count\n- 新增 files_create_text\n";
  const r = await TOOL_files_create_text.run(ctx, { filename: "周报-summary.md", content });
  assert.ok(r.ok, `files_create_text 必须成功：${(r as any)?.error}`);
  const data = r.data as { artifactId: string; filename: string; bytes: number; collection: string };
  assert.equal(data.filename, "周报-summary.md");
  assert.equal(data.collection, "generated");

  // Exact stored bytes (UTF-8) in R2 and in the DB row.
  const expectedBytes = new TextEncoder().encode(content).byteLength;
  assert.equal(data.bytes, expectedBytes, "返回的 bytes 必须等于内容的 UTF-8 字节数");

  const artifactRows = await rows(env.env, "SELECT * FROM artifacts WHERE id=?", data.artifactId);
  assert.equal(artifactRows.length, 1, "必须恰好写入一行 artifacts");
  const row = artifactRows[0] as Record<string, unknown>;
  assert.equal(row.workspace_id, "ws-gen");
  assert.equal(row.task_id, "task-gen-1");
  assert.equal(row.source, "generated", "artifacts.source 必须是 generated");
  assert.equal(row.kind, "generated", "artifacts.kind 必须是 generated");
  assert.equal(row.size_bytes, expectedBytes, "size_bytes 必须等于存储字节数");

  // Evidence: artifact_created with "<artifactId> <filename>".
  const evidence = await rows(env.env, "SELECT * FROM task_evidence WHERE task_id=? ORDER BY created_at", "task-gen-1");
  const ev = evidence.find((e) => (e as any).type === "artifact_created") as any;
  assert.ok(ev, "必须写入 artifact_created 证据");
  assert.equal(ev.value, `${data.artifactId} 周报-summary.md`);

  console.log("    ✅ artifact row source=generated, exact bytes, evidence written");
}

console.log("  [2] content round-trips through R2 byte-for-byte");
{
  const env = withR2(makeConnectorEnv());
  const content = "line1\nline2 中文 ✓\nline3";
  const r = await TOOL_files_create_text.run(toolCtx(env.env, "ws-gen"), { filename: "data.txt", content });
  assert.ok(r.ok);
  const data = r.data as { artifactId: string };
  const key = `artifacts/ws-gen/${data.artifactId}`;
  const obj = env.objects.get(key)!;
  assert.ok(obj, "R2 对象必须存在（workspace-scoped key）");
  assert.equal(new TextDecoder().decode(obj.body), content, "R2 内容必须与输入逐字节一致");
  console.log("    ✅ R2 content matches input exactly");
}

console.log("  [3] duplicate filename refused with actionable message; overwrite proceeds");
{
  const env = withR2(makeConnectorEnv());
  const ctx = toolCtx(env.env, "ws-gen", "task-dup");
  const first = await TOOL_files_create_text.run(ctx, { filename: "report.md", content: "v1" });
  assert.ok(first.ok);
  const dup = await TOOL_files_create_text.run(ctx, { filename: "report.md", content: "v2" });
  assert.ok(!dup.ok, "同名且未 overwrite 必须拒绝");
  assert.match(String(dup.error), /report\.md/, "错误信息必须点名冲突文件");
  assert.match(String(dup.error), /overwrite/, "错误信息必须给出 overwrite 动作指引");
  const forced = await TOOL_files_create_text.run(ctx, { filename: "report.md", content: "v2", overwrite: true });
  assert.ok(forced.ok, "overwrite: true 必须允许生成新版本");
  console.log("    ✅ duplicate refusal + overwrite escape hatch");
}

console.log("  [4] failures are specific, never bare: invalid filename, missing binding");
{
  const env = withR2(makeConnectorEnv());
  const ctx = toolCtx(env.env, "ws-gen");
  const badName = await TOOL_files_create_text.run(ctx, { filename: "../escape.md", content: "x" });
  assert.ok(!badName.ok);
  assert.match(String(badName.error), /文件名/, "路径穿越文件名必须得到具体错误");

  const empty = await TOOL_files_create_text.run(ctx, { filename: "  ", content: "x" });
  assert.ok(!empty.ok);
  assert.match(String(empty.error), /filename/, "空文件名必须得到具体错误");

  const noBinding = await TOOL_files_create_text.run(toolCtx(makeConnectorEnv(), "ws-gen"), { filename: "ok.md", content: "x" });
  assert.ok(!noBinding.ok, "缺 ARTIFACTS 存储桶必须失败");
  assert.match(String(noBinding.error), /存储桶|部署配置/, "缺绑定时错误必须指明部署配置问题");
  assert.notEqual(String(noBinding.error).trim(), "failed", "绝不能是裸失败");
  console.log("    ✅ specific failure reasons for invalid name / missing bucket");
}

console.log("  [5] workspace isolation: second workspace cannot see or read the artifact");
{
  const env = withR2(makeConnectorEnv());
  const r = await TOOL_files_create_text.run(toolCtx(env.env, "ws-A"), { filename: "secret.txt", content: "top" });
  assert.ok(r.ok);
  const artifactId = (r.data as { artifactId: string }).artifactId;

  // Same artifactId from another workspace must be invisible (service-level).
  const { getArtifact, readContent } = await import("../src/files/service");
  assert.equal(await getArtifact(env.env, "ws-B", artifactId), null, "跨工作区读元数据必须 not found");
  const cross = await readContent(env.env, "ws-B", artifactId);
  assert.ok(!cross.ok && cross.error === "not_found", "跨工作区读内容必须被拒绝");

  // Listing from ws-B must not contain the artifact either.
  const other = await TOOL_files_create_text.run(toolCtx(env.env, "ws-B"), { filename: "secret.txt", content: "other-ws" });
  assert.ok(other.ok, "另一工作区同名文件不受影响");
  const wsBList = await rows(env.env, "SELECT * FROM artifacts WHERE workspace_id=?", "ws-B");
  assert.equal(wsBList.length, 1, "ws-B 只能看到自己的 artifact");
  assert.notEqual((wsBList[0] as any).id, artifactId);
  console.log("    ✅ cross-workspace metadata/read/list all isolated");
}

console.log("  [6] DEFECT-027-support: mail_draft success writes evidence (executor path)");
{
  const env = makeConnectorEnv();
  env.IMAP = {
    async draftMail(req: { account: string; mail: { to: string; subject: string } }) {
      return {
        ok: true,
        uid: 4242,
        folder: "Drafts",
        deduped: false,
        to: req.mail.to,
        subject: req.mail.subject,
        isDraft: true,
        messageId: "<d@example.com>",
        verifiedAt: Date.now(),
      };
    },
  };
  seedMailboxAccount(env, "ws-draft", "user@qq.com");
  const r = await TOOL_mail_draft.run(
    toolCtx(env, "ws-draft", "task-draft-1"),
    { to: "bob@example.com", subject: "季度总结草稿", body: "正文内容" },
  );
  assert.ok(r.ok, `mail_draft 必须成功：${(r as any)?.error}`);
  const evidence = await rows(env, "SELECT * FROM task_evidence WHERE task_id=?", "task-draft-1");
  const ev = evidence.find((e) => (e as any).type === "mail_draft_created") as any;
  assert.ok(ev, "mail_draft 成功必须写入 mail_draft_created 证据");
  assert.match(ev.value, /^Drafts\/4242 /, "证据值必须包含 folder/uid");
  assert.ok(ev.value.includes("季度总结草稿"), "证据值必须包含主题摘录");
  console.log("    ✅ mail_draft_created evidence written with folder/uid + subject");
}

console.log("  [7] mail_draft failure keeps the specific verification error (no evidence written)");
{
  const env = makeConnectorEnv();
  env.IMAP = {
    async draftMail() {
      return { ok: false, error: "draft_flag_missing", uid: 7, folder: "Drafts", isDraft: false };
    },
  };
  seedMailboxAccount(env, "ws-draft2", "user@qq.com");
  const r = await TOOL_mail_draft.run(
    toolCtx(env, "ws-draft2", "task-draft-2"),
    { to: "bob@example.com", subject: "验证失败", body: "正文" },
  );
  assert.ok(!r.ok, "验证失败必须如实失败");
  assert.match(String(r.error), /草稿创建失败.*draft_flag_missing/, "必须原样返回具体验证错误");
  const evidence = await rows(env, "SELECT * FROM task_evidence WHERE task_id=?", "task-draft-2");
  assert.equal(evidence.filter((e) => (e as any).type === "mail_draft_created").length, 0, "失败不得写成功证据");
  console.log("    ✅ verification error surfaced unchanged; no success evidence");
}

// Minimal mailbox account row so defaultMailboxAccount resolves in the tool.
function seedMailboxAccount(env: any, workspaceId: string, email: string): void {
  env.DB.prepare(
    `INSERT OR REPLACE INTO mailbox_accounts
     (id, workspace_id, provider, email, imap_host, imap_port, smtp_host, smtp_port, smtp_starttls, send_id, vault_item_id, created_at, updated_at)
     VALUES (?, ?, 'qq', ?, 'imap.qq.com', 993, 'smtp.qq.com', 465, 0, 0, 'v-seed', 1, 1)`,
  ).bind(`acc-${workspaceId}`, workspaceId, email).run();
}

console.log("✅ artifact-write-tool tests passed");
