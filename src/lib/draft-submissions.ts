import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { database } from "@/lib/project-db";
import { ownerHashFor } from "@/lib/auth";
import { getSocialAccount } from "@/lib/social-accounts";
import { claimPostTarget, readSubmissionTarget, type ClaimTargetRow, type SubmitOutcome } from "@/lib/post-submission";
import { databaseEpoch, getManualPost } from "@/lib/posts";
import { createStrictDraft, fetchPostizIntegrations, fetchPostizPostDetails } from "@/lib/postiz";
import { recordSocialSubmission } from "@/lib/social-notifications";
import type { DraftSubmissionState, DraftSubmissionTask } from "./draft-submission-types";

const utc = (date: Date) => date.toISOString().slice(0, 23).replace("T", " ");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const LEASE_MS = 300_000;
const UNKNOWN_WARNING = "The submission result could not be confirmed. Check the publishing engine before submitting again.";
const AUDIT_WARNING = "The draft was accepted, but local tracking could not be saved. Do not submit again.";

type Snapshot = {
  content: string;
  imageUrl: string | null;
  platform: string;
  accountName: string;
  version?: number;
  rejectedBinding: ClaimTargetRow | null;
};
interface TaskRow extends RowDataPacket {
  id: string;
  owner_user_id: string;
  kind: "asset" | "manual";
  source_id: string;
  project_id: string | null;
  integration_id: string;
  attempt_id: string | null;
  fingerprint: string;
  snapshot: Snapshot | string;
  state: DraftSubmissionState;
  lease_token: string | null;
  audit_id: string | null;
  postiz_post_id: string | null;
  warning: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function projectTask(row: TaskRow): DraftSubmissionTask {
  const timestamp = (value: string) => new Date(databaseEpoch(value)).toISOString();
  return {
    id: row.id, kind: row.kind, sourceId: row.source_id, projectId: row.project_id,
    integrationId: row.integration_id, state: row.state, auditId: row.audit_id, postId: row.postiz_post_id,
    warning: row.warning, error: row.error, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    finishedAt: row.finished_at ? timestamp(row.finished_at) : null
  };
}

export async function listDraftSubmissions(ownerUserId: string, options: { ids?: string[]; sourceIds?: string[]; projectId?: string }): Promise<DraftSubmissionTask[]> {
  const identifiers = options.ids?.length ? options.ids : options.sourceIds;
  if (!identifiers?.length || identifiers.length > 64) return [];
  const fields = "id, kind, source_id, project_id, integration_id, state, audit_id, postiz_post_id, warning, error, created_at, updated_at, finished_at";
  const [rows] = await database().execute<TaskRow[]>(
    `SELECT * FROM (SELECT ${fields}, ROW_NUMBER() OVER (
        PARTITION BY source_id, integration_id ORDER BY created_at DESC, id DESC) AS task_rank
      FROM draft_submissions WHERE owner_user_id=?
        AND ${options.ids?.length ? "id" : "source_id"} IN (${identifiers.map(() => "?").join(",")})
        ${options.ids?.length ? "" : "AND kind='asset' AND project_id <=> ?"}) AS ranked_tasks
      ${options.ids?.length ? "" : "WHERE task_rank=1"} ORDER BY created_at DESC, id DESC`,
    [ownerUserId, ...identifiers, ...(options.ids?.length ? [] : [options.projectId || null])]
  );
  return rows.map(projectTask);
}

async function insertTask(connection: PoolConnection, input: {
  id: string; ownerUserId: string; kind: "asset" | "manual"; sourceId: string; projectId?: string;
  integrationId: string; attemptId?: string; requestKey: string; fingerprint: string; activeKey: string; snapshot: Snapshot;
}): Promise<void> {
  const now = utc(new Date());
  await connection.execute(
    `INSERT INTO draft_submissions
       (id, owner_user_id, kind, source_id, project_id, integration_id, attempt_id, request_key,
        fingerprint, active_key, snapshot, state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
    [input.id, input.ownerUserId, input.kind, input.sourceId, input.projectId || null, input.integrationId,
      input.attemptId || null, input.requestKey, input.fingerprint, input.activeKey, JSON.stringify(input.snapshot), now, now]
  );
}

type EnqueueOutcome = Exclude<SubmitOutcome, { kind: "ok" }> | { kind: "queued"; task: DraftSubmissionTask; post?: Awaited<ReturnType<typeof getManualPost>> } | Extract<SubmitOutcome, { kind: "ok" }>;

export async function enqueueManualSubmission(options: Parameters<typeof import("./post-submission").submitPostTarget>[0]): Promise<EnqueueOutcome> {
  const account = await getSocialAccount(options.integrationId);
  if (!options.isAdmin && account?.ownerUserId !== options.userId) return { kind: "forbidden", message: "This social account is not assigned to you." };
  const current = await readSubmissionTarget(database(), options.userId, options.postId, options.integrationId);
  const rejectedBinding = current?.status === "rejected" ? current : null;
  if (rejectedBinding && (!options.expectedAuditId || options.expectedAuditId !== rejectedBinding.audit_id || !rejectedBinding.postiz_post_id)) {
    return { kind: "conflict" };
  }
  const taskId = randomUUID();
  const claim = await claimPostTarget({
    ...options, platform: account?.provider || "unknown", accountName: account?.accountName || options.integrationId, rejectedBinding,
    enqueue: async (connection, frozen) => {
      await insertTask(connection, {
        id: taskId, ownerUserId: options.userId, kind: "manual", sourceId: options.postId,
        integrationId: options.integrationId, attemptId: frozen.attemptId,
        requestKey: digest(["manual", frozen.attemptId]), fingerprint: digest([options.postId, options.integrationId, options.expectedVersion, options.expectedAuditId]),
        activeKey: digest(["manual", options.userId, options.postId, options.integrationId]),
        snapshot: { content: frozen.content, imageUrl: frozen.imageDataUrl, platform: account?.provider || "unknown",
          accountName: account?.accountName || options.integrationId, version: options.expectedVersion, rejectedBinding }
      });
    }
  });
  if (claim.kind === "accepted") {
    const post = await getManualPost(options.userId, options.postId);
    return post ? { kind: "ok", post } : { kind: "not_found" };
  }
  if (claim.kind !== "claimed") return claim;
  const [task] = await listDraftSubmissions(options.userId, { ids: [taskId] });
  return { kind: "queued", task, post: await getManualPost(options.userId, options.postId) };
}

export async function enqueueAssetSubmission(input: {
  userId: string; isAdmin: boolean; projectId?: string; assetId: string; integrationId: string;
  content: string; imageUrl?: string; platform?: string; requestId: string; expectedAuditId?: string;
}): Promise<EnqueueOutcome> {
  const account = await getSocialAccount(input.integrationId);
  if (!input.isAdmin && account?.ownerUserId !== input.userId) return { kind: "forbidden", message: "This social account is not assigned to you." };
  const scope = ["asset", input.userId, input.projectId || null, input.assetId, input.integrationId];
  const fingerprint = digest([...scope, input.content, input.imageUrl || null, input.expectedAuditId || null]);
  const requestKey = digest([input.userId, input.requestId]);
  const activeKey = digest(scope);
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    // This owner lock serializes short enqueue decisions, not external work; unique keys remain the backstop.
    await connection.execute("SELECT id FROM users WHERE id=? FOR UPDATE", [input.userId]);
    if (input.projectId) {
      const [projects] = await connection.execute<RowDataPacket[]>("SELECT id FROM projects WHERE id=? AND owner_hash=? FOR SHARE", [input.projectId, ownerHashFor(input.userId)]);
      if (!projects.length) { await connection.rollback(); return { kind: "forbidden", message: "This project does not belong to you." }; }
    }
    const [existing] = await connection.execute<TaskRow[]>(
      `SELECT * FROM draft_submissions WHERE owner_user_id=? AND
        (request_key=? OR active_key=? OR (fingerprint=? AND state='succeeded'))
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [input.userId, requestKey, activeKey, fingerprint]
    );
    if (existing.length) {
      await connection.rollback();
      if (existing[0].fingerprint !== fingerprint) return { kind: existing[0].state === "unknown" ? "unconfirmed" : "in_flight" };
      return { kind: "queued", task: projectTask(existing[0]) };
    }
    let rejectedBinding: ClaimTargetRow | null = null;
    if (input.expectedAuditId) {
      const [bindings] = await connection.execute<ClaimTargetRow[]>(
        `SELECT 'rejected' AS status, a.id AS audit_id, a.postiz_post_id, a.created_at AS submitted_at,
                tracking.postiz_publish_date
           FROM social_publishes a JOIN social_post_tracking tracking ON tracking.publish_audit_id=a.id
             AND CAST(tracking.postiz_post_id AS BINARY)=CAST(a.postiz_post_id AS BINARY)
          WHERE a.id=? AND a.asset_id=? AND a.integration_id=? AND a.published_by=? AND a.project_id <=> ?
            AND tracking.state='DRAFT' AND tracking.review_status='rejected'`,
        [input.expectedAuditId, input.assetId, input.integrationId, input.userId, input.projectId || null]
      );
      rejectedBinding = bindings[0] ?? null;
      if (!rejectedBinding) { await connection.rollback(); return { kind: "conflict" }; }
    }
    const taskId = randomUUID();
    await insertTask(connection, {
      id: taskId, ownerUserId: input.userId, kind: "asset", sourceId: input.assetId, projectId: input.projectId,
      integrationId: input.integrationId, requestKey, fingerprint, activeKey,
      snapshot: { content: input.content, imageUrl: input.imageUrl || null, platform: account?.provider || input.platform || "unknown",
        accountName: account?.accountName || input.integrationId, rejectedBinding }
    });
    await connection.commit();
    const [tasks] = await connection.execute<TaskRow[]>(
      "SELECT * FROM draft_submissions WHERE id=? AND owner_user_id=?", [taskId, input.userId]
    );
    return { kind: "queued", task: projectTask(tasks[0]) };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

type Completion = { state: "succeeded" | "failed" | "unknown"; postId?: string; auditId?: string; warning?: string; error?: string };

async function completeTask(task: TaskRow, snapshot: Snapshot, result: Completion): Promise<void> {
  const connection = await database().getConnection();
  const now = utc(new Date());
  try {
    await connection.beginTransaction();
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE draft_submissions SET state=?, postiz_post_id=?, audit_id=?, warning=?, error=?,
          active_key=IF(?='unknown',active_key,NULL), finished_at=?, updated_at=?, lease_expires_at=NULL
        WHERE id=? AND lease_token=? AND state IN ('running','unknown')`,
      [result.state, result.postId || null, result.auditId || null, result.warning?.slice(0, 512) || null,
        result.error?.slice(0, 512) || null, result.state, now, now, task.id, task.lease_token]
    );
    if (updated.affectedRows && task.kind === "manual") {
      const restore = result.state === "failed" ? snapshot.rejectedBinding : null;
      await connection.execute(
        `UPDATE post_targets SET status=?, postiz_post_id=?, audit_id=?, warning=?, error=?, submitted_at=?, updated_at=?
          WHERE post_id=? AND integration_id=? AND attempt_id=? AND status IN ('submitting','pending_unknown')`,
        [restore || result.state === "succeeded" ? "accepted" : result.state === "unknown" ? "pending_unknown" : "failed",
          restore?.postiz_post_id || result.postId || null, restore?.audit_id || result.auditId || null,
          result.warning?.slice(0, 512) || null, result.error?.slice(0, 512) || null,
          restore?.submitted_at || (result.state === "unknown" ? null : now), now, task.source_id, task.integration_id, task.attempt_id]
      );
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function recoverDraftSubmissions(): Promise<void> {
  const [expired] = await database().execute<TaskRow[]>(
    "SELECT * FROM draft_submissions WHERE state='running' AND lease_expires_at<=? LIMIT 100", [utc(new Date())]
  );
  for (const task of expired) {
    await completeTask(task, typeof task.snapshot === "string" ? JSON.parse(task.snapshot) : task.snapshot,
      { state: "unknown", warning: UNKNOWN_WARNING });
  }
}

async function claimTask(): Promise<TaskRow | null> {
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [tasks] = await connection.execute<TaskRow[]>("SELECT * FROM draft_submissions WHERE state='queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED");
    const task = tasks[0];
    if (!task) { await connection.rollback(); return null; }
    const leaseToken = randomUUID();
    const [updated] = await connection.execute<ResultSetHeader>(
      "UPDATE draft_submissions SET state='running', lease_token=?, lease_expires_at=?, updated_at=? WHERE id=? AND state='queued'",
      [leaseToken, utc(new Date(Date.now() + LEASE_MS)), utc(new Date()), task.id]
    );
    await connection.commit();
    return updated.affectedRows ? { ...task, state: "running", lease_token: leaseToken } : null;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function verifyRejected(snapshot: Snapshot): Promise<boolean> {
  const binding = snapshot.rejectedBinding;
  if (!binding) return true;
  const submittedAt = databaseEpoch(binding.submitted_at);
  if (!submittedAt || !binding.postiz_post_id) return false;
  const publishDate = databaseEpoch(binding.postiz_publish_date);
  const dates = [submittedAt, ...(publishDate ? [publishDate] : [])];
  const details = await fetchPostizPostDetails([binding.postiz_post_id], {
    startDate: new Date(Math.min(...dates) - 86_400_000),
    endDate: new Date(Math.max(Date.now(), ...dates) + 86_400_000)
  });
  const upstream = details.get(binding.postiz_post_id);
  return upstream?.id === binding.postiz_post_id && upstream.state === "DRAFT" && upstream.saveAction === "pass";
}

async function executeTask(task: TaskRow): Promise<void> {
  const snapshot: Snapshot = typeof task.snapshot === "string" ? JSON.parse(task.snapshot) : task.snapshot;
  let createStarted = false;
  let completion: Completion | null = null;
  try {
    const [users] = await database().execute<RowDataPacket[]>("SELECT role, disabled, display_name FROM users WHERE id=?", [task.owner_user_id]);
    const account = await getSocialAccount(task.integration_id);
    if (!users[0] || Number(users[0].disabled) || (users[0].role !== "admin" && account?.ownerUserId !== task.owner_user_id)) {
      throw new Error("Submission permission changed. No draft was created.");
    }
    if (task.project_id) {
      const [projects] = await database().execute<RowDataPacket[]>("SELECT id FROM projects WHERE id=? AND owner_hash=?", [task.project_id, ownerHashFor(task.owner_user_id)]);
      if (!projects.length) throw new Error("The source project is no longer available. No draft was created.");
    }
    const live = await fetchPostizIntegrations();
    const liveAccount = live.accounts.find(candidate => candidate.id === task.integration_id);
    if (!live.configured || live.error || !liveAccount || liveAccount.disabled) throw new Error("The target account could not be verified. No draft was created.");
    if (!await verifyRejected(snapshot)) throw new Error("The publishing engine no longer confirms this draft as rejected. No retry was submitted.");
    if (snapshot.rejectedBinding) {
      const [bindings] = await database().execute<RowDataPacket[]>(
        `SELECT a.id FROM social_publishes a JOIN social_post_tracking tracking ON tracking.publish_audit_id=a.id
            AND CAST(tracking.postiz_post_id AS BINARY)=CAST(a.postiz_post_id AS BINARY)
          WHERE a.id=? AND a.asset_id=? AND a.integration_id=? AND a.published_by=? AND a.project_id <=> ?
            AND CAST(a.postiz_post_id AS BINARY)=CAST(? AS BINARY)
            AND tracking.state='DRAFT' AND tracking.review_status='rejected'`,
        [snapshot.rejectedBinding.audit_id, task.source_id, task.integration_id, task.owner_user_id,
          task.project_id, snapshot.rejectedBinding.postiz_post_id]
      );
      if (!bindings.length) throw new Error("The frozen submission binding changed. No draft was created.");
    }
    // Recheck the entire frozen attempt after external verification, never a stale tab's authorization.
    if (task.kind === "manual") {
      const [targets] = await database().execute<RowDataPacket[]>(
        `SELECT t.attempt_id FROM post_targets t JOIN posts p ON p.id=t.post_id
          WHERE t.post_id=? AND t.integration_id=? AND p.owner_user_id=? AND t.attempt_id=?
            AND t.status='submitting' AND p.version=? AND t.snapshot_version=?`,
        [task.source_id, task.integration_id, task.owner_user_id, task.attempt_id, snapshot.version ?? 0, snapshot.version ?? 0]
      );
      if (!targets.length) throw new Error("The frozen submission binding changed. No draft was created.");
    }
    const [lease] = await database().execute<RowDataPacket[]>(
      "SELECT id FROM draft_submissions WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>?",
      [task.id, task.lease_token, utc(new Date())]
    );
    if (!lease.length) return;
    createStarted = true;
    const result = await createStrictDraft({ integrationId: task.integration_id, content: snapshot.content,
      imageUrl: snapshot.imageUrl || undefined, platform: liveAccount.identifier || snapshot.platform });
    if (result.success) {
      completion = { state: "succeeded", postId: result.postId, warning: result.warning };
      try {
        const registration = await recordSocialSubmission({
          projectId: task.project_id || undefined, assetId: task.source_id, platform: liveAccount.identifier || snapshot.platform,
          integrationId: task.integration_id, accountName: liveAccount.name || snapshot.accountName,
          publishedBy: task.owner_user_id, publishedByName: String(users[0].display_name),
          contentPreview: snapshot.content.slice(0, 200), postizPostId: result.postId, status: "drafted"
        });
        completion.auditId = registration.auditId;
        completion.warning = [result.warning, registration.warning || (!registration.auditId ? AUDIT_WARNING : "")].filter(Boolean).join(" ") || undefined;
      } catch { completion.warning = [result.warning, AUDIT_WARNING].filter(Boolean).join(" "); }
    } else {
      completion = result.uncertain ? { state: "unknown", warning: UNKNOWN_WARNING }
        : { state: "failed", error: "The publishing engine refused the draft. No draft was created." };
      if (!result.uncertain) {
        try {
          const registration = await recordSocialSubmission({ projectId: task.project_id || undefined,
            assetId: task.source_id, platform: liveAccount.identifier || snapshot.platform, integrationId: task.integration_id,
            accountName: liveAccount.name || snapshot.accountName, publishedBy: task.owner_user_id,
            publishedByName: String(users[0].display_name), contentPreview: snapshot.content.slice(0, 200), status: "failed" });
          completion.auditId = registration.auditId;
        } catch { /* The task itself retains a definite failure even when supplementary auditing is unavailable. */ }
      }
    }
  } catch (error) {
    completion ??= createStarted ? { state: "unknown", warning: UNKNOWN_WARNING }
      : { state: "failed", error: error instanceof Error ? error.message : "Submission validation failed. No draft was created." };
  }
  if (completion) await completeTask(task, snapshot, completion);
}

export async function processDraftSubmissions(limit = 4): Promise<number> {
  await recoverDraftSubmissions();
  let processed = 0;
  for (let index = 0; index < limit; index++) {
    const task = await claimTask();
    if (!task) break;
    await executeTask(task);
    processed++;
  }
  return processed;
}
