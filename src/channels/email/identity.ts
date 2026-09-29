


import type { Env } from "../../env";
import type { ContactClass, EmailIdentityFacts, MessageAuth } from "../../security/context";
import { sha256hex } from "../../crypto";

export function canonicalAddress(addr: string): string {
  return String(addr ?? "").trim().toLowerCase();
}

export async function peerHash(addr: string): Promise<string> {
  return sha256hex(canonicalAddress(addr));
}

export async function getContactFacts(
  env: Env,
  workspaceId: string,
  peerAddress: string,
): Promise<{ contactClass: ContactClass; addressVerifiedByOwner: boolean }> {
  const row = await env.DB.prepare(
    `SELECT contact_class, address_verified_by_owner FROM email_contacts WHERE workspace_id=? AND address=?`,
  )
    .bind(workspaceId, canonicalAddress(peerAddress))
    .first<{ contact_class: string; address_verified_by_owner: number }>()
    .catch(() => null);
  const contactClass: ContactClass =
    row?.contact_class === "known" || row?.contact_class === "blocked" ? row.contact_class : "unknown";
  return { contactClass, addressVerifiedByOwner: (row?.address_verified_by_owner ?? 0) === 1 };
}





export async function touchContact(
  env: Env,
  workspaceId: string,
  peerAddress: string,
  nowMs = Date.now(),
): Promise<void> {
  const addr = canonicalAddress(peerAddress);
  await env.DB.prepare(
    `INSERT INTO email_contacts (workspace_id, address, contact_class, address_verified_by_owner, first_seen_at, last_seen_at, msg_count)
     VALUES (?, ?, 'unknown', 0, ?, ?, 1)
     ON CONFLICT(workspace_id, address) DO UPDATE SET last_seen_at=excluded.last_seen_at, msg_count=msg_count+1`,
  )
    .bind(workspaceId, addr, nowMs, nowMs)
    .run()
    .catch(() => {});
}


export async function identityForUnauthenticated(
  env: Env,
  workspaceId: string,
  peerAddress: string,
): Promise<EmailIdentityFacts> {
  const c = await getContactFacts(env, workspaceId, peerAddress);
  return {
    peerAddress: canonicalAddress(peerAddress),
    contactClass: c.contactClass,
    addressVerifiedByOwner: c.addressVerifiedByOwner,
    messageAuth: "none" satisfies MessageAuth,
  };
}
