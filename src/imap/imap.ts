
//



let connectOverride: ((addr: SocketAddress, opts: SocketOptions) => any) | null = null;

async function getConnect() {
  if (connectOverride) return connectOverride;
  const mod = await import("cloudflare:sockets");
  return mod.connect;
}

export function __setConnectForTests(fn: ((addr: SocketAddress, opts: SocketOptions) => any) | null): void {
  connectOverride = fn;
}

export interface ImapConfig {
  host: string;
  port?: number;
  user: string;
  pass: string;
  sendId?: boolean;
  starttls?: boolean;
}

export interface MailSummary {
  seq: number;
  uid?: number;
  from: string;
  to: string;
  subject: string;
  date: string;
}

export interface MailFull extends MailSummary {
  body: string;
}

export const PRESETS: Record<string, { host: string; smtpHost: string; smtpPort: number; smtpStarttls?: boolean; sendId: boolean }> = {
  qq: { host: "imap.qq.com", smtpHost: "smtp.qq.com", smtpPort: 465, sendId: false },
  "163": { host: "imap.163.com", smtpHost: "smtp.163.com", smtpPort: 465, sendId: true },
  "126": { host: "imap.126.com", smtpHost: "smtp.126.com", smtpPort: 465, sendId: true },
  icloud: { host: "imap.mail.me.com", smtpHost: "smtp.mail.me.com", smtpPort: 587, smtpStarttls: true, sendId: false },
  gmail: { host: "imap.gmail.com", smtpHost: "smtp.gmail.com", smtpPort: 465, sendId: false },
  exmail: { host: "imap.exmail.qq.com", smtpHost: "smtp.exmail.qq.com", smtpPort: 465, sendId: false },
  yahoo: { host: "imap.mail.yahoo.com", smtpHost: "smtp.mail.yahoo.com", smtpPort: 465, sendId: false },
};

class SocketReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);
  private decoder = new TextDecoder();
  closed = false;
  private socket: any;

  constructor(socket: any) {
    this.reader = socket.readable.getReader();
    this.socket = socket;
  }


  private async cancellableRead(timeoutMs: number): Promise<{ done: boolean; value?: Uint8Array }> {
    const ms = Math.max(1, Math.min(timeoutMs, 30_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onCancel: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {

      timer = setTimeout(() => reject(new Error("imap_timeout")), ms);
      onCancel = () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new Error("imap_timeout"));
      };
      try { this.reader.closed?.then?.(onCancel, onCancel); } catch {}
    });
    try {
      return await Promise.race([this.reader.read(), timeout]);
    } catch (e) {
      await this.destroy(e);
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }


  async destroy(_cause?: unknown): Promise<void> {
    this.closed = true;
    try { await this.reader.cancel(); } catch {}
    try { this.reader.releaseLock(); } catch {}
    try { this.socket?.close?.(); } catch {}
  }

  async readLine(timeoutMs = 30000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.indexOfCrlf();
      if (idx >= 0) {
        const line = this.decoder.decode(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx + 2);
        return line;
      }
      const remain = deadline - Date.now();
      if (remain <= 0) {
        await this.destroy(new Error("imap_timeout"));
        throw new Error("imap_timeout");
      }
      const { done, value } = await this.cancellableRead(remain);
      if (done) {
        this.closed = true;
        throw new Error("imap_closed");
      }
      const merged = new Uint8Array(this.buf.length + (value?.length ?? 0));
      merged.set(this.buf);
      if (value) merged.set(value, this.buf.length);
      this.buf = merged;
    }
  }

  async readBytes(n: number, timeoutMs = 30000): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      const remain = deadline - Date.now();
      if (remain <= 0) {
        await this.destroy(new Error("imap_timeout"));
        throw new Error("imap_timeout");
      }
      const { done, value } = await this.cancellableRead(remain);
      if (done) {
        this.closed = true;
        throw new Error("imap_closed");
      }
      const merged = new Uint8Array(this.buf.length + (value?.length ?? 0));
      merged.set(this.buf);
      if (value) merged.set(value, this.buf.length);
      this.buf = merged;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  async readResponseLine(timeoutMs = 30000): Promise<string> {
    let line = await this.readLine(timeoutMs);
    for (;;) {
      const m = line.match(/\{(\d+)\}\r?$/);
      if (!m) return line;
      const literal = await this.readBytes(Number(m[1]), timeoutMs);
      const rest = await this.readLine(timeoutMs);
      line = line.slice(0, m.index) + new TextDecoder().decode(literal) + rest;
    }
  }

  private indexOfCrlf(): number {
    for (let i = 0; i + 1 < this.buf.length; i++) {
      if (this.buf[i] === 13 && this.buf[i + 1] === 10) return i;
    }
    return -1;
  }
}

