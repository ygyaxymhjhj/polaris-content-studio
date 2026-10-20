import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { database } from "@/lib/project-db";
import { createStrictDraft, fetchPostizIntegrations, fetchPostizPostDetails } from "@/lib/postiz";
import { getSocialAccount } from "@/lib/social-accounts";
import { recordSocialSubmission } from "@/lib/social-notifications";
import { POST_TARGET_REVIEW_JOINS, POST_TARGET_STATUS_SQL, SUBMISSION_STALE_MS, databaseEpoch, getManualPost, sweepStaleSubmissions } from "@/lib/posts";
import type { ManualPostDetail, PostTargetStatus } from "@/lib/post-types";

/**
 * Hands one account of a manual post to Postiz as a draft.
 *
 * The ordering matters: verify the account, claim the target in a short transaction, call Postiz
 * without holding any database lock, then persist the outcome. A claim that is already accepted
 * returns the current state without creating another draft; an unconfirmed result must be reviewed
 * by a human instead of being retried, because the first attempt may well have succeeded.
 */

const utc = (date: Date) => date.toISOString().slice(0, 23).replace("T", " ");

const STALE_WARNING = "The submission result could not be confirmed. Check Postiz before submitting this account again.";

export type SubmitOutcome =
  | { kind: "ok"; post: ManualPostDetail }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "target_missing" }
  | { kind: "in_flight" }
  | { kind: "unconfirmed" }
  | { kind: "validation"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "postiz_unavailable"; message: string };

type ClaimResult =
  | { kind: "claimed"; content: string; imageDataUrl: string | null; platform: string; accountName: string; attemptId: string; rejectedBinding: ClaimTargetRow | null }
  | { kind: "accepted" }
  | Exclude<SubmitOutcome, { kind: "ok" }>;

interface ClaimPostRow extends RowDataPacket {
  content: string;
  image_data: string | null;
  version: number;
}

export interface ClaimTargetRow extends RowDataPacket {
  status: PostTargetStatus;
  attempt_started_at: string | null;
  audit_id: string | null;
  postiz_post_id: string | null;
  submitted_at: string | null;
  postiz_publish_date: string | null;
}

export async function readSubmissionTarget(
  connection: Pick<PoolConnection, "execute">,
  userId: string,
  postId: string,
  integrationId: string,
  lock = false
): Promise<ClaimTargetRow | null> {
  // Audits are append-only and the app cannot UPDATE them; lock only the mutable target/tracking.
  const [targets] = await connection.execute<ClaimTargetRow[]>(
    `SELECT ${POST_TARGET_STATUS_SQL} AS status, t.attempt_started_at, t.audit_id,
            t.postiz_post_id, t.submitted_at, tracking.postiz_publish_date
       FROM post_targets t JOIN posts p ON p.id = t.post_id ${POST_TARGET_REVIEW_JOINS}
      WHERE t.post_id=? AND t.integration_id=? AND p.owner_user_id=?${lock ? " FOR UPDATE OF t, tracking" : ""}`,
    [postId, integrationId, userId]
  );
  return targets[0] ?? null;
}

