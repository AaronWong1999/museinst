//
// Browser Public & Access Routes (§14.12, §14.13, §14.14, §14.19).
//

import type { Env } from "../env";
import { readSession } from "../session";
import { agentFetch } from "../agent/rpc";
import { BrowserService } from "./service";
import { sha256Hex, type BrowserAccessGrantRow } from "./grants";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
};

const TERMINAL_GRANT_STATUSES = new Set(["revoked", "expired", "completed"]);

function grantIsActive(grant: BrowserAccessGrantRow): boolean {
  return !TERMINAL_GRANT_STATUSES.has(grant.status) && grant.expires_at > Date.now();
}

function browserControlCookie(req: Request): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const entry = part.trim();
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (name !== "__Secure-oi-browser-control" && name !== "oi-browser-control") continue;
    try {
      return decodeURIComponent(entry.slice(eq + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A browser-control request is authorized by either:
 *  1) a normal authenticated session in the same workspace, or
 *  2) the HttpOnly restricted bearer created by redeeming the one-time link.
 *
 * The restricted cookie contains grant id + the grant's high-entropy token hash.
 * It is never accepted as a general MuseInst login credential.
 */
async function authorizeGrant(req: Request, env: Env, grant: BrowserAccessGrantRow): Promise<boolean> {
  const session = await readSession(env, req).catch(() => null);
  if (session?.workspaceId === grant.workspace_id) return true;

  if (!grantIsActive(grant) || !grant.redeemed_at) return false;
  const proof = browserControlCookie(req);
  if (!proof) return false;
  const dot = proof.indexOf(".");
  if (dot <= 0) return false;
  const grantId = proof.slice(0, dot);
  const tokenHash = proof.slice(dot + 1);
  return grantId === grant.id && tokenHash === grant.token_hash;
}

function unauthorizedJson(): Response {
  return Response.json({ error: "browser_access_unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
}

function unauthorizedHtml(): Response {
  return new Response(renderErrorHtml("需要授权", "This browser session requires a valid MuseInst session or redeemed access link."), {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
  });
}

const STALE_ACTIVE_SESSION_MS = 20 * 60 * 1000;

export async function handleBrowserRoute(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const service = new BrowserService(env);

  // 1. GET /b/:token — Minimal interstitial preflight (never consumes grant)
  const bMatch = pathname.match(/^\/b\/([A-Za-z0-9_-]{16,128})$/);
  if (bMatch && req.method === "GET") {
    const rawToken = bMatch[1];
    const tokenHash = await sha256Hex(rawToken);
    const grant = await service.repository.findByTokenHash(tokenHash);

    if (!grant) {
      return new Response(renderErrorHtml("链接无效或已过期", "Invalid or expired link"), {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }
    if (!grantIsActive(grant)) {
      return new Response(renderErrorHtml("链接已失效", "Link has expired or was revoked"), {
        status: 410,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }

    const caps = await service.capabilities();
    if (grant.requested_mode === "interactive" && !caps.interactiveView) {
      return new Response(renderErrorHtml("安全接管暂不可用", "Interactive takeover is disabled until handoff revocation is proven."), {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }
    if (grant.requested_mode === "readonly" && !caps.readonlyView) {
      return new Response(renderErrorHtml("实时预览暂不可用", "Readonly browser live view is not configured."), {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }

    const nonce = crypto.randomUUID();
    return new Response(renderPreflightHtml(rawToken, nonce, grant.requested_mode), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
    });
  }

  // 2. POST /b/:token/redeem — Atomic CAS redemption & restricted cookie issuance
  const redeemMatch = pathname.match(/^\/b\/([A-Za-z0-9_-]{16,128})\/redeem$/);
  if (redeemMatch && req.method === "POST") {
    const rawToken = redeemMatch[1];
    const tokenHash = await sha256Hex(rawToken);
    const preGrant = await service.repository.findByTokenHash(tokenHash);
    if (!preGrant || !grantIsActive(preGrant)) {
      return new Response(renderErrorHtml("链接无效或已过期", "Link expired or invalid"), {
        status: preGrant ? 410 : 404,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }

    const caps = await service.capabilities();
    if ((preGrant.requested_mode === "interactive" && !caps.interactiveView) ||
        (preGrant.requested_mode === "readonly" && !caps.readonlyView)) {
      return new Response(renderErrorHtml("浏览器能力暂不可用", "The requested browser capability is unavailable and was not redeemed."), {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }

    let grant: BrowserAccessGrantRow;
    try {
      grant = await service.repository.redeemGrant(tokenHash);
    } catch (e: any) {
      const msg = e?.message || "redeem_failed";
      if (msg === "grant_already_redeemed") {
        return new Response(renderErrorHtml("链接已被使用", "Link has already been used"), {
          status: 409,
          headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
        });
      }
      return new Response(renderErrorHtml("链接无效或已过期", "Link expired or invalid"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }

    const cookieName = url.protocol === "https:" ? "__Secure-oi-browser-control" : "oi-browser-control";
    // token_hash is a SHA-256 of a cryptographically random one-time token. It
    // remains a high-entropy bearer proof while the raw token itself is never stored.
    const cookieVal = `${grant.id}.${grant.token_hash}`;
    const maxAge = Math.max(1, Math.min(1800, Math.floor((grant.expires_at - Date.now()) / 1000)));
    const cookieHeader = `${cookieName}=${encodeURIComponent(cookieVal)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === "https:" ? "; Secure" : ""}`;

    const wantsJson = (req.headers.get("accept") || "").includes("application/json");
    if (wantsJson) {
      return Response.json(
        { ok: true, grantId: grant.id, redirectUrl: `/browser/${grant.id}`, mode: grant.current_mode },
        { status: 200, headers: { "Set-Cookie": cookieHeader, ...NO_STORE_HEADERS } },
      );
    }

    return new Response(null, {
      status: 303,
      headers: { Location: `/browser/${grant.id}`, "Set-Cookie": cookieHeader, ...NO_STORE_HEADERS },
    });
  }

  // 3. GET /browser/:grantId — Browser shell page
  const browserShellMatch = pathname.match(/^\/browser\/(bg_[A-Za-z0-9]+)$/);
  if (browserShellMatch && req.method === "GET") {
    const grant = await service.repository.findById(browserShellMatch[1]);
    if (!grant) {
      return new Response(renderErrorHtml("未找到浏览器访问权限", "Browser access grant not found"), {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }
    if (!(await authorizeGrant(req, env, grant))) return unauthorizedHtml();
    if (!grantIsActive(grant)) {
      return new Response(renderErrorHtml("浏览器访问已结束", "This browser access grant is no longer active."), {
        status: 410,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }

    return new Response(renderBrowserShellHtml(grant, await service.capabilities()), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS },
    });
  }

  // 4. GET /api/browser/access/:grantId/status — Query status & JIT mint live view URL
  const statusMatch = pathname.match(/^\/api\/browser\/access\/(bg_[A-Za-z0-9]+)\/status$/);
  if (statusMatch && req.method === "GET") {
    const grant = await service.repository.findById(statusMatch[1]);
    if (!grant) return Response.json({ error: "grant_not_found" }, { status: 404, headers: NO_STORE_HEADERS });
    if (!(await authorizeGrant(req, env, grant))) return unauthorizedJson();
    if (!grantIsActive(grant)) {
      return Response.json({ error: "grant_inactive", status: grant.status }, { status: 410, headers: NO_STORE_HEADERS });
    }

    if (!(await service.isProviderSessionAlive(grant.browser_session_ref))) {
      await service.markSessionEnded(grant.workspace_id, grant.task_id);
      return Response.json({ error: "browser_session_ended", status: "completed" }, { status: 410, headers: NO_STORE_HEADERS });
    }

    let providerView = null;
    let providerError = null;
    try {
      providerView = await service.mintLiveView(grant);
    } catch (e: any) {
      providerError = e?.message || "live_view_unavailable";
    }

    return Response.json(
      {
        grantId: grant.id,
        taskId: grant.task_id,
        status: grant.status,
        currentMode: grant.current_mode,
        requestedMode: grant.requested_mode,
        controlEpoch: grant.control_epoch,
        expiresAt: grant.expires_at,
        providerView,
        providerError,
        capabilities: await service.capabilities(),
      },
      { headers: NO_STORE_HEADERS },
    );
  }

  // 5. POST /api/browser/access/:grantId/takeover — Human takeover (§14.8)
  const takeoverMatch = pathname.match(/^\/api\/browser\/access\/(bg_[A-Za-z0-9]+)\/takeover$/);
  if (takeoverMatch && req.method === "POST") {
    const grant = await service.repository.findById(takeoverMatch[1]);
    if (!grant) return Response.json({ error: "grant_not_found" }, { status: 404, headers: NO_STORE_HEADERS });
    if (!(await authorizeGrant(req, env, grant))) return unauthorizedJson();
    const body = (await req.json().catch(() => ({}))) as { deviceId?: string };
    try {
      const result = await service.takeover(grant.workspace_id, grant.id, body.deviceId);
      return Response.json(result, { headers: NO_STORE_HEADERS });
    } catch (e: any) {
      const error = e?.message || "takeover_failed";
      return Response.json({ error }, { status: error === "browser_takeover_unavailable" ? 503 : 400, headers: NO_STORE_HEADERS });
    }
  }

  // 6. POST /api/browser/access/:grantId/done — Human done (§14.4)
  const doneMatch = pathname.match(/^\/api\/browser\/access\/(bg_[A-Za-z0-9]+)\/done$/);
  if (doneMatch && req.method === "POST") {
    const grant = await service.repository.findById(doneMatch[1]);
    if (!grant) return Response.json({ error: "grant_not_found" }, { status: 404, headers: NO_STORE_HEADERS });
    if (!(await authorizeGrant(req, env, grant))) return unauthorizedJson();
    try {
      const result = await service.done(grant.workspace_id, grant.id);
      // Wake the parked agent turn so the task continues without the user
      // also having to type "done" in chat. Best-effort: the chat reply path
      // still resumes it if this fails.
      try {
        await agentFetch(env.AGENT, grant.workspace_id, "/browser/handoff-done", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId: grant.task_id }),
        });
      } catch (err) {
        console.warn("[browser] handoff-done notify failed", String(err).slice(0, 200));
      }
      return Response.json(result, { headers: NO_STORE_HEADERS });
    } catch (e: any) {
      const error = e?.message || "done_failed";
      return Response.json({ error }, { status: error === "browser_takeover_unavailable" ? 503 : 400, headers: NO_STORE_HEADERS });
    }
  }

  // 7. POST /api/browser/access/:grantId/cancel — Cancel browser task
  const cancelMatch = pathname.match(/^\/api\/browser\/access\/(bg_[A-Za-z0-9]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const grant = await service.repository.findById(cancelMatch[1]);
    if (!grant) return Response.json({ error: "grant_not_found" }, { status: 404, headers: NO_STORE_HEADERS });
    if (!(await authorizeGrant(req, env, grant))) return unauthorizedJson();
    try {
      return Response.json(await service.cancel(grant.workspace_id, grant.id), { headers: NO_STORE_HEADERS });
    } catch (e: any) {
      return Response.json({ error: e?.message || "cancel_failed" }, { status: 400, headers: NO_STORE_HEADERS });
    }
  }

  // 8. POST /api/browser/access/:grantId/system-browser-transfer — Transfer out of mobile WebView (§14.19, §14.20)
  const transferMatch = pathname.match(/^\/api\/browser\/access\/(bg_[A-Za-z0-9]+)\/system-browser-transfer$/);
  if (transferMatch && req.method === "POST") {
    const grant = await service.repository.findById(transferMatch[1]);
    if (!grant) return Response.json({ error: "grant_not_found" }, { status: 404, headers: NO_STORE_HEADERS });
    if (!(await authorizeGrant(req, env, grant))) return unauthorizedJson();
    if (!grantIsActive(grant)) return Response.json({ error: "grant_inactive" }, { status: 410, headers: NO_STORE_HEADERS });

    try {
      const transferGrant = await service.issueGrant({
        workspaceId: grant.workspace_id,
        taskId: grant.task_id,
        mode: grant.current_mode,
        createdBy: "system",
        ttlMs: 5 * 60_000,
        reasonCode: "system_browser_transfer",
      });
      return Response.json({ ok: true, transferUrl: transferGrant.accessUrl, expiresAt: transferGrant.expiresAt }, { headers: NO_STORE_HEADERS });
    } catch (e: any) {
      return Response.json({ error: e?.message || "transfer_failed" }, { status: 503, headers: NO_STORE_HEADERS });
    }
  }

  // 9. POST /api/browser/access/:grantId/steer — Steer browser task (§14.16)
  const steerMatch = pathname.match(/^\/api\/browser\/access\/(bg_[A-Za-z0-9]+)\/steer$/);
  if (steerMatch && req.method === "POST") {
    const grant = await service.repository.findById(steerMatch[1]);
    if (!grant) return Response.json({ error: "grant_not_found" }, { status: 404, headers: NO_STORE_HEADERS });
    if (!(await authorizeGrant(req, env, grant))) return unauthorizedJson();
    if (!grantIsActive(grant)) return Response.json({ error: "grant_inactive" }, { status: 410, headers: NO_STORE_HEADERS });

    const body = (await req.json().catch(() => ({}))) as { goal?: string; expectedRevision?: number };
    const goal = (body.goal ?? "").trim();
    if (!goal) return Response.json({ error: "goal_required" }, { status: 400, headers: NO_STORE_HEADERS });
    try {
      return Response.json(await service.steer(grant.workspace_id, grant.task_id, goal, body.expectedRevision), { headers: NO_STORE_HEADERS });
    } catch (e: any) {
      return Response.json({ error: e?.message || "steer_failed" }, { status: 400, headers: NO_STORE_HEADERS });
    }
  }

  // 10. GET /api/browser/sessions — workspace-scoped Computer V1 list (§13, §25.7)
  if (pathname === "/api/browser/sessions" && req.method === "GET") {
    const session = await readSession(env, req).catch(() => null);
    if (!session) return unauthorizedJson();

    // Real browser task sessions published by the BrowserWorker (DEFECT-022):
    // a normal agent-run task completes without any handoff grant, so grants
    // alone always showed an empty list. Map real rows onto the same fields the
    // hosted UI reads (id/task_id/goal/status/current_mode) with hasGrant=false,
    // while grants keep hasGrant=true.
    const realSessions = await env.DB.prepare(
      `SELECT id, workspace_id, task_id, url, title, state, observed_text,
              started_at, updated_at, ended_at
       FROM browser_sessions
       WHERE workspace_id = ?
       ORDER BY started_at DESC LIMIT 20`,
    ).bind(session.workspaceId).all().catch(() => ({ results: [] as any[] }));

    const rows = await env.DB.prepare(
      `SELECT g.id, g.task_id, g.workspace_id, g.current_mode, g.status, g.reason_code,
              g.instructions, g.control_epoch, g.issued_at, g.expires_at, g.redeemed_at,
              t.goal, t.status AS task_status
       FROM browser_access_grants g
       LEFT JOIN tasks t ON t.id = g.task_id AND t.workspace_id = g.workspace_id
       WHERE g.workspace_id = ?
       ORDER BY g.issued_at DESC LIMIT 20`,
    ).bind(session.workspaceId).all().catch(() => ({ results: [] as any[] }));

    // A browser session idles out on the provider after at most ten minutes. A row
    // still marked active well past that never received its end event; show it as
    // ended instead of offering a watch link to a dead session.
    const staleBefore = Date.now() - STALE_ACTIVE_SESSION_MS;
    for (const r of (realSessions.results ?? []) as any[]) {
      if (r.state === "active" && Number(r.updated_at ?? 0) < staleBefore) {
        r.state = "completed";
        r.ended_at = r.ended_at ?? r.updated_at;
        await env.DB.prepare(`UPDATE browser_sessions SET state='completed', ended_at=COALESCE(ended_at, updated_at) WHERE id=? AND state='active'`)
          .bind(r.id).run().catch(() => {});
      }
    }

    const real = (realSessions.results ?? []).map((r: any) => ({
      id: r.id,
      task_id: r.task_id,
      workspace_id: r.workspace_id,
      url: r.url ?? "",
      title: r.title ?? "",
      // Grant-shaped fields the UI reads; real sessions are agent-run, so the
      // watch/takeover CTA is inactive and the state label comes from `status`.
      current_mode: "readonly",
      status: r.state,
      reason_code: null,
      instructions: null,
      control_epoch: 0,
      issued_at: r.started_at,
      expires_at: r.ended_at ?? r.updated_at,
      redeemed_at: null,
      goal: r.title ?? r.url ?? "",
      task_status: r.state === "completed" ? "completed" : r.state === "failed" ? "failed" : "running",
      hasGrant: false,
      observed_text: r.observed_text ?? null,
      started_at: r.started_at,
      updated_at: r.updated_at,
      ended_at: r.ended_at ?? null,
    }));
    const grants = (rows.results ?? []).map((r: any) => ({ ...r, hasGrant: true }));

    return Response.json({ sessions: [...real, ...grants] }, { headers: NO_STORE_HEADERS });
  }

  return null;
}

function renderPreflightHtml(token: string, nonce: string, mode: string): string {
  const isWatch = mode === "readonly";
  const title = isWatch ? "打开浏览器实时预览" : "接入浏览器控制";
  const subtitle = isWatch
    ? "点击下方按钮进入只读实时预览界面，你可以随时查看 Agent 正在操作的页面。"
    : "点击下方按钮接管浏览器控制权，输入信息或完成操作后交还给 Agent。";
  const btnLabel = isWatch ? "进入预览 (Watch)" : "接管浏览器 (Take Over)";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — MuseInst</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 32px 28px; max-width: 440px; width: 90%; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
    p { font-size: 14px; color: #9ca3af; line-height: 1.6; margin: 0 0 28px; }
    button { width: 100%; padding: 14px; background: #2563eb; color: #fff; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; }
    .footer { margin-top: 20px; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${subtitle}</p>
    <form method="POST" action="/b/${token}/redeem">
      <input type="hidden" name="nonce" value="${nonce}">
      <button type="submit">${btnLabel}</button>
    </form>
    <div class="footer">MuseInst · 最小权限凭据保障 · 单次兑换有效</div>
  </div>
</body>
</html>`;
}

function renderErrorHtml(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — MuseInst</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 32px 28px; max-width: 440px; width: 90%; text-align: center; }
    h1 { font-size: 20px; font-weight: 600; color: #ef4444; margin: 0 0 12px; }
    p { font-size: 14px; color: #9ca3af; line-height: 1.6; margin: 0 0 24px; }
    a { display: inline-block; padding: 10px 20px; background: #1f2937; color: #e5e7eb; text-decoration: none; border-radius: 8px; font-size: 14px; }
  </style>
</head>
<body><div class="card"><h1>${title}</h1><p>${detail}</p><a href="/chat">返回控制台</a></div></body>
</html>`;
}

function renderBrowserShellHtml(grant: BrowserAccessGrantRow, capabilities: { interactiveView: boolean }): string {
  const isTakeover = grant.current_mode === "interactive" && capabilities.interactiveView;
  const takeoverAvailable = capabilities.interactiveView;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MuseInst Browser</title>
  <link rel="icon" type="image/png" href="/icon/favicon-32.png">
  <style>
    * { box-sizing:border-box; } body, html { margin:0; width:100%; height:100%; overflow:hidden; background:#fff; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; color:#1a1a1a; }
    #header { height:56px; border-bottom:1px solid #ececec; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0 16px; font-size:14px; }
    .brand { display:flex; align-items:center; gap:10px; min-width:0; } .brand strong { font-family:Newsreader,Georgia,serif; font-weight:400; font-size:20px; }
    .badge { display:inline-flex; align-items:center; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; } .badge-watch { background:#f3f2ef; color:#3f4145; } .badge-takeover { background:#fdf3e4; color:#9a5b12; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; } .btn { padding:7px 14px; border-radius:999px; font-size:13px; font-weight:600; cursor:pointer; border:1px solid #e4e4e4; background:#fff; color:#1a1a1a; text-decoration:none; white-space:nowrap; } .btn-dark { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
    #viewport-container { width:100%; height:calc(100% - 56px); position:relative; background:#fafaf9; } iframe { width:100%; height:100%; border:none; }
    #state { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:24px; text-align:center; color:#6f7175; font-size:14.5px; line-height:1.6; }
    #state h2 { margin:0; color:#1a1a1a; font-size:17px; font-weight:600; } #state .row { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; justify-content:center; }
    @media (max-width:640px) { #header { height:auto; min-height:56px; flex-wrap:wrap; padding:10px 12px; } #viewport-container { height:calc(100% - 104px); } }
  </style>
</head>
<body>
  <div id="header">
    <div class="brand"><strong>MuseInst</strong><span id="mode-badge" class="badge ${isTakeover ? "badge-takeover" : "badge-watch"}" data-t="${isTakeover ? "modeTakeover" : "modeWatch"}"></span></div>
    <div class="actions">
      ${takeoverAvailable && !isTakeover ? '<button id="btn-takeover" class="btn btn-dark" onclick="doTakeover()" data-t="takeover"></button>' : ""}
      ${isTakeover ? '<button id="btn-done" class="btn btn-dark" onclick="doDone()" data-t="handBack"></button>' : ""}
      <button id="btn-transfer" class="btn" onclick="doTransfer()" data-t="openExternal"></button>
      <a class="btn" href="/chat" data-t="close"></a>
    </div>
  </div>
  <div id="viewport-container"><div id="state"><div data-t="connecting"></div></div><iframe id="live-view-frame" style="display:none" allow="clipboard-read; clipboard-write"></iframe></div>
  <script>
    const grantId = ${JSON.stringify(grant.id)};
    const T = {
      en: { modeWatch: "Watching", modeTakeover: "You're in control", takeover: "Take over", handBack: "Hand back to agent", openExternal: "Open in my browser", close: "Close",
        connecting: "Connecting to the browser…", endedTitle: "This browser session has ended", endedBody: "The agent closes its browser when a task finishes or sits idle. Your task history is kept.",
        openComputer: "Open a new browser", backToChat: "Back to chat", unavailableTitle: "Live view isn't available right now", unavailableBody: "Try again in a moment.", retry: "Try again",
        handedBack: "Handed back. The agent continues and will post the result in chat. You can close this page.", takeoverFailed: "Couldn't take over: ", handBackFailed: "Couldn't hand back: ", transferFailed: "Couldn't create the link: " },
      zh: { modeWatch: "观看中", modeTakeover: "你正在操作", takeover: "接管", handBack: "交还 Agent", openExternal: "在我的浏览器打开", close: "关闭",
        connecting: "正在连接浏览器…", endedTitle: "这个浏览器会话已经结束", endedBody: "任务完成或空闲一段时间后，Agent 会关闭浏览器。任务记录都还在。",
        openComputer: "打开新的浏览器", backToChat: "回到聊天", unavailableTitle: "实时画面暂时不可用", unavailableBody: "稍等一下再试。", retry: "重试",
        handedBack: "已交还给 Agent，它会接着处理，结果会发到聊天里。这个页面可以关了。", takeoverFailed: "接管失败：", handBackFailed: "交还失败：", transferFailed: "生成链接失败：" },
    };
    let lang = "en";
    try { const saved = localStorage.getItem("openinst_lang"); lang = saved === "zh" || saved === "en" ? saved : ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en"); } catch (e) {}
    const t = (k) => (T[lang] && T[lang][k]) || T.en[k] || k;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.getAttribute("data-t"));
    const deviceKey = "oi-browser-device-id";
    let deviceId = localStorage.getItem(deviceKey);
    if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem(deviceKey, deviceId); }
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    function showState(title, body, actions) {
      const frame = document.getElementById("live-view-frame"); frame.style.display = "none"; frame.src = "about:blank";
      const box = document.getElementById("state"); box.style.display = "flex";
      box.innerHTML = (title ? "<h2>" + esc(title) + "</h2>" : "") + "<div>" + esc(body) + "</div>" + (actions ? '<div class="row">' + actions + "</div>" : "");
    }
    function showEnded() {
      for (const id of ["btn-takeover", "btn-done", "btn-transfer"]) document.getElementById(id)?.remove();
      showState(t("endedTitle"), t("endedBody"), '<a class="btn btn-dark" href="/computer">' + esc(t("openComputer")) + '</a><a class="btn" href="/chat">' + esc(t("backToChat")) + "</a>");
    }
    async function api(path, init) {
      const res = await fetch(path, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(data.error || ("http_" + res.status)); err.status = res.status; throw err; }
      return data;
    }
    async function loadStatus() {
      try {
        const data = await api("/api/browser/access/" + grantId + "/status");
        if (data.providerView?.providerViewUrl) {
          const frame = document.getElementById("live-view-frame"); frame.src = data.providerView.providerViewUrl; frame.style.display = "block"; document.getElementById("state").style.display = "none";
        } else {
          showState(t("unavailableTitle"), t("unavailableBody"), '<button class="btn btn-dark" onclick="loadStatus()">' + esc(t("retry")) + "</button>");
        }
      } catch (e) {
        if (e.status === 410 || e.message === "browser_session_ended" || e.message === "grant_inactive") return showEnded();
        showState(t("unavailableTitle"), t("unavailableBody"), '<button class="btn btn-dark" onclick="loadStatus()">' + esc(t("retry")) + "</button>");
      }
    }
    async function doTakeover() {
      try {
        const data = await api("/api/browser/access/" + grantId + "/takeover", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ deviceId }) });
        if (data.providerView?.providerViewUrl) location.reload();
      } catch (e) { alert(t("takeoverFailed") + e.message); }
    }
    async function doDone() {
      try {
        await api("/api/browser/access/" + grantId + "/done", { method:"POST" });
        document.getElementById("btn-done")?.remove();
        showState("", t("handedBack"), '<a class="btn" href="/chat">' + esc(t("backToChat")) + "</a>");
        setTimeout(() => { try { window.close(); } catch {} }, 1200);
      }
      catch (e) { alert(t("handBackFailed") + e.message); }
    }
    async function doTransfer() {
      try { const data = await api("/api/browser/access/" + grantId + "/system-browser-transfer", { method:"POST" }); if (data.transferUrl) window.open(data.transferUrl, "_blank", "noopener"); }
      catch (e) { alert(t("transferFailed") + e.message); }
    }
    loadStatus();
  </script>
</body>
</html>`;
}