const MAX_MAILBOX = 50;


const IMAP_COMMAND_BUDGET_MS = 30_000;

async function withImap<T>(cfg: ImapConfig, fn: (session: ImapSession) => Promise<T>): Promise<T> {
  const connectFn = await getConnect();
  const socket = connectFn(
    { hostname: cfg.host, port: cfg.port ?? 993 },
    { secureTransport: "on", allowHalfOpen: false },
  );
  const writer = socket.writable.getWriter();
  const enc = new TextEncoder();
  let seqCounter = 0;
  let sr: SocketReader | null = null;
  const session: ImapSession = {
    lines: [],
    async cmd(command: string, opts: { collect?: boolean; budgetMs?: number } = {}): Promise<{ ok: boolean; lines: string[] }> {
      const budgetMs = opts.budgetMs ?? IMAP_COMMAND_BUDGET_MS;
      const tag = `a${++seqCounter}`;
      await writer.write(enc.encode(`${tag} ${command}\r\n`));
      const lines: string[] = [];
      const deadline = Date.now() + budgetMs;
      for (;;) {
        const remain = deadline - Date.now();
        if (remain <= 0) {
          await sr?.destroy(new Error("imap_command_timeout"));
          throw new Error("imap_command_timeout");
        }
        const resp = await session.reader.readResponseLine(Math.min(remain, IMAP_COMMAND_BUDGET_MS));
        if (resp.startsWith(`${tag} `)) {
          const ok = /^(OK|PREAUTH)/i.test(resp.slice(tag.length + 1));
          return { ok, lines };
        }
        if (opts.collect !== false) lines.push(resp);
      }
    },
    raw: async (payload: string) => {
      await writer.write(enc.encode(payload));
    },
    reader: null as any,
  };
  (session as any).seqNext = () => `a${++seqCounter}`;

  sr = new SocketReader(socket);
  session.reader = sr;

  try {
    const greeting = await sr.readResponseLine(IMAP_COMMAND_BUDGET_MS);
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting)) throw new Error(`imap_bad_greeting: ${greeting.slice(0, 80)}`);

    const cap = await session.cmd("CAPABILITY");
    const caps = cap.lines.join(" ");
    if (cfg.sendId && /ID\b/i.test(caps)) {
      await session.cmd(`ID ("name" "openinst" "version" "1.0")`);
    }
    const login = await session.cmd(`LOGIN "${escapeQuoted(cfg.user)}" "${escapeQuoted(cfg.pass)}"`);
    if (!login.ok) throw new Error("imap_login_failed（检查 IMAP 服务是否开启、授权码是否正确）");
    return await fn(session);
  } finally {
    try { await writer.write(enc.encode(`zz LOGOUT\r\n`)); } catch {}
    try { await writer.releaseLock(); } catch {}
    try { socket.close(); } catch {}
  }
}

export interface ImapSession {
  lines: string[];
  cmd(command: string, opts?: { collect?: boolean; budgetMs?: number }): Promise<{ ok: boolean; lines: string[] }>;
  raw(payload: string): Promise<void>;
  reader: SocketReader;
}

function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Mailbox folder names are interpolated into SELECT commands: restrict to a
// conservative IMAP-safe alphabet (upper-cased) so hostile input can never
// break out of the quoted string (no quotes/backslash/CR/LF can survive).
const FOLDER_RE = /^[A-Z0-9 _\/\.\-&]+$/;

