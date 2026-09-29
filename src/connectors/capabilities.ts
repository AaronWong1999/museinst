


export interface ConnectorCapability {
  id: string;

  enabled: boolean;

  multiAccount: boolean;

  multiInstallation?: boolean;
}

export const CAPABILITIES: Record<string, ConnectorCapability> = {
  google: { id: "google", enabled: true, multiAccount: true },
  github: { id: "github", enabled: true, multiAccount: true, multiInstallation: true },
  feishu: { id: "feishu", enabled: true, multiAccount: false },
  lark: { id: "lark", enabled: true, multiAccount: false },
  mailbox: { id: "mailbox", enabled: true, multiAccount: true },
  slack: { id: "slack", enabled: false, multiAccount: false }, // V1 not active
  linear: { id: "linear", enabled: false, multiAccount: false }, // V1 not active
};

export function isConnectorEnabled(id: string): boolean {
  return CAPABILITIES[id]?.enabled === true;
}
