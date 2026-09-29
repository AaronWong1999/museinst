
//





import type { Env } from "../env";
import { b64decode, b64encode, newId, now, utf8 } from "../util";
import { validatePaymentCard, detectCardBrand, type CardValidationResult } from "./card";
import { parseCsv, parseChromePasswordsCsv, importChromePasswords, type ChromePasswordEntry, type CsvImportResult } from "./csv-import";

export * from "./card";
export * from "./csv-import";
export * from "./totp";

export type VaultKind = "login" | "payment" | "address" | "contact" | "phone" | "identity" | "token";

export interface VaultItemMeta {
  id: string;
  kind: VaultKind;
  label: string;
  account: string;
  origin?: string;
  hasTotp?: boolean;
  has_totp?: number;
  createdAt: number;
  updatedAt: number;
}

async function masterKeyBytes(env: Env): Promise<CryptoKey> {
  const raw = env.VAULT_MASTER_KEY || env.OPENINST_SECRET || "";
  if (raw.length < 16) throw new Error("vault_master_key_not_configured");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = b64decode(raw);
  } catch {
    bytes = utf8(raw);
  }
  if (bytes.length < 16) throw new Error("vault_master_key_too_short");
  return crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
}


export async function workspaceDek(env: Env, workspaceId: string): Promise<CryptoKey> {
  const mk = await masterKeyBytes(env);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(workspaceId), info: utf8("openinst-vault-dek-v1") },
    mk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVaultPayload(
  env: Env,
  workspaceId: string,
  itemId: string,
  fieldsJson: string,
): Promise<string> {
  const dek = await workspaceDek(env, workspaceId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(`${workspaceId}:${itemId}`) },
    dek,
    utf8(fieldsJson),
  );
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ct), iv.length);
  return "vault:v1:" + b64encode(packed);
}

export async function decryptVaultPayload(
  env: Env,
  workspaceId: string,
  itemId: string,
  stored: string,
): Promise<string> {
  const dek = await workspaceDek(env, workspaceId);
  const packed = b64decode(stored.replace(/^vault:v1:/, ""));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.slice(0, 12), additionalData: utf8(`${workspaceId}:${itemId}`) },
    dek,
    packed.slice(12),
  );
  return new TextDecoder().decode(plain);
}



export async function putItem(
  env: Env,
  workspaceId: string,
  input: { kind: VaultKind; label: string; account: string; origin?: string; fields: Record<string, string>; id?: string },
): Promise<VaultItemMeta> {
  const id = input.id || newId("vi");
  const t = now();
  const fields = { ...input.fields };
  let account = input.account;
  let origin = input.origin;

  if (input.kind === "payment") {
    const num = fields.number || fields.cardNumber || "";
    if (num) {
      const cardVal = validatePaymentCard({
        number: num,
        expirationMonth: fields.expMonth ? parseInt(fields.expMonth, 10) : undefined,
        expirationYear: fields.expYear ? parseInt(fields.expYear, 10) : undefined,
        securityCode: fields.cvv || fields.securityCode,
      });
      fields.brand = cardVal.brand;
      const clean = num.replace(/\D/g, "");
      if (!account || account === "card") {
        account = `${cardVal.brand} (•••• ${clean.slice(-4)})`;
      }
    }
    // PCI DSS Requirement 3.2: Sensitive Authentication Data (CVV/CVC/securityCode) must never be stored after authorization, even encrypted!
    delete fields.cvv;
    delete fields.securityCode;
  } else if (input.kind === "login") {
    if (origin) {
      origin = validateLoginOrigin(origin) || origin;
    }
  }

  let hasTotp = 0;
  if (input.id) {
    const existingSecret = await env.DB.prepare(
      `SELECT ciphertext FROM encrypted_secrets WHERE workspace_id=? AND namespace='vault' AND id=?`,
    )
      .bind(workspaceId, id)
      .first<{ ciphertext: string }>();
    if (existingSecret) {
      try {
        const oldJson = await decryptVaultPayload(env, workspaceId, id, existingSecret.ciphertext);
        const oldFields = JSON.parse(oldJson) as Record<string, unknown>;
        // Section 21: Vault generic edit preservation
        // Protect internal fields like __totp from being wiped by generic caller
        if (oldFields.__totp && !(fields as Record<string, unknown>).__totp) {
          (fields as Record<string, unknown>).__totp = oldFields.__totp;
        }
      } catch {
        // ignore decrypt failure
      }
    }
    const existingItem = await env.DB.prepare(
      `SELECT has_totp FROM vault_items WHERE workspace_id=? AND id=?`,
    )
      .bind(workspaceId, id)
      .first<{ has_totp: number }>();
    if (existingItem?.has_totp) {
      hasTotp = existingItem.has_totp;
    }
  }
  const totpConfig = (fields as Record<string, unknown>).__totp as { status?: string } | undefined;
  if (totpConfig?.status === "active") {
    hasTotp = 1;
  } else if (totpConfig && totpConfig.status !== "active") {
    hasTotp = 0;
  }

  const ciphertext = await encryptVaultPayload(env, workspaceId, id, JSON.stringify(fields));
  const batch = [
    env.DB.prepare(
      `INSERT INTO vault_items (id, workspace_id, kind, label, account, origin, has_totp, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, label=excluded.label,
         account=excluded.account, origin=excluded.origin, has_totp=excluded.has_totp, updated_at=excluded.updated_at`,
    ).bind(id, workspaceId, input.kind, input.label, account, origin ?? null, hasTotp, t, t),
    env.DB.prepare(
      `INSERT INTO encrypted_secrets (workspace_id, namespace, id, ciphertext, updated_at)
       VALUES (?, 'vault', ?, ?, ?)
       ON CONFLICT(workspace_id, namespace, id) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`,
    ).bind(workspaceId, id, ciphertext, t),
  ];
  await env.DB.batch(batch);
  return { id, kind: input.kind, label: input.label, account, origin, hasTotp: Boolean(hasTotp), has_totp: hasTotp, createdAt: t, updatedAt: t };
}

