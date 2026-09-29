
//





import { b64decode, b64encode, utf8 } from "./util";

const PREFIX = "enc:v1:";

async function fieldKey(env: import("./env").Env): Promise<CryptoKey> {
  const secret =
    env.WECHAT_TOKEN_KEY || env.OPENINST_SECRET || "";
  if (secret.length < 16) throw new Error("field_crypto_not_configured");
  const digest = await crypto.subtle.digest("SHA-256", utf8(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptField(
  env: import("./env").Env,
  namespace: string,
  value: string,
): Promise<string> {
  if (!value) return "";
  const key = await fieldKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(namespace) },
    key,
    utf8(value),
  );
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ct), iv.length);
  return PREFIX + b64encode(packed);
}

export async function decryptField(
  env: import("./env").Env,
  namespace: string,
  stored: string | null | undefined,
): Promise<string> {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored;
  const packed = b64decode(stored.slice(PREFIX.length));
  if (packed.length < 29) throw new Error("invalid_ciphertext");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.slice(0, 12), additionalData: utf8(namespace) },
    await fieldKey(env),
    packed.slice(12),
  );
  return new TextDecoder().decode(plain);
}



export async function hmacSign(keySecret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(keySecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(payload))));
}

export async function hmacVerify(
  keySecret: string,
  payload: string,
  sig: string,
): Promise<boolean> {
  const expect = await hmacSign(keySecret, payload);
  if (expect.length !== sig.length) return false;

  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export async function sha256hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(s)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}


export async function fingerprint(secret: string): Promise<string> {
  return (await sha256hex(secret)).slice(0, 16);
}
