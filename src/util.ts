

export function newId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("");
  return prefix ? `${prefix}_${s}` : s;
}

export function newSlug(len = 5): string {

  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export function now(): number {
  return Date.now();
}

export function todayDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(headers ?? {}) },
  });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const arr = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as unknown as Uint8Array<ArrayBuffer>;
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function clampText(s: string, maxChars: number): string {

  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `…[截断，原长 ${s.length} 字符]`;
}

export function isFlagOn(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "on";
}






export function isExplicitlyEnabled(v: string | undefined): boolean {
  return v === "1";
}
