// MuseInst shared-core facade.
// Both the self-hosted adapter and Enterprise consume these neutral primitives.
// Self-host-only routes and runtime classes must not be exported from this module.

// Shared Durable Objects.
export { TokenBroker } from "../connectors/token-broker";
export { PersonalAgent } from "../agent/personal-agent";
export { BrowserWorker } from "../agent/browser-worker";

// Agent RPC.
export { agentFetch } from "../agent/rpc";

// Shared authenticated/core API router.
export { coreApiApp } from "./router";

// Channel dispatch and normalization.
export { dispatchChannelEvent, dispatchExternalEmail } from "../channels/dispatch";
export {
  type ChannelEvent,
  type MediaKind,
  textEvent,
} from "../channels/normalize";

// Telegram protocol primitives.
export {
  type TgUpdate,
  parseUpdate,
  transcribeVoice,
  setWebhook as setTelegramWebhook,
  getWebhookInfo as getTelegramWebhookInfo,
  handleTelegramWebhook,
  setupTelegramBot,
  timingSafeEqual,
} from "../channels/telegram";

// Telegram reliable-ingress and send-checkpoint primitives.
export { consumeInboundEnvelope, inboxStats, bumpMetric, type ConsumeOutcome } from "../channels/inbox";
export { stageOutbox, drainTelegramOutbox, outboxStats, type DrainResult } from "../channels/outbox";

// WeChat iLink protocol primitives. The self-hosted Poller Durable Object is intentionally excluded.
export {
  fetchLoginQrCode,
  pollQrStatus,
  ilinkGetUpdates,
  ilinkSendMessage,
  ilinkSendTyping,
  type QrStatusResult,
  type QrCodeResult,
} from "../channels/wechat/ilink";

// Outbound messaging.
export {
  sendOutbound,
  telegramSend,
  telegramTyping,
  enqueueWechatOutbox,
  dequeueWechatOutbox,
  markOutboxDelivered,
  splitText,
  type OutboundOptions,
} from "../channels/outbound";

// Channel runtime primitives used by both adapters.
export {
  getTelegramToken,
  setTelegramToken,
  getTelegramBotId,
  setTelegramBotId,
  telegramGetMe,
  getTelegramUsername,
  setTelegramUsername,
  getTelegramWebhookSecret,
  ensureTelegramWebhookSecret,
  telegramConfigured,
  wechatConfigured,
  isAdmin,
} from "../channels/config";

// Bind and login-code primitives. Adapter-specific admission stays outside core.
export {
  createLoginNonce,
  createBindCode,
  getOrCreateBindCode,
} from "../channels/dispatch";

// Identity primitives.
export {
  createWorkspace,
  resolveIdentity,
  bindChannelIdentity,
  unbindChannelIdentity,
  type BindResult,
  type ResolvedIdentity,
  DUPLICATE_BIND_COPY,
  COOLDOWN_DAYS,
} from "../identity";

// Session primitives. Enterprise authentication is injected through host hooks.
export {
  createSession,
  readSession,
  sessionCookieHeader,
  clearSessionHeader,
  consumeLoginNonceAndCreateSession,
  COOKIE_NAME,
} from "../session";

// Crypto.
export {
  encryptField,
  decryptField,
  hmacSign,
  hmacVerify,
  sha256hex,
  fingerprint,
} from "../crypto";

// Email transport, MIME, thread and outbox primitives.
// Platform adapters should use reliable ingress so transient durable failures are not acknowledged permanently.
export { handleInboundEmail, inboundFingerprint, APP_MAX_INBOUND_BYTES } from "../channels/email/reliable-ingress";
export { parseEmail, cleanBodyText, snippetOf } from "../channels/email/parse";
export { classifyProtocol, screenOrdinary } from "../channels/email/screen";
export { resolveMailbox, registerMailbox, normalizeThread, acceptedMailboxDomains, currentMailboxAddress } from "../channels/email/mailbox";
export {
  enqueueOutbox,
  sendOutboxRow,
  sweepStuckSending,
  dueOutbox,
  getOutboundMessageId,
  isRetryableSendError,
  isHardSendError,
  type OutboxStatus,
} from "../channels/email/outbox";
export { canonicalAddress, peerHash, getContactFacts, touchContact, identityForUnauthenticated } from "../channels/email/identity";
export { mintThreadCapability, verifyThreadCapability, extractCapabilityToken, buildCapabilityReplyTo } from "../channels/email/thread";
export {
  extractCapabilityRef,
  rotateThreadCapabilityReplyTo,
  createAddressVerificationChallenge,
  completeAddressVerification,
  sendAddressVerificationEmail,
} from "../channels/email/thread";
export { readEmailMessage } from "../channels/email/mailbox";
export {
  findThreadByProviderMessageId,
  retryAcceptedCommit,
  listUncertainOutbox,
  classifySendError,
} from "../channels/email/outbox";

