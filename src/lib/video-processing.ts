import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { uploadVideoFileToPostiz } from "./postiz";
import { isVideoAttachment, isVideoMediaId, isVideoProcessingResponse, type VideoAttachment, type VideoProcessingJob } from "./video-types";
import { getVideoUpload, getVideoUploadByRequest, recordVideoUpload, VideoUploadRequestConflictError, withVideoUploadConnection } from "./video-uploads";
import { VideoUploadError } from "./video-validation";
import { prepareCompatibleVideo } from "./video-transcoding";

type Connection = Pick<PoolConnection, "execute">;
interface JobRow extends RowDataPacket {
  id: string;
  owner_user_id: string;
  request_id: string;
  checksum: string;
  input_bytes: number;
  filename: string;
  state: VideoProcessingJob["state"];
  phase: VideoProcessingJob["phase"];
  video_media_id: string | null;
  error_code: string | null;
  error: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
}

const SQL_TIMEOUT = 5_000;
const LEASE_DURATION = 15 * 60_000;
const FILE_RETENTION = 24 * 60 * 60_000;
const capacityLock = "polaris-video-processing-capacity";
const processingGlobal = globalThis as typeof globalThis & {
  polarisVideoProcessing?: { active: Map<string, AbortController>; inFlight: Promise<number> | null; lastSweep: number };
};
const state = processingGlobal.polarisVideoProcessing ??= { active: new Map(), inFlight: null, lastSweep: 0 };
const utc = (milliseconds = Date.now()) => new Date(milliseconds).toISOString().slice(0, 23).replace("T", " ");
const sql = (statement: string) => ({ sql: statement, timeout: SQL_TIMEOUT });
const storageSignal = () => AbortSignal.timeout(SQL_TIMEOUT);

function spoolPaths(jobId: string) {
  if (!isVideoMediaId(jobId)) throw new Error("Invalid video processing identifier.");
  const root = resolve(process.env.VIDEO_PROCESSING_DIRECTORY?.trim() || join(process.cwd(), ".data", "video-processing"));
  const directory = join(root, jobId.toLowerCase());
  return { root, directory, partPath: join(directory, "input.part"), inputPath: join(directory, "input.mp4"), outputPath: join(directory, "output.mp4") };
}

async function ensureSpoolRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Video storage is unavailable.");
  await chmod(root, 0o700);
}

export async function createVideoProcessingInput() {
  const id = randomUUID();
  const paths = spoolPaths(id);
  await ensureSpoolRoot(paths.root);
  await mkdir(paths.directory, { mode: 0o700 });
  return { id, ...paths };
}

export async function completeVideoProcessingInput(jobId: string): Promise<void> {
  const paths = spoolPaths(jobId);
  await rename(paths.partPath, paths.inputPath);
}

/** Caller must know that no job references the input, or that its worker has fully settled. */
export async function removeVideoProcessingInput(jobId: string): Promise<void> {
  const paths = spoolPaths(jobId);
  await ensureSpoolRoot(paths.root);
  await rm(paths.directory, { recursive: true, force: true });
}

function publicVideo(video: VideoAttachment): VideoAttachment {
  return { id: video.id, name: video.name, bytes: video.bytes, width: video.width, height: video.height, durationSeconds: video.durationSeconds };
}

async function readJob(connection: Connection, ownerUserId: string, jobId: string, lock = false): Promise<JobRow | null> {
  const [rows] = await connection.execute<JobRow[]>(sql(
    `SELECT * FROM video_processing_jobs WHERE owner_user_id = ? AND id = ?${lock ? " FOR UPDATE" : ""}`
  ), [ownerUserId, jobId]);
  return rows[0] ?? null;
}

async function publicJob(row: JobRow, connection: Connection): Promise<VideoProcessingJob> {
  const job: VideoProcessingJob = { id: row.id, state: row.state, phase: row.phase };
  if (row.state === "succeeded") {
    const video = row.video_media_id ? await getVideoUpload(row.owner_user_id, row.video_media_id, connection) : null;
    if (!video) throw new Error("Video processing receipt is missing.");
    job.video = publicVideo(video);
  }
  if (row.error) job.error = row.error;
  if (row.error_code) job.code = row.error_code;
  if (!isVideoProcessingResponse({ job })) throw new Error("Invalid stored video processing job.");
  return job;
}