export async function claimPostTarget(options: {
  userId: string;
  postId: string;
  integrationId: string;
  expectedVersion: number;
  platform: string;
  accountName: string;
  expectedAuditId?: string;
  rejectedBinding: ClaimTargetRow | null;
  enqueue?: (connection: PoolConnection, snapshot: { content: string; imageDataUrl: string | null; attemptId: string }) => Promise<void>;
}): Promise<ClaimResult> {
  const { userId, postId, integrationId, expectedVersion, platform, accountName, expectedAuditId, rejectedBinding } = options;
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [posts] = await connection.execute<ClaimPostRow[]>(
      "SELECT content, image_data, version FROM posts WHERE id=? AND owner_user_id=? FOR UPDATE",
      [postId, userId]
    );
    if (!posts.length) {
      await connection.rollback();
      return { kind: "not_found" };
    }
    const post = posts[0];
    if (Number(post.version) !== expectedVersion) {
      await connection.rollback();
      return { kind: "conflict" };
    }
    const content = String(post.content || "");
    if (!content.trim()) {
      await connection.rollback();
      return { kind: "validation", message: "Add post text before submitting to Postiz." };
    }

    const target = await readSubmissionTarget(connection, userId, postId, integrationId, true);
    if (!target) {
      await connection.rollback();
      return { kind: "target_missing" };
    }
    const now = utc(new Date());
    // The live check ran without a transaction. Revalidate the complete current binding under
    // locks so a second tab, worker observation or newer attempt cannot reuse its authorization.
    if (expectedAuditId || rejectedBinding || target.status === "rejected") {
      if (!rejectedBinding || target.status !== "rejected" || target.audit_id !== expectedAuditId
        || target.audit_id !== rejectedBinding.audit_id || target.postiz_post_id !== rejectedBinding.postiz_post_id) {
        await connection.rollback();
        return { kind: "conflict" };
      }
    }
    if (target.status === "accepted") {
      // Already handed to Postiz: return the stored result instead of creating a duplicate draft.
      await connection.rollback();
      return { kind: "accepted" };
    }
    if (target.status === "pending_unknown") {
      await connection.rollback();
      return { kind: "unconfirmed" };
    }
    if (target.status === "submitting") {
      if (options.enqueue) {
        await connection.rollback();
        return { kind: "in_flight" };
      }
      const startedAt = databaseEpoch(target.attempt_started_at);
      if (startedAt && Date.now() - startedAt < SUBMISSION_STALE_MS) {
        await connection.rollback();
        return { kind: "in_flight" };
      }
      // A stale in-flight row is a result nobody can vouch for; it must not be resubmitted automatically.
      await connection.execute(
        "UPDATE post_targets SET status='pending_unknown', warning=COALESCE(warning, ?), updated_at=? WHERE post_id=? AND integration_id=?",
        [STALE_WARNING, now, postId, integrationId]
      );
      await connection.commit();
      return { kind: "unconfirmed" };
    }

    const attemptId = randomUUID();
    await connection.execute(
      `UPDATE post_targets
          SET status='submitting', attempt_id=?, attempt_started_at=?, snapshot_version=?,
              platform=?, account_name=?, postiz_post_id=NULL, audit_id=NULL, submitted_at=NULL,
              error=NULL, warning=NULL, updated_at=?
        WHERE post_id=? AND integration_id=?`,
      [attemptId, now, Number(post.version), platform, accountName, now, postId, integrationId]
    );
    await options.enqueue?.(connection, { content, imageDataUrl: post.image_data ?? null, attemptId });
    await connection.commit();
    return { kind: "claimed", content, imageDataUrl: post.image_data ?? null, platform, accountName, attemptId, rejectedBinding };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

interface FinalizeOutcome {
  status: Extract<PostTargetStatus, "accepted" | "failed" | "pending_unknown">;
  postizPostId?: string | null;
  auditId?: string | null;
  submittedAt?: string | null;
  warning?: string | null;
  error?: string | null;
}

/**
 * Both normal completion and recovery after the stale sweep are bound to the same attempt.
 * Audit and upstream ids change together; a late response must never bind an old audit to a new draft.
 */
export async function finalizeTarget(postId: string, integrationId: string, attemptId: string, outcome: FinalizeOutcome): Promise<void> {
  const now = utc(new Date());
  const [result] = await database().execute(
    `UPDATE post_targets
        SET status=?, postiz_post_id=?, audit_id=?, warning=?, error=?, submitted_at=?, updated_at=?
      WHERE post_id=? AND integration_id=? AND attempt_id=? AND status='submitting'`,
    [outcome.status, outcome.postizPostId ?? null, outcome.auditId ?? null, outcome.warning ?? null, outcome.error ?? null,
      outcome.submittedAt ?? (outcome.status === "pending_unknown" ? null : now), now, postId, integrationId, attemptId]
  );
  if ((result as { affectedRows?: number }).affectedRows) return;
  if (outcome.status !== "accepted") return;
  // The sweep moved this row to needs-review while Postiz was working, but the draft does exist.
  await database().execute(
    `UPDATE post_targets
        SET status='accepted', postiz_post_id=?, audit_id=?, warning=?, error=?, submitted_at=?, updated_at=?
      WHERE post_id=? AND integration_id=? AND attempt_id=? AND status='pending_unknown'`,
    [outcome.postizPostId ?? null, outcome.auditId ?? null, outcome.warning ?? null, outcome.error ?? null,
      outcome.submittedAt ?? now, now, postId, integrationId, attemptId]
  );
}

export async function submitPostTarget(options: {
  userId: string;
  userName: string;
  isAdmin: boolean;
  postId: string;
  integrationId: string;
  expectedVersion: number;
  expectedAuditId?: string;
}): Promise<SubmitOutcome> {
  const { userId, userName, isAdmin, postId, integrationId, expectedVersion, expectedAuditId } = options;

  // Anything left in flight past the request window becomes needs-review before a claim is made.
  await sweepStaleSubmissions(userId);

  const registryAccount = await getSocialAccount(integrationId);
  // Ownership gate, identical to the legacy publish route: members may only use channels assigned
  // to them, and administrators keep full access.
  if (!isAdmin && (!registryAccount || registryAccount.ownerUserId !== userId)) {
    return { kind: "forbidden", message: "This social account is not assigned to you. Ask an administrator to assign it." };
  }

  // The registry can be stale; verify the channel still exists and is enabled before claiming.
  const live = await fetchPostizIntegrations();
  if (!live.configured) return { kind: "postiz_unavailable", message: "Postiz is not configured on the server. Set POSTIZ_API_URL and POSTIZ_API_KEY." };
  if (live.error) return { kind: "postiz_unavailable", message: "Could not verify the account with Postiz. Please try again." };
  const liveAccount = live.accounts.find((candidate) => candidate.id === integrationId);
  if (!liveAccount) return { kind: "forbidden", message: "This social account no longer exists in Postiz. Refresh the account list." };
  if (liveAccount.disabled) return { kind: "forbidden", message: "This social account needs to be reconnected in Postiz before it can receive drafts." };

  const platform = (liveAccount.identifier || registryAccount?.provider || "").toLowerCase();
  const accountName = liveAccount.name || registryAccount?.accountName || integrationId;

  const currentTarget = await readSubmissionTarget(database(), userId, postId, integrationId);
  let rejectedBinding: ClaimTargetRow | null = null;
  if (currentTarget?.status === "rejected") {
    if (!expectedAuditId) return { kind: "validation", message: "Reload this rejected draft before retrying; its current audit ID is required. Copy the post to edit its frozen content." };
    if (currentTarget.audit_id !== expectedAuditId || !currentTarget.postiz_post_id) return { kind: "conflict" };
    const submittedAt = databaseEpoch(currentTarget.submitted_at);
    if (!submittedAt) return { kind: "validation", message: "The original submission date is unavailable. Check this draft in Postiz before retrying." };
    const publishDate = databaseEpoch(currentTarget.postiz_publish_date);
    const relevantDates = [submittedAt, ...(publishDate ? [publishDate] : [])];
    try {
      const details = await fetchPostizPostDetails([currentTarget.postiz_post_id], {
        startDate: new Date(Math.min(...relevantDates) - 86_400_000),
        endDate: new Date(Math.max(Date.now() + 86_400_000, ...relevantDates.map(date => date + 86_400_000)))
      });
      const upstream = details.get(currentTarget.postiz_post_id);
      if (!upstream || upstream.id !== currentTarget.postiz_post_id || upstream.state !== "DRAFT" || upstream.saveAction !== "pass") {
        return { kind: "validation", message: "Postiz no longer confirms this draft as rejected. Refresh and check it in Postiz before retrying." };
      }
    } catch {
      return { kind: "postiz_unavailable", message: "Could not confirm the rejected draft with Postiz. No retry was submitted." };
    }
    rejectedBinding = currentTarget;
  } else if (expectedAuditId) {
    return { kind: "conflict" };
  }

  const claim = await claimPostTarget({ userId, postId, integrationId, expectedVersion, platform, accountName, expectedAuditId, rejectedBinding });
  if (claim.kind === "accepted") {
    const post = await getManualPost(userId, postId);
    return post ? { kind: "ok", post } : { kind: "not_found" };
  }
  if (claim.kind !== "claimed") return claim as SubmitOutcome;

  const result = await createStrictDraft({
    integrationId,
    content: claim.content,
    imageUrl: claim.imageDataUrl ?? undefined,
    platform: claim.platform
  });

  if (result.success) {
    let warning = result.warning ?? null;
    let auditId: string | null = null;
    try {
      const registration = await recordSocialSubmission({
        assetId: postId,
        platform: claim.platform,
        integrationId,
        accountName: claim.accountName,
        publishedBy: userId,
        publishedByName: userName,
        contentPreview: claim.content.slice(0, 200),
        postizPostId: result.postId,
        status: "drafted",
        error: undefined
      });
      auditId = registration.auditId ?? null;
      // A failed audit or notification write must never downgrade an accepted draft into a retry:
      // the warning stays on the target so the UI can say "do not submit again".
      if (registration.warning) warning = [warning, registration.warning].filter(Boolean).join(" ");
    } catch {
      warning = [warning, "Postiz accepted the draft, but the local audit record could not be saved. Do not submit it again."].filter(Boolean).join(" ");
    }
    await finalizeTarget(postId, integrationId, claim.attemptId, { status: "accepted", postizPostId: result.postId ?? null, auditId, warning });
  } else if (result.uncertain) {
    // Transport failure: Postiz may have created the draft, so this needs a human check, not a retry.
    await finalizeTarget(postId, integrationId, claim.attemptId, {
      status: "pending_unknown",
      warning: "Postiz did not answer. The draft may or may not exist there; check Postiz before doing anything else.",
      error: null
    });
  } else {
    await finalizeTarget(postId, integrationId, claim.attemptId, claim.rejectedBinding ? {
      status: "accepted",
      postizPostId: claim.rejectedBinding.postiz_post_id,
      auditId: claim.rejectedBinding.audit_id,
      submittedAt: claim.rejectedBinding.submitted_at,
      warning: "The retry failed. The original rejected draft remains frozen; copy this post if you need to edit it.",
      error: result.error ?? "Postiz refused the draft."
    } : { status: "failed", error: result.error ?? "Postiz refused the draft." });
    try {
      await recordSocialSubmission({
        assetId: postId,
        platform: claim.platform,
        integrationId,
        accountName: claim.accountName,
        publishedBy: userId,
        publishedByName: userName,
        contentPreview: claim.content.slice(0, 200),
        status: "failed",
        error: result.error ?? "Postiz refused the draft."
      });
    } catch {
      // The target row already carries the failure; the audit is supplementary here.
    }
  }

  const post = await getManualPost(userId, postId);
  return post ? { kind: "ok", post } : { kind: "not_found" };
}
