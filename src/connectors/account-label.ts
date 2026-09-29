



export function normalizeAccountLabel(provider: string, label: string): string {
  const v = (label ?? "").trim();
  if (provider === "google" || provider === "mailbox") return v.toLowerCase();
  if (provider === "github") return v.toLowerCase();
  return v;
}

export function connectorSlotKey(provider: string, label: string): string {
  const normalized = normalizeAccountLabel(provider, label);
  return provider === "mailbox"
    ? `mailbox:${normalized}`
    : `oauth:${provider}:${normalized}`;
}


export function tokenBrokerId(workspaceId: string, provider: string, accountLabel: string): string {
  return `${workspaceId}|${provider}|${accountLabel}`;
}
