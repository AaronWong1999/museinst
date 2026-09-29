import type { Hono } from "hono";
import type { Env } from "../env";
import { json } from "../util";
import * as receiptImage from "./receipt-image";
import { renderReceiptPng } from "./receipt-image";
import * as tasksMod from "./tasks";
import { readSession } from "../session";

async function viewerWorkspace(c: any): Promise<string | null> {
  const session = await readSession(c.env as Env, c.req.raw).catch(() => null);
  return session?.workspaceId ?? null;
}

/** Mount the public receipt routes on Core and Hosted Worker entry points. */
export function registerPublicReceiptRoutes(app: Hono<any>): void {
  app.get("/api/receipt/:slug", async (c: any) => {
    const receipt = await tasksMod.getReceiptBySlug(c.env as Env, c.req.param("slug"), await viewerWorkspace(c));
    return receipt ? json(receipt) : json({ error: "not_found" }, 404);
  });

  app.get("/r/:slug", async (c: any) => {
    const slug = c.req.param("slug");
    const receipt = await tasksMod.getReceiptBySlug(c.env as Env, slug, await viewerWorkspace(c));
    if (!receipt) {
      return c.html('<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:40px;font-family:Georgia,serif">404</div><div style="color:#737373;margin-top:8px">这个凭证不存在，或者是私密的。</div><p><a href="/workspace" style="color:#171717">返回工作区</a></p></div></body>', 404);
    }
    const res = c.html(receiptImage.buildReceiptPageHtml(receipt, slug, c.env.PUBLIC_BASE_URL));
    res.headers.set("cache-control", "private, no-store");
    return res;
  });

  app.get("/r/:slug/og.png", async (c: any) => {
    const slug = c.req.param("slug");
    const workspace = await c.env.DB.prepare(
      `SELECT t.workspace_id FROM task_receipts tr JOIN tasks t ON t.id=tr.task_id WHERE tr.share_slug=?`,
    ).bind(slug).first() as { workspace_id: string } | null;
    let watermark = true;
    if (workspace) {
      const setting = await c.env.DB.prepare(
        `SELECT value FROM settings WHERE workspace_id=? AND key='watermark_enabled'`,
      ).bind(workspace.workspace_id).first() as { value: string } | null;
      watermark = setting?.value !== "0";
    }
    const rendered = await renderReceiptPng(c.env as Env, slug, {
      edition: "open",
      watermark,
      baseUrl: c.env.PUBLIC_BASE_URL,
    });
    if ("error" in rendered) {
      return json({ error: rendered.error }, rendered.error === "not_found" ? 404 : 502);
    }
    return new Response(rendered.bytes.buffer as ArrayBuffer, {
      headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
    });
  });
}
