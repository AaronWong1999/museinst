import { Hono } from "hono";
import { connectorRedirectBase } from "../connectors/oauth-flow";
import type { Env, SessionInfo } from "../env";
import { json, now, readJson } from "../util";
import { readSession, clearSessionHeader } from "../session";
import { listBindings } from "../identity";
import { createBindCode, dispatchChannelEvent } from "../channels/dispatch";
import { textEvent } from "../channels/normalize";
import { deriveSecurityContext, OWNER_GLOBAL_SCOPE } from "../security/context";
import {
  getTelegramUsername,
  telegramConfigured,
  wechatConfigured,
  isAdmin,
} from "../channels/config";
import * as vault from "../vault/service";
import { gmailProfile, googleAuthorizeUrl, googleExchangeCode, googleStoreConnection, googleConfigured, getGoogleToken } from "../connectors/google";
import { githubAuthorizeUrl, githubExchangeCode, githubStoreConnection, githubConfigured } from "../connectors/github";
import { linearStore } from "../connectors/linear";
import { slackStore } from "../connectors/slack";
import {
  isLarkFeishuConfigured,
  larkFeishuAuthorizeUrl,
  larkFeishuExchangeCode,
  larkFeishuIdentifyAccount,
  type LarkFeishuProvider,
} from "../connectors/lark-feishu";
import { upsertConnectedAccount } from "../connectors/token-store";
import { ingestLocation, lastKnown, recentPoints, computeVisits, labelVisits } from "../location";
import { PRESETS } from "../imap/imap";
import { getHostHooks } from "../hooks";
import { testModelConnection, type CustomModelConfig } from "../model/call";
import { getWorkspaceModelConfig, saveWorkspaceModelConfig, CLOUDFLARE_PRESETS } from "../model/config";
import * as tasksMod from "../tasks/tasks";
import { registerPublicReceiptRoutes } from "../tasks/receipt-routes";

export const coreApiApp = new Hono<{ Bindings: Env; Variables: { session: SessionInfo } }>();
registerPublicReceiptRoutes(coreApiApp);

async function requireAuth(c: any, next: () => Promise<void>): Promise<Response | void> {
  const session = await readSession(c.env, c.req.raw);
  if (!session) return json({ error: "unauthorized" }, 401);
  c.set("session", session as SessionInfo);
  await next();
}

async function canAddConnector(env: Env, workspaceId: string): Promise<boolean> {
  const quota = getHostHooks().connectorQuota;
  if (!quota) return true;
  const max = await quota(env, { workspaceId });
  if (max === null) return true;
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT provider) AS c FROM connections WHERE workspace_id=?`,
  ).bind(workspaceId).first<{ c: number }>().catch(() => ({ c: 0 }));
  return (row?.c ?? 0) < max;
}

async function consumeOAuthState(
  env: Env,
  state: string,
  provider: string,
): Promise<{ workspace_id: string } | null> {
  return env.DB.prepare(
    `DELETE FROM oauth_states
       WHERE state=? AND provider=? AND (expires_at IS NULL OR expires_at>?)
       RETURNING workspace_id`,
  ).bind(state, provider, now()).first<{ workspace_id: string }>();
}

async function startLarkFeishu(c: any, provider: LarkFeishuProvider): Promise<Response> {
  const session = c.get("session") as SessionInfo;
  if (!(await canAddConnector(c.env, session.workspaceId))) {
    return json({ error: "connectors_limit_reached" }, 403);
  }
  if (!isLarkFeishuConfigured(c.env, provider)) {
    return json({ error: `${provider}_not_configured` }, 400);
  }
  const state = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO oauth_states (state, workspace_id, provider, created_at) VALUES (?, ?, ?, ?)`,
  ).bind(state, session.workspaceId, provider, now()).run();
  const redirectUri = `${connectorRedirectBase(c.env)}/api/connectors/${provider}/callback`;
  return c.redirect(larkFeishuAuthorizeUrl(c.env, provider, redirectUri, state));
}

async function finishLarkFeishu(c: any, provider: LarkFeishuProvider): Promise<Response> {
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (!code || !state) return c.redirect(`/workspace?connect=${provider}_failed`);
  const consumed = await consumeOAuthState(c.env, state, provider);
  if (!consumed) return c.redirect(`/workspace?connect=${provider}_failed`);
  const redirectUri = `${connectorRedirectBase(c.env)}/api/connectors/${provider}/callback`;
  const tokens = await larkFeishuExchangeCode(c.env, provider, code, redirectUri);
  if ("error" in tokens) return c.redirect(`/workspace?connect=${provider}_failed`);
  try {
    const account = await larkFeishuIdentifyAccount(c.env, provider, tokens.accessToken);
    await upsertConnectedAccount(
      c.env,
      consumed.workspace_id,
      provider,
      account.label,
      tokens,
      account.displayName,
    );
  } catch (error) {
    console.error(`[${provider}] identity/store failed`, error);
    return c.redirect(`/workspace?connect=${provider}_failed`);
  }
  return c.redirect(`/workspace?connect=${provider}_ok`);
}

coreApiApp.get("/healthz", async (c) => {
  if (!isAdmin(c.req.raw, c.env)) return json({ ok: true });
  const [telegram, wechat] = await Promise.all([
    telegramConfigured(c.env),
    wechatConfigured(c.env),
  ]);
  return json({
    ok: true,
    channels: { telegram, wechat },
    model: {
      provider: c.env.MODEL_PROVIDER,
      root: c.env.MODEL_ROOT,
      maxContext: c.env.MODEL_MAX_CONTEXT,
    },
    vault: Boolean(c.env.VAULT_MASTER_KEY || c.env.OPENINST_SECRET),
  });
});

for (const path of [
  "/api/me",
  "/api/vault/*",
  "/api/tasks",
  "/api/tasks/*",
  "/api/agent/*",
  "/api/settings",
  "/api/locations",
  "/api/session/logout",
  "/api/usage",
  "/api/model/*",
  "/api/connectors",
  "/api/connectors/*",
  "/api/privacy/*",
  "/api/receipts/*",
  "/api/recipes",
  "/api/recipe/*",
  "/api/chat",
  "/api/chat/*",
  "/api/automations",
  "/api/automations/*",
  "/api/files",
  "/api/files/*",
  "/api/goals",
  "/api/goals/*",
  "/api/ideas",
  "/api/ideas/*",
  "/api/context",
  "/api/context/*",
  "/api/browser/sessions",
]) {
  coreApiApp.use(path, (c, next) => requireAuth(c, next));
}

