import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { database } from "@/lib/project-db";
import { readFeishuConfig, sendFeishuMessage } from "@/lib/feishu";
import { fetchPostizPostDetails, getPostizUiUrl } from "@/lib/postiz";

export type SocialSubmissionEntry = {
  projectId?: string;
  assetId: string;
  platform: string;
  integrationId: string;
  accountName: string;
  publishedBy: string;
  publishedByName: string;
  contentPreview: string;
  postizPostId?: string;
  status: "drafted" | "failed";
  error?: string;
};

export type SocialDeliverySummary = { sent: number; failed: number; skipped: number };
export type SocialWorkerSummary = SocialDeliverySummary & {
  checked: number;
  confirmed: number;
  locked: boolean;
  warning?: string;
};

type FeishuConfig = NonNullable<Awaited<ReturnType<typeof readFeishuConfig>>>;
type NotificationEvent = "draft_submitted" | "draft_rejected" | "published";
type PostState = "DRAFT" | "QUEUE" | "PUBLISHED" | "ERROR";
type SaveAction = "pass" | "update" | "draft" | "schedule" | "now";
type PostDetails = { id: string; state: PostState; releaseUrl?: string; publishDate?: string; saveAction?: SaveAction | null };
type NotificationPayload = {
  applicantId: string;
  applicantName: string;
  platform: string;
  accountName: string;
  summary: string;
  assetId: string;
  integrationId: string;
  projectId?: string;
  postizPostId?: string;
  occurredAt: string;
  timeKind: "submission" | "publication" | "confirmation" | "detection";
  releaseUrl?: string;
};

const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_BACKOFF_SECONDS = [60, 300, 900, 3600];
const LEASE_DURATION_MS = 300_000;
const WORKER_BUDGET_MS = 45_000;
const WORKER_TASK_RESERVE_MS = 5_000;
// The list API filters publishDate, not creation time. Unknown moves beyond this horizon need operator review.
const UNKNOWN_PUBLISH_HORIZON_MS = 365 * 86_400_000;
const LOCAL_SAVE_WARNING = "Postiz 已收到投稿，但本地审计或通知记录保存失败；请勿重复投稿。";
const CONFIG_READ_ERROR = "飞书通知配置暂不可用。";
const DELIVERY_ERROR = "飞书通知发送失败，系统将按重试策略处理。";
const POLLING_ERROR = "Postiz 状态查询失败，稍后重试。";

// DATETIME has no timezone: never mix server NOW() with application-computed deadlines.
function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function parseDatabaseUtc(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value).replace(" ", "T") + "Z");
}

function parsePublishDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseSaveAction(value: unknown): SaveAction | null {
  return typeof value === "string" && ["pass", "update", "draft", "schedule", "now"].includes(value)
    ? value as SaveAction : null;
}