export function normalizeImapFolder(raw: string | undefined | null, fallback = "INBOX"): string {
  const f = String(raw ?? "").trim().toUpperCase() || fallback;
  if (!FOLDER_RE.test(f) || f.length > 120) throw new Error("imap_folder_invalid");
  return f;
}

export async function imapList(cfg: ImapConfig, search = "", max = 10, folder = "INBOX"): Promise<MailSummary[]> {
  return withImap(cfg, async (s) => {
    const box = normalizeImapFolder(folder);
    const sel = await s.cmd(`SELECT "${escapeQuoted(box)}"`);
    if (!sel.ok) throw new Error("imap_select_failed");
    const safeSearch = search.replace(/[\r\n]+/g, " ").trim();
    const q = safeSearch ? `SEARCH ${safeSearch}` : "SEARCH ALL";
    const r = await s.cmd(q);
    const seqs = (r.lines.find((l) => l.startsWith("* SEARCH")) ?? "")
      .replace("* SEARCH", "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .slice(-Math.min(max, MAX_MAILBOX))
      .reverse();
    const out: MailSummary[] = [];
    for (const seq of seqs) {
      try {
        const f = await s.cmd(`FETCH ${seq} (UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])`);
        out.push({ seq, ...parseHeaderFetch(f.lines.join("\r\n")) });
      } catch {

      }
    }
    return out;
  });
}
// Count-only path (DEFECT-024): SELECT + SEARCH only. No FETCH of any kind is
// issued here — headers or bodies must never leave the server for a count.
export async function imapCount(
  cfg: ImapConfig,
  search = "",
  folder = "INBOX",
): Promise<{ folder: string; count: number }> {
  const box = normalizeImapFolder(folder);
  return withImap(cfg, async (s) => {
    const sel = await s.cmd(`SELECT "${escapeQuoted(box)}"`);
    if (!sel.ok) throw new Error("imap_select_failed");
    const safeSearch = search.replace(/[\r\n]+/g, " ").trim();
    const q = safeSearch ? `SEARCH ${safeSearch}` : "SEARCH ALL";
    const r = await s.cmd(q);
    const seqs = (r.lines.find((l) => l.startsWith("* SEARCH")) ?? "")
      .replace("* SEARCH", "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return { folder: box, count: seqs.length };
  });
}


export async function imapGetByUid(cfg: ImapConfig, uid: number, bodyChars = 6000): Promise<MailFull | null> {
  return withImap(cfg, async (s) => {
    await s.cmd("SELECT INBOX");
    const f = await s.cmd(`UID FETCH ${uid} (UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)] BODY.PEEK[TEXT])`);
    const raw = f.lines.join("\r\n");
    if (!raw.trim() || /^\s*a\d+\s+OK/i.test(raw.trim())) return null;
    const header = parseHeaderFetch(raw);
    const body = extractTextBody(raw).slice(0, bodyChars);
    return { seq: header.uid ?? uid, ...header, uid, body };
  });
}

export async function imapGet(cfg: ImapConfig, seq: number, bodyChars = 6000): Promise<MailFull | null> {
  return withImap(cfg, async (s) => {
    await s.cmd("SELECT INBOX");
    const f = await s.cmd(`FETCH ${seq} (UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)] BODY.PEEK[TEXT])`);
    const raw = f.lines.join("\r\n");
    const header = parseHeaderFetch(raw);
    const body = extractTextBody(raw).slice(0, bodyChars);
    return { seq, ...header, body };
  });
}

function parseHeaderFetch(raw: string): { from: string; to: string; subject: string; date: string; messageId?: string; uid?: number } {
  const pick = (name: string): string => {
    const m = raw.match(new RegExp(`${name}:\\s*([^\\r\\n]*(?:\\r\\n\\s[^\\r\\n]*)*)`, "i"));
    if (!m) return "";
    return decodeMimeWords(m[1].replace(/\r?\n\s+/g, " ").trim());
  };
  const uidM = raw.match(/UID\s+(\d+)/i);
  return {
    from: pick("From"),
    to: pick("To"),
    subject: pick("Subject"),
    date: pick("Date"),
    messageId: pick("Message-ID"),
    uid: uidM ? Number(uidM[1]) : undefined,
  };
}

function makeMessageId(from: string): string {
  const domain = from.includes("@") ? from.split("@").slice(-1)[0].replace(/[^A-Za-z0-9.-]/g, "") || "openinst.local" : "openinst.local";
  const uuid = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  return `<${uuid}@${domain}>`;
}

function encodeMimeWord(s: string): string {
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;
}

function canonicalAddress(value: string): string | null {
  const trimmed = value.trim();
  const angle = trimmed.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const candidate = (angle?.[1] ?? trimmed).trim().toLowerCase();
  return /^[^\s@<>,;:"']+@[^\s@<>,;:"'@]+\.[^\s@<>,;:"']+$/.test(candidate) ? candidate : null;
}

function normalizeDraftBody(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/g, "");
}








export async function imapAppendDraft(
  cfg: ImapConfig,
  mail: { from: string; to: string; subject: string; body: string },
): Promise<{
  ok: boolean;
  appendAccepted?: boolean;
  uid?: number;
  folder?: string;
  to?: string;
  subject?: string;
  isDraft?: boolean;
  messageId?: string;
  verifiedAt?: number;
  error?: string;
}> {
  return withImap(cfg, async (s) => {
    let folder = "";
    const listSpecial = await s.cmd(`LIST (SPECIAL-USE) "" "*"`);
    const allLines = listSpecial.lines.join("\r\n");
    const draftSpecial = allLines.match(/\* LIST \(([^)]*\\Draft[^)]*)\)\s+"?([^"\s]+)"?\s+(.+)/i)
      ?? allLines.match(/\* LIST \(([^)]*)\)\s+"?([^"\s]+)"?\s+(.*[Dd]raft.*)/i);
    if (draftSpecial) {
      folder = draftSpecial[3].trim().replace(/^"|"$/g, "");
    } else {
      const list = await s.cmd(`LIST "" "*"`);
      for (const line of list.lines) {
        const m = line.match(/\* LIST \([^)]*\)\s+"?([^"\s]+)"?\s+(.+)/i);
        if (m && /draft/i.test(m[2])) {
          folder = m[2].trim().replace(/^"|"$/g, "");
          break;
        }
      }
    }
    if (!folder) return { ok: false, error: "imap_drafts_folder_not_found" };

    const messageId = makeMessageId(mail.from);
    const headers =
      `From: <${mail.from}>\r\nTo: <${mail.to}>\r\n` +
      `Subject: ${encodeMimeWord(mail.subject)}\r\n` +
      `Date: ${new Date().toUTCString().replace(/GMT/, "+0000")}\r\n` +
      `Message-ID: ${messageId}\r\n` +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
    const body = mail.body.replace(/\r?\n/g, "\r\n");
    const mime = headers + body + "\r\n";
    const myTag = (s as any).seqNext();
    const enc = new TextEncoder();
    await s.raw(`${myTag} APPEND "${escapeQuoted(folder)}" (\\Draft) {${enc.encode(mime).length}}\r\n`);
    const cont = await s.reader.readResponseLine();
    if (!cont.startsWith("+")) return { ok: false, error: "imap_append_refused: " + cont.slice(0, 80) };
    await s.raw(mime + "\r\n");

    let appendTaggedResp = "";
    for (;;) {
      const resp = await s.reader.readResponseLine();
      if (resp.startsWith(`${myTag} `)) {
        if (!/^(OK|PREAUTH)/i.test(resp.slice(myTag.length + 1))) {
          return { ok: false, error: "imap_append_refused: " + resp.slice(0, 80) };
        }
        appendTaggedResp = resp;
        break;
      }
    }
    const appendAccepted = true;

    let targetUid: number | undefined;
    const appendUidMatch = appendTaggedResp.match(/\[APPENDUID\s+(\d+)\s+(\d+)\]/i);
    if (appendUidMatch) targetUid = Number(appendUidMatch[2]);

    const sel = await s.cmd(`SELECT "${escapeQuoted(folder)}"`);
    if (!sel.ok) return { ok: false, appendAccepted, error: "imap_drafts_select_failed", folder };

    if (!targetUid) {
      const searchRes = await s.cmd(`UID SEARCH HEADER Message-ID "${escapeQuoted(messageId)}"`);
      const searchUids = (searchRes.lines.find((l) => l.startsWith("* SEARCH")) ?? "")
        .replace("* SEARCH", "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      if (searchUids.length !== 1) {
        return {
          ok: false,
          appendAccepted,
          error: searchUids.length === 0 ? "imap_draft_exact_readback_missing" : "imap_draft_exact_readback_ambiguous",
          folder,
        };
      }
      targetUid = searchUids[0];
    }

    const f = await s.cmd(`UID FETCH ${targetUid} (UID FLAGS BODY.PEEK[HEADER.FIELDS (TO SUBJECT MESSAGE-ID)] BODY.PEEK[TEXT])`);
    if (!f.ok) return { ok: false, appendAccepted, error: "imap_draft_exact_fetch_failed", uid: targetUid, folder };
    const raw = f.lines.join("\r\n");
    if (!raw.trim()) return { ok: false, appendAccepted, error: "imap_draft_exact_fetch_empty", uid: targetUid, folder };

    const header = parseHeaderFetch(raw);
    const isDraft = /\\Draft/i.test(raw);
    if (!isDraft) {
      return { ok: false, appendAccepted, error: "draft_flag_missing", uid: targetUid, folder, isDraft: false };
    }

    const expectedTo = canonicalAddress(mail.to);
    const actualTo = canonicalAddress(header.to ?? "");
    if (!expectedTo || !actualTo || actualTo !== expectedTo) {
      return { ok: false, appendAccepted, error: "draft_to_mismatch", uid: targetUid, folder, isDraft };
    }

    const decodedSubj = decodeMimeWords(header.subject ?? "").trim();
    if (!decodedSubj || decodedSubj !== mail.subject.trim()) {
      return { ok: false, appendAccepted, error: "draft_subject_mismatch", uid: targetUid, folder, isDraft };
    }

    const actualMessageId = (header.messageId ?? "").trim();
    if (!actualMessageId || actualMessageId !== messageId) {
      return { ok: false, appendAccepted, error: "draft_message_id_mismatch", uid: targetUid, folder, isDraft };
    }

    const bodyMatch = raw.match(/BODY\[TEXT\]\s*(?:\{\d+\}\r?\n)?([\s\S]*?)(?:\r?\n\s*\)|\r?\n\S+\s+(?:OK|FETCH))/i);
    if (!bodyMatch) {
      return { ok: false, appendAccepted, error: "draft_body_unparseable", uid: targetUid, folder, isDraft };
    }
    const normReqBody = normalizeDraftBody(mail.body);
    const normFetchedBody = normalizeDraftBody(bodyMatch[1]);
    if (normFetchedBody !== normReqBody) {
      return { ok: false, appendAccepted, error: "draft_body_mismatch", uid: targetUid, folder, isDraft };
    }

    return {
      ok: true,
      appendAccepted,
      uid: targetUid,
      folder,
      to: header.to,
      subject: decodedSubj,
      messageId,
      verifiedAt: Date.now(),
      isDraft: true,
    };
  });
}

