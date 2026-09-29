


import PostalMime from "postal-mime";


export const EMAIL_MAX_ATTACHMENT_META = 100;

export interface ParsedEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  attachments: Array<{ filename: string | null; mimeType: string; size: number }>;
  headers: Record<string, string>;
}

function firstAddress(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const a = v[0] as { address?: string; email?: string } | undefined;
    return String(a?.address ?? a?.email ?? "");
  }
  const o = v as { address?: string; email?: string };
  return String(o.address ?? o.email ?? "");
}

function headerListToRecord(headers: Array<{ key: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const k = String(h.key ?? "").toLowerCase();
    if (!k) continue;
    if (!(k in out)) out[k] = String(h.value ?? "");
  }
  return out;
}

export async function parseEmail(raw: ArrayBuffer, envelopeFrom: string): Promise<ParsedEmail> {
  const mail = await PostalMime.parse(raw);
  const headers = headerListToRecord((mail.headers as Array<{ key: string; value: string }>) ?? []);
  const refs = String(headers["references"] ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const all = (mail.attachments ?? []) as Array<{ filename?: string | null; mimeType?: string; content?: Uint8Array }>;
  const attachments = all.slice(0, EMAIL_MAX_ATTACHMENT_META).map((a) => ({
    filename: a.filename ? String(a.filename).slice(0, 200) : null,
    mimeType: String(a.mimeType ?? "application/octet-stream").slice(0, 100),
    size: Number(a.content?.byteLength ?? 0),
  }));
  return {
    messageId: (mail.messageId as string | undefined) ?? headers["message-id"] ?? null,
    inReplyTo: (mail.inReplyTo as string | undefined) ?? headers["in-reply-to"] ?? null,
    references: refs,
    from: firstAddress((mail as { from?: unknown }).from) || String(envelopeFrom ?? ""),
    to: firstAddress((mail as { to?: unknown }).to),
    subject: String(mail.subject ?? ""),
    text: String(mail.text ?? ""),
    html: (mail.html as string | undefined) ?? null,
    attachments,
    headers,
  };
}


export function cleanBodyText(text: string, maxChars = 8000): string {
  const t = String(text ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + `…[截断，原长 ${t.length} 字符]`;
}


export const EMAIL_BODY_STORE_MAX_CHARS = 200_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent: string) => {
    if (ent.startsWith("#")) {
      const hex = ent[1]?.toLowerCase() === "x";
      const code = Number.parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}





export function htmlToText(html: string, maxChars = EMAIL_BODY_STORE_MAX_CHARS): string {
  let s = String(html ?? "");

  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|head|template|noscript|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<\/?(br|p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|pre)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]{2,}/g, " ").replace(/ ?\n ?/g, "\n");
  return cleanBodyText(s, maxChars);
}





export function sanitizeHtml(html: string, maxChars = EMAIL_BODY_STORE_MAX_CHARS): string {
  let s = String(html ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|template|noscript|iframe|frame|frameset|object|embed|form|input|button|link|meta|base)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<\/?(script|style|iframe|frame|frameset|object|embed|form|input|button|link|meta|base)\b[^>]*>/gi, "");

  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  s = s.replace(/\s(href|src|xlink:href)\s*=\s*("|')?\s*(javascript|vbscript|data)\s*:[^"'>\s]*/gi, " $1=\"#\"");
  if (s.length > maxChars) s = s.slice(0, maxChars) + "<!--truncated-->";
  return s;
}


export function snippetOf(text: string, maxChars = 200): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= maxChars ? t : t.slice(0, maxChars) + "…";
}
