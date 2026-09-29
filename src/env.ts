export type Channel = "wechat" | "telegram" | "web" | "email" | "a2a";

/** Stable Telegram ingress contract between webhook, queue, and consumer. */
export interface InboundEnvelope {
  v: 1;
  channel: "telegram";
  /** Telegram numeric bot id. The username is mutable and is not a dedupe namespace. */
  botId: string;
  /** Telegram update_id. */
  externalKey: string;
  payload: unknown;
  receivedAt: number;
}

/** Agent Mail queue dispatch contract. */
export interface EmailDispatchEnvelope {
  v: 1;
  kind: "agent_mail_dispatch";
  rowId: string;
  workspaceId: string;
  enqueuedAt: number;
}

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  KV: KVNamespace;
  ASSETS: Fetcher;
  AI: any;
  BROWSER: Fetcher;
  AGENT: DurableObjectNamespace;
  BROWSER_WORKER: DurableObjectNamespace;
  TOKEN_BROKER?: DurableObjectNamespace;
  WECHAT_POLLER: DurableObjectNamespace;
  INBOUND_QUEUE: Queue<InboundEnvelope>;
  EMAIL_DISPATCH_QUEUE?: Queue<EmailDispatchEnvelope>;

  QUEUE_ENABLED: string;
  TELEGRAM_ENABLED?: string;
  WECHAT_ENABLED?: string;
  MODEL_PROVIDER: "workers-ai" | "openai";
  MODEL_ROOT: string;
  MODEL_WORKER: string;
  /** Optional operator safety override; absent means the provider owns its context limit. */
  MODEL_MAX_CONTEXT?: string;
  BROWSER_PERCEPTION: "hybrid" | "a11y" | "vision";
  BROWSER_MAX_CONCURRENT: string;
  /** Optional technical safety limits for browser tasks. */
  BROWSER_MAX_STEPS?: string;
  BROWSER_TASK_TIMEOUT_MS?: string;
  PUBLIC_BASE_URL: string;
  /** Optional host for connector OAuth redirect URIs; defaults to PUBLIC_BASE_URL. */
  CONNECTOR_OAUTH_BASE_URL?: string;

  OPENINST_SECRET: string;
  VAULT_MASTER_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  WECHAT_TOKEN_KEY?: string;
  ADMIN_KEY?: string;
  /** Set by the Deploy button build: until this ISO time, a fresh instance without ADMIN_KEY can be claimed in the browser. */
  SETUP_CLAIM_UNTIL?: string;
  /** Local development escape hatch only. Never enable in a deployed instance. */
  ALLOW_INSECURE_DEV_SESSION?: string;

  AGENT_EMAIL_ENABLED?: string;
  EMAIL_DOMAIN?: string;
  /** Previous agent mailbox domains that keep receiving mail, comma-separated. */
  EMAIL_LEGACY_DOMAINS?: string;
  AGENT_EMAIL_OUTBOUND_ENABLED?: string;
  STRANGER_AUTOREPLY_GLOBAL?: string;
  A2A_ENABLED?: string;
  A2A_HUMAN_FALLBACK_ENABLED?: string;
  EMAIL_THREAD_SECRET?: string;
  A2A_SIGNING_PRIVATE_JWK?: string;
  A2A_SIGNING_PUBLIC_JWKS_JSON?: string;
  EMAIL_INBOUND_MAX_BYTES?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Google authorization scope profile. Adapter policy decides which profile is allowed;
   * core connector code should not infer product edition from this value.
   */
  GOOGLE_OAUTH_SCOPE_PROFILE?: "no_casa" | "self_hosted_full";
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;

  MODEL_BASE_URL?: string;
  MODEL_API_KEY?: string;

  EXPECTED_ACCOUNT_ID?: string;

  /**
   * Browser Live View REST surface (§24.2). Only required when the readonly
   * surface is resolved to "rest"; the binding path needs no credential.
   * Server-side secrets: never serialized into cards, grants, HTML or logs.
   */
  BROWSER_LIVE_VIEW_READONLY_SURFACE?: "binding" | "rest" | "unavailable";
  BROWSER_LIVE_VIEW_ACCOUNT_ID?: string;
  BROWSER_LIVE_VIEW_API_TOKEN?: string;
  BROWSER_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;

  FINANCE_TOOLS_ENABLED?: string;
  WECHAT_TYPING_ENABLED?: string;
  TOOL_DSL_SANITIZER_ENABLED?: string;

  TRUSTED_PEOPLE_ENABLED?: string;
  TRUSTED_PEOPLE_CROSS_ISSUER_ENABLED?: string;
  TOTP_ENABLED?: string;
  TOTP_ENROLLMENT_ENABLED?: string;
  A2A_ISSUER?: string;
}

export interface SessionInfo {
  userId: string;
  workspaceId: string;
}