// ── Web Chat channel (spec §9, §25.1-§25.2) ───────────────────────────────
// The browser session is the identity: client-supplied workspaceId/userId are
// never accepted. Messages enqueue durably in the PersonalAgent DO and return
// 202 receipts; reads and realtime come from the DO's durable projection.

const WEB_CHAT_MAX_TEXT = 8000;
const WEB_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

coreApiApp.post("/api/chat/messages", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{ clientMessageId?: string; threadId?: string; text?: string }>(c.req.raw);
  const clientMessageId = String(body.clientMessageId ?? "");
  const text = String(body.text ?? "").trim();
  const threadId = body.threadId ? String(body.threadId).trim() : undefined;
  if (!WEB_MESSAGE_ID_RE.test(clientMessageId)) return json({ error: "client_message_id_invalid" }, 400);
  if (!text) return json({ error: "text_required" }, 400);
  if (text.length > WEB_CHAT_MAX_TEXT) return json({ error: "text_too_long" }, 400);

  const event = textEvent("web", `web:${session.userId}`, clientMessageId, text);
  const security = deriveSecurityContext({
    claims: { source: "owner_chat", workspaceId: session.workspaceId, scopeKey: OWNER_GLOBAL_SCOPE },
    identity: null,
    approvalRoute: { channel: "web" },
  });

  let receipt: Record<string, unknown> | null = null;
  const result = await dispatchChannelEvent(c.env, event, async () => {}, {
    security,
    authoritativeIdentity: { workspaceId: session.workspaceId, userId: session.userId },
    conversation: threadId ? { threadId } : undefined,
    executionMode: "enqueue",
    onAccepted: (r) => {
      receipt = { ...r };
    },
  });
  if (result === "failed" || !receipt) return json({ error: "chat_unavailable" }, 502);
  return json(receipt, 202);
});

coreApiApp.get("/api/chat/threads", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { agentFetch } = await import("../agent/rpc");
  const includeArchived = c.req.query("includeArchived") === "1" ? "?includeArchived=1" : "";
  const res = await agentFetch(c.env.AGENT, session.workspaceId, `/chat/threads${includeArchived}`);
  return json(await res.json(), res.status as 200);
});

coreApiApp.post("/api/chat/threads", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{ title?: string }>(c.req.raw);
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(c.env.AGENT, session.workspaceId, "/chat/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: body.title }),
  });
  return json(await res.json(), res.status as 201);
});

coreApiApp.patch("/api/chat/threads/:threadId", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{ title?: string; status?: string }>(c.req.raw);
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(c.env.AGENT, session.workspaceId, `/chat/threads/${encodeURIComponent(c.req.param("threadId"))}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: body.title, status: body.status }),
  });
  return json(await res.json(), res.status as 200);
});

coreApiApp.get("/api/chat/threads/:threadId/messages", async (c) => {
  const session = c.get("session") as SessionInfo;
  const after = c.req.query("afterMessageSeq") ?? "0";
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(
    c.env.AGENT,
    session.workspaceId,
    `/chat/threads/${encodeURIComponent(c.req.param("threadId"))}/messages?afterMessageSeq=${encodeURIComponent(after)}`,
  );
  return json(await res.json(), res.status as 200);
});

coreApiApp.get("/api/chat/threads/:threadId/events", async (c) => {
  const session = c.get("session") as SessionInfo;
  const after = c.req.query("after") ?? "0";
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(
    c.env.AGENT,
    session.workspaceId,
    `/chat/threads/${encodeURIComponent(c.req.param("threadId"))}/events?after=${encodeURIComponent(after)}`,
  );
  return json(await res.json(), res.status as 200);
});

coreApiApp.get("/api/chat/threads/:threadId/followups", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(c.env.AGENT, session.workspaceId, `/chat/threads/${encodeURIComponent(c.req.param("threadId"))}/followups`);
  return json(await res.json(), res.status as 200);
});

coreApiApp.post("/api/chat/threads/:threadId/followups/:followupId/cancel", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(
    c.env.AGENT,
    session.workspaceId,
    `/chat/threads/${encodeURIComponent(c.req.param("threadId"))}/followups/${encodeURIComponent(c.req.param("followupId"))}/cancel`,
    { method: "POST" },
  );
  return json(await res.json(), res.status as 200);
});

coreApiApp.post("/api/chat/threads/:threadId/followups/run", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(
    c.env.AGENT,
    session.workspaceId,
    `/chat/threads/${encodeURIComponent(c.req.param("threadId"))}/followups/run`,
    { method: "POST" },
  );
  return json(await res.json(), res.status as 200);
});

coreApiApp.post("/api/chat/runs/:runId/stop", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(c.env.AGENT, session.workspaceId, `/chat/runs/${encodeURIComponent(c.req.param("runId"))}/stop`, {
    method: "POST",
  });
  return json(await res.json(), res.status as 200);
});

// SSE notification transport (spec §9.3): pass-through stream from the DO.
// Notifications carry committed event copies; the durable projection remains
// the source of truth and reconnects replay from the last event cursor.
coreApiApp.get("/api/chat/realtime", async (c) => {
  const session = c.get("session") as SessionInfo;
  const threadId = c.req.query("threadId") ?? "";
  const after = c.req.query("after") ?? "0";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(threadId)) return json({ error: "thread_id_invalid" }, 400);
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(
    c.env.AGENT,
    session.workspaceId,
    `/chat/stream?threadId=${encodeURIComponent(threadId)}&after=${encodeURIComponent(after)}`,
  );
  if (!res.ok || !res.body) return json({ error: "stream_unavailable" }, 502);
  return new Response(res.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});

// ── Automations (spec §12/§25.4) ─────────────────────────────────────────
// Named automations over the DO schedule engine: explicit instruction,
// structured trigger (type/time/weekday/timezone/condition), delivery target
// with attention-only policy, and per-run disposition + receipt history.

coreApiApp.get("/api/automations", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(c.env.AGENT, session.workspaceId, "/automations");
  return json(await res.json(), res.status as 200);
});

coreApiApp.post("/api/automations", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<Record<string, unknown>>(c.req.raw);
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(c.env.AGENT, session.workspaceId, "/automations/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return json(await res.json(), res.status as 201);
});

coreApiApp.patch("/api/automations/:id", async (c) => {
  const session = c.get("session") as SessionInfo;
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ error: "not_found" }, 404);
  const body = await readJson<Record<string, unknown>>(c.req.raw);
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(c.env.AGENT, session.workspaceId, `/automations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return json(await res.json(), res.status as 200);
});