function shortenText(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function validateHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

async function runTransaction<Result>(operation: (connection: PoolConnection) => Promise<Result>): Promise<Result> {
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function createPayload(entry: SocialSubmissionEntry, occurredAt: Date): NotificationPayload {
  return {
    applicantId: entry.publishedBy, applicantName: entry.publishedByName,
    platform: entry.platform, accountName: entry.accountName,
    summary: shortenText(entry.contentPreview, 200), assetId: entry.assetId, integrationId: entry.integrationId,
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.postizPostId ? { postizPostId: entry.postizPostId } : {}),
    occurredAt: occurredAt.toISOString(), timeKind: "submission"
  };
}

async function insertNotification(
  connection: PoolConnection, auditId: string, eventType: NotificationEvent,
  eventTime: Date, version: number, payload: NotificationPayload
): Promise<void> {
  await connection.execute(
    `INSERT INTO social_notification_outbox
      (id, publish_audit_id, event_type, event_time, next_attempt_at, config_version, payload)
     VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
    [randomUUID(), auditId, eventType, formatUtc(eventTime), formatUtc(new Date()), version, JSON.stringify(payload)]
  );
}

/** Call only after Postiz has completed. Identity must be supplied by the authenticated server route. */
export async function recordSocialSubmission(entry: SocialSubmissionEntry): Promise<{ auditId?: string; warning?: string }> {
  let config: FeishuConfig | null = null;
  let warning: string | undefined;
  try {
    config = await readFeishuConfig();
  } catch {
    warning = CONFIG_READ_ERROR;
  }
  const submittedAt = new Date();
  const auditId = randomUUID();
  // Only preserve a genuine upstream id. A missing id is not an upstream submission failure.
  const postId = entry.postizPostId?.trim();
  const realPostId = postId && postId.length <= 128 && !/[\u0000-\u001f]/.test(postId) ? postId : null;
  if (entry.status === "drafted" && !realPostId) {
    warning = "Postiz 已收到草稿，但未返回有效帖子 ID；无法跟踪发布，请勿重复投稿。";
  }
  try {
    await runTransaction(async connection => {
      await connection.execute(
        `INSERT INTO social_publishes
         (id, project_id, asset_id, platform, integration_id, account_name, published_by,
          published_by_name, content_preview, postiz_post_id, status, error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [auditId, entry.projectId || null, entry.assetId, entry.platform, entry.integrationId,
          entry.accountName, entry.publishedBy, entry.publishedByName, shortenText(entry.contentPreview, 200),
          realPostId, entry.status, entry.status === "failed" ? "Postiz 投稿失败。" : null, formatUtc(submittedAt)]
      );
      if (entry.status !== "drafted") return;
      if (realPostId) {
        // Serialize insertion with configuration disable/cleanup without decrypting or doing network I/O.
        const [currentConfigs] = await connection.execute<RowDataPacket[]>(
          "SELECT enabled, notify_rejected, version FROM workspace_feishu_config WHERE id=1 FOR SHARE"
        );
        const currentConfig = currentConfigs[0];
        const rejectionEligible = config?.enabled && config.notifyRejected && currentConfig &&
          Number(currentConfig.enabled) === 1 && Number(currentConfig.notify_rejected) === 1 &&
          Number(currentConfig.version) === config.version;
        await connection.execute(
          `INSERT INTO social_post_tracking
            (publish_audit_id, postiz_post_id, submitted_at, next_check_at, notify_published, config_version,
             notify_rejected, review_status)
           VALUES (?,?,?,?,?,?,?,'pending')`,
          [auditId, realPostId, formatUtc(submittedAt), formatUtc(submittedAt),
            config?.enabled && config.notifyPublished ? 1 : 0, config?.version ?? 1,
            rejectionEligible ? 1 : 0]
        );
      }
      if (config?.enabled && config.notifyDrafts) {
        await insertNotification(connection, auditId, "draft_submitted", submittedAt, config.version,
          createPayload({ ...entry, postizPostId: realPostId ?? undefined }, submittedAt));
      }
    });
    return { auditId, ...(warning ? { warning } : {}) };
  } catch {
    // No fallback INSERT: a committed-but-unacknowledged transaction must not produce duplicate audits.
    return { warning: LOCAL_SAVE_WARNING };
  }
}