export function getVideoProcessingRequest(ownerUserId: string, requestId: string, signal: AbortSignal) {
  return withVideoUploadConnection(async connection => {
    const [rows] = await connection.execute<JobRow[]>(sql(
      "SELECT * FROM video_processing_jobs WHERE owner_user_id = ? AND request_id = ?"
    ), [ownerUserId, requestId]);
    const receipt = await getVideoUploadByRequest(ownerUserId, requestId, connection);
    return { receipt, job: rows[0] ? await publicJob(rows[0], connection) : null, checksum: rows[0]?.checksum };
  }, signal);
}

export async function registerVideoProcessingJob(input: {
  id: string; ownerUserId: string; requestId: string; checksum: string; bytes: number; name: string;
}, signal: AbortSignal): Promise<{ job: VideoProcessingJob } | { video: VideoAttachment }> {
  let inputMayBeReferenced = false;
  let commitAttempted = false;
  try {
    return await withVideoUploadConnection(async connection => {
      const [locks] = await connection.execute<RowDataPacket[]>(sql("SELECT GET_LOCK(?, 1) AS acquired"), [capacityLock]);
      if (Number(locks[0]?.acquired) !== 1) throw new VideoUploadError("Video processing is busy. Try again shortly.", "UPLOAD_BUSY", 429);
      try {
        await connection.execute(sql("START TRANSACTION"));
        const [users] = await connection.execute<RowDataPacket[]>(sql("SELECT id FROM users WHERE id = ? AND disabled = 0"), [input.ownerUserId]);
        if (!users.length) throw new VideoUploadError("This account cannot process videos.", "FORBIDDEN", 403);
        const [existing] = await connection.execute<JobRow[]>(sql(
          "SELECT * FROM video_processing_jobs WHERE owner_user_id = ? AND request_id = ? FOR UPDATE"
        ), [input.ownerUserId, input.requestId]);
        const receipt = await getVideoUploadByRequest(input.ownerUserId, input.requestId, connection);
        if ((receipt && receipt.checksum !== input.checksum) || (existing[0] && existing[0].checksum !== input.checksum)) {
          throw new VideoUploadRequestConflictError();
        }
        if (existing[0]?.state === "cancelled") return { job: await publicJob(existing[0], connection) };
        if (receipt) return { video: publicVideo(receipt) };
        if (existing[0]) return { job: await publicJob(existing[0], connection) };
        // GET_LOCK serializes this count + insert across transactions, including different owners.
        const [counts] = await connection.execute<RowDataPacket[]>(sql(
          "SELECT COUNT(*) AS total, SUM(owner_user_id = ?) AS ownerTotal FROM video_processing_jobs WHERE state IN ('queued','running')"
        ), [input.ownerUserId]);
        if (Number(counts[0].total) >= 8 || Number(counts[0].ownerTotal) >= 1) {
          throw new VideoUploadError("Another video is being processed. Wait for it to finish and try again.", "UPLOAD_BUSY", 429);
        }
        // A lost socket after INSERT/COMMIT is not evidence of rollback. Preserve this input for reconciliation.
        inputMayBeReferenced = true;
        await connection.execute(sql(`INSERT INTO video_processing_jobs
          (id, owner_user_id, request_id, checksum, input_bytes, filename, state, phase, created_at, updated_at)
          VALUES (?,?,?,?,?,?,'queued','validating',?,?)`),
        [input.id, input.ownerUserId, input.requestId, input.checksum, input.bytes, input.name, utc(), utc()]);
        commitAttempted = true;
        await connection.execute(sql("COMMIT"));
        return { job: { id: input.id, state: "queued", phase: "validating" } };
      } finally {
        // Rollback also closes read-only replay transactions; never release a named lock into the pool.
        if (!commitAttempted) {
          await connection.execute(sql("ROLLBACK"));
          inputMayBeReferenced = false;
        }
        const [released] = await connection.execute<RowDataPacket[]>(sql("SELECT RELEASE_LOCK(?) AS released"), [capacityLock]);
        if (Number(released[0]?.released) !== 1) throw new Error("Video processing admission lock was not released.");
      }
    }, signal);
  } finally {
    if (!inputMayBeReferenced) await removeVideoProcessingInput(input.id).catch(() => {
      console.warn("[video-processing] Unreferenced input cleanup was incomplete.");
    });
  }
}

export function getVideoProcessingJob(ownerUserId: string, jobId: string, signal: AbortSignal): Promise<VideoProcessingJob | null> {
  if (!isVideoMediaId(jobId)) return Promise.resolve(null);
  return withVideoUploadConnection(async connection => {
    const row = await readJob(connection, ownerUserId, jobId.toLowerCase());
    return row ? publicJob(row, connection) : null;
  }, signal);
}