coreApiApp.get("/api/automations/:id/runs", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { agentFetch } = await import("../agent/rpc");
  const res = await agentFetch(
    c.env.AGENT,
    session.workspaceId,
    `/automations/${encodeURIComponent(c.req.param("id"))}/runs`,
  );
  return json(await res.json(), res.status as 200);
});

for (const action of ["pause", "resume", "delete", "run"] as const) {
  coreApiApp.post(`/api/automations/:id/${action}`, async (c) => {
    const session = c.get("session") as SessionInfo;
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ error: "not_found" }, 404);
    const { agentFetch } = await import("../agent/rpc");
    const res = await agentFetch(c.env.AGENT, session.workspaceId, `/automations/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    return json(await res.json(), res.status as 200);
  });
}

// ── Files / Artifacts (spec §15/§25.6) ───────────────────────────────────
// R2 is the binary truth; ownership lives in D1. Every route is
// workspace-scoped by the session; content is streamed only to the owner —
// no public or presigned R2 URLs.

coreApiApp.get("/api/files", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { listArtifacts } = await import("../files/service");
  const rows = await listArtifacts(c.env, session.workspaceId, {
    source: c.req.query("source") || undefined,
    threadId: c.req.query("threadId") || undefined,
    taskId: c.req.query("taskId") || undefined,
    limit: Number(c.req.query("limit") || "100"),
  });
  return json({
    files: rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      kind: r.kind,
      source: r.source,
      threadId: r.thread_id,
      taskId: r.task_id,
      createdAt: r.created_at,
      available: r.size_bytes !== null,
    })),
  });
});

coreApiApp.post("/api/files/upload/init", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{ filename?: string; mimeType?: string; threadId?: string; taskId?: string; source?: string }>(c.req.raw);
  const { initUpload } = await import("../files/service");
  const result = await initUpload(c.env, {
    workspaceId: session.workspaceId,
    filename: String(body.filename ?? ""),
    mimeType: body.mimeType ? String(body.mimeType) : undefined,
    threadId: body.threadId ? String(body.threadId) : undefined,
    taskId: body.taskId ? String(body.taskId) : undefined,
    source: body.source ? String(body.source) : undefined,
  });
  if (!result.ok) return json({ error: result.error }, 400);
  return json({
    artifactId: result.artifact.id,
    uploadUrl: `/api/files/${result.artifact.id}/content`,
  }, 201);
});

coreApiApp.put("/api/files/:id/content", async (c) => {
  const session = c.get("session") as SessionInfo;
  const artifactId = c.req.param("id");
  if (!/^[A-Za-z0-9_-]+$/.test(artifactId)) return json({ error: "not_found" }, 404);
  const { putContent } = await import("../files/service");
  const body = await c.req.arrayBuffer();
  const result = await putContent(c.env, {
    workspaceId: session.workspaceId,
    artifactId,
    body,
    contentType: c.req.header("content-type") || undefined,
  });
  if (!result.ok) return json({ error: result.error }, result.status ?? 400);
  return json({ ok: true });
});

coreApiApp.post("/api/files/upload/complete", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{ artifactId?: string }>(c.req.raw);
  const artifactId = String(body.artifactId ?? "");
  if (!/^[A-Za-z0-9_-]+$/.test(artifactId)) return json({ error: "not_found" }, 404);
  const { completeUpload } = await import("../files/service");
  const result = await completeUpload(c.env, { workspaceId: session.workspaceId, artifactId });
  if (!result.ok) return json({ error: result.error }, result.status ?? 400);
  return json({ ok: true, artifactId: result.artifact.id, sizeBytes: result.artifact.size_bytes });
});

coreApiApp.get("/api/files/:id", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { getArtifact } = await import("../files/service");
  const row = await getArtifact(c.env, session.workspaceId, c.req.param("id"));
  if (!row || row.deleted_at) return json({ error: "not_found" }, 404);
  return json({
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    kind: row.kind,
    source: row.source,
    threadId: row.thread_id,
    taskId: row.task_id,
    createdAt: row.created_at,
    available: row.size_bytes !== null,
  });
});

coreApiApp.get("/api/files/:id/content", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { readContent } = await import("../files/service");
  const result = await readContent(c.env, session.workspaceId, c.req.param("id"));
  if (!result.ok) return json({ error: result.error }, result.status ?? 400);
  return new Response(result.body.body, {
    headers: {
      "content-type": result.row.mime_type || "application/octet-stream",
      "content-disposition": `inline; filename="${result.row.filename.replace(/["\\]/g, "")}"`,
      "cache-control": "private, no-store",
    },
  });
});

coreApiApp.delete("/api/files/:id", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { deleteArtifact } = await import("../files/service");
  const result = await deleteArtifact(c.env, session.workspaceId, c.req.param("id"));
  if (!result.ok) return json({ error: result.error }, result.status ?? 404);
  return json({ ok: true });
});

// PDF / Documents inspection & form filling (§15.5, §15.6)
coreApiApp.get("/api/files/:id/inspect", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { readContent } = await import("../files/service");
  const { inspectPdfBytes } = await import("../files/pdf");
  const result = await readContent(c.env, session.workspaceId, c.req.param("id"));
  if (!result.ok) return json({ error: result.error }, result.status ?? 404);
  const bytes = new Uint8Array(await result.body.arrayBuffer());
  const inspection = inspectPdfBytes(bytes);
  return json(inspection);
});

coreApiApp.post("/api/files/:id/fill-form", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { fillPdfAcroForm } = await import("../files/pdf");
  const body = (await c.req.json().catch(() => ({}))) as { fieldValues?: Record<string, string>; outputFilename?: string };
  if (!body.fieldValues || typeof body.fieldValues !== "object") {
    return json({ error: "field_values_required" }, 400);
  }
  const result = await fillPdfAcroForm(c.env, {
    workspaceId: session.workspaceId,
    sourceArtifactId: c.req.param("id"),
    fieldValues: body.fieldValues,
    outputFilename: body.outputFilename,
  });
  if (!result.ok) return json({ error: result.error }, 400);
  return json({ ok: true, artifact: result.newArtifact });
});

// Goals & Milestones (§16, §25.8)
coreApiApp.get("/api/goals", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { GoalsService } = await import("../agent/goals-service");
  const svc = new GoalsService(c.env);
  const goals = await svc.listGoals(session.workspaceId);
  return json({ goals });
});

