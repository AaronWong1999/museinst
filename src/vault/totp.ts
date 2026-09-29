// vault/totp.ts — RFC 6238 TOTP primitive & Vault __totp internal field service.
// Strict security bounds: TOTP secret and generated codes NEVER leave encrypted storage or leak to model.

import type { Env } from "../env";
import { now } from "../util";
import { decryptVaultPayload, encryptVaultPayload, getItemMeta } from "./service";

export interface VaultTotpConfig {
  status: "pending" | "active";
  secretBase32: string;
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: 6 | 8;
  period: number;
  issuer?: string;
  accountName?: string;
  enrolledOrigin?: string;
  createdAt: number;
  verifiedAt?: number;
}

function flagOn(value: unknown): boolean {
  return value === "1" || value === "true" || value === true;
}

export function parseBase32Secret(input: string): Uint8Array {
  if (typeof input !== "string") throw new Error("invalid_totp_secret");
  // Spaces/hyphens and RFC padding are tolerated; '_' is not Base32 and must not be silently erased.
  const clean = input.replace(/[\s\-=]/g, "").toUpperCase();
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) throw new Error("invalid_totp_secret");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val === -1) throw new Error("invalid_totp_secret");
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (output.length < 10) throw new Error("invalid_totp_secret");
  return new Uint8Array(output);
}

function validateConfig(
  config: Omit<VaultTotpConfig, "status" | "createdAt">,
): { ok: true; config: Omit<VaultTotpConfig, "status" | "createdAt"> } | { ok: false; error: string } {
  try {
    parseBase32Secret(config.secretBase32);
  } catch {
    return { ok: false, error: "invalid_totp_secret" };
  }
  if (config.algorithm !== "SHA1" && config.algorithm !== "SHA256" && config.algorithm !== "SHA512") {
    return { ok: false, error: "unsupported_algorithm" };
  }
  if (config.digits !== 6 && config.digits !== 8) return { ok: false, error: "unsupported_digits" };
  if (!Number.isInteger(config.period) || config.period < 15 || config.period > 120) {
    return { ok: false, error: "period_out_of_bounds" };
  }
  if ((config.issuer?.length ?? 0) > 100 || (config.accountName?.length ?? 0) > 150 || (config.enrolledOrigin?.length ?? 0) > 512) {
    return { ok: false, error: "totp_metadata_too_long" };
  }
  return { ok: true, config };
}