export async function cancelVideoProcessingJob(ownerUserId: string, jobId: string, signal: AbortSignal): Promise<VideoProcessingJob | null> {
  if (!isVideoMediaId(jobId)) return null;
  let cancelledBeforeClaim = false;
  const job = await withVideoUploadConnection(async connection => {
    await connection.execute(sql("START TRANSACTION"));
    try {
      const row = await readJob(connection, ownerUserId, jobId.toLowerCase(), true);
      if (!row) return null;
      if (row.state === "queued" || row.state === "running") {
        cancelledBeforeClaim = row.state === "queued";
        await connection.execute(sql(`UPDATE video_processing_jobs SET state='cancelled', error_code='PROCESSING_CANCELLED',
          error='Video processing was cancelled.', updated_at=? WHERE id=? AND owner_user_id=?`), [utc(), row.id, ownerUserId]);
        row.state = "cancelled";
        row.error_code = "PROCESSING_CANCELLED";
        row.error = "Video processing was cancelled.";
      }
      const projected = await publicJob(row, connection);
      await connection.execute(sql("COMMIT"));
      return projected;
    } finally { await connection.execute(sql("ROLLBACK")); }
  }, signal);
  if (job?.state === "cancelled") state.active.get(job.id)?.abort();
  // A queued cancellation held the claim row lock; there cannot be an old file reader to await.
  if (job?.state === "cancelled" && cancelledBeforeClaim) {
    try {
      await removeVideoProcessingInput(job.id);
      await withVideoUploadConnection(connection => connection.execute(sql(
        "UPDATE video_processing_jobs SET files_cleaned_at=? WHERE id=?"
      ), [utc(), job.id]), storageSignal());
    } catch { console.warn("[video-processing] Cancelled input cleanup was incomplete."); }
  }
  return job;
}

async function changePhase(job: JobRow, phase: VideoProcessingJob["phase"], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await withVideoUploadConnection(async connection => {
    const [result] = await connection.execute<ResultSetHeader>(sql(`UPDATE video_processing_jobs SET phase=?, updated_at=?
      WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>?`), [phase, utc(), job.id, job.lease_token, utc()]);
    if (result.affectedRows !== 1) throw new Error("Video processing lease was lost.");
  }, signal);
}

async function claimJob(): Promise<JobRow | null> {
  return withVideoUploadConnection(async connection => {
    await connection.execute(sql("START TRANSACTION"));
    try {
      const [rows] = await connection.execute<JobRow[]>(sql(
        "SELECT * FROM video_processing_jobs WHERE state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED"
      ));
      if (!rows.length) return null;
      const job = rows[0];
      job.lease_token = randomUUID();
      job.lease_expires_at = utc(Date.now() + LEASE_DURATION);
      await connection.execute(sql(`UPDATE video_processing_jobs SET state='running', lease_token=?, lease_expires_at=?, updated_at=?
        WHERE id=? AND state='queued'`), [job.lease_token, job.lease_expires_at, utc(), job.id]);
      job.state = "running";
      await connection.execute(sql("COMMIT"));
      return job;
    } finally { await connection.execute(sql("ROLLBACK")); }
  }, storageSignal());
}

async function verifyInput(job: JobRow, signal: AbortSignal): Promise<void> {
  const paths = spoolPaths(job.id);
  const directory = await lstat(paths.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) throw new Error("Invalid input storage.");
  const file = await open(paths.inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== Number(job.input_bytes) || (before.mode & 0o777) !== 0o600) {
      throw new Error("Invalid input file.");
    }
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk);
    const after = await file.stat();
    const named = await lstat(paths.inputPath);
    if (hash.digest("hex") !== job.checksum || before.ino !== named.ino || before.dev !== named.dev || named.isSymbolicLink()
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Input file changed.");
  } finally { await file.close(); }
}

async function recoverReceipt(connection: Connection, job: JobRow): Promise<boolean> {
  const receipt = await getVideoUploadByRequest(job.owner_user_id, job.request_id, connection);
  if (!receipt || receipt.checksum !== job.checksum) return false;
  await connection.execute(sql(`UPDATE video_processing_jobs SET state='succeeded', phase='saving', video_media_id=?,
    error_code=NULL, error=NULL, updated_at=? WHERE id=?`), [receipt.id, utc(), job.id]);
  return true;
}