coreApiApp.post("/api/goals", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { GoalsService } = await import("../agent/goals-service");
  const svc = new GoalsService(c.env);
  const body = (await c.req.json().catch(() => ({}))) as any;
  const result = await svc.createOrConfirmGoal(session.workspaceId, {
    proposalId: body.proposalId,
    threadId: body.threadId,
    title: body.title,
    target: body.target,
    milestones: body.milestones,
    linkedWorkstreamId: body.linkedWorkstreamId,
  });
  if (!result.ok) return json({ error: result.error }, 400);
  return json(result);
});

coreApiApp.post("/api/goals/confirm", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { GoalsService } = await import("../agent/goals-service");
  const svc = new GoalsService(c.env);
  const body = (await c.req.json().catch(() => ({}))) as any;
  const result = await svc.createOrConfirmGoal(session.workspaceId, body);
  if (!result.ok) return json({ error: result.error }, 400);
  return json(result);
});

coreApiApp.patch("/api/goals/:id", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { GoalsService } = await import("../agent/goals-service");
  const svc = new GoalsService(c.env);
  const body = (await c.req.json().catch(() => ({}))) as any;
  if (!body.status) return json({ error: "status_required" }, 400);
  const ok = await svc.updateGoalStatus(session.workspaceId, c.req.param("id"), body.status);
  if (!ok) return json({ error: "goal_not_found" }, 404);
  return json({ ok: true });
});

// Ideas (§17, §25.8)
coreApiApp.get("/api/ideas", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { GoalsService } = await import("../agent/goals-service");
  const svc = new GoalsService(c.env);
  const ideas = await svc.listIdeas(session.workspaceId);
  return json({ ideas });
});

coreApiApp.post("/api/ideas/:id/accept", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { GoalsService } = await import("../agent/goals-service");
  const svc = new GoalsService(c.env);
  const body = (await c.req.json().catch(() => ({}))) as any;
  const ok = await svc.resolveIdea(session.workspaceId, c.req.param("id"), "accepted", body.acceptedTaskId);
  if (!ok) return json({ error: "idea_not_found" }, 404);
  return json({ ok: true });
});

coreApiApp.post("/api/ideas/:id/dismiss", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { GoalsService } = await import("../agent/goals-service");
  const svc = new GoalsService(c.env);
  const ok = await svc.resolveIdea(session.workspaceId, c.req.param("id"), "dismissed");
  if (!ok) return json({ error: "idea_not_found" }, 404);
  return json({ ok: true });
});

// Personal Context (§18)
coreApiApp.get("/api/context", async (c) => {
  const session = c.get("session") as SessionInfo;
  const agentStub = c.env.AGENT.get(c.env.AGENT.idFromName(session.workspaceId));
  const res = await agentStub.fetch("https://agent/summarize", {
    headers: { "x-partykit-room": session.workspaceId },
  }).catch(() => null);
  const summary = (res && res.ok ? await res.json().catch(() => ({})) : {}) as Record<string, unknown>;
  return json({
    workspaceId: session.workspaceId,
    personality: {
      name: "MuseInst",
      tone: "professional",
      wordmark: "O",
    },
    ...(summary && typeof summary === "object" ? summary : {}),
  });
});

// Browser Live View & Access routes (§14.13)
coreApiApp.all("/b/*", async (c) => {
  const { handleBrowserRoute } = await import("../browser/routes");
  const res = await handleBrowserRoute(c.req.raw, c.env);
  return res ?? c.notFound();
});
coreApiApp.all("/browser/*", async (c) => {
  const { handleBrowserRoute } = await import("../browser/routes");
  const res = await handleBrowserRoute(c.req.raw, c.env);
  return res ?? c.notFound();
});
coreApiApp.all("/api/browser/*", async (c) => {
  const { handleBrowserRoute } = await import("../browser/routes");
  const res = await handleBrowserRoute(c.req.raw, c.env);
  return res ?? c.notFound();
});

coreApiApp.get("/api/recipes", async (c) => {
  const session = c.get("session") as SessionInfo;
  return json({ recipes: await tasksMod.listRecipes(c.env, session.workspaceId) });
});

coreApiApp.get("/api/recipe/:slug", async (c) => {
  const session = c.get("session") as SessionInfo;
  const r = await tasksMod.getRecipe(c.env, session.workspaceId, c.req.param("slug"));
  if (!r) return json({ error: "not_found" }, 404);
  return json(r);
});