async function claimNotification(auditId?: string): Promise<RowDataPacket | null> {
  return runTransaction(async connection => {
    const now = new Date();
    await connection.execute(
      `UPDATE social_notification_outbox
          SET status=IF(attempts>=5,'failed','pending'), lease_token=NULL, lease_expires_at=NULL
        WHERE status='sending' AND lease_expires_at <= ?`, [formatUtc(now)]
    );
    const [notifications] = await connection.execute<RowDataPacket[]>(
      `SELECT notification.* FROM social_notification_outbox AS notification
        WHERE notification.status='pending' AND notification.next_attempt_at<=? AND notification.attempts<5
          ${auditId ? "AND notification.publish_audit_id=?" : ""}
          AND (notification.event_type='draft_submitted' OR NOT EXISTS (
            SELECT 1 FROM social_notification_outbox AS draft
              WHERE draft.publish_audit_id=notification.publish_audit_id AND draft.event_type='draft_submitted'
                AND draft.status IN ('pending','sending')))
        ORDER BY notification.event_time, notification.event_type, notification.id
        LIMIT 1 FOR UPDATE SKIP LOCKED`, [formatUtc(now), ...(auditId ? [auditId] : [])]
    );
    const notification = notifications[0];
    if (!notification) return null;
    const leaseToken = randomUUID();
    const [claimed] = await connection.execute<ResultSetHeader>(
      `UPDATE social_notification_outbox
          SET status='sending', attempts=attempts+1, lease_token=?, lease_expires_at=?
        WHERE id=? AND status='pending'`,
      [leaseToken, formatUtc(new Date(now.getTime() + LEASE_DURATION_MS)), notification.id]
    );
    return claimed.affectedRows === 1 ? { ...notification, attempts: Number(notification.attempts) + 1, lease_token: leaseToken } : null;
  });
}

async function finishNotification(
  notification: RowDataPacket, status: "pending" | "sent" | "failed" | "cancelled", error: string | null = null
): Promise<boolean> {
  const now = new Date();
  const retrySeconds = DELIVERY_BACKOFF_SECONDS[Math.min(Number(notification.attempts) - 1, 3)];
  const [updated] = await database().execute<ResultSetHeader>(
    `UPDATE social_notification_outbox
        SET status=?, sent_at=?, next_attempt_at=?, last_error=?, lease_token=NULL, lease_expires_at=NULL
      WHERE id=? AND status='sending' AND lease_token=?`,
    [status, status === "sent" ? formatUtc(now) : null,
      formatUtc(new Date(now.getTime() + (status === "pending" ? retrySeconds * 1000 : 0))),
      error, notification.id, notification.lease_token]
  );
  return updated.affectedRows === 1;
}

async function deferUnsentNotification(notification: RowDataPacket): Promise<void> {
  // Budget deferral is not a delivery attempt; only the current lease owner may return it.
  await database().execute(
    `UPDATE social_notification_outbox
        SET status='pending', attempts=GREATEST(attempts-1,0), next_attempt_at=?,
            lease_token=NULL, lease_expires_at=NULL
      WHERE id=? AND status='sending' AND lease_token=?`,
    [formatUtc(new Date(Date.now() + 60_000)), notification.id, notification.lease_token]
  );
}

function formatMessage(notification: RowDataPacket): string {
  const payload = (typeof notification.payload === "string" ? JSON.parse(notification.payload) : notification.payload) as NotificationPayload;
  if (!payload || typeof payload.applicantName !== "string" || typeof payload.platform !== "string" ||
      typeof payload.accountName !== "string" || typeof payload.summary !== "string") throw new Error("Invalid notification payload");
  const occurredAt = parsePublishDate(payload.occurredAt);
  if (!occurredAt) throw new Error("Invalid notification time");
  const singleLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ");
  let title: string;
  let timeLabel: string;
  switch (notification.event_type as NotificationEvent) {
    case "draft_submitted": title = "[Polaris] 新草稿待审核"; timeLabel = "提交时间"; break;
    case "draft_rejected": title = "[Polaris] 草稿审核不通过"; timeLabel = "首次检测时间"; break;
    case "published": title = "[Polaris] 内容已发布"; timeLabel = payload.timeKind === "publication" ? "发布时间" : "确认时间"; break;
    default: throw new Error("Unknown notification event");
  }
  const lines = [title,
    `申请人：${singleLine(payload.applicantName)}`,
    `平台 / 账号：${singleLine(payload.platform)} / ${singleLine(payload.accountName)}`,
    `摘要：${singleLine(shortenText(payload.summary, 200))}`,
    `${timeLabel}：${occurredAt.toISOString().replace("T", " ").replace("Z", " UTC")}`];
  if (notification.event_type !== "published") {
    const reviewUrl = validateHttpUrl(getPostizUiUrl());
    // The configured Postiz origin is a known entry point; never invent a post deep-link.
    if (reviewUrl) lines.push(`${notification.event_type === "draft_rejected" ? "处理入口" : "审核入口"}：${new URL(reviewUrl).origin}`);
  } else {
    const releaseUrl = validateHttpUrl(payload.releaseUrl);
    if (releaseUrl) lines.push(`发布链接：${releaseUrl}`);
    else {
      const managementUrl = validateHttpUrl(getPostizUiUrl());
      if (managementUrl) lines.push(`管理入口：${new URL(managementUrl).origin}`);
    }
  }
  return lines.join("\n");
}