// A2A open protocol primitives.
export { canonicalize, canonicalBytes } from "../channels/email/a2a/canonical";
export { validateEnvelopeShape, validateDiscoveryShape, A2A_PROTOCOL_VERSION } from "../channels/email/a2a/schema";
export { generateSigningKey, signEnvelope, verifyEnvelopeSig, jwkFromX, xFromJwk } from "../channels/email/a2a/sign";
export { discoveryUrl, fetchDiscovery, getCachedKey, storeDiscoveryKeys } from "../channels/email/a2a/discovery";
export { verifyA2aInbound } from "../channels/email/a2a/verify";
export { nextState, stepConvo, TERMINAL_STATES, shouldNotifyHalt } from "../channels/email/a2a/statemachine";
export { serializeDisclosure, readDisclosedFacts } from "../channels/email/a2a/disclosure";
export { renderHumanBody } from "../channels/email/a2a/render";
export { dispatchA2AEvent } from "../channels/email/a2a/dispatch";
export { parseHumanScheduleReply, needsOwnerReview } from "../channels/email/a2a/human-fallback";

// Neutral host extension contract.
export {
  type HostHooks,
  type TaskContext,
  type UsageRecord,
  type UsageContext,
  type TransportDeliveredEvent,
  type ExternalEventClaims,
  type BindAttempt,
  setHostHooks,
  getHostHooks,
  resetHostHooks,
} from "../hooks";

// Security primitives.
export {
  type ContactClass,
  type MessageAuth,
  type EventSource,
  type PromptProfile,
  type SecurityClaims,
  type SecurityContext,
  type EmailIdentityFacts,
  type ApprovalRoute,
  deriveSecurityContext,
  OWNER_GLOBAL_SCOPE,
  emailScopeKey,
  humanA2aScopeKey,
  doIdempotencyKey,
  normalizeParkedState,
} from "../security/context";
export { resolveOwnerApprovalRoute } from "../security/approval-route";

// Copy.
export { chatCopy, type Lang } from "../copy";

// Utilities.
export { newId, newSlug, now, isFlagOn, isExplicitlyEnabled } from "../util";

// Vault.
export {
  listItems as listVaultItems,
  getItemFields as getVaultItemFields,
  getItemMeta as getVaultItemMeta,
  putItem as putVaultItem,
  deleteItem as deleteVaultItem,
  type VaultKind,
  type VaultItemMeta,
} from "../vault/service";

// Environment types.
export type { Env, InboundEnvelope } from "../env";

// Tools and registry.
export { type Tool, type ToolContext, type ToolResult } from "../agent/tool-types";
export { allTools, toolDefs, findTool } from "../agent/tools";
export {
  buildKernelCatalogEntries,
  buildFullCatalog,
  defaultToolSession,
  toolDefsForSession,
  findToolInSession,
  searchAndActivateTools,
  CORE_TOOL_NAMES,
  isDynamicRoutingEnabled,
  TOOL_tool_search_placeholder,
  type ToolCatalogEntry,
  type ToolNamespace,
} from "../agent/tools";
export {
  catalogEntry,
  buildCatalogEntries,
} from "../agent/tool-catalog";
export {
  createToolSession,
  activateNamespace,
  activateTools,
  cleanupStaleNamespaces,
  activeDefsForSession,
  sessionTelemetry,
  type ToolSessionState,
} from "../agent/tool-session";
export {
  ADVANCED_CAPABILITY_MANIFEST,
  manifestText,
  toolSearchDescription,
  toolSearchParameters,
  searchNamespaces,
  executeToolSearch,
  buildToolSearchTool,
} from "../agent/tool-search";
export {
  resolveProvider,
  providerFromResourceRef,
  LARK_FEISHU_FAMILY,
  familyOf,
  type ProviderResolution,
  type ProviderResolutionInput,
} from "../agent/provider-resolver";
export {
  type ExternalEvidence,
  type ExternalErrorCode,
  type ExternalFailure,
  type ExternalOperation,
  type ExternalToolResult,
  type ToolExternalAttachment,
  externalCodeFromConnectorReason,
  externalFailure,
  externalSuccess,
  evidenceFromConnector,
  notConnected,
  serializeEvidenceForLog,
} from "../external/result";