coreApiApp.get("/api/me", async (c) => {
  const session = c.get("session") as SessionInfo;
  const user = await c.env.DB.prepare(
    `SELECT id, display_name, created_at FROM users WHERE id=?`,
  ).bind(session.userId).first<{ id: string; display_name: string; created_at: number }>();
  const bindings = await listBindings(c.env, session.workspaceId);
  const [telegram, wechat, username] = await Promise.all([
    telegramConfigured(c.env),
    wechatConfigured(c.env),
    getTelegramUsername(c.env),
  ]);
  const connections = await c.env.DB.prepare(
    `SELECT provider, account_label, expires_at, scopes FROM connections WHERE workspace_id=?`,
  ).bind(session.workspaceId).all<{
    provider: string;
    account_label: string;
    expires_at: number | null;
    scopes: string;
  }>();
  const googleToken = await getGoogleToken(c.env, session.workspaceId).catch(() => null);
  const googleEmail = googleToken
    ? (await gmailProfile(googleToken).catch(() => null))?.emailAddress ?? null
    : null;
  const vaultCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM vault_items WHERE workspace_id=?`,
  ).bind(session.workspaceId).first<{ c: number }>();
  const bindCode = await createBindCode(c.env, session.workspaceId, session.userId);

  return json({
    userId: session.userId,
    workspaceId: session.workspaceId,
    displayName: user?.display_name ?? "",
    createdAt: user?.created_at,
    bindings,
    channels: {
      telegram: { configured: telegram, username },
      wechat: { configured: wechat },
    },
    connections: connections.results ?? [],
    googleEmail,
    vaultCount: vaultCount?.c ?? 0,
    bindCode,
    connectorsAvailable: {
      google: googleConfigured(c.env),
      feishu: isLarkFeishuConfigured(c.env, "feishu"),
      lark: isLarkFeishuConfigured(c.env, "lark"),
      github: githubConfigured(c.env),
    },
  });
});

coreApiApp.delete("/api/me", async (c) => {
  const session = c.get("session") as SessionInfo;
  if (c.req.query("confirm") !== "DELETE") return json({ error: "confirm_required" }, 400);
  const hooks = getHostHooks();
  const context = { workspaceId: session.workspaceId, userId: session.userId };
  try {
    await hooks.beforeAccountDelete?.(c.env, context);
    const { wipeWorkspaceArtifacts, wipeWorkspaceDurableState, wipeWorkspaceStatements } = await import("../wipe");
    await wipeWorkspaceArtifacts(c.env, session.workspaceId);
    await wipeWorkspaceDurableState(c.env, session.workspaceId);

    const { agentFetch } = await import("../agent/rpc");
    const agentResponse = await agentFetch(c.env.AGENT, session.workspaceId, "/wipe", { method: "POST" });
    if (!agentResponse.ok) throw new Error(`agent_wipe_http_${agentResponse.status}`);

    await hooks.onAccountDelete?.(c.env, context);
    await c.env.DB.batch(wipeWorkspaceStatements(c.env, session.workspaceId, session.userId));
  } catch (error) {
    console.error("[account-delete] incomplete; retry is required", String(error));
    return json({ error: "account_delete_incomplete", retryable: true }, 503);
  }
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearSessionHeader() },
  });
});

coreApiApp.post("/api/receipts/:slug/visibility", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{ public?: boolean }>(c.req.raw);
  const slug = c.req.param("slug");
  const result = await c.env.DB.prepare(
    `UPDATE task_receipts SET public=? WHERE share_slug=? AND task_id IN (SELECT id FROM tasks WHERE workspace_id=?)`,
  ).bind(body.public ? 1 : 0, slug, session.workspaceId).run();
  if ((result.meta?.changes ?? 0) !== 1) return json({ error: "not_found" }, 404);
  if (!body.public) await c.env.ARTIFACTS.delete(`receipts/${slug}.jpg`).catch(() => {});
  return json({ ok: true, public: Boolean(body.public) });
});

coreApiApp.get("/api/vault/items", async (c) => {
  const session = c.get("session") as SessionInfo;
  return json({ items: await vault.listItems(c.env, session.workspaceId) });
});

coreApiApp.post("/api/vault/items", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{
    kind?: string;
    label?: string;
    account?: string;
    origin?: string;
    fields?: Record<string, string>;
  }>(c.req.raw);
  if (!body.kind || !body.label) return json({ error: "kind_and_label_required" }, 400);
  const item = await vault.putItem(c.env, session.workspaceId, {
    kind: body.kind as vault.VaultKind,
    label: body.label,
    account: body.account ?? "",
    origin: vault.validateLoginOrigin(body.origin),
    fields: body.fields ?? {},
  });
  return json({ ok: true, item });
});

coreApiApp.delete("/api/vault/items/:id", async (c) => {
  const session = c.get("session") as SessionInfo;
  await vault.deleteItem(c.env, session.workspaceId, c.req.param("id"));
  return json({ ok: true });
});

coreApiApp.post("/api/vault/import-csv", async (c) => {
  const session = c.get("session") as SessionInfo;
  const contentType = c.req.header("content-type") || "";
  let csvText = "";
  if (
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    const formData = await c.req.formData();
    const file = formData.get("file");
    csvText = file && typeof file === "object" && "text" in file
      ? await (file as File).text()
      : String(formData.get("csv") || "");
  } else {
    csvText = (await readJson<{ csv?: string }>(c.req.raw)).csv || "";
  }
  if (!csvText.trim()) return json({ error: "csv_required" }, 400);
  const result = await vault.importChromePasswords(c.env, session.workspaceId, csvText);
  return json({ ok: true, ...result });
});

coreApiApp.get("/api/tasks", async (c) => {
  const session = c.get("session") as SessionInfo;
  const cutoffHook = getHostHooks().taskHistoryCutoff;
  const cutoff = cutoffHook
    ? await cutoffHook(c.env, { workspaceId: session.workspaceId })
    : 0;
  const { results } = await c.env.DB.prepare(
    `SELECT id, class, title, status, channel, thread_id, started_at, completed_at, trace_id
       FROM tasks WHERE workspace_id=? AND started_at>=?
       ORDER BY started_at DESC LIMIT 50`,
  ).bind(session.workspaceId, cutoff).all();
  return json({ tasks: results ?? [] });
});

coreApiApp.get("/api/tasks/:id", async (c) => {
  const session = c.get("session") as SessionInfo;
  const task = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE id=? AND workspace_id=?`,
  ).bind(c.req.param("id"), session.workspaceId).first();
  if (!task) return json({ error: "not_found" }, 404);
  const [steps, evidence, receipt] = await Promise.all([
    c.env.DB.prepare(
      `SELECT seq, desc, ts FROM task_steps WHERE task_id=? ORDER BY seq`,
    ).bind((task as any).id).all(),
    c.env.DB.prepare(
      `SELECT type, value FROM task_evidence WHERE task_id=?`,
    ).bind((task as any).id).all(),
    c.env.DB.prepare(
      `SELECT share_slug, public FROM task_receipts WHERE task_id=?`,
    ).bind((task as any).id).first(),
  ]);
  // Typed waiting state (spec §11.2/§25.3): surface the agent's own pending
  // row rather than inferring from message text.
  const pending = await c.env.DB.prepare(
    `SELECT kind, wait_reason, status FROM pending_tasks WHERE task_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1`,
  ).bind((task as any).id).first<{ kind: string; wait_reason: string; status: string }>().catch(() => null);
  const waiting = pending ? { kind: pending.kind, reason: pending.wait_reason } : null;
  return json({ task, steps: steps.results ?? [], evidence: evidence.results ?? [], receipt, waiting });
});

// Pending approvals for the workspace (Round 1 DEFECT-028: approval rows were
// persisted but no read API surfaced them, so Web users never saw the pending
// action or its approve/deny controls).
coreApiApp.get("/api/approvals", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { results } = await c.env.DB.prepare(
    `SELECT id, task_id, tool_name, payload_json, channel, decision, created_at
       FROM approvals WHERE workspace_id=? AND decision IS NULL
       ORDER BY created_at DESC LIMIT 20`,
  ).bind(session.workspaceId).all().catch(() => ({ results: [] as unknown[] }));
  return json({ approvals: results ?? [] });
});