async function recordDeliveryHealth(error: string | null): Promise<void> {
  await database().execute("UPDATE workspace_feishu_config SET last_delivery_error=? WHERE id=1", [error]);
}

async function renewDeliveryLease(notification: RowDataPacket): Promise<boolean> {
  const now = new Date();
  const [renewed] = await database().execute<ResultSetHeader>(
    `UPDATE social_notification_outbox SET lease_expires_at=?
      WHERE id=? AND status='sending' AND lease_token=? AND lease_expires_at>?`,
    [formatUtc(new Date(now.getTime() + LEASE_DURATION_MS + 1000)), notification.id,
      notification.lease_token, formatUtc(now)]
  );
  return renewed.affectedRows === 1;
}

/** Atomic SQL leases guard immediate route delivery and the worker; network runs after commit. */
export async function deliverSocialNotifications(options?: { auditId?: string; limit?: number }): Promise<SocialDeliverySummary> {
  return deliverWithinBudget(options);
}

function hasTaskBudget(deadline?: number): boolean {
  return deadline === undefined || Date.now() + WORKER_TASK_RESERVE_MS < deadline;
}

async function deliverWithinBudget(
  options?: { auditId?: string; limit?: number }, deadline?: number
): Promise<SocialDeliverySummary> {
  const summary: SocialDeliverySummary = { sent: 0, failed: 0, skipped: 0 };
  const requestedLimit = options?.limit ?? 20;
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(20, Math.floor(requestedLimit))) : 20;
  let previousSendAt: number | null = null;
  let latestDeliveryError: string | null | undefined;
  try {
    for (let processed = 0; processed < limit; processed++) {
      if (!hasTaskBudget(deadline)) break;
      const notification = await claimNotification(options?.auditId);
      if (!notification) break;
      let deliveryError = DELIVERY_ERROR;
      try {
        if (previousSendAt !== null) {
          const remainingDelay = 1000 - (Date.now() - previousSendAt);
          if (remainingDelay > 0) await delay(remainingDelay);
        }
        // Read after any rate-limit wait, so a queued message never uses an obsolete destination snapshot.
        const config = await readFeishuConfig().catch(() => { throw new Error(CONFIG_READ_ERROR); });
        let eventEnabled = false;
        switch (notification.event_type as NotificationEvent) {
          case "draft_submitted": eventEnabled = config?.notifyDrafts === true; break;
          case "draft_rejected": eventEnabled = config?.notifyRejected === true; break;
          case "published": eventEnabled = config?.notifyPublished === true; break;
        }
        if (!config?.enabled || !eventEnabled || config.version !== Number(notification.config_version)) {
          await finishNotification(notification, "cancelled");
          summary.skipped++;
          continue;
        }
        const message = formatMessage(notification);
        // A configuration read may stall beyond the lease. An obsolete owner must not start a send.
        if (!await renewDeliveryLease(notification)) { summary.skipped++; continue; }
        if (!hasTaskBudget(deadline)) {
          await deferUnsentNotification(notification);
          summary.skipped++;
          break;
        }
        previousSendAt = Date.now();
        await sendFeishuMessage(config, message);
        if (await finishNotification(notification, "sent")) summary.sent++;
        else summary.skipped++;
        latestDeliveryError = null;
      } catch (error) {
        if (error instanceof Error && error.message === CONFIG_READ_ERROR) deliveryError = CONFIG_READ_ERROR;
        const nextStatus = Number(notification.attempts) >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending";
        if (await finishNotification(notification, nextStatus, deliveryError)) summary.failed++;
        else summary.skipped++;
        latestDeliveryError = deliveryError;
      }
    }
  } catch {
    summary.failed++;
    latestDeliveryError = DELIVERY_ERROR;
  }
  if (latestDeliveryError !== undefined) {
    // Monitoring failures must not requeue an acknowledged message or distort delivery counts.
    try { await recordDeliveryHealth(latestDeliveryError); } catch { /* The worker also checks health storage. */ }
  }
  return summary;
}