export function decodeMimeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      let bytes: Uint8Array;
      if (enc.toLowerCase() === "b") {
        const bin = atob(text);
        bytes = Uint8Array.from(bin, (c: string) => c.charCodeAt(0));
      } else {
        const expanded = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_mm: string, h: string) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(expanded, (c: string) => c.charCodeAt(0));
      }
      const label = charset.toLowerCase() === "gbk" || charset.toLowerCase() === "gb2312" ? "gbk" : "utf-8";
      return new TextDecoder(label).decode(bytes);
    } catch {
      return text;
    }
  });
}

function extractTextBody(raw: string): string {
  const lower = raw.toLowerCase();
  const plainIdx = lower.indexOf("content-type: text/plain");
  const htmlIdx = lower.indexOf("content-type: text/html");
  let start = plainIdx >= 0 ? plainIdx : htmlIdx >= 0 ? htmlIdx : 0;
  start = raw.indexOf("\r\n\r\n", start);
  let body = start >= 0 ? raw.slice(start + 4) : raw;
  const boundary = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundary) {
    const end = body.indexOf(`--${boundary[1]}`, 10);
    if (end > 0) body = body.slice(0, end);
  }
  if (htmlIdx >= 0 && plainIdx < 0) {
    body = body
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");
  }
  return body.replace(/\r\n/g, "\n").trim();
}