export function parseOtpAuthUri(uri: string): { ok: true; config: Omit<VaultTotpConfig, "status" | "createdAt"> } | { ok: false; error: string } {
  if (typeof uri !== "string" || uri.length > 1024) return { ok: false, error: "invalid_uri_length" };
  const trimmed = uri.trim();
  if (trimmed.startsWith("otpauth://hotp/")) return { ok: false, error: "unsupported_otp_type" };
  if (!trimmed.startsWith("otpauth://totp/")) return { ok: false, error: "invalid_uri_scheme" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "malformed_uri" };
  }

  const rawSecret = url.searchParams.get("secret");
  if (!rawSecret) return { ok: false, error: "missing_secret" };
  try {
    parseBase32Secret(rawSecret);
  } catch {
    return { ok: false, error: "invalid_totp_secret" };
  }
  const secretBase32 = rawSecret.replace(/[\s\-=]/g, "").toUpperCase();

  const rawAlgo = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  let algorithm: "SHA1" | "SHA256" | "SHA512" = "SHA1";
  if (rawAlgo === "SHA256" || rawAlgo === "SHA-256") algorithm = "SHA256";
  else if (rawAlgo === "SHA512" || rawAlgo === "SHA-512") algorithm = "SHA512";
  else if (rawAlgo !== "SHA1" && rawAlgo !== "SHA-1") return { ok: false, error: "unsupported_algorithm" };

  const rawDigits = url.searchParams.get("digits");
  let digits: 6 | 8 = 6;
  if (rawDigits) {
    const d = Number(rawDigits);
    if (d === 8) digits = 8;
    else if (d !== 6) return { ok: false, error: "unsupported_digits" };
  }

  const rawPeriod = url.searchParams.get("period");
  let period = 30;
  if (rawPeriod) {
    const p = Number(rawPeriod);
    if (!Number.isInteger(p) || p < 15 || p > 120) return { ok: false, error: "period_out_of_bounds" };
    period = p;
  }

  const issuer = url.searchParams.get("issuer")?.slice(0, 100) ?? undefined;
  let label = "";
  try {
    label = decodeURIComponent(url.pathname.replace(/^\//, "")).slice(0, 150);
  } catch {
    return { ok: false, error: "malformed_uri" };
  }
  let accountName: string | undefined;
  if (label) {
    const parts = label.split(":");
    accountName = parts.length > 1 ? parts.slice(1).join(":").trim() : parts[0].trim();
  }

  const result = validateConfig({ secretBase32, algorithm, digits, period, issuer, accountName });
  return result.ok ? result : { ok: false, error: result.error };
}

export async function generateTotp(
  config: { secretBase32: string; algorithm?: "SHA1" | "SHA256" | "SHA512"; digits?: 6 | 8; period?: number },
  nowMs: number = Date.now(),
): Promise<string> {
  const algo = (config.algorithm ?? "SHA1").toUpperCase();
  if (algo !== "SHA1" && algo !== "SHA256" && algo !== "SHA512") throw new Error("unsupported_algorithm");
  const hashName = algo === "SHA256" ? "SHA-256" : algo === "SHA512" ? "SHA-512" : "SHA-1";
  const digits = config.digits ?? 6;
  if (digits !== 6 && digits !== 8) throw new Error("unsupported_digits");
  const period = Number(config.period ?? 30);
  if (!Number.isInteger(period) || period < 15 || period > 120) throw new Error("period_out_of_bounds");

  const keyBytes = parseBase32Secret(config.secretBase32);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: { name: hashName } },
    false,
    ["sign"],
  );

  const counter = Math.floor(Math.floor(nowMs / 1000) / period);
  const counterBuffer = new ArrayBuffer(8);
  const counterView = new DataView(counterBuffer);
  counterView.setUint32(0, Math.floor(counter / 0x100000000), false);
  counterView.setUint32(4, counter >>> 0, false);

  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBuffer));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (binary % Math.pow(10, digits)).toString().padStart(digits, "0");
}

async function loadDecryptedLoginFields(
  env: Env,
  workspaceId: string,
  itemId: string,
): Promise<{ ok: true; fields: Record<string, unknown> } | { ok: false; error: string }> {
  const meta = await getItemMeta(env, workspaceId, itemId);
  if (!meta) return { ok: false, error: "item_not_found" };
  if (meta.kind !== "login") return { ok: false, error: "not_a_login_item" };

  const row = await env.DB.prepare(`SELECT ciphertext FROM encrypted_secrets WHERE workspace_id=? AND namespace='vault' AND id=?`)
    .bind(workspaceId, itemId).first<{ ciphertext: string }>();
  if (!row) return { ok: false, error: "secret_not_found" };
  try {
    return { ok: true, fields: JSON.parse(await decryptVaultPayload(env, workspaceId, itemId, row.ciphertext)) as Record<string, unknown> };
  } catch {
    return { ok: false, error: "decrypt_failed" };
  }
}

async function saveEncryptedLoginFields(
  env: Env,
  workspaceId: string,
  itemId: string,
  fields: Record<string, unknown>,
  hasTotp: number,
): Promise<void> {
  const t = now();
  const ciphertext = await encryptVaultPayload(env, workspaceId, itemId, JSON.stringify(fields));
  await env.DB.batch([
    env.DB.prepare(`UPDATE encrypted_secrets SET ciphertext=?, updated_at=? WHERE workspace_id=? AND namespace='vault' AND id=?`)
      .bind(ciphertext, t, workspaceId, itemId),
    env.DB.prepare(`UPDATE vault_items SET has_totp=?, updated_at=? WHERE workspace_id=? AND id=?`)
      .bind(hasTotp, t, workspaceId, itemId),
  ]);
}

