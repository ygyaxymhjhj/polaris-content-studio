import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { database } from "@/lib/project-db";
import { isVideoAttachment, isVideoMediaId, type VideoAttachment } from "./video-types";

export interface StoredVideoUpload extends VideoAttachment {
  postizMediaId: string;
  postizPath: string;
  ownerUserId: string;
}

export interface VideoUploadReceipt extends StoredVideoUpload {
  requestId: string;
  checksum: string;
}

type VideoUploadConnection = Pick<PoolConnection, "execute">;

const VIDEO_UPLOAD_SQL_TIMEOUT_MS = 5_000;

/** Only short upload receipt SQL belongs here, never file processing or an upstream request. */
export function withVideoUploadConnection<Result>(
  callback: (connection: VideoUploadConnection) => Promise<Result>,
  signal: AbortSignal
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    let connection: PoolConnection | undefined;
    let finished = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
    };
    const stop = () => {
      if (finished) return;
      finished = true;
      cleanup();
      // Do not return a socket with in-flight SQL to the shared pool.
      connection?.destroy();
      reject(new Error("Video upload storage operation was interrupted."));
    };
    const cancel = () => { stop(); };
    const timeout = setTimeout(stop, VIDEO_UPLOAD_SQL_TIMEOUT_MS);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { stop(); return; }

    Promise.resolve().then(() => database().getConnection()).then(async acquired => {
      if (finished) { acquired.release(); return; }
      connection = acquired;
      try {
        const result = await callback(acquired);
        if (finished) return;
        finished = true;
        cleanup();
        acquired.release();
        resolve(result);
      } catch (error) {
        if (finished) return;
        finished = true;
        cleanup();
        acquired.destroy();
        reject(error);
      }
    }).catch(error => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    });
  });
}

const videoColumns = `id, owner_user_id AS ownerUserId, request_id AS requestId, checksum,
  postiz_media_id AS postizMediaId, postiz_path AS postizPath, filename AS name,
  byte_size AS bytes, width, height, duration_seconds AS durationSeconds`;

function readVideoUpload(row: RowDataPacket): VideoUploadReceipt {
  const video = {
    id: String(row.id), ownerUserId: String(row.ownerUserId), requestId: String(row.requestId),
    checksum: String(row.checksum), postizMediaId: String(row.postizMediaId), postizPath: String(row.postizPath),
    name: String(row.name), bytes: Number(row.bytes), width: Number(row.width), height: Number(row.height),
    durationSeconds: Number(row.durationSeconds)
  };
  if (!isVideoAttachment(video) || !video.postizMediaId || !video.postizPath) {
    throw new Error("Invalid stored video upload.");
  }
  return video;
}

export async function getVideoUpload(
  ownerUserId: string,
  mediaId: string,
  connection?: VideoUploadConnection
): Promise<StoredVideoUpload | null> {
  if (!ownerUserId || !isVideoMediaId(mediaId)) return null;
  const [rows] = await (connection ?? database()).execute<RowDataPacket[]>(
    `SELECT ${videoColumns} FROM video_uploads WHERE owner_user_id = ? AND id = ?`, [ownerUserId, mediaId]
  );
  return rows.length ? readVideoUpload(rows[0]) : null;
}

export async function ownsVideoUploads(
  ownerUserId: string,
  mediaIds: readonly string[],
  connection?: VideoUploadConnection
): Promise<boolean> {
  if (mediaIds.length === 0) return true;
  if (!ownerUserId || !mediaIds.every(isVideoMediaId)) return false;
  const uniqueIds = [...new Set(mediaIds)];
  const [rows] = await (connection ?? database()).execute<RowDataPacket[]>(
    `SELECT id FROM video_uploads WHERE owner_user_id = ? AND id IN (${uniqueIds.map(() => "?").join(",")})`,
    [ownerUserId, ...uniqueIds]
  );
  return rows.length === uniqueIds.length;
}

export async function getVideoUploadByRequest(
  ownerUserId: string,
  requestId: string,
  connection: VideoUploadConnection = database()
): Promise<VideoUploadReceipt | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    { sql: `SELECT ${videoColumns} FROM video_uploads WHERE owner_user_id = ? AND request_id = ?`, timeout: VIDEO_UPLOAD_SQL_TIMEOUT_MS },
    [ownerUserId, requestId]
  );
  return rows.length ? readVideoUpload(rows[0]) : null;
}

export class VideoUploadRequestConflictError extends Error {
  constructor() {
    super("This upload request ID was already used for a different file. Upload again with a new request ID.");
    this.name = "VideoUploadRequestConflictError";
  }
}

/** Ready receipts are append-only; a concurrent successful replay must never replace their media. */
export async function recordVideoUpload(
  input: Omit<VideoUploadReceipt, "id">,
  connection: VideoUploadConnection = database()
): Promise<{ video: StoredVideoUpload; replayed: boolean }> {
  const video = { ...input, id: randomUUID() };
  try {
    await connection.execute(
      { sql: `INSERT INTO video_uploads
        (id, owner_user_id, request_id, checksum, postiz_media_id, postiz_path, filename, byte_size, width, height, duration_seconds)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`, timeout: VIDEO_UPLOAD_SQL_TIMEOUT_MS },
      [video.id, video.ownerUserId, video.requestId, video.checksum, video.postizMediaId, video.postizPath,
        video.name, video.bytes, video.width, video.height, video.durationSeconds]
    );
    return { video, replayed: false };
  } catch (error) {
    if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
    const existing = await getVideoUploadByRequest(input.ownerUserId, input.requestId, connection);
    if (!existing) throw error;
    if (existing.checksum !== input.checksum) throw new VideoUploadRequestConflictError();
    return { video: existing, replayed: true };
  }
}