export interface SmtpConfig {
  host: string;
  port?: number;
  user: string;
  pass: string;
  starttls?: boolean;
}

export type SmtpSendPhase = "pre_send" | "sent" | "unknown";
export type SmtpSendResult = { ok: boolean; phase: SmtpSendPhase; error?: string; queueLine?: string };

function assertEmail(addr: string, field: string): void {
  const v = String(addr ?? "").trim();
  if (!/^[^\s@<>,;:"']+@[^\s@<>,;:"'@]+\.[^\s@<>,;:"']+$/.test(v) || /[\r\n]/.test(v)) {
    throw new Error(`smtp_invalid_${field}`);
  }
}

interface SmtpSession {
  socket: any;
  reader: SocketReader;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  send(line: string): Promise<void>;
  readUntil(prefixes: string[]): Promise<string>;
}

async function openAuthenticatedSmtp(cfg: SmtpConfig): Promise<SmtpSession> {
  const connectFn = await getConnect();
  const port = cfg.port ?? 465;
  let socket: any = connectFn(
    { hostname: cfg.host, port },
    { secureTransport: cfg.starttls ? "starttls" : "on", allowHalfOpen: false },
  );
  let writer = socket.writable.getWriter();
  let reader = new SocketReader(socket);
  const enc = new TextEncoder();
  const send = async (line: string) => writer.write(enc.encode(line + "\r\n"));


  const SMTP_STAGE_BUDGET_MS = 20_000;
  const readUntil = async (prefixes: string[], budgetMs: number = SMTP_STAGE_BUDGET_MS): Promise<string> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) {
        await reader.destroy(new Error("smtp_stage_timeout"));
        throw new Error("smtp_stage_timeout");
      }
      const line = await reader.readLine(Math.min(remain, SMTP_STAGE_BUDGET_MS));
      if (prefixes.some((p) => line.startsWith(p))) return line;
    }
  };
  const readEhloCaps = async (): Promise<string> => {
    const lines: string[] = [];
    const deadline = Date.now() + SMTP_STAGE_BUDGET_MS;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) {
        await reader.destroy(new Error("smtp_stage_timeout"));
        throw new Error("smtp_stage_timeout");
      }
      const line = await reader.readLine(Math.min(remain, SMTP_STAGE_BUDGET_MS));
      lines.push(line);
      if (line.startsWith("250 ")) break;
      if (!line.startsWith("250-")) throw new Error(`smtp_ehlo: ${line.slice(0, 80)}`);
    }
    return lines.join("\n").toUpperCase();
  };

  try {
    await readUntil(["220"]);
    await send(`EHLO openinst.local`);
    let caps = await readEhloCaps();

    if (cfg.starttls) {
      if (!caps.includes("STARTTLS")) throw new Error("smtp_starttls_not_supported");
      await send("STARTTLS");
      const ready = await readUntil(["220", "4", "5"]);
      if (!ready.startsWith("220")) throw new Error(`smtp_starttls_rejected: ${ready.slice(0, 80)}`);
      try { await writer.releaseLock(); } catch {}
      reader = null as unknown as SocketReader;
      writer = null as unknown as WritableStreamDefaultWriter<Uint8Array>;
      let upgraded: any;
      try {
        upgraded = await socket.startTls();
      } catch (e) {
        throw new Error(`smtp_starttls_failed: ${String(e).slice(0, 120)}`);
      }
      if (!upgraded) throw new Error("smtp_starttls_failed: no_socket");
      socket = upgraded;
      writer = socket.writable.getWriter();
      reader = new SocketReader(socket);
      await send(`EHLO openinst.local`);
      caps = await readEhloCaps();
    }

    if (!caps.includes("AUTH")) throw new Error("smtp_auth_not_advertised");
    await send("AUTH LOGIN");
    await readUntil(["334"]);
    await send(btoa(cfg.user));
    await readUntil(["334"]);
    await send(btoa(cfg.pass));
    const auth = await reader.readLine();
    if (!auth.startsWith("235")) throw new Error(`smtp_auth_failed: ${auth.slice(0, 80)}`);
    return { socket, reader, writer, send, readUntil };
  } catch (e) {
    try { await writer.releaseLock(); } catch {}
    try { socket.close(); } catch {}
    throw e;
  }
}

