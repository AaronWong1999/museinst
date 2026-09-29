// docs.ts — Semantic Documents adapter for Lark & Feishu Docx.
// V2 §10.5 / §13: document_search, document_read, document_create, document_append.

import type { Env } from "../../env";
import { ConnectorCallError } from "../types";
import { larkFeishuUserRequest } from "./client";
import type { LarkFeishuDocument, LarkFeishuProvider } from "./types";

function stripSearchHighlight(input: unknown): string {
  return String(input ?? "").replace(/<\/?h[b]?>/g, "").trim();
}

function tokenFromSearchUnit(unit: any): string {
  const meta = unit?.result_meta && typeof unit.result_meta === "object" ? unit.result_meta : {};
  for (const candidate of [
    meta.token,
    meta.doc_token,
    meta.docs_token,
    meta.file_token,
    unit?.token,
    unit?.doc_token,
    unit?.docs_token,
    unit?.file_token,
  ]) {
    const value = String(candidate ?? "").trim();
    if (value) return value;
  }

  const url = String(meta.url ?? unit?.url ?? "").trim();
  const match = url.match(/\/(?:docx|docs?)\/([A-Za-z0-9_-]+)/i);
  return match?.[1] ?? "";
}

export async function larkFeishuDocumentSearch(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  query?: string,
  max = 10,
): Promise<LarkFeishuDocument[]> {
  const pageSize = Math.max(1, Math.min(Math.trunc(max || 10), 20));
  const body = {
    query: String(query ?? "").trim(),
    page_size: pageSize,
    doc_filter: { doc_types: ["DOC", "DOCX"] },
    wiki_filter: { doc_types: ["DOC", "DOCX"] },
  };

  const res = await larkFeishuUserRequest(env, provider, userToken, "/search/v2/doc_wiki/search", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const units = Array.isArray((res as any)?.res_units) ? (res as any).res_units : [];
  return units
    .map((unit: any) => {
      const meta = unit?.result_meta && typeof unit.result_meta === "object" ? unit.result_meta : {};
      const type = String(meta.doc_types ?? unit?.entity_type ?? "").toUpperCase();
      if (type && !type.includes("DOC")) return null;
      const documentId = tokenFromSearchUnit(unit);
      if (!documentId) return null;
      return {
        documentId,
        title: stripSearchHighlight(unit?.title_highlighted || unit?.title) || "(未命名文档)",
        url: meta.url ? String(meta.url) : unit?.url ? String(unit.url) : undefined,
      } satisfies LarkFeishuDocument;
    })
    .filter((doc: LarkFeishuDocument | null): doc is LarkFeishuDocument => !!doc)
    .slice(0, pageSize);
}

export async function larkFeishuDocumentRead(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  documentId: string,
): Promise<{ documentId: string; title: string; content: string }> {
  const res = await larkFeishuUserRequest(env, provider, userToken, `/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`);
  const content = String((res as any)?.content ?? "");

  let title = "Document";
  try {
    const meta = await larkFeishuUserRequest(env, provider, userToken, `/docx/v1/documents/${encodeURIComponent(documentId)}`);
    if ((meta as any)?.document?.title) title = String((meta as any).document.title);
  } catch {
    // Reading raw content is still a valid read even when the optional metadata
    // request fails. Write verification below does not use this relaxed path.
  }

  return { documentId, title, content };
}

async function verifyDocumentTitle(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  documentId: string,
  expectedTitle: string,
): Promise<void> {
  const meta = await larkFeishuUserRequest(env, provider, userToken, `/docx/v1/documents/${encodeURIComponent(documentId)}`);
  const actual = String((meta as any)?.document?.title ?? (meta as any)?.title ?? "").trim();
  if (!actual) throw new ConnectorCallError("provider_error", `${provider}_document_create: read_back_missing_title`);
  if (actual !== expectedTitle.trim()) {
    throw new ConnectorCallError("provider_error", `${provider}_document_create: title_mismatch`);
  }
}

async function verifyDocumentContains(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  documentId: string,
  expectedText: string,
): Promise<void> {
  const res = await larkFeishuUserRequest(env, provider, userToken, `/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`);
  const content = String((res as any)?.content ?? "");
  if (!content.includes(expectedText)) {
    throw new ConnectorCallError("provider_error", `${provider}_document_append: read_back_mismatch`);
  }
}

export async function larkFeishuDocumentCreate(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  title: string,
  initialContent?: string,
): Promise<{ documentId: string; title: string; url?: string }> {
  const res = await larkFeishuUserRequest(env, provider, userToken, `/docx/v1/documents`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });

  const doc = (res as any)?.document ?? res;
  const documentId = String(doc?.document_id ?? "");
  if (!documentId) throw new ConnectorCallError("provider_error", `${provider}_document_create: missing_document_id`);

  if (initialContent) {
    await larkFeishuDocumentAppend(env, provider, userToken, documentId, initialContent);
  }

  // External Truth: a 2xx create response alone is not enough for the semantic
  // layer to claim success. Confirm the provider can read the same document and
  // that its title matches the requested title.
  await verifyDocumentTitle(env, provider, userToken, documentId, title);

  return {
    documentId,
    title: doc?.title ? String(doc.title) : title,
    url: (doc as any)?.url,
  };
}

export async function larkFeishuDocumentAppend(
  env: Env,
  provider: LarkFeishuProvider,
  userToken: string,
  documentId: string,
  text: string,
): Promise<{ documentId: string; appended: true }> {
  const body = {
    children: [
      {
        block_type: 2,
        text: {
          elements: [
            { text_run: { content: text } },
          ],
        },
      },
    ],
  };

  await larkFeishuUserRequest(env, provider, userToken, `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (text) await verifyDocumentContains(env, provider, userToken, documentId, text);
  return { documentId, appended: true };
}
