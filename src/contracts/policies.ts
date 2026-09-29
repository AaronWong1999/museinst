/**
 * contracts/policies.ts — Neutral runtime policy contracts for MuseInst.
 *
 * Open source core provides defaults (unrestricted single-tenant execution).
 * Enterprise / hosted platforms install policy adapters to implement multi-tenant
 * admission, quotas, retention, and billing without coupling core code to commercial concepts.
 */

export interface Principal {
  userId: string;
  workspaceId: string;
  displayName?: string;
  isAdmin?: boolean;
}

export interface AdmissionDecision {
  allow: boolean;
  reason?: string;
  userMessage?: string;
}

export interface OperationDecision {
  allow: boolean;
  reason?: string;
}

export interface ModelSelection {
  model: string;
  provider: string;
  baseUrl?: string;
}

export interface HistoryPolicy {
  cutoffMs: number;
}

export interface ConnectorPolicy {
  maxConnectors: number | null;
}

export interface UsageEvent {
  eventId: string;
  workspaceId: string;
  taskId?: string;
  source: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  browserMs?: number;
  estimatedUsd?: number;
  timestamp: number;
}

export interface RuntimePolicies {
  authenticate?(request: Request, env: any): Promise<Principal | null>;
  admitExecution?(context: { workspaceId: string; channel: string }): Promise<AdmissionDecision>;
  authorizeOperation?(request: { workspaceId: string; operation: string }): Promise<OperationDecision>;
  resolveModel?(request: { workspaceId: string; role: "root" | "worker" }): Promise<ModelSelection | null>;
  taskHistoryPolicy?(context: { workspaceId: string }): Promise<HistoryPolicy>;
  connectorPolicy?(context: { workspaceId: string }): Promise<ConnectorPolicy>;
  recordUsage?(event: UsageEvent): Promise<void>;
}

export interface RuntimeIdentity {
  productName: string;
  agentDefaultName: string;
}

export const DEFAULT_RUNTIME_IDENTITY: RuntimeIdentity = {
  productName: "MuseInst",
  agentDefaultName: "MuseInst",
};