export async function smtpSend(
  cfg: SmtpConfig,
  mail: { from: string; to: string; subject: string; body: string },
): Promise<SmtpSendResult> {
  try {
    assertEmail(mail.from, "from");
    assertEmail(mail.to, "to");
  } catch (e) {
    return { ok: false, phase: "pre_send", error: String(e) };
  }
  let session: SmtpSession;
  try {
    session = await openAuthenticatedSmtp(cfg);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return { ok: false, phase: "pre_send", error: msg.slice(0, 200) };
  }
  const { socket, reader, writer, send, readUntil } = session;
  try {
    await send(`MAIL FROM:<${mail.from}>`);
    await readUntil(["250"]);
    await send(`RCPT TO:<${mail.to}>`);
    await readUntil(["250"]);
    await send("DATA");
    let dataResp: string;
    try {
      dataResp = await readUntil(["354", "5", "4"]);
    } catch (e) {
      return { ok: false, phase: "unknown", error: `smtp_data_unknown: ${e}` };
    }
    if (!dataResp.startsWith("354")) return { ok: false, phase: "pre_send", error: `smtp_data_refused: ${dataResp.slice(0, 80)}` };
    const headers =
      `From: <${mail.from}>\r\nTo: <${mail.to}>\r\n` +
      `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(mail.subject)))}?=\r\n` +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
    const body = mail.body.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
    await send(headers + body + "\r\n.");
    let done: string;
    try {
      done = await reader.readLine();
    } catch (e) {
      return { ok: false, phase: "unknown", error: `smtp_final_unknown: ${e}` };
    }
    if (!done.startsWith("250")) {
      return { ok: false, phase: "pre_send", error: `smtp_data: ${done.slice(0, 80)}` };
    }
    await send("QUIT");
    return { ok: true, phase: "sent", queueLine: done.slice(0, 80) };
  } catch (e) {
    return { ok: false, phase: "unknown", error: String(e) };
  } finally {
    try { await writer.releaseLock(); } catch {}
    try { socket.close(); } catch {}
  }
}

export async function smtpVerify(cfg: SmtpConfig): Promise<{ ok: boolean; error?: string }> {
  let session: SmtpSession;
  try {
    session = await openAuthenticatedSmtp(cfg);
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  const { socket, writer, send } = session;
  try {
    await send("QUIT");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  } finally {
    try { await writer.releaseLock(); } catch {}
    try { socket.close(); } catch {}
  }
}

export const CUSTOM_IMAP_PORT = 993;
export const CUSTOM_SMTP_PORTS = [465, 587];
export function validateCustomEndpoint(host: string, port: number, kind: "imap" | "smtp"): { ok: true } | { ok: false; error: string } {
  const h = host.trim().toLowerCase();
  if (!h) return { ok: false, error: "custom_host_empty" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return { ok: false, error: "custom_host_ip_literal_forbidden" };
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localdomain") || h.endsWith(".lan")) {
    return { ok: false, error: "custom_host_private_forbidden" };
  }
  const allowed = kind === "imap" ? [CUSTOM_IMAP_PORT] : CUSTOM_SMTP_PORTS;
  if (!allowed.includes(port)) return { ok: false, error: `custom_port_forbidden_${kind}` };
  return { ok: true };
}
