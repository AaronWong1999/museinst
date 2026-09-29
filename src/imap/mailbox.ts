



import type { Env } from "../env";
import { PRESETS, type ImapConfig, type SmtpConfig } from "./imap";
import { getItemFields, type VaultItemMeta } from "../vault/service";

export interface MailboxResolved {
  provider: string;
  email: string;
  imap: ImapConfig;
  smtp: SmtpConfig;
  itemId: string;
}


export async function resolveMailbox(
  env: Env,
  workspaceId: string,
  priorityProviderOrAccount?: string,
): Promise<MailboxResolved | null> {
  const items = (await env.DB.prepare(
    `SELECT id, kind, label, account, origin FROM vault_items
      WHERE workspace_id=? AND kind IN ('token','login') ORDER BY updated_at DESC`,
  )
    .bind(workspaceId)
    .all<VaultItemMeta & { origin: string | null }>()) as any;
  const rows: VaultItemMeta[] = items.results ?? [];

  const candidates = rows
    .map((r) => {
      const presetKey = r.label.toLowerCase().replace(/\s+/g, "");
      const fromOrigin = r.origin?.match(/^imap:\/\/([^/]+)/)?.[1];
      const preset =
        PRESETS[presetKey] ??
        Object.entries(PRESETS).find(([, p]) => p.host === fromOrigin)?.[1];
      if (!preset) return null;
      const provider = Object.entries(PRESETS).find(([, p]) => p.host === preset.host)?.[0] ?? presetKey;
      return { item: r, preset, provider };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (candidates.length === 0) return null;

  let chosen: (typeof candidates)[0] | null = null;
  if (priorityProviderOrAccount) {
    const q = priorityProviderOrAccount.toLowerCase().trim();
    chosen =
      candidates.find(
        (c) =>
          c.provider.toLowerCase() === q ||
          c.item.account?.toLowerCase() === q ||
          c.item.label?.toLowerCase() === q,
      ) ?? null;

    if (!chosen) return null;
  } else {
    chosen = candidates[0];
  }
  if (!chosen) return null;

  const fields = await getItemFields(env, workspaceId, chosen.item.id);
  if (!fields?.authCode && !fields?.password) return null;
  const pass = fields.authCode || fields.password;
  const email = fields.account || fields.email || chosen.item.account;
  if (!email) return null;
  return {
    provider: chosen.provider,
    email,
    itemId: chosen.item.id,
    imap: { host: chosen.preset.host, port: 993, user: email, pass, sendId: chosen.preset.sendId },
    smtp: { host: chosen.preset.smtpHost, port: chosen.preset.smtpPort, user: email, pass },
  };
}
