
import type { Env, EmailDispatchEnvelope } from "../../env";
import { getHostHooks, type ExternalEventClaims } from "../../hooks";
import { isFlagOn } from "../../util";
import {
  consumeEmailModelAdmission,
  releaseEmailModelAdmission,
} from "./admission";
import {
  resolveMailbox,
  getMailboxSettings,
} from "./mailbox";
import {
  canonicalAddress,
  getContactFacts,
  touchContact,
} from "./identity";
import {
  deriveSecurityContext,
  type MessageAuth,
} from "../../security/context";
import {
  enqueueReply,
  loadPublicFacts,
  resolveOwnerApprovalRouteSafe,
} from "./ingress";
import { dispatchExternalEmail } from "../dispatch";
import { ensureOwnerEmailNotification } from "./notifications";

export type { EmailDispatchEnvelope };

export const EMAIL_AGENT_DISPATCH_BUDGET_MS = 10 * 60_000;
export const EMAIL_DISPATCH_LEASE_MS = 12 * 60_000;
export const MAX_DISPATCH_ATTEMPTS = 5;

export type QueueConsumeResult =
  | { kind: "ack" }
  | { kind: "retry"; delaySeconds?: number };








export async function queueEmailDispatch(
  env: Env,
  params: { rowId: string; workspaceId: string },
): Promise<void> {
  const queue = env.EMAIL_DISPATCH_QUEUE;
  if (!queue) {
    throw new Error("email_dispatch_queue_unconfigured");
  }

  const nowMs = Date.now();
  await queue.send({
    v: 1,
    kind: "agent_mail_dispatch",
    rowId: params.rowId,
    workspaceId: params.workspaceId,
    enqueuedAt: nowMs,
  });

  await env.DB.prepare(
    `UPDATE email_messages SET dispatch_enqueued_at=? WHERE id=? AND workspace_id=?`,
  )
    .bind(nowMs, params.rowId, params.workspaceId)
    .run()
    .catch((e) => console.warn("[dispatch-queue] failed to record dispatch_enqueued_at", params.rowId, e));
}





