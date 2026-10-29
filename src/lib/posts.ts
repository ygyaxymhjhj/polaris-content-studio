import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { database } from "@/lib/project-db";
import {
  MAX_POST_TARGETS,
  isTargetSetEditable,
  type ManualPostDetail,
  type ManualPostListItem,
  type ManualPostStatus,
  type OverviewActivity,
  type PostTarget,
  type PostTargetStatus,
  type PostsCounts
} from "./post-types";
import type { ValidatedPostImage } from "./post-media";
import { getVideoUpload } from "@/lib/video-uploads";
import { getImageUploads } from "@/lib/image-uploads";
import { areImageMediaIds, getImagePreviewUrl } from "./image-types";

/**
 * Storage for manual posts. Every query is scoped by owner_user_id: unlike AI projects there is no
 * administrator bypass, because a manual post is a private draft until someone publishes it.
 */

const utc = (date: Date) => date.toISOString().slice(0, 23).replace("T", " ");

/** An in-flight submission older than this can no longer be trusted to still be running. */
export const SUBMISSION_STALE_MS = 120_000;

const STALE_WARNING = "The submission result could not be confirmed. Check Postiz before submitting this account again.";

export function databaseEpoch(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
}

interface PostRow extends RowDataPacket {
  id: string;
  title: string;
  content: string;
  image_data: string | null;
  image_media_ids: string[] | string | null;
  image_thumb: string | null;
  image_name: string | null;
  image_width: number | null;
  image_height: number | null;
  video_media_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface TargetRow extends RowDataPacket {
  integration_id: string;
  platform: string;
  account_name: string;
  status: PostTargetStatus;
  snapshot_version: number;
  postiz_post_id: string | null;
  audit_id: string | null;
  warning: string | null;
  error: string | null;
  submitted_at: string | null;
}

interface ListedPostRow extends RowDataPacket {
  id: string;
  title: string;
  excerpt: string;
  has_image: number;
  image_media_ids: string[] | string | null;
  has_video: number;
  target_count: number;
  accepted_count: number;
  rejected_count: number;
  submitting_count: number;
  unsettled_count: number;
  unknown_count: number;
  platforms: string | null;
  status: ManualPostStatus;
  created_at: string;
  updated_at: string;
}

// Only the current, owner-bound manual audit can contribute a review. The worker deliberately
// preserves a known rejected marker when a later response omits saveAction.
export const POST_TARGET_REVIEW_JOINS = `
  LEFT JOIN social_publishes audit ON audit.id = t.audit_id
    AND audit.asset_id = t.post_id AND audit.integration_id = t.integration_id
    AND audit.project_id IS NULL AND audit.published_by = p.owner_user_id
    AND CAST(audit.postiz_post_id AS BINARY) = CAST(t.postiz_post_id AS BINARY)
  LEFT JOIN social_post_tracking tracking ON tracking.publish_audit_id = audit.id
    AND CAST(tracking.postiz_post_id AS BINARY) = CAST(t.postiz_post_id AS BINARY)
`;

export const POST_TARGET_STATUS_SQL = `CASE
  WHEN t.status = 'accepted' AND tracking.review_status = 'rejected'
    AND tracking.state = 'DRAFT' THEN 'rejected'
  ELSE t.status END`;

/** Shared classification for list results, filtered counts and overview counts. */
const POST_STATUS_CTE = `
  WITH owner_posts AS (SELECT * FROM posts WHERE owner_user_id = ?),
  target_rows AS (
    SELECT t.*, ${POST_TARGET_STATUS_SQL} AS effective_status
    FROM post_targets t JOIN owner_posts p ON p.id = t.post_id
    ${POST_TARGET_REVIEW_JOINS}
  ), post_rows AS (
    SELECT
      p.id, p.title, p.created_at, p.updated_at,
      LEFT(p.content, 400) AS excerpt,
      p.image_media_ids,
      (CASE WHEN p.image_media_ids IS NULL THEN p.image_thumb IS NOT NULL ELSE JSON_LENGTH(p.image_media_ids) > 0 END) AS has_image,
      (p.video_media_id IS NOT NULL) AS has_video,
      (SELECT COUNT(*) FROM target_rows t WHERE t.post_id = p.id) AS target_count,
      (SELECT COUNT(*) FROM target_rows t WHERE t.post_id = p.id AND t.effective_status = 'accepted') AS accepted_count,
      (SELECT COUNT(*) FROM target_rows t WHERE t.post_id = p.id AND t.effective_status = 'rejected') AS rejected_count,
      (SELECT COUNT(*) FROM target_rows t WHERE t.post_id = p.id AND t.effective_status = 'submitting') AS submitting_count,
      (SELECT COUNT(*) FROM target_rows t WHERE t.post_id = p.id AND t.effective_status IN ('failed','pending_unknown','rejected')) AS unsettled_count,
      (SELECT COUNT(*) FROM target_rows t WHERE t.post_id = p.id AND t.effective_status = 'pending_unknown') AS unknown_count,
      (SELECT GROUP_CONCAT(DISTINCT t.platform ORDER BY t.platform) FROM target_rows t WHERE t.post_id = p.id) AS platforms
    FROM owner_posts p
  ),
  post_status AS (
    SELECT r.*,
      CASE
        WHEN r.submitting_count > 0 THEN 'pushing'
        WHEN r.unsettled_count > 0 THEN 'attention'
        WHEN r.accepted_count > 0 AND r.accepted_count = r.target_count THEN 'pushed'
        WHEN r.accepted_count > 0 THEN 'attention'
        ELSE 'draft'
      END AS status
    FROM post_rows r
  )
`;

function emptyCounts(): PostsCounts {
  return { all: 0, draft: 0, pushing: 0, pushed: 0, attention: 0 };
}

function toListItem(row: ListedPostRow): ManualPostListItem {
  // Editing and deleting follow the same rule: nothing may have reached Postiz, and nothing may
  // still be in flight or unconfirmed, or the frozen copy would stop matching the database.
  const editable = listItemEditable(row);
  const imageMediaIds = readPostImageMediaIds(row.image_media_ids);
  return {
    id: String(row.id),
    title: String(row.title || ""),
    excerpt: String(row.excerpt || "").replace(/\s+/g, " ").trim(),
    hasImage: Number(row.has_image) === 1,
    imageCount: imageMediaIds?.length ?? Number(row.has_image),
    imageUrl: imageMediaIds !== undefined ? imageMediaIds[0] ? getImagePreviewUrl(imageMediaIds[0], "thumb") : null
      : Number(row.has_image) === 1 ? `/api/posts/${row.id}/image?size=thumb&v=${databaseEpoch(row.updated_at)}` : null,
    hasVideo: Number(row.has_video) === 1,
    imageVersion: databaseEpoch(row.updated_at),
    status: row.status,
    targetCount: Number(row.target_count),
    acceptedCount: Number(row.accepted_count),
    rejectedCount: Number(row.rejected_count || 0),
    platforms: row.platforms ? String(row.platforms).split(",").filter(Boolean) : [],
    editable,
    deletable: editable,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

/**
 * A post may be changed only while no target is accepted, rejected, submitting or unconfirmed. Failed and
 * not-started targets stay changeable: nothing reached Postiz, so the next attempt may send new
 * content. This is the same rule post_targets rows encode for the editor and the delete endpoint.
 */
function listItemEditable(row: Pick<ListedPostRow, "accepted_count" | "rejected_count" | "submitting_count" | "unknown_count">): boolean {
  return Number(row.accepted_count) === 0 && Number(row.rejected_count || 0) === 0 && Number(row.submitting_count) === 0 && Number(row.unknown_count) === 0;
}

function toTarget(row: TargetRow): PostTarget {
  return {
    integrationId: String(row.integration_id),
    platform: String(row.platform || ""),
    accountName: String(row.account_name || ""),
    status: row.status,
    snapshotVersion: Number(row.snapshot_version || 0),
    postizPostId: row.postiz_post_id ? String(row.postiz_post_id) : null,
    auditId: row.audit_id ? String(row.audit_id) : null,
    warning: row.warning ? String(row.warning) : null,
    error: row.error ? String(row.error) : null,
    submittedAt: row.submitted_at ? String(row.submitted_at) : null
  };
}

export function toPostDetail(row: PostRow, targets: PostTarget[]): ManualPostDetail {
  const imageEpoch = databaseEpoch(row.updated_at);
  const imageMediaIds = readPostImageMediaIds(row.image_media_ids);
  const editable = isTargetSetEditable(targets);
  const frozenReason = targets.some((target) => target.status === "accepted")
    ? "accepted" as const
    : targets.some((target) => target.status === "rejected")
      ? "rejected" as const
      : targets.some((target) => target.status === "submitting")
        ? "submitting" as const
        : targets.some((target) => target.status === "pending_unknown")
          ? "pending_unknown" as const
          : null;
  return {
    id: String(row.id),
    title: String(row.title || ""),
    content: String(row.content || ""),
    imageUrl: imageMediaIds !== undefined ? imageMediaIds[0] ? getImagePreviewUrl(imageMediaIds[0]) : null
      : row.image_data ? `/api/posts/${row.id}/image?v=${imageEpoch}` : null,
    ...(imageMediaIds !== undefined ? { imageMediaIds } : {}),
    videoMediaId: row.video_media_id ?? null,
    imageName: row.image_name ? String(row.image_name) : null,
    imageWidth: row.image_width == null ? null : Number(row.image_width),
    imageHeight: row.image_height == null ? null : Number(row.image_height),
    version: Number(row.version),
    editable,
    frozenReason,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    targets
  };
}

/** Turns in-flight submissions that have outlived the request window into needs-review rows. */
export async function sweepStaleSubmissions(ownerUserId: string): Promise<number> {
  const cutoff = utc(new Date(Date.now() - SUBMISSION_STALE_MS));
  const [result] = await database().execute(
    `UPDATE post_targets t JOIN posts p ON p.id = t.post_id
        SET t.status = 'pending_unknown',
            t.warning = COALESCE(t.warning, ?),
            t.updated_at = ?
      WHERE p.owner_user_id = ? AND t.status = 'submitting'
        AND (t.attempt_started_at IS NULL OR t.attempt_started_at < ?)
        AND NOT EXISTS (SELECT 1 FROM draft_submissions submission
          WHERE submission.attempt_id=t.attempt_id AND submission.kind='manual'
            AND submission.state IN ('queued','running'))`,
    [STALE_WARNING, utc(new Date()), ownerUserId, cutoff]
  );
  return (result as { affectedRows?: number }).affectedRows || 0;
}

export async function loadPostRow(ownerUserId: string, postId: string): Promise<PostRow | null> {
  const [rows] = await database().execute<PostRow[]>(
    "SELECT id, title, content, image_data, image_media_ids, image_thumb, image_name, image_width, image_height, video_media_id, version, created_at, updated_at FROM posts WHERE id=? AND owner_user_id=?",
    [postId, ownerUserId]
  );
  return rows.length ? rows[0] : null;
}

export async function listTargetRows(connection: Pick<PoolConnection, "execute"> | ReturnType<typeof database>, postId: string): Promise<PostTarget[]> {
  const [rows] = await connection.execute<TargetRow[]>(
    `SELECT t.integration_id, t.platform, t.account_name, ${POST_TARGET_STATUS_SQL} AS status,
            t.snapshot_version, t.postiz_post_id, t.audit_id, t.warning, t.error, t.submitted_at
       FROM post_targets t JOIN posts p ON p.id = t.post_id ${POST_TARGET_REVIEW_JOINS}
      WHERE t.post_id=? ORDER BY t.created_at`,
    [postId]
  );
  return rows.map(toTarget);
}

export async function getManualPost(ownerUserId: string, postId: string): Promise<ManualPostDetail | null> {
  const row = await loadPostRow(ownerUserId, postId);
  if (!row) return null;
  return toPostDetail(row, await listTargetRows(database(), postId));
}

export interface PostListFilters {
  status: "all" | ManualPostStatus;
  search: string;
  platform: string;
  integrationId: string;
  /** Epoch millis; rows older than this are excluded. 0 disables the filter. */
  updatedSince: number;
  page: number;
  perPage: number;
}

/** mysql2 only accepts these scalar types, so filter builders stay on this union. */
type SqlValue = string | number;

function filterArguments(filters: PostListFilters): [string, ...SqlValue[]] {
  const databaseFilters: SqlValue[] = [];
  const conditions: string[] = [];
  const search = filters.search.trim();
  if (search) {
    // LOCATE keeps user text literal: LIKE would treat % and _ as wildcards.
    conditions.push("(LOCATE(?, r.title) > 0 OR LOCATE(?, r.excerpt) > 0)");
    databaseFilters.push(search, search);
  }
  if (filters.platform) {
    const platforms = filters.platform === "linkedin" ? ["linkedin", "linkedin-page"] : [filters.platform];
    conditions.push(`EXISTS (SELECT 1 FROM post_targets tp WHERE tp.post_id = r.id AND tp.platform IN (${platforms.map(() => "?").join(",")}))`);
    databaseFilters.push(...platforms);
  }
  if (filters.integrationId) {
    conditions.push("EXISTS (SELECT 1 FROM post_targets ti WHERE ti.post_id = r.id AND ti.integration_id = ?)");
    databaseFilters.push(filters.integrationId);
  }
  if (filters.updatedSince > 0) {
    conditions.push("r.updated_at >= ?");
    databaseFilters.push(utc(new Date(filters.updatedSince)));
  }
  return [conditions.join(" AND "), ...databaseFilters];
}

export async function listManualPosts(ownerUserId: string, filters: PostListFilters): Promise<{ items: ManualPostListItem[]; total: number; counts: PostsCounts }> {
  const counts: PostsCounts = emptyCounts();
  {
    const [conditions, ...values] = filterArguments(filters);
    const [rows] = await database().execute<(RowDataPacket & { status: ManualPostStatus; total: number })[]>(
      `${POST_STATUS_CTE}
       SELECT status, COUNT(*) AS total FROM post_status r
       ${conditions ? `WHERE ${conditions}` : ""}
       GROUP BY status`,
      [ownerUserId, ...values]
    );
    for (const row of rows) {
      const status = row.status as ManualPostStatus;
      if (status in counts) counts[status] = Number(row.total);
    }
    counts.all = counts.draft + counts.pushing + counts.pushed + counts.attention;
  }

  const offset = (filters.page - 1) * filters.perPage;
  const [conditions, ...values] = filterArguments(filters);
  const [rows] = await database().execute<ListedPostRow[]>(
    `${POST_STATUS_CTE}
     SELECT r.id, r.title, r.updated_at, r.created_at, r.excerpt, r.has_image, r.image_media_ids, r.has_video, r.target_count,
            r.accepted_count, r.rejected_count, r.submitting_count, r.unsettled_count, r.unknown_count, r.platforms, r.status
       FROM post_status r
      WHERE ${conditions ? `(${conditions}) AND ` : ""}(? = 'all' OR r.status = ?)
      ORDER BY r.updated_at DESC
      LIMIT ? OFFSET ?`,
    [ownerUserId, ...values, filters.status, filters.status, filters.perPage, offset]
  );
  const items = rows.map(toListItem);
  const total = filters.status === "all" ? counts.all : counts[filters.status];
  return { items, total, counts };
}

export type PostAccountSnapshot = { integrationId: string; platform: string; accountName: string };

export interface CreatePostInput {
  title: string;
  content: string;
  image: ValidatedPostImage | null;
  imageMediaIds?: string[];
  videoMediaId?: string | null;
  targets: PostAccountSnapshot[];
}

export class PostMediaValidationError extends Error {}

export function readPostImageMediaIds(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  let ids: unknown;
  try { ids = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new PostMediaValidationError("The image attachments are invalid."); }
  if (!areImageMediaIds(ids)) throw new PostMediaValidationError("The image attachments are invalid.");
  return ids;
}

async function validatePostMedia(ownerUserId: string, hasImage: boolean, videoMediaId: string | null | undefined, connection: Pick<PoolConnection, "execute">, imageMediaIds?: string[]): Promise<void> {
  if ((hasImage || imageMediaIds?.length) && videoMediaId) throw new PostMediaValidationError("Attach either images or one video, not both.");
  if (imageMediaIds !== undefined) {
    try { await getImageUploads(ownerUserId, imageMediaIds, connection); }
    catch { throw new PostMediaValidationError("The image attachments are unavailable in this account."); }
  }
  if (videoMediaId != null && !await getVideoUpload(ownerUserId, videoMediaId, connection)) {
    throw new PostMediaValidationError("The video attachment is unavailable in this account.");
  }
}

export async function createManualPost(ownerUserId: string, input: CreatePostInput): Promise<ManualPostDetail> {
  const id = randomUUID();
  const now = utc(new Date());
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    if (input.imageMediaIds !== undefined && !areImageMediaIds(input.imageMediaIds)) throw new PostMediaValidationError("The image attachments are invalid.");
    if (input.imageMediaIds === undefined && input.image && input.videoMediaId) throw new PostMediaValidationError("Attach either images or one video, not both.");
    const imageMediaIds = input.imageMediaIds === undefined ? input.videoMediaId ? [] : undefined : readPostImageMediaIds(input.imageMediaIds);
    if (imageMediaIds?.length && input.image) throw new PostMediaValidationError("Choose uploaded images or an inline image, not both.");
    const image = imageMediaIds === undefined ? input.image : null;
    await validatePostMedia(ownerUserId, Boolean(image), input.videoMediaId, connection, imageMediaIds);
    await connection.execute(
      `INSERT INTO posts (id, owner_user_id, title, content, image_data, image_thumb, image_name, image_width, image_height, image_media_ids, video_media_id, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [
        id, ownerUserId, input.title, input.content,
        image?.dataUrl ?? null, image?.thumbnailDataUrl ?? null,
        image?.filename ?? null, image?.width ?? null, image?.height ?? null,
        imageMediaIds === undefined ? null : JSON.stringify(imageMediaIds), input.videoMediaId ?? null,
        now, now
      ]
    );
    await insertTargets(connection, id, input.targets, now);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const created = await getManualPost(ownerUserId, id);
  if (!created) throw new Error("The post was saved but could not be read back.");
  return created;
}

async function insertTargets(connection: PoolConnection, postId: string, targets: PostAccountSnapshot[], now: string): Promise<void> {
  if (!targets.length) return;
  const values = targets.slice(0, MAX_POST_TARGETS);
  const placeholders = values.map(() => "(?,?,?,?,?,?,?,?)").join(",");
  await connection.execute(
    `INSERT INTO post_targets (id, post_id, integration_id, platform, account_name, status, created_at, updated_at)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE platform=VALUES(platform), account_name=VALUES(account_name), updated_at=VALUES(updated_at)`,
    values.flatMap((target) => [randomUUID(), postId, target.integrationId, target.platform, target.accountName, "not_started", now, now])
  );
}

export type UpdatePostPatch = {
  title?: string;
  content?: string;
  image?: { kind: "keep" } | { kind: "set"; image: ValidatedPostImage } | { kind: "remove" };
  imageMediaIds?: string[];
  /** Omitted keeps the reference, null removes only the video, an ID replaces all media. */
  videoMediaId?: string | null;
  targets?: PostAccountSnapshot[];
};

export type UpdatePostResult =
  | { kind: "ok"; post: ManualPostDetail }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "frozen" };

export async function updateManualPost(ownerUserId: string, postId: string, version: number, patch: UpdatePostPatch): Promise<UpdatePostResult> {
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<PostRow[]>(
      "SELECT id, image_data, image_media_ids, video_media_id, version, created_at, updated_at FROM posts WHERE id=? AND owner_user_id=? FOR UPDATE",
      [postId, ownerUserId]
    );
    if (!rows.length) {
      await connection.rollback();
      return { kind: "not_found" };
    }
    if (Number(rows[0].version) !== version) {
      await connection.rollback();
      return { kind: "conflict" };
    }
    const targets = await listTargetRows(connection, postId);
    if (!isTargetSetEditable(targets)) {
      await connection.rollback();
      return { kind: "frozen" };
    }

    if (patch.imageMediaIds !== undefined && !areImageMediaIds(patch.imageMediaIds)) throw new PostMediaValidationError("The image attachments are invalid.");
    const suppliedIds = patch.imageMediaIds;
    if (suppliedIds?.length && patch.image?.kind === "set") {
      throw new PostMediaValidationError("Choose uploaded images or an inline image, not both.");
    }
    if ((patch.image?.kind === "set" && suppliedIds === undefined || suppliedIds?.length) && patch.videoMediaId) {
      throw new PostMediaValidationError("Attach either images or one video, not both.");
    }
    const setsVideo = patch.videoMediaId != null;
    const setsImage = suppliedIds === undefined && patch.image?.kind === "set";
    const imageMediaIds = setsVideo ? [] : suppliedIds ?? (setsImage ? undefined
      : patch.image?.kind === "remove" && rows[0].image_media_ids != null ? [] : readPostImageMediaIds(rows[0].image_media_ids));
    const videoMediaId = setsImage || suppliedIds?.length ? null : patch.videoMediaId === undefined ? rows[0].video_media_id : patch.videoMediaId;
    const hasImage = imageMediaIds === undefined && (setsImage || (!setsVideo && patch.image?.kind !== "remove" && Boolean(rows[0].image_data)));
    await validatePostMedia(ownerUserId, hasImage, videoMediaId, connection, imageMediaIds);

    const assignments: string[] = [];
    const values: SqlValue[] = [];
    if (patch.title !== undefined) { assignments.push("title=?"); values.push(patch.title); }
    if (patch.content !== undefined) { assignments.push("content=?"); values.push(patch.content); }
    if (patch.image && suppliedIds === undefined) {
      if (patch.image.kind === "set") {
        assignments.push("image_data=?", "image_thumb=?", "image_name=?", "image_width=?", "image_height=?");
        values.push(patch.image.image.dataUrl, patch.image.image.thumbnailDataUrl, patch.image.image.filename, patch.image.image.width, patch.image.image.height);
      } else if (patch.image.kind === "remove" && !setsVideo) {
        assignments.push("image_data=NULL", "image_thumb=NULL", "image_name=NULL", "image_width=NULL", "image_height=NULL");
      }
    }
    if (setsVideo || suppliedIds !== undefined) {
      assignments.push("image_data=NULL", "image_thumb=NULL", "image_name=NULL", "image_width=NULL", "image_height=NULL");
    }
    if (setsVideo || suppliedIds !== undefined || patch.image?.kind === "remove" && imageMediaIds !== undefined) {
      assignments.push("image_media_ids=?");
      values.push(JSON.stringify(imageMediaIds));
    } else if (setsImage) {
      assignments.push("image_media_ids=NULL");
    }
    if (setsImage || suppliedIds?.length || patch.videoMediaId === null) {
      assignments.push("video_media_id=NULL");
    } else if (patch.videoMediaId != null) {
      assignments.push("video_media_id=?");
      values.push(patch.videoMediaId);
    }
    const now = utc(new Date());
    assignments.push("version=version+1", "updated_at=?");
    values.push(now);
    await connection.execute(`UPDATE posts SET ${assignments.join(", ")} WHERE id=? AND owner_user_id=?`, [...values, postId, ownerUserId]);

    if (patch.targets) {
      await insertTargets(connection, postId, patch.targets, now);
      const keep = patch.targets.map((target) => target.integrationId).slice(0, MAX_POST_TARGETS);
      if (keep.length) {
        await connection.execute(
          `DELETE FROM post_targets WHERE post_id=? AND integration_id NOT IN (${keep.map(() => "?").join(",")})`,
          [postId, ...keep]
        );
      } else {
        await connection.execute("DELETE FROM post_targets WHERE post_id=?", [postId]);
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const updated = await getManualPost(ownerUserId, postId);
  return updated ? { kind: "ok", post: updated } : { kind: "not_found" };
}

export type DeletePostResult = { kind: "ok" } | { kind: "not_found" } | { kind: "frozen" };

export async function deleteManualPost(ownerUserId: string, postId: string): Promise<DeletePostResult> {
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM posts WHERE id=? AND owner_user_id=? FOR UPDATE", [postId, ownerUserId]);
    if (!rows.length) {
      await connection.rollback();
      return { kind: "not_found" };
    }
    const targets = await listTargetRows(connection, postId);
    if (!isTargetSetEditable(targets)) {
      await connection.rollback();
      return { kind: "frozen" };
    }
    // post_targets rows go with the post through the foreign key.
    await connection.execute("DELETE FROM posts WHERE id=? AND owner_user_id=?", [postId, ownerUserId]);
    await connection.commit();
    return { kind: "ok" };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** Copy content and media references; targets are dropped so the new draft can be re-checked. */
export async function duplicateManualPost(ownerUserId: string, postId: string): Promise<ManualPostDetail | null> {
  const row = await loadPostRow(ownerUserId, postId);
  if (!row) return null;
  const imageMediaIds = readPostImageMediaIds(row.image_media_ids);
  if (imageMediaIds?.length && row.image_data) throw new PostMediaValidationError("The post contains mixed image sources.");
  const id = randomUUID();
  const now = utc(new Date());
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    await validatePostMedia(ownerUserId, imageMediaIds === undefined && Boolean(row.image_data), row.video_media_id, connection, imageMediaIds);
    await connection.execute(
      `INSERT INTO posts (id, owner_user_id, title, content, image_data, image_thumb, image_name, image_width, image_height, image_media_ids, video_media_id, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [id, ownerUserId, row.title, row.content,
        imageMediaIds === undefined ? row.image_data : null, imageMediaIds === undefined ? row.image_thumb : null,
        imageMediaIds === undefined ? row.image_name : null, imageMediaIds === undefined ? row.image_width : null,
        imageMediaIds === undefined ? row.image_height : null,
        imageMediaIds === undefined ? null : JSON.stringify(imageMediaIds), row.video_media_id ?? null, now, now]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  return getManualPost(ownerUserId, id);
}

export async function getPostImage(ownerUserId: string, postId: string, size: "full" | "thumb"): Promise<{ dataUrl: string } | null> {
  const column = size === "thumb" ? "image_thumb" : "image_data";
  const [rows] = await database().execute<(RowDataPacket & { image: string | null })[]>(
    `SELECT ${column} AS image FROM posts WHERE id=? AND owner_user_id=? AND image_media_ids IS NULL`,
    [postId, ownerUserId]
  );
  if (!rows.length || !rows[0].image) return null;
  return { dataUrl: String(rows[0].image) };
}

export interface OverviewSnapshot {
  counts: Omit<PostsCounts, "all"> & { total: number };
  activity: OverviewActivity[];
}

export async function overviewSnapshot(ownerUserId: string, withinMs: number): Promise<OverviewSnapshot> {
  const counts: Omit<PostsCounts, "all"> & { total: number } = { total: 0, draft: 0, pushing: 0, pushed: 0, attention: 0 };
  {
    const [rows] = await database().execute<(RowDataPacket & { status: ManualPostStatus; total: number })[]>(
      `${POST_STATUS_CTE} SELECT status, COUNT(*) AS total FROM post_status GROUP BY status`,
      [ownerUserId]
    );
    for (const row of rows) {
      const status = row.status as ManualPostStatus;
      if (status in counts) counts[status] = Number(row.total);
    }
    counts.total = counts.draft + counts.pushing + counts.pushed + counts.attention;
  }

  const since = utc(new Date(Date.now() - withinMs));
  const [postRows] = await database().execute<(RowDataPacket & { id: string; title: string; created_at: string; updated_at: string })[]>(
    "SELECT id, title, created_at, updated_at FROM posts WHERE owner_user_id=? AND updated_at>=? ORDER BY updated_at DESC LIMIT 60",
    [ownerUserId, since]
  );
  const [targetRows] = await database().execute<(RowDataPacket & {
    post_id: string; title: string; platform: string; account_name: string; status: PostTargetStatus; submitted_at: string | null; updated_at: string;
  })[]>(
    `SELECT t.post_id, p.title, t.platform, t.account_name, ${POST_TARGET_STATUS_SQL} AS status,
            t.submitted_at,
            CASE WHEN (${POST_TARGET_STATUS_SQL}) = 'rejected'
              THEN COALESCE(tracking.rejected_detected_at, t.updated_at) ELSE t.updated_at END AS updated_at
       FROM post_targets t JOIN posts p ON p.id = t.post_id ${POST_TARGET_REVIEW_JOINS}
      WHERE p.owner_user_id = ? AND t.snapshot_version > 0
        AND (t.updated_at >= ? OR ((${POST_TARGET_STATUS_SQL}) = 'rejected' AND tracking.rejected_detected_at >= ?))
      ORDER BY updated_at DESC LIMIT 60`,
    [ownerUserId, since, since]
  );

  const activity: OverviewActivity[] = [];
  for (const row of postRows) {
    const created = databaseEpoch(row.created_at);
    const updated = databaseEpoch(row.updated_at);
    const createdInWindow = created >= Date.now() - withinMs;
    activity.push({
      id: `post-${row.id}-${createdInWindow ? "created" : "updated"}`,
      kind: createdInWindow ? "created" : "updated",
      postId: String(row.id),
      title: String(row.title || ""),
      platform: null,
      accountName: null,
      at: new Date(createdInWindow ? created : updated).toISOString()
    });
  }
  for (const row of targetRows) {
    const kind: OverviewActivity["kind"] = row.status === "accepted" ? "accepted"
      : row.status === "rejected" ? "rejected"
        : row.status === "failed" ? "failed"
        : row.status === "pending_unknown" ? "pending"
          : "submitted";
    const at = row.status !== "rejected" && row.submitted_at ? databaseEpoch(row.submitted_at) : databaseEpoch(row.updated_at);
    activity.push({
      id: `target-${row.post_id}-${row.account_name}-${kind}-${at}`,
      kind,
      postId: String(row.post_id),
      title: String(row.title || ""),
      platform: row.platform ? String(row.platform) : null,
      accountName: row.account_name ? String(row.account_name) : null,
      at: new Date(at).toISOString()
    });
  }
  activity.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { counts, activity: activity.slice(0, 12) };
}