export async function listItems(env: Env, workspaceId: string): Promise<VaultItemMeta[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, label, account, origin, has_totp, created_at, updated_at
       FROM vault_items WHERE workspace_id=? ORDER BY kind, label`,
  )
    .bind(workspaceId)
    .all<VaultItemMeta & { has_totp: number }>();
  return (results ?? []).map((r) => ({
    ...r,
    hasTotp: Boolean(r.has_totp),
  }));
}

export async function getItemMeta(
  env: Env,
  workspaceId: string,
  itemId: string,
): Promise<VaultItemMeta | null> {
  const row = await env.DB.prepare(
    `SELECT id, kind, label, account, origin, has_totp, created_at, updated_at
       FROM vault_items WHERE workspace_id=? AND id=?`,
  )
    .bind(workspaceId, itemId)
    .first<VaultItemMeta & { has_totp: number }>();
  if (!row) return null;
  return {
    ...row,
    hasTotp: Boolean(row.has_totp),
  };
}


export async function getItemFields(
  env: Env,
  workspaceId: string,
  itemId: string,
): Promise<Record<string, string> | null> {
  const row = await env.DB.prepare(
    `SELECT ciphertext FROM encrypted_secrets WHERE workspace_id=? AND namespace='vault' AND id=?`,
  )
    .bind(workspaceId, itemId)
    .first<{ ciphertext: string }>();
  if (!row) return null;
  return JSON.parse(await decryptVaultPayload(env, workspaceId, itemId, row.ciphertext));
}



export function deleteItemStatements(env: Env, workspaceId: string, itemId: string) {
  return [
    env.DB.prepare("DELETE FROM vault_items WHERE workspace_id=? AND id=?").bind(workspaceId, itemId),
    env.DB.prepare("DELETE FROM encrypted_secrets WHERE workspace_id=? AND namespace='vault' AND id=?").bind(workspaceId, itemId),
  ];
}

export async function deleteItem(env: Env, workspaceId: string, itemId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM vault_items WHERE workspace_id=? AND id=?`).bind(workspaceId, itemId),
    env.DB.prepare(`DELETE FROM encrypted_secrets WHERE workspace_id=? AND namespace='vault' AND id=?`).bind(workspaceId, itemId),
  ]);
}




export { chromeCsvToItems } from "./csv-import";


export function validateLoginOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}