// Task controls (spec §25.3): each call carries the object id and is
// re-authorized against the workspace by the auth middleware; the DO re-checks
// the authoritative state before acting.
for (const action of ["cancel", "pause", "resume"] as const) {
  coreApiApp.post(`/api/tasks/:id/${action}`, async (c) => {
    const session = c.get("session") as SessionInfo;
    const taskId = c.req.param("id");
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return json({ error: "not_found" }, 404);
    const owned = await c.env.DB.prepare(`SELECT id FROM tasks WHERE id=? AND workspace_id=?`)
      .bind(taskId, session.workspaceId).first();
    if (!owned) return json({ error: "not_found" }, 404);
    const { agentFetch } = await import("../agent/rpc");
    const res = await agentFetch(c.env.AGENT, session.workspaceId, `/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST" });
    return json(await res.json(), res.status as 200);
  });
}

coreApiApp.get("/api/usage", async (c) => {
  const session = c.get("session") as SessionInfo;
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const { results } = await c.env.DB.prepare(
    `SELECT day, tokens_in, tokens_out, browser_ms, tasks_ok, tasks_fail
       FROM usage_daily WHERE workspace_id=? AND day LIKE ? ORDER BY day`,
  ).bind(session.workspaceId, `${monthPrefix}%`).all<{
    day: string;
    tokens_in: number;
    tokens_out: number;
    browser_ms: number;
    tasks_ok: number;
    tasks_fail: number;
  }>();
  const rows = results ?? [];
  const totals = rows.reduce(
    (acc, row) => ({
      tokensIn: acc.tokensIn + (row.tokens_in ?? 0),
      tokensOut: acc.tokensOut + (row.tokens_out ?? 0),
      browserMs: acc.browserMs + (row.browser_ms ?? 0),
      tasksOk: acc.tasksOk + (row.tasks_ok ?? 0),
      tasksFail: acc.tasksFail + (row.tasks_fail ?? 0),
    }),
    { tokensIn: 0, tokensOut: 0, browserMs: 0, tasksOk: 0, tasksFail: 0 },
  );
  const current = await getWorkspaceModelConfig(c.env, session.workspaceId);
  return json({
    month: monthPrefix,
    days: rows.map((row) => ({
      day: row.day,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      browserMs: row.browser_ms,
    })),
    totals: {
      ...totals,
      totalTokens: totals.tokensIn + totals.tokensOut,
      totalTasks: totals.tasksOk + totals.tasksFail,
    },
    currentModel: {
      name: current.name || current.model,
      id: current.model,
      provider: current.provider,
      maxContext: current.maxContext,
      status: "active",
    },
    model: { root: current.model, provider: current.provider },
  });
});

coreApiApp.post("/api/privacy/delete", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{
    mode?: "disconnect_only" | "disconnect_and_delete";
    provider?: string;
  }>(c.req.raw);
  if (body.mode === "disconnect_only") {
    if (body.provider) {
      const { disconnectProviderStatements } = await import("../wipe");
      await c.env.DB.batch(
        disconnectProviderStatements(c.env, session.workspaceId, body.provider),
      );
    }
    return json({ ok: true, deleted: false });
  }
  if (body.mode === "disconnect_and_delete") {
    const ws = session.workspaceId;
    const slugs = await c.env.DB.prepare(
      `SELECT tr.share_slug FROM task_receipts tr JOIN tasks t ON t.id=tr.task_id WHERE t.workspace_id=? AND tr.share_slug IS NOT NULL`,
    ).bind(ws).all<{ share_slug: string }>();
    for (const row of slugs.results ?? []) {
      if (row.share_slug) await c.env.ARTIFACTS.delete(`receipts/${row.share_slug}.jpg`);
    }
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM connections WHERE workspace_id=?`).bind(ws),
      c.env.DB.prepare(`DELETE FROM vault_items WHERE workspace_id=?`).bind(ws),
      c.env.DB.prepare(`DELETE FROM encrypted_secrets WHERE workspace_id=?`).bind(ws),
      c.env.DB.prepare(
        `DELETE FROM task_receipts WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=?)`,
      ).bind(ws),
      c.env.DB.prepare(
        `DELETE FROM task_evidence WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=?)`,
      ).bind(ws),
      c.env.DB.prepare(
        `DELETE FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=?)`,
      ).bind(ws),
      c.env.DB.prepare(`DELETE FROM tasks WHERE workspace_id=?`).bind(ws),
      c.env.DB.prepare(`DELETE FROM oauth_states WHERE workspace_id=?`).bind(ws),
      c.env.DB.prepare(`DELETE FROM wechat_outbox WHERE workspace_id=? OR workspace_id=''`).bind(ws),
    ]);
    return json({ ok: true, deleted: true });
  }
  return json({ error: "mode_required" }, 400);
});

coreApiApp.get("/api/agent/summary", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { agentFetch } = await import("../agent/rpc");
  const response = await agentFetch(c.env.AGENT, session.workspaceId, "/summarize");
  return json(await response.json());
});

coreApiApp.delete("/api/privacy/memory", async (c) => {
  const session = c.get("session") as SessionInfo;
  const { agentFetch } = await import("../agent/rpc");
  await agentFetch(c.env.AGENT, session.workspaceId, "/memory", { method: "DELETE" });
  return json({ ok: true });
});

coreApiApp.get("/api/connectors", async (c) => {
  const session = c.get("session") as SessionInfo;
  const [connections, mailboxes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT provider, account_label, expires_at FROM connections WHERE workspace_id=?`,
    ).bind(session.workspaceId).all(),
    c.env.DB.prepare(
      `SELECT id, label, account FROM vault_items WHERE workspace_id=? AND kind='token'`,
    ).bind(session.workspaceId).all(),
  ]);
  return json({
    connections: connections.results ?? [],
    mailboxes: mailboxes.results ?? [],
    presets: PRESETS,
  });
});

coreApiApp.post("/api/connectors/mailbox", async (c) => {
  const session = c.get("session") as SessionInfo;
  if (!(await canAddConnector(c.env, session.workspaceId))) {
    return json({ error: "connectors_limit_reached" }, 403);
  }
  const body = await readJson<{ provider?: string; email?: string; authCode?: string }>(c.req.raw);
  const provider = (body.provider ?? "qq").toLowerCase();
  const preset = PRESETS[provider];
  if (!preset || !body.email || !body.authCode) {
    return json({ error: "provider_email_authcode_required" }, 400);
  }
  const { imapList } = await import("../imap/imap");
  try {
    await imapList(
      { host: preset.host, port: 993, user: body.email, pass: body.authCode, sendId: preset.sendId },
      "ALL",
      1,
    );
  } catch (error) {
    return json({ error: `auth_failed: ${String(error).slice(0, 120)}` }, 400);
  }
  await vault.putItem(c.env, session.workspaceId, {
    kind: "token",
    label: provider,
    account: body.email,
    origin: `imap://${preset.host}`,
    fields: { account: body.email, authCode: body.authCode, provider },
  });
  return json({ ok: true, provider });
});