export async function consumeEmailDispatchEnvelope(
  env: Env,
  envelope: EmailDispatchEnvelope,
): Promise<QueueConsumeResult> {
  const nowMs = Date.now();
  const leaseToken = crypto.randomUUID();
  const leaseUntil = nowMs + EMAIL_DISPATCH_LEASE_MS;


  const cas = await env.DB.prepare(
    `UPDATE email_messages
     SET ingest_state='processing',
         ingest_lease_token=?,
         ingest_lease_until=?,
         processing_started_at=?,
         ingest_attempts=COALESCE(ingest_attempts,0)+1,
         ingest_last_error=NULL
     WHERE id=? AND workspace_id=? AND (
       ingest_state IN ('dispatch_queued', 'dispatch_failed')
       OR (ingest_state='processing' AND (ingest_lease_until IS NULL OR ingest_lease_until < ?))
     )`,
  )
    .bind(leaseToken, leaseUntil, nowMs, envelope.rowId, envelope.workspaceId, nowMs)
    .run()
    .catch((e) => {
      console.error("[dispatch-queue] lease claim error", envelope.rowId, e);
      return null;
    });

  if ((cas?.meta?.changes ?? 0) !== 1) {
    const cur = await env.DB.prepare(
      `SELECT ingest_state, ingest_lease_until FROM email_messages WHERE id=? AND workspace_id=?`,
    )
      .bind(envelope.rowId, envelope.workspaceId)
      .first<{ ingest_state: string; ingest_lease_until: number | null }>();

    if (!cur) return { kind: "ack" };
    if (cur.ingest_state === "processed" || cur.ingest_state.startsWith("stored_") || cur.ingest_state.startsWith("failed_")) {
      return { kind: "ack" };
    }
    if (cur.ingest_state === "processing" && (cur.ingest_lease_until ?? 0) > nowMs) {
      return { kind: "ack" };
    }
    return { kind: "ack" };
  }


  const row = await env.DB.prepare(
    `SELECT id, workspace_id, from_addr, to_addr, subject, snippet, body_text, r2_key, thread_id,
            message_auth, capability_id, fingerprint, scope_key, ingest_attempts
     FROM email_messages WHERE id=? AND workspace_id=?`,
  )
    .bind(envelope.rowId, envelope.workspaceId)
    .first<{
      id: string;
      workspace_id: string;
      from_addr: string;
      to_addr: string;
      subject: string | null;
      snippet: string | null;
      body_text: string | null;
      r2_key: string | null;
      thread_id: string;
      message_auth: string;
      capability_id: string | null;
      fingerprint: string;
      scope_key: string;
      ingest_attempts: number;
    }>();

  if (!row) {
    return { kind: "ack" };
  }

  const claims: ExternalEventClaims = {
    source: "email",
    workspaceId: row.workspace_id,
    scopeKey: row.scope_key,
    emailMessageRowId: row.id,
    threadId: row.thread_id,
    peerAddress: canonicalAddress(row.from_addr),
    capabilityId: row.capability_id ?? undefined,
  };

  if ((row.ingest_attempts ?? 1) > MAX_DISPATCH_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE email_messages
       SET ingest_state='stored_dispatch_exhausted',
           processing_finished_at=?,
           ingest_lease_token=NULL,
           ingest_lease_until=NULL
       WHERE id=? AND ingest_lease_token=?`,
    )
      .bind(nowMs, row.id, leaseToken)
      .run();

    await releaseEmailModelAdmission(env, row.workspace_id, row.id, nowMs).catch(() => false);
    await getHostHooks().releaseExternalEventAdmission?.(env, claims).catch(() => undefined);
    await ensureOwnerEmailNotification(env, { workspaceId: row.workspace_id, rowId: row.id, reason: "stored_dispatch_exhausted", nowMs });
    return { kind: "ack" };
  }


  let revokeReason: string | null = null;
  const contactFacts = await getContactFacts(env, row.workspace_id, row.from_addr).catch(() => ({
    contactClass: "unknown" as const,
    addressVerifiedByOwner: false,
  }));

  if (!isFlagOn(env.AGENT_EMAIL_ENABLED)) {
    revokeReason = "disabled";
  }

  const mailbox = !revokeReason ? await resolveMailbox(env, row.to_addr) : null;
  if (!revokeReason && !mailbox) {
    revokeReason = "mailbox_missing";
  }

  if (!revokeReason && contactFacts.contactClass === "blocked") {
    revokeReason = "blocked";
  }

  if (!revokeReason && row.message_auth === "none") {
    const mbSettings = await getMailboxSettings(env, row.workspace_id);
    const globalStrangerOn = isFlagOn(env.STRANGER_AUTOREPLY_GLOBAL);
    if (!mbSettings?.strangerAutoreply || !globalStrangerOn) {
      revokeReason = "stranger_autoreply_off";
    }
  }

  if (!revokeReason) {
    const hostHook = getHostHooks().revalidateExternalEvent;
    if (hostHook) {
      const live = await hostHook(env, claims).catch((e) => {
        console.error("[dispatch-queue] host revalidate error; fail closed", e);
        return { allow: false, reason: "host_revalidate_error" };
      });
      if (!live.allow) {
        revokeReason = live.reason || "host_policy_revoked";
      }
    }
  }

  if (revokeReason) {
    await releaseEmailModelAdmission(env, row.workspace_id, row.id, nowMs).catch(() => false);
    await getHostHooks().releaseExternalEventAdmission?.(env, claims).catch(() => undefined);

    await env.DB.prepare(
      `UPDATE email_messages
       SET ingest_state='stored_policy_revoked',
           external_admission_state='policy_revoked',
           external_admission_reason=?,
           processing_finished_at=?,
           ingest_lease_token=NULL,
           ingest_lease_until=NULL
       WHERE id=? AND ingest_lease_token=?`,
    )
      .bind(revokeReason, nowMs, row.id, leaseToken)
      .run();

    await ensureOwnerEmailNotification(env, { workspaceId: row.workspace_id, rowId: row.id, reason: revokeReason, nowMs });
    return { kind: "ack" };
  }



  const modelAdmissionConsumed = await consumeEmailModelAdmission(env, row.workspace_id, row.id, nowMs).catch((e) => {
    console.error("[dispatch-queue] model admission consume error; fail closed", row.id, e);
    return false;
  });
  if (!modelAdmissionConsumed) {
    await getHostHooks().releaseExternalEventAdmission?.(env, claims).catch(() => undefined);
    await env.DB.prepare(
      `UPDATE email_messages
       SET ingest_state='stored_policy_revoked',
           external_admission_state='policy_revoked',
           external_admission_reason='model_admission_invalid',
           processing_finished_at=?,
           ingest_lease_token=NULL,
           ingest_lease_until=NULL
       WHERE id=? AND ingest_lease_token=?`,
    )
      .bind(nowMs, row.id, leaseToken)
      .run();
    await ensureOwnerEmailNotification(env, {
      workspaceId: row.workspace_id,
      rowId: row.id,
      reason: "model_admission_invalid",
      nowMs,
    });
    return { kind: "ack" };
  }

  // Hosted stranger admission is converted after Core admission. The hook is idempotent;
  // Hosted's live-policy revalidation above remains the authoritative fail-closed gate.
  await getHostHooks().consumeExternalEventAdmission?.(env, claims).catch((e) => {
    console.error("[dispatch-queue] host admission consume failed", row.id, e);
  });


  const approvalRoute = await resolveOwnerApprovalRouteSafe(env, row.workspace_id);
  const publicFacts = await loadPublicFacts(env, row.workspace_id);

  const security = deriveSecurityContext({
    claims: {
      source: "email",
      workspaceId: row.workspace_id,
      scopeKey: row.scope_key,
      emailMessageRowId: row.id,
      threadId: row.thread_id,
      peerAddress: canonicalAddress(row.from_addr),
      capabilityId: row.capability_id ?? undefined,
    },
    identity: {
      messageAuth: row.message_auth as MessageAuth,
      peerAddress: row.from_addr,
      capabilityId: row.capability_id ?? undefined,
      contactClass: contactFacts.contactClass,
      addressVerifiedByOwner: contactFacts.addressVerifiedByOwner,
    },
    approvalRoute,
    publicFacts,
  });

  let rootTaskId: string | undefined;
  const sendWithTask = async (texts: string[], info: { taskId?: string }) => {
    rootTaskId = info.taskId;
    await enqueueReply(env, {
      route: {
        workspaceId: row.workspace_id,
        localPart: mailbox!.localPart,
        domain: mailbox!.domain,
        address: mailbox!.address,
      },
      rowId: row.id,
      threadId: row.thread_id,
      texts,
      rootTaskId,
      capabilityPeer: row.message_auth === "thread_capability" ? row.from_addr : undefined,
    });
  };


  try {
    const dispatchResult = await dispatchExternalEmail(
      env,
      {
        workspaceId: row.workspace_id,
        from: canonicalAddress(row.from_addr),
        to: row.to_addr,
        text: row.body_text || row.snippet || "",
        subject: (row.subject ?? "").slice(0, 200),
        messageRowId: row.id,
        messageId: row.fingerprint,
        messageAuth: row.message_auth as MessageAuth,
        receivedAt: nowMs,
      },
      async () => {},
      {
        security,
        sendWithTask,
        deadlineMs: EMAIL_AGENT_DISPATCH_BUDGET_MS,
      },
    );

    if (dispatchResult === "handled") {
      const commit = await env.DB.prepare(
        `UPDATE email_messages
         SET ingest_state='processed',
             root_task_id=COALESCE(?, root_task_id),
             processing_finished_at=?,
             ingest_lease_token=NULL,
             ingest_lease_until=NULL
         WHERE id=? AND ingest_lease_token=?`,
      )
        .bind(rootTaskId ?? null, Date.now(), row.id, leaseToken)
        .run();

      if ((commit.meta?.changes ?? 0) === 1) {
        await touchContact(env, row.workspace_id, row.from_addr).catch(() => {});
        await ensureOwnerEmailNotification(env, { workspaceId: row.workspace_id, rowId: row.id, reason: "processed", nowMs: Date.now() });
      } else {
        console.warn("[dispatch-queue] stale consumer commit ignored", row.id);
      }
      return { kind: "ack" };
    }

    await env.DB.prepare(
      `UPDATE email_messages
       SET ingest_state='dispatch_failed',
           ingest_last_error='dispatch_failed',
           ingest_lease_token=NULL,
           ingest_lease_until=NULL
       WHERE id=? AND ingest_lease_token=?`,
    )
      .bind(row.id, leaseToken)
      .run();

    return { kind: "retry", delaySeconds: 20 };
  } catch (err) {
    console.error("[dispatch-queue] dispatch exception", row.id, err);
    await env.DB.prepare(
      `UPDATE email_messages
       SET ingest_state='dispatch_failed',
           ingest_last_error=?,
           ingest_lease_token=NULL,
           ingest_lease_until=NULL
       WHERE id=? AND ingest_lease_token=?`,
    )
      .bind(String(err).slice(0, 300), row.id, leaseToken)
      .run()
      .catch(() => {});

    return { kind: "retry", delaySeconds: 20 };
  }
}