async function reconcileInterrupted(): Promise<void> {
  await withVideoUploadConnection(async connection => {
    await connection.execute(sql("START TRANSACTION"));
    try {
      const [rows] = await connection.execute<JobRow[]>(sql(
        "SELECT * FROM video_processing_jobs WHERE state='running' AND lease_expires_at<=? ORDER BY created_at LIMIT 8 FOR UPDATE SKIP LOCKED"
      ), [utc()]);
      for (const job of rows) {
        state.active.get(job.id)?.abort();
        if (await recoverReceipt(connection, job)) continue;
        await connection.execute(sql(`UPDATE video_processing_jobs SET state='failed', error_code='PROCESSING_INTERRUPTED',
          error='Video processing was interrupted. Upload again with a new request ID.', updated_at=? WHERE id=?`), [utc(), job.id]);
      }
      await connection.execute(sql("COMMIT"));
    } finally { await connection.execute(sql("ROLLBACK")); }
  }, storageSignal());
}

async function processJob(job: JobRow): Promise<void> {
  const cancellation = new AbortController();
  state.active.set(job.id, cancellation);
  const leaseDeadline = Date.parse(`${job.lease_expires_at!.replace(" ", "T")}Z`);
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(Math.max(1, leaseDeadline - Date.now()))]);
  let polling: Promise<void> | null = null;
  const poll = setInterval(() => {
    if (polling) return;
    polling = withVideoUploadConnection(async connection => {
      const row = await readJob(connection, job.owner_user_id, job.id);
      if (!row || row.state !== "running" || row.lease_token !== job.lease_token) cancellation.abort();
    }, storageSignal()).catch(() => { cancellation.abort(); }).finally(() => { polling = null; });
  }, 2_000);
  poll.unref();
  try {
    const recovered = await withVideoUploadConnection(async connection => {
      await connection.execute(sql("START TRANSACTION"));
      try {
        const row = await readJob(connection, job.owner_user_id, job.id, true);
        if (!row || row.state !== "running" || row.lease_token !== job.lease_token) throw new Error("Video processing lease was lost.");
        const found = await recoverReceipt(connection, row);
        await connection.execute(sql("COMMIT"));
        return found;
      } finally { await connection.execute(sql("ROLLBACK")); }
    }, signal);
    if (recovered) return;
    await withVideoUploadConnection(async connection => {
      const [users] = await connection.execute<RowDataPacket[]>(sql("SELECT id FROM users WHERE id=? AND disabled=0"), [job.owner_user_id]);
      if (!users.length) throw new VideoUploadError("This account cannot process videos.", "ACCOUNT_DISABLED", 403);
    }, signal);
    await verifyInput(job, signal);
    const paths = spoolPaths(job.id);
    const prepared = await prepareCompatibleVideo(paths.inputPath, paths.outputPath, signal, () => changePhase(job, "converting", signal));
    signal.throwIfAborted();
    if (prepared.filePath !== paths.inputPath && prepared.filePath !== paths.outputPath) throw new Error("Invalid prepared video.");
    const output = await lstat(prepared.filePath);
    if (!output.isFile() || output.isSymbolicLink() || output.nlink !== 1 || output.size !== prepared.bytes
      || !isVideoAttachment({ id: job.id, name: job.filename, bytes: prepared.bytes, ...prepared.metadata })) throw new Error("Invalid prepared video.");
    await chmod(prepared.filePath, 0o600);
    await changePhase(job, "saving", signal);
    const uploaded = await uploadVideoFileToPostiz(prepared.filePath, signal);
    signal.throwIfAborted();
    // The row lock fences BOTH receipt insertion and success. DELETE must take this same lock.
    await withVideoUploadConnection(async connection => {
      await connection.execute(sql("START TRANSACTION"));
      try {
        const current = await readJob(connection, job.owner_user_id, job.id, true);
        if (!current || current.state !== "running" || current.lease_token !== job.lease_token
          || !current.lease_expires_at || current.lease_expires_at <= utc()) throw new Error("Video processing lease was lost.");
        const [users] = await connection.execute<RowDataPacket[]>(sql("SELECT id FROM users WHERE id=? AND disabled=0"), [job.owner_user_id]);
        if (!users.length) throw new VideoUploadError("This account cannot process videos.", "ACCOUNT_DISABLED", 403);
        signal.throwIfAborted();
        const recorded = await recordVideoUpload({ ownerUserId: job.owner_user_id, requestId: job.request_id, checksum: job.checksum,
          name: job.filename, bytes: prepared.bytes, ...prepared.metadata, postizMediaId: uploaded.id, postizPath: uploaded.path }, connection);
        const [completed] = await connection.execute<ResultSetHeader>(sql(`UPDATE video_processing_jobs SET state='succeeded', phase='saving', video_media_id=?,
          error_code=NULL, error=NULL, updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>?`),
        [recorded.video.id, utc(), job.id, job.lease_token, utc()]);
        if (completed.affectedRows !== 1) throw new Error("Video processing lease was lost.");
        signal.throwIfAborted();
        await connection.execute(sql("COMMIT"));
      } finally { await connection.execute(sql("ROLLBACK")); }
    }, signal);
  } catch (error) {
    const code = error instanceof VideoUploadError ? error.code : signal.aborted ? "PROCESSING_INTERRUPTED" : "VIDEO_PROCESSING_FAILED";
    const message = error instanceof VideoUploadError ? error.message : "The video could not be processed. Upload again with a new request ID.";
    await withVideoUploadConnection(async connection => {
      await connection.execute(sql(`UPDATE video_processing_jobs SET state='failed', error_code=?, error=?, updated_at=?
        WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>?`), [code, message, utc(), job.id, job.lease_token, utc()]);
    }, storageSignal()).catch(() => { console.warn("[video-processing] Job outcome will be reconciled after its lease expires."); });
  } finally {
    clearInterval(poll);
    if (polling) await polling;
    // prepare/upload are awaited, including abort settlement; no live reader is unlinked here.
    state.active.delete(job.id);
    await withVideoUploadConnection(async connection => {
      const row = await readJob(connection, job.owner_user_id, job.id);
      if (row && ["succeeded", "failed", "cancelled"].includes(row.state)) {
        await removeVideoProcessingInput(job.id);
        await connection.execute(sql("UPDATE video_processing_jobs SET files_cleaned_at=? WHERE id=?"), [utc(), job.id]);
      }
    }, storageSignal()).catch(() => { console.warn("[video-processing] Settled input cleanup was incomplete."); });
  }
}