coreApiApp.get("/api/connectors/google/start", async (c) => {
  const session = c.get("session") as SessionInfo;
  if (!(await canAddConnector(c.env, session.workspaceId))) {
    return json({ error: "connectors_limit_reached" }, 403);
  }
  if (!googleConfigured(c.env)) return json({ error: "google_not_configured" }, 400);
  const state = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO oauth_states (state, workspace_id, provider, created_at) VALUES (?, ?, 'google', ?)`,
  ).bind(state, session.workspaceId, now()).run();
  return c.redirect(
    googleAuthorizeUrl(c.env, `${connectorRedirectBase(c.env)}/api/connectors/google/callback`, state),
  );
});

coreApiApp.get("/api/connectors/google/callback", async (c) => {
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (!code || !state) return c.redirect("/workspace?connect=google_failed");
  const consumed = await consumeOAuthState(c.env, state, "google");
  if (!consumed) return c.redirect("/workspace?connect=google_failed");
  const tokens = await googleExchangeCode(
    c.env,
    code,
    `${connectorRedirectBase(c.env)}/api/connectors/google/callback`,
  );
  if ("error" in tokens) return c.redirect("/workspace?connect=google_failed");
  const profile = await gmailProfile(tokens.accessToken).catch(() => null);
  await googleStoreConnection(c.env, consumed.workspace_id, profile?.emailAddress ?? "", tokens);

  const binding = (await listBindings(c.env, consumed.workspace_id)).find(
    (item) => item.channel !== "web",
  );
  if (binding) {
    const { agentFetch } = await import("../agent/rpc");
    await agentFetch(c.env.AGENT, consumed.workspace_id, "/schedule-reauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        channel: binding.channel,
        externalId: binding.external_id,
        at: now() + 6 * 24 * 3600 * 1000,
      }),
    }).catch(() => {});
  }
  return c.redirect("/workspace?connect=google_ok");
});

coreApiApp.get("/api/connectors/feishu/start", (c) => startLarkFeishu(c, "feishu"));
coreApiApp.get("/api/connectors/feishu/callback", (c) => finishLarkFeishu(c, "feishu"));
coreApiApp.get("/api/connectors/lark/start", (c) => startLarkFeishu(c, "lark"));
coreApiApp.get("/api/connectors/lark/callback", (c) => finishLarkFeishu(c, "lark"));

coreApiApp.get("/api/connectors/github/start", async (c) => {
  const session = c.get("session") as SessionInfo;
  if (!(await canAddConnector(c.env, session.workspaceId))) {
    return json({ error: "connectors_limit_reached" }, 403);
  }
  if (!githubConfigured(c.env)) return json({ error: "github_not_configured" }, 400);
  const state = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO oauth_states (state, workspace_id, provider, created_at) VALUES (?, ?, 'github', ?)`,
  ).bind(state, session.workspaceId, now()).run();
  return c.redirect(
    githubAuthorizeUrl(c.env, `${connectorRedirectBase(c.env)}/api/connectors/github/callback`, state),
  );
});

coreApiApp.get("/api/connectors/github/callback", async (c) => {
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (!code || !state) return c.redirect("/workspace?connect=github_failed");
  const consumed = await consumeOAuthState(c.env, state, "github");
  if (!consumed) return c.redirect("/workspace?connect=github_failed");
  const token = await githubExchangeCode(c.env, code);
  if ("error" in token) return c.redirect("/workspace?connect=github_failed");
  const me = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.accessToken}`,
      "user-agent": "openinst",
    },
  }).then((response) => response.json()).catch(() => null) as any;
  if (!me?.login) return c.redirect("/workspace?connect=github_failed");
  await githubStoreConnection(c.env, consumed.workspace_id, token.accessToken, me.login);
  return c.redirect("/workspace?connect=github_ok");
});

coreApiApp.delete("/api/connectors/:provider", async (c) => {
  const session = c.get("session") as SessionInfo;
  const provider = c.req.param("provider");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM connections WHERE workspace_id=? AND provider=?`,
    ).bind(session.workspaceId, provider),
    c.env.DB.prepare(
      `DELETE FROM connector_slots WHERE workspace_id=? AND slot_key LIKE ?`,
    ).bind(session.workspaceId, `oauth:${provider}:%`),
  ]);
  return json({ ok: true });
});

coreApiApp.post("/api/connectors/linear", async (c) => {
  const session = c.get("session") as SessionInfo;
  if (!(await canAddConnector(c.env, session.workspaceId))) {
    return json({ error: "connectors_limit_reached" }, 403);
  }
  const body = await readJson<{ apiKey?: string }>(c.req.raw);
  if (!body.apiKey) return json({ error: "api_key_required" }, 400);
  const result = await linearStore(c.env, session.workspaceId, body.apiKey);
  return "error" in result ? json({ error: result.error }, 400) : json(result);
});

coreApiApp.post("/api/connectors/slack", async (c) => {
  const session = c.get("session") as SessionInfo;
  if (!(await canAddConnector(c.env, session.workspaceId))) {
    return json({ error: "connectors_limit_reached" }, 403);
  }
  const body = await readJson<{ token?: string }>(c.req.raw);
  if (!body.token) return json({ error: "token_required" }, 400);
  const result = await slackStore(c.env, session.workspaceId, body.token);
  return "error" in result ? json({ error: result.error }, 400) : json(result);
});

coreApiApp.get("/api/settings", async (c) => {
  const session = c.get("session") as SessionInfo;
  const rows = await c.env.DB.prepare(
    `SELECT key, value FROM settings WHERE workspace_id=? AND key IN ('appearance','improve_optin')`,
  ).bind(session.workspaceId).all<{ key: string; value: string }>();
  const settings = Object.fromEntries((rows.results ?? []).map((row) => [row.key, row.value]));
  const user = await c.env.DB.prepare(
    `SELECT display_name FROM users WHERE id=?`,
  ).bind(session.userId).first<{ display_name: string | null }>();
  const bindings = await listBindings(c.env, session.workspaceId);
  return json({
    displayName: user?.display_name ?? "",
    appearance: settings.appearance ?? "system",
    improveOptin: settings.improve_optin === "1",
    signInMethods: bindings.map((binding) => ({
      channel: binding.channel,
      displayName: binding.display_name,
    })),
  });
});

