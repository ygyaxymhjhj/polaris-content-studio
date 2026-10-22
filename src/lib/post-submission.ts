import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { database } from "@/lib/project-db";
import { POST_TARGET_REVIEW_JOINS, POST_TARGET_STATUS_SQL } from "@/lib/posts";
import type { ManualPostDetail, PostTargetStatus } from "@/lib/post-types";
import { getVideoUpload } from "@/lib/video-uploads";

const utc = (date: Date) => date.toISOString().slice(0, 23).replace("T", " ");

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
  | { kind: "claimed" }
  | { kind: "accepted" }
  | Exclude<SubmitOutcome, { kind: "ok" }>;

interface ClaimPostRow extends RowDataPacket {
  content: string;
  image_data: string | null;
  video_media_id: string | null;
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
  enqueue: (connection: PoolConnection, snapshot: { content: string; imageDataUrl: string | null; videoMediaId: string | null; attemptId: string }) => Promise<void>;
}): Promise<ClaimResult> {
  const { userId, postId, integrationId, expectedVersion, platform, accountName, expectedAuditId, rejectedBinding } = options;
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [posts] = await connection.execute<ClaimPostRow[]>(
      "SELECT content, image_data, video_media_id, version FROM posts WHERE id=? AND owner_user_id=? FOR UPDATE",
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
    // Revalidate the rejected binding under locks before freezing and enqueueing this attempt.
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
      await connection.rollback();
      return { kind: "in_flight" };
    }

    if (post.video_media_id && post.image_data) {
      await connection.rollback();
      return { kind: "validation", message: "Attach either one image or one video, not both." };
    }
    if (post.video_media_id && !await getVideoUpload(userId, post.video_media_id, connection)) {
      await connection.rollback();
      return { kind: "validation", message: "The video attachment is unavailable in this account." };
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
    await options.enqueue(connection, { content, imageDataUrl: post.image_data ?? null, videoMediaId: post.video_media_id ?? null, attemptId });
    await connection.commit();
    return { kind: "claimed" };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