function calculateCheckDelay(attempts: number): number {
  return Math.min(3600, 60 * 2 ** Math.min(attempts, 6)) * 1000;
}

async function postponeTracking(row: RowDataPacket, state: PostState, error: string | null): Promise<void> {
  const now = new Date();
  await database().execute(
    `UPDATE social_post_tracking SET state=?, next_check_at=?, last_checked_at=?, last_error=?, check_attempts=check_attempts+1
      WHERE publish_audit_id=? AND confirmed_at IS NULL`,
    [state, formatUtc(new Date(now.getTime() + (error === null && (state === "DRAFT" || state === "QUEUE")
      ? 60_000 : calculateCheckDelay(Number(row.check_attempts))))),
      formatUtc(now), error, row.publish_audit_id]
  );
}

function createTrackingPayload(row: RowDataPacket, occurredAt: Date): NotificationPayload {
  return createPayload({
    assetId: String(row.asset_id), platform: String(row.platform), integrationId: String(row.integration_id),
    accountName: String(row.account_name), publishedBy: String(row.published_by), publishedByName: String(row.published_by_name),
    contentPreview: String(row.content_preview), postizPostId: String(row.postiz_post_id), status: "drafted",
    ...(row.project_id ? { projectId: String(row.project_id) } : {})
  }, occurredAt);
}

async function recordObservedPost(row: RowDataPacket, details: PostDetails): Promise<void> {
  await runTransaction(async connection => {
    const [currentRows] = await connection.execute<RowDataPacket[]>(
      "SELECT * FROM social_post_tracking WHERE publish_audit_id=? FOR UPDATE", [row.publish_audit_id]
    );
    const current = currentRows[0];
    if (!current || current.confirmed_at) return;
    const observedAt = new Date();
    const saveAction = parseSaveAction(details.saveAction);
    const isRejected = details.state === "DRAFT" && saveAction === "pass";
    let reviewStatus = current.review_status ?? "unknown";
    if (details.state !== "DRAFT") reviewStatus = "unknown";
    else if (isRejected) reviewStatus = "rejected";
    else if (saveAction === "draft" || saveAction === "update") reviewStatus = "pending";
    else if (saveAction === "schedule" || saveAction === "now") reviewStatus = "unknown";
    // Missing or unrecognized actions cannot prove approval or erase an observed rejection.
    const firstDetectedAt = isRejected
      ? current.rejected_detected_at ? parseDatabaseUtc(current.rejected_detected_at) : observedAt
      : null;
    if (isRejected && Number(current.notify_rejected) === 1) {
      const payload = createTrackingPayload(row, firstDetectedAt!);
      payload.timeKind = "detection";
      await insertNotification(connection, String(row.publish_audit_id), "draft_rejected", firstDetectedAt!,
        Number(current.config_version), payload);
    }
    const publishDate = parsePublishDate(details.publishDate);
    const error = details.state === "ERROR" ? "Postiz 报告帖子发布失败。" : null;
    await connection.execute(
      `UPDATE social_post_tracking SET state=?, save_action=?, review_status=?,
         rejected_detected_at=COALESCE(rejected_detected_at,?), postiz_publish_date=COALESCE(?,postiz_publish_date),
         next_check_at=?, last_checked_at=?, last_error=?, check_attempts=check_attempts+1
       WHERE publish_audit_id=? AND confirmed_at IS NULL`,
      [details.state, saveAction, reviewStatus, firstDetectedAt ? formatUtc(firstDetectedAt) : null,
        publishDate ? formatUtc(publishDate) : null,
        formatUtc(new Date(observedAt.getTime() + (error ? calculateCheckDelay(Number(current.check_attempts)) : 60_000))),
        formatUtc(observedAt), error, row.publish_audit_id]
    );
  });
}