// Capability registry and versioned contracts.
export {
  capabilityRegistry,
  registerCapabilityResolver,
  type CapabilityState,
  type CapabilityContext,
  type CapabilityResolver,
} from "./capabilities";
export * from "../contracts";

export {
  type ExternalClaimViolation,
  type ExternalClaimType,
  type ExternalLedger,
  type ExternalOutcomeRecord,
  externalCorrectionInstruction,
  findExternalCompletionViolations,
  providerForToolName,
  recordFromToolResult,
  stripUnsupportedExternalClaims,
} from "../agent/external-completion-guard";
export { listBindings } from "../identity";
export { resolveEffectiveModel, type EffectiveModel } from "../model/effective";

// Connector surfaces used by thin host adapters; implementation remains in the kernel.
export { connectorSlotKey, normalizeAccountLabel } from "../connectors/account-label";
export { countConnectorSlots, releaseConnectorSlot, reserveConnectorSlot } from "../connectors/slots";
export {
  GOOGLE_HOSTED_SCOPE_DENYLIST,
  GOOGLE_RESTRICTED_SCOPES_DENYLIST,
  GOOGLE_SIGN_IN_SCOPES,
  GOOGLE_WORKSPACE_SCOPES,
  GOOGLE_SCOPES,
  getProvider,
  providers,
} from "../connectors/registry";
export { consumeOAuthState, createOAuthState, normalizeRedirectTo, DEFAULT_REDIRECT_TO } from "../connectors/oauth-state";
export { disconnectProvider, handleOAuthCallback, revokeGrant, type DisconnectResult } from "../connectors/oauth-flow";
export { audit, connectorFailureToExternal, getAccessToken, markNeedsReauth, markOk, withConnectorCall } from "../connectors/token-mark";
export { listAccounts, resolveLabel, upsertConnectedAccount } from "../connectors/token-store";

// GitHub App installation and REST primitives. Workspace mapping belongs to the host adapter.
export {
  clearInstallationTokenCache,
  createGitHubAppJwt,
  createInstallationAccessToken,
  githubAppConfigured,
  githubInstallationFetch,
  githubInstallationJson,
  getGitHubInstallation,
  listUserInstallationsWithToken,
  type GitHubAppEnv,
  type GitHubInstallationInfo,
} from "../connectors/github-app";
export type {
  FetchFn as GitHubFetchFn,
  GithubCodeHit,
  GithubDiff,
  GithubFileRead,
  GithubIssueDetail,
  GithubIssueSummary,
  GithubPrSummary,
  GithubRepoCard,
  GithubRepoMeta,
  GithubTreeEntry,
} from "../connectors/github-api";
export {
  createIssue as githubApiCreateIssue,
  createIssueComment as githubApiCreateIssueComment,
  createPullRequest as githubApiCreatePullRequest,
  listActionRuns as githubApiListActionRuns,
  listCommits as githubApiListCommits,
  listInstallationRepos as githubApiListInstallationRepos,
  listIssuesExcludingPrs as githubApiListIssuesExcludingPrs,
  listPullRequests as githubApiListPullRequests,
  constrainedApiRead as githubApiConstrainedRead,
  readActionRun as githubApiReadActionRun,
  readCommit as githubApiReadCommit,
  readFile as githubApiReadFile,
  readIssue as githubApiReadIssue,
  readPullRequest as githubApiReadPullRequest,
  readPullRequestDiff as githubApiReadPullRequestDiff,
  readRepo as githubApiReadRepo,
  readTree as githubApiReadTree,
  searchCode as githubApiSearchCode,
} from "../connectors/github-api";

// Browser Live View, Grants & State Machine (§14, §29)
export { handleBrowserRoute } from "../browser/routes";
export { BrowserService } from "../browser/service";
export { BrowserGrantRepository, type BrowserAccessGrantRow, type IssuedGrant } from "../browser/grants";
export { RestBrowserLiveViewProvider, type BrowserProviderCapabilities, type ProviderView } from "../browser/provider";
export { transitionBrowserControlState, getWriterPermissions, assertSingleWriter, assertControlEpoch, type BrowserControlState, type BrowserSessionState } from "../browser/state-machine";
export { deliverBrowserHandoff, buildBrowserSessionCard, type HandoffDelivery } from "../browser/cards";

// Files / PDF & Form filling (§15)
export { inspectPdfBytes, fillPdfAcroForm, type PdfInspectionResult, type PdfFieldInfo } from "../files/pdf";

// Goals & Ideas (§16, §17)
export { GoalsService, type GoalRow, type MilestoneRow, type IdeaRow } from "../agent/goals-service";