coreApiApp.patch("/api/settings", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{
    displayName?: string;
    appearance?: string;
    improveOptin?: boolean;
  }>(c.req.raw);
  if (typeof body.displayName === "string") {
    await c.env.DB.prepare(
      `UPDATE users SET display_name=? WHERE id=?`,
    ).bind(body.displayName.trim().slice(0, 40), session.userId).run();
  }
  if (body.appearance && ["light", "dark", "system"].includes(body.appearance)) {
    await c.env.DB.prepare(
      `INSERT INTO settings (workspace_id, key, value) VALUES (?, 'appearance', ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value`,
    ).bind(session.workspaceId, body.appearance).run();
  }
  if (typeof body.improveOptin === "boolean") {
    await c.env.DB.prepare(
      `INSERT INTO settings (workspace_id, key, value) VALUES (?, 'improve_optin', ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value`,
    ).bind(session.workspaceId, body.improveOptin ? "1" : "0").run();
  }
  return json({ ok: true });
});

coreApiApp.get("/api/model/presets", async () => json({ presets: CLOUDFLARE_PRESETS }));

coreApiApp.get("/api/model/config", async (c) => {
  const session = c.get("session") as SessionInfo;
  const config = await getWorkspaceModelConfig(c.env, session.workspaceId);
  const apiKey = config.apiKey
    ? config.apiKey.length > 8
      ? `${config.apiKey.slice(0, 3)}••••••••${config.apiKey.slice(-4)}`
      : "••••••••"
    : "";
  return json({
    config: { ...config, apiKey, hasApiKey: Boolean(config.apiKey) },
    presets: CLOUDFLARE_PRESETS,
  });
});

coreApiApp.post("/api/model/config", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<Partial<CustomModelConfig>>(c.req.raw);
  if (!body?.provider || !["workers-ai", "custom"].includes(body.provider)) {
    return json({ error: "invalid_provider" }, 400);
  }
  const existing = await getWorkspaceModelConfig(c.env, session.workspaceId);
  const limitsMode = body.limitsMode === "manual" ? "manual" : "auto";
  const manualLimits = limitsMode === "manual"
    ? {
        maxContext: Number(body.maxContext) > 0 ? Number(body.maxContext) : undefined,
        maxTokens: Number(body.maxTokens) > 0 ? Number(body.maxTokens) : undefined,
      }
    : {};

  let next: CustomModelConfig;
  if (body.provider === "workers-ai") {
    const model = body.model?.trim() || c.env.MODEL_ROOT || "@cf/zai-org/glm-5.3-flash";
    const preset = CLOUDFLARE_PRESETS.find((item) => item.id === model);
    next = {
      provider: "workers-ai",
      model,
      name: body.name?.trim() || preset?.name || model,
      limitsMode,
      ...manualLimits,
      enableTools: body.enableTools !== false,
    };
  } else {
    if (!body.model?.trim()) return json({ error: "model_required" }, 400);
    if (!body.baseUrl?.trim()) return json({ error: "base_url_required" }, 400);
    let apiKey = body.apiKey?.trim();
    if (!apiKey || apiKey.includes("••••")) apiKey = existing.apiKey || "";
    next = {
      provider: "custom",
      model: body.model.trim(),
      name: body.name?.trim() || body.model.trim(),
      baseUrl: body.baseUrl.trim(),
      apiKey,
      protocol: body.protocol === "anthropic" ? "anthropic" : "chat_completions",
      limitsMode,
      ...manualLimits,
      enableTools: body.enableTools !== false,
    };
  }

  await saveWorkspaceModelConfig(c.env, session.workspaceId, next);
  const masked = next.apiKey
    ? next.apiKey.length > 8
      ? `${next.apiKey.slice(0, 3)}••••••••${next.apiKey.slice(-4)}`
      : "••••••••"
    : "";
  return json({
    ok: true,
    config: { ...next, apiKey: masked, hasApiKey: Boolean(next.apiKey) },
  });
});

coreApiApp.post("/api/model/test", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<Partial<CustomModelConfig>>(c.req.raw);
  if (!body?.model?.trim()) return json({ ok: false, error: "请填写模型名称 / ID" }, 400);
  let apiKey = body.apiKey?.trim();
  if (body.provider === "custom") {
    if (!body.baseUrl?.trim()) return json({ ok: false, error: "请填写 Base URL" }, 400);
    if (!apiKey || apiKey.includes("••••")) {
      apiKey = (await getWorkspaceModelConfig(c.env, session.workspaceId)).apiKey || "";
    }
  }
  return json(await testModelConnection({
    provider: body.provider === "custom" ? "custom" : "workers-ai",
    model: body.model.trim(),
    baseUrl: body.baseUrl?.trim(),
    apiKey,
    protocol: body.protocol === "anthropic" ? "anthropic" : "chat_completions",
    limitsMode: "auto",
  }));
});

coreApiApp.post("/api/session/logout", async (c) => {
  const session = await readSession(c.env, c.req.raw);
  if (session) {
    const match = (c.req.header("cookie") ?? "").match(/(?:^|;\s*)oi=([a-f0-9]+)\./);
    if (match) {
      await c.env.DB.prepare(`DELETE FROM sessions WHERE id=?`).bind(match[1]).run().catch(() => {});
    }
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json",
      "set-cookie": clearSessionHeader(),
    },
  });
});

coreApiApp.post("/api/locations", async (c) => {
  const session = c.get("session") as SessionInfo;
  const body = await readJson<{ lat?: number; lng?: number; accuracy?: number }>(c.req.raw);
  if (typeof body.lat !== "number" || typeof body.lng !== "number") {
    return json({ error: "lat_lng_required" }, 400);
  }
  const result = await ingestLocation(c.env, session.workspaceId, {
    source: "web",
    lat: body.lat,
    lng: body.lng,
    accuracy: body.accuracy,
  });
  return result.ok
    ? json({ ok: true, firedTriggers: result.firedTriggers })
    : json({ error: "invalid_coords" }, 400);
});

coreApiApp.get("/api/locations", async (c) => {
  const session = c.get("session") as SessionInfo;
  const last = await lastKnown(c.env, session.workspaceId);
  if (!last) return json({ hasLocation: false });
  const place = await import("../location").then((module) =>
    module.reverseGeocode(last.lat, last.lng).catch(() => ""),
  );
  const points = await recentPoints(c.env, session.workspaceId, now() - 24 * 3600_000);
  const visits = await labelVisits(c.env, session.workspaceId, computeVisits(points));
  return json({
    hasLocation: true,
    last: {
      lat: last.lat,
      lng: last.lng,
      source: last.source,
      live: last.live === 1,
      ageMinutes: Math.round((now() - last.created_at) / 60_000),
      place,
    },
    visits24h: visits.length,
    points24h: points.length,
  });
});