async function confirmPublished(row: RowDataPacket, details: PostDetails): Promise<boolean> {
  return runTransaction(async connection => {
    const [currentRows] = await connection.execute<RowDataPacket[]>(
      "SELECT * FROM social_post_tracking WHERE publish_audit_id=? FOR UPDATE", [row.publish_audit_id]
    );
    const current = currentRows[0];
    if (!current || current.confirmed_at) return false;
    const confirmedAt = new Date();
    const publishDate = parsePublishDate(details.publishDate);
    const releaseUrl = validateHttpUrl(details.releaseUrl);
    const payload = createTrackingPayload(row, publishDate ?? confirmedAt);
    payload.timeKind = publishDate ? "publication" : "confirmation";
    if (releaseUrl) payload.releaseUrl = releaseUrl;
    if (Number(current.notify_published) === 1) {
      await insertNotification(connection, String(row.publish_audit_id), "published", publishDate ?? confirmedAt,
        Number(current.config_version), payload);
    }
    await connection.execute(
      `UPDATE social_post_tracking SET state='PUBLISHED', release_url=?, postiz_publish_date=?, confirmed_at=?,
         last_checked_at=?, next_check_at=?, save_action=?, review_status='unknown',
         last_error=NULL, check_attempts=check_attempts+1 WHERE publish_audit_id=?`,
      [releaseUrl, publishDate ? formatUtc(publishDate) : null, formatUtc(confirmedAt), formatUtc(confirmedAt),
        formatUtc(confirmedAt), parseSaveAction(details.saveAction), row.publish_audit_id]
    );
    return true;
  });
}

async function pollTrackedPosts(deadline: number): Promise<{ checked: number; confirmed: number; warning?: string }> {
  if (!hasTaskBudget(deadline)) return { checked: 0, confirmed: 0 };
  // Read eligibility in the UPDATE itself: an old worker snapshot must not retire newer submissions.
  await database().execute(
    `UPDATE social_post_tracking AS tracking
       LEFT JOIN workspace_feishu_config AS config ON config.id=1
       SET tracking.notify_published=IF(tracking.config_version<>COALESCE(config.version,0)
             OR COALESCE(config.enabled,0)=0 OR COALESCE(config.notify_published,0)=0,0,tracking.notify_published),
           tracking.notify_rejected=IF(tracking.config_version<>COALESCE(config.version,0)
             OR COALESCE(config.enabled,0)=0 OR COALESCE(config.notify_rejected,0)=0,0,tracking.notify_rejected)
       WHERE tracking.notify_published=1 OR tracking.notify_rejected=1`
  );
  if (!hasTaskBudget(deadline)) return { checked: 0, confirmed: 0 };
  const now = new Date();
  const [tracking] = await database().execute<RowDataPacket[]>(
    `SELECT tracking.*, audit.project_id, audit.asset_id, audit.platform, audit.integration_id, audit.account_name,
            audit.published_by, audit.published_by_name, audit.content_preview
       FROM social_post_tracking AS tracking JOIN social_publishes AS audit ON audit.id=tracking.publish_audit_id
      WHERE tracking.confirmed_at IS NULL AND tracking.next_check_at<=?
      ORDER BY tracking.next_check_at, tracking.publish_audit_id LIMIT 100`, [formatUtc(now)]
  );
  const summary = { checked: 0, confirmed: 0 };
  if (!tracking.length || !hasTaskBudget(deadline)) return summary;
  const oldestSubmission = Math.min(...tracking.map(row => parseDatabaseUtc(row.submitted_at).getTime()));
  const knownPublishDates = tracking.map(row => parseDatabaseUtc(row.postiz_publish_date).getTime()).filter(Number.isFinite);
  const earliestRelevantDate = Math.min(oldestSubmission, ...knownPublishDates);
  const latestRelevantDate = Math.max(now.getTime() + UNKNOWN_PUBLISH_HORIZON_MS, ...knownPublishDates.map(date => date + 86_400_000));
  const postIds = [...new Set(tracking.map(row => String(row.postiz_post_id)))];
  let details: Map<string, PostDetails>;
  try {
    details = await fetchPostizPostDetails(postIds, {
      // Upstream creates the draft before local audit persistence; include that boundary and modest clock skew.
      startDate: new Date(earliestRelevantDate - 86_400_000), endDate: new Date(latestRelevantDate)
    });
  } catch {
    for (const row of tracking) {
      if (!hasTaskBudget(deadline)) break;
      await postponeTracking(row, row.state as PostState, POLLING_ERROR);
      summary.checked++;
    }
    return { ...summary, warning: POLLING_ERROR };
  }
  for (const row of tracking) {
    if (!hasTaskBudget(deadline)) break;
    const post = details.get(String(row.postiz_post_id));
    if (!post || post.id !== String(row.postiz_post_id) || !["DRAFT", "QUEUE", "PUBLISHED", "ERROR"].includes(post.state)) {
      await postponeTracking(row, row.state as PostState, "Postiz 尚未确认此帖子状态。");
    } else if (post.state === "PUBLISHED") {
      if (await confirmPublished(row, post)) summary.confirmed++;
    } else {
      await recordObservedPost(row, post);
    }
    summary.checked++;
  }
  return summary;
}