export async function setLoginTotpPending(
  env: Env,
  workspaceId: string,
  itemId: string,
  config: Omit<VaultTotpConfig, "status" | "createdAt">,
): Promise<{ ok: boolean; error?: string }> {
  if (!flagOn(env.TOTP_ENABLED)) return { ok: false, error: "totp_disabled" };
  if (!flagOn(env.TOTP_ENROLLMENT_ENABLED)) return { ok: false, error: "totp_enrollment_disabled" };
  const checked = validateConfig(config);
  if (!checked.ok) return checked;
  const loaded = await loadDecryptedLoginFields(env, workspaceId, itemId);
  if (!loaded.ok) return loaded;
  loaded.fields.__totp = { ...checked.config, status: "pending", createdAt: now() } satisfies VaultTotpConfig;
  await saveEncryptedLoginFields(env, workspaceId, itemId, loaded.fields, 0);
  return { ok: true };
}

export async function importLoginTotpActive(
  env: Env,
  workspaceId: string,
  itemId: string,
  config: Omit<VaultTotpConfig, "status" | "createdAt">,
): Promise<{ ok: boolean; error?: string }> {
  if (!flagOn(env.TOTP_ENABLED)) return { ok: false, error: "totp_disabled" };
  const checked = validateConfig(config);
  if (!checked.ok) return checked;
  const loaded = await loadDecryptedLoginFields(env, workspaceId, itemId);
  if (!loaded.ok) return loaded;
  const t = now();
  loaded.fields.__totp = { ...checked.config, status: "active", createdAt: t, verifiedAt: t } satisfies VaultTotpConfig;
  await saveEncryptedLoginFields(env, workspaceId, itemId, loaded.fields, 1);
  return { ok: true };
}

export async function activateLoginTotp(
  env: Env,
  workspaceId: string,
  itemId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!flagOn(env.TOTP_ENABLED)) return { ok: false, error: "totp_disabled" };
  if (!flagOn(env.TOTP_ENROLLMENT_ENABLED)) return { ok: false, error: "totp_enrollment_disabled" };
  const loaded = await loadDecryptedLoginFields(env, workspaceId, itemId);
  if (!loaded.ok) return loaded;
  const current = loaded.fields.__totp as VaultTotpConfig | undefined;
  if (!current || !current.secretBase32) return { ok: false, error: "no_totp_configured" };
  const checked = validateConfig(current);
  if (!checked.ok) return checked;
  current.status = "active";
  current.verifiedAt = now();
  loaded.fields.__totp = current;
  await saveEncryptedLoginFields(env, workspaceId, itemId, loaded.fields, 1);
  return { ok: true };
}

export async function removeLoginTotp(
  env: Env,
  workspaceId: string,
  itemId: string,
): Promise<{ ok: boolean; error?: string }> {
  const loaded = await loadDecryptedLoginFields(env, workspaceId, itemId);
  if (!loaded.ok) return loaded;
  delete loaded.fields.__totp;
  await saveEncryptedLoginFields(env, workspaceId, itemId, loaded.fields, 0);
  return { ok: true };
}

export async function getLoginTotpStatus(
  env: Env,
  workspaceId: string,
  itemId: string,
): Promise<{ configured: boolean; status?: "pending" | "active"; algorithm?: string; digits?: number; period?: number; issuer?: string; accountName?: string } | null> {
  const loaded = await loadDecryptedLoginFields(env, workspaceId, itemId);
  if (!loaded.ok) return null;
  const current = loaded.fields.__totp as VaultTotpConfig | undefined;
  if (!current) return { configured: false };
  return {
    configured: current.status === "active",
    status: current.status,
    algorithm: current.algorithm,
    digits: current.digits,
    period: current.period,
    issuer: current.issuer,
    accountName: current.accountName,
  };
}

export async function getLoginTotpCode(
  env: Env,
  workspaceId: string,
  itemId: string,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; code?: string; remainingSeconds?: number; error?: string }> {
  if (!flagOn(env.TOTP_ENABLED)) return { ok: false, error: "totp_disabled" };
  const loaded = await loadDecryptedLoginFields(env, workspaceId, itemId);
  if (!loaded.ok) return loaded;
  const current = loaded.fields.__totp as VaultTotpConfig | undefined;
  if (!current || current.status !== "active") return { ok: false, error: "totp_not_active" };
  const checked = validateConfig(current);
  if (!checked.ok) return checked;
  const period = current.period;
  const seconds = Math.floor(nowMs / 1000);
  const remainingSeconds = period - (seconds % period);
  return { ok: true, code: await generateTotp(current, nowMs), remainingSeconds };
}
