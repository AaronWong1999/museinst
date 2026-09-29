//
// Comprehensive regression tests for P0/P1 capabilities:
//  - C4/C5/C7: capability-gated handoff
//  - E4: PDF field inspection & AcroForm filling
//  - F1/F3: Goals & Milestones, Ideas lifecycle
//
import assert from "node:assert/strict";
import { deliverBrowserHandoff } from "../src/browser/cards";
import { inspectPdfBytes } from "../src/files/pdf";
import { GoalsService } from "../src/agent/goals-service";

console.log("▶ P0/P1 Full Verification Suite");

function createMockD1(): any {
  const tables = new Map<string, Map<string, any>>();
  const getTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };

  return {
    prepare(sql: string) {
      return {
        _bindings: [] as any[],
        bind(...args: any[]) { this._bindings = args; return this; },
        async run() {
          const b = this._bindings;
          if (sql.includes("INSERT INTO browser_access_grants")) {
            const row = { id: b[0], workspace_id: b[1], task_id: b[2], token_hash: b[7], status: "issued", requested_mode: b[8], current_mode: b[9], created_by: b[10] };
            getTable("grants").set(row.id, row);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO goals")) {
            const row = { id: b[0], workspace_id: b[1], thread_id: b[2], linked_workstream_id: b[3], proposal_id: b[4], title: b[5], target: b[6], status: b[7], created_at: b[8], updated_at: b[9] };
            getTable("goals").set(row.id, row);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO goal_milestones")) {
            const row = { id: b[0], goal_id: b[1], title: b[2], state: b[3], ordinal: b[4], created_at: b[5], updated_at: b[6] };
            getTable("milestones").set(row.id, row);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE goals SET status = ?")) {
            const row = getTable("goals").get(b[4]);
            if (row) { row.status = b[0]; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("INSERT INTO ideas")) {
            const row = { id: b[0], workspace_id: b[1], thread_id: b[2], suggestion: b[3], why_now: b[4], action_label: b[5], action_kind: b[6], evidence_json: b[7], status: "open", dedupe_key: b[8], created_at: b[9] };
            getTable("ideas").set(row.id, row);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE ideas SET status = ?")) {
            const row = getTable("ideas").get(b[3]);
            if (row && row.status === "open") { row.status = b[0]; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first<T = any>() {
          const b = this._bindings;
          if (sql.includes("FROM goals WHERE") && sql.includes("proposal_id = ?")) {
            for (const row of getTable("goals").values()) {
              if (row.workspace_id === b[0] && row.proposal_id === b[1]) return { ...row } as T;
            }
          }
          return null;
        },
        async all<T = any>() {
          const b = this._bindings;
          if (sql.includes("FROM goals WHERE workspace_id = ?")) {
            return { results: Array.from(getTable("goals").values()).filter((r) => r.workspace_id === b[0]) as T[] };
          }
          if (sql.includes("FROM goal_milestones WHERE goal_id IN")) {
            const ids = new Set(b);
            return { results: Array.from(getTable("milestones").values()).filter((r) => ids.has(r.goal_id)) as T[] };
          }
          if (sql.includes("FROM ideas WHERE workspace_id = ?")) {
            return { results: Array.from(getTable("ideas").values()).filter((r) => r.workspace_id === b[0] && r.status === "open") as T[] };
          }
          return { results: [] as T[] };
        },
      };
    },
  };
}

function classicAcroFormFixture(): Uint8Array {
  const enc = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n",
    "4 0 obj\n<< /Fields [5 0 R 6 0 R] >>\nendobj\n",
    "5 0 obj\n<< /T (FullName) /FT /Tx /V () >>\nendobj\n",
    "6 0 obj\n<< /T (AgreeTerms) /FT /Btn >>\nendobj\n",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(enc.encode(pdf).byteLength);
    pdf += object;
  }
  const xrefOffset = enc.encode(pdf).byteLength;
  pdf += "xref\n0 7\n0000000000 65535 f \n";
  for (let i = 1; i <= 6; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc.encode(pdf);
}

// ── 1. Browser handoff capability gating ────────────────────────────────────
{
  console.log("  [1] Browser handoff only advertises configured capabilities (§14.9/§14.10)");
  const mockDb = createMockD1();
  const mockEnv: any = {
    DB: mockDb,
    PUBLIC_BASE_URL: "https://openinst.test",
    BROWSER_LIVE_VIEW_ACCOUNT_ID: "acc12345",
    BROWSER_API_TOKEN: "browser_only_token",
  };

  const { BROWSER_API_TOKEN: _token, ...envWithoutToken } = mockEnv;
  await assert.rejects(() => deliverBrowserHandoff(envWithoutToken, {
    workspaceId: "ws1",
    threadId: "th1",
    taskId: "t_browser_1",
    sessionId: "624e2202-0b29-4023-b509-97b956fb55cd",
    targetId: "90AD1A631CF95CB728060533FF88CCFB",
    mode: "interactive",
    reasonCode: "captcha",
    instructions: "请通过滑块验证码",
    privacyMode: "normal",
    lang: "zh",
  }), /browser_takeover_unavailable/);

  const delivery = await deliverBrowserHandoff(mockEnv, {
    workspaceId: "ws1",
    threadId: "th1",
    taskId: "t_browser_1",
    sessionId: "624e2202-0b29-4023-b509-97b956fb55cd",
    targetId: "90AD1A631CF95CB728060533FF88CCFB",
    mode: "readonly",
    reasonCode: "user_requested",
    instructions: "查看 Agent 当前页面",
    privacyMode: "normal",
    lang: "zh",
  });
  assert.ok(delivery.grant.grantId.startsWith("bg_"));
  assert.ok(delivery.grant.accessUrl.includes("/b/"));
  assert.equal(delivery.card.type, "browser_session");
  assert.equal(delivery.card.state, "watch_available");
  assert.ok(delivery.card.actions.some((a) => a.kind === "browser_watch"));
  assert.ok(!delivery.card.actions.some((a) => a.kind === "browser_takeover"));
  assert.ok(delivery.text.includes("只读预览"));
  assert.ok(!delivery.text.includes("624e2202-0b29-4023-b509-97b956fb55cd"));
}

// ── 2. PDF Inspection & AcroForm Support ────────────────────────────────────
{
  console.log("  [2] PDF AcroForm field inspection accurately detects form fields (§15.5)");
  const result = inspectPdfBytes(classicAcroFormFixture());
  assert.equal(result.isPdf, true);
  assert.equal(result.isEncrypted, false);
  assert.equal(result.formType, "AcroForm");
  assert.equal(result.fields.length, 2);
  assert.equal(result.fields[0].name, "FullName");
  assert.equal(result.fields[0].type, "text");
  assert.equal(result.fields[1].name, "AgreeTerms");
  assert.equal(result.fields[1].type, "checkbox");
  assert.equal(result.supportedForFilling, true);
  const nonPdf = inspectPdfBytes(new Uint8Array([1, 2, 3, 4]));
  assert.equal(nonPdf.isPdf, false);
  assert.equal(nonPdf.supportedForFilling, false);
}

// ── 3. Goals & Ideas Lifecycle & Idempotency ────────────────────────────────
{
  console.log("  [3] Goals & Ideas persistence, proposal idempotency & lifecycle (§16, §17)");
  const mockDb = createMockD1();
  const mockEnv: any = { DB: mockDb };
  const svc = new GoalsService(mockEnv);

  const g1 = await svc.createOrConfirmGoal("ws_user", {
    proposalId: "prop_123",
    title: "Launch OpenInst Cloudflare Upgrade",
    target: "Deploy all tests passing",
    milestones: ["Run all test suites", "Deploy to CF Workers", "Commit to git main"],
  });
  assert.equal(g1.ok, true);
  if (g1.ok) {
    assert.equal(g1.goal.title, "Launch OpenInst Cloudflare Upgrade");
    assert.equal(g1.milestones.length, 3);
  }

  const g2 = await svc.createOrConfirmGoal("ws_user", {
    proposalId: "prop_123",
    title: "Different title that should be ignored due to proposalId dedupe",
  });
  assert.equal(g2.ok, true);
  if (g2.ok) {
    assert.equal(g2.goal.id, g1.ok ? g1.goal.id : "");
    assert.equal(g2.goal.title, "Launch OpenInst Cloudflare Upgrade");
  }

  if (g1.ok) assert.equal(await svc.updateGoalStatus("ws_user", g1.goal.id, "completed"), true);

  const idea = await svc.createIdea("ws_user", {
    suggestion: "Reply to important email from investor",
    whyNow: "Received 30 minutes ago",
    actionLabel: "Draft reply",
    actionKind: "draft_email",
    dedupeKey: "email:inv_123",
  });
  assert.ok(idea.id.startsWith("idea_"));
  assert.equal((await svc.listIdeas("ws_user")).length, 1);
  assert.equal(await svc.resolveIdea("ws_user", idea.id, "dismissed"), true);
}

console.log("✅ All P0/P1 Full Verification Suite tests passed!");