/** Invoked by the authenticated internal timer, never by browser cookies or client-reported states. */
export async function processSocialNotifications(): Promise<SocialWorkerSummary> {
  const deadline = Date.now() + WORKER_BUDGET_MS;
  const summary: SocialWorkerSummary = { checked: 0, confirmed: 0, sent: 0, failed: 0, skipped: 0, locked: false };
  let lockConnection: PoolConnection | undefined;
  let lockName: string | undefined;
  let acquired = false;
  let destroyConnection = false;
  try {
    lockConnection = await database().getConnection();
    const [databaseNames] = await lockConnection.execute<RowDataPacket[]>("SELECT DATABASE() AS database_name");
    const databaseName = String(databaseNames[0]?.database_name ?? "");
    if (!databaseName) throw new Error("Database name unavailable");
    lockName = `polaris-social:${createHash("sha256").update(databaseName).digest("hex").slice(0, 48)}`;
    const [locks] = await lockConnection.execute<RowDataPacket[]>("SELECT GET_LOCK(?,0) AS acquired", [lockName]);
    acquired = Number(locks[0]?.acquired) === 1;
    if (!acquired) { summary.locked = true; return summary; }
    // GET_LOCK is connection-scoped. Its dedicated connection has NO open transaction during network I/O.
    const polling = await pollTrackedPosts(deadline);
    Object.assign(summary, polling);
    Object.assign(summary, await deliverWithinBudget({ limit: 20 }, deadline));
    await database().execute("UPDATE workspace_feishu_config SET last_worker_at=? WHERE id=1", [formatUtc(new Date())]);
  } catch {
    summary.warning = "通知任务暂未完成，请检查服务配置与连接。";
    try {
      await database().execute("UPDATE workspace_feishu_config SET last_worker_at=?, last_delivery_error=? WHERE id=1",
        [formatUtc(new Date()), summary.warning]);
    } catch { /* The safe warning also reports unavailable health storage to the internal caller. */ }
  } finally {
    if (lockConnection && acquired && lockName) {
      try { await lockConnection.execute("SELECT RELEASE_LOCK(?) AS released", [lockName]); }
      catch { destroyConnection = true; summary.warning = "通知任务锁连接异常，已关闭该连接。"; }
    }
    if (lockConnection) {
      if (destroyConnection) lockConnection.destroy();
      else lockConnection.release();
    }
  }
  return summary;
}