async function sweepSpool(): Promise<void> {
  if (Date.now() - state.lastSweep < 60_000) return;
  state.lastSweep = Date.now();
  const paths = spoolPaths(randomUUID());
  await ensureSpoolRoot(paths.root);
  const [terminal] = await withVideoUploadConnection(connection => connection.execute<JobRow[]>(sql(
    `SELECT * FROM video_processing_jobs WHERE state IN ('succeeded','failed','cancelled') AND files_cleaned_at IS NULL
     AND updated_at<? AND (lease_expires_at IS NULL OR lease_expires_at<?) LIMIT 20`
  ), [utc(Date.now() - FILE_RETENTION), utc(Date.now() - FILE_RETENTION)]), storageSignal());
  for (const job of terminal) {
    if (state.active.has(job.id)) continue;
    await removeVideoProcessingInput(job.id);
    await withVideoUploadConnection(connection => connection.execute(sql("UPDATE video_processing_jobs SET files_cleaned_at=? WHERE id=?"), [utc(), job.id]), storageSignal());
  }
  const directory = await opendir(paths.root);
  let inspected = 0;
  let removed = 0;
  let checkedReferences = 0;
  for await (const entry of directory) {
    if (++inspected > 200 || removed >= 20 || checkedReferences >= 20) break;
    if (!entry.isDirectory() || !isVideoMediaId(entry.name) || state.active.has(entry.name)) continue;
    const details = await lstat(join(paths.root, entry.name));
    if (details.mtimeMs >= Date.now() - FILE_RETENTION) continue;
    checkedReferences++;
    const [referenced] = await withVideoUploadConnection(connection => connection.execute<RowDataPacket[]>(sql(
      "SELECT id FROM video_processing_jobs WHERE id=?"
    ), [entry.name]), storageSignal());
    if (!referenced.length) { await removeVideoProcessingInput(entry.name); removed++; }
  }
}

export function processVideoProcessingJobs(): Promise<number> {
  if (state.inFlight) return state.inFlight;
  state.inFlight = (async () => {
    await reconcileInterrupted();
    await sweepSpool().catch(() => { console.warn("[video-processing] Spool cleanup was incomplete; check local disk capacity."); });
    const job = await claimJob();
    if (!job) return 0;
    await processJob(job);
    return 1;
  })().finally(() => { state.inFlight = null; });
  return state.inFlight;
}
