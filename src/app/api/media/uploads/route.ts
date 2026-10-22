import { NextRequest, NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { isSameOrigin } from "@/lib/same-origin";
import { getPostizConfig, PostizConnectionError, uploadVideoFileToPostiz } from "@/lib/postiz";
import { isVideoMediaId, type VideoAttachment } from "@/lib/video-types";
import { getVideoUploadByRequest, recordVideoUpload, VideoUploadRequestConflictError, withVideoUploadConnection } from "@/lib/video-uploads";
import {
  acquireVideoUploadSlot, createVideoUploadTempFile, readVideoContentLength, readVideoFilename,
  removeVideoUploadTempFile, streamVideoUpload, validateVideoFile, VideoUploadError
} from "@/lib/video-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const json = (data: unknown, status: number) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: string, code: string, status: number) => json({ error, code }, status);

function success(video: VideoAttachment, status: number) {
  // Explicit projection: never expose an owner, checksum, upstream URL or Postiz media ID.
  return json({ video: {
    id: video.id, name: video.name, bytes: video.bytes, width: video.width, height: video.height,
    durationSeconds: video.durationSeconds
  } }, status);
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return failure("Same-origin request required.", "FORBIDDEN", 403);

  let releaseSlot: (() => void) | undefined;
  let temporaryDirectory: string | undefined;
  try {
    const auth = await currentUser();
    if (!auth) return unauthorized();
    if (!databaseConfigured()) return failure("Video storage is unavailable. Ask an administrator to configure storage.", "STORAGE_UNAVAILABLE", 503);
    if (!getPostizConfig()) return failure("Video uploads are unavailable. Ask an administrator to configure Postiz.", "POSTIZ_UNAVAILABLE", 503);
    if (request.headers.get("content-type")?.trim().toLowerCase() !== "video/mp4") {
      return failure("Upload the original MP4 file bytes, not a multipart form.", "INVALID_CONTENT_TYPE", 415);
    }
    const requestIdHeader = request.headers.get("x-upload-request-id");
    if (!isVideoMediaId(requestIdHeader)) return failure("A valid upload request ID is required.", "INVALID_REQUEST_ID", 400);
    const requestId = requestIdHeader.toLowerCase();
    const name = readVideoFilename(request.headers.get("x-file-name"));
    const expectedBytes = readVideoContentLength(request.headers.get("content-length"));
    releaseSlot = acquireVideoUploadSlot(auth.user.id);

    // Preflight also fails closed on a missing migration, before receiving or uploading a large file.
    const existing = await withVideoUploadConnection(
      connection => getVideoUploadByRequest(auth.user.id, requestId, connection), request.signal
    );
    const temporary = await createVideoUploadTempFile();
    temporaryDirectory = temporary.directory;
    const incomingSignal = AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]);
    const received = await streamVideoUpload(request, temporary.filePath, expectedBytes, incomingSignal);
    if (existing) {
      if (existing.checksum !== received.checksum) throw new VideoUploadRequestConflictError();
      return success(existing, 200);
    }

    const metadata = await validateVideoFile(temporary.filePath, request.signal);
    // Do not Promise.race this call: its abort must settle before finally removes the file and slot.
    const uploaded = await uploadVideoFileToPostiz(temporary.filePath, request.signal);
    request.signal.throwIfAborted();
    const recorded = await withVideoUploadConnection(connection => recordVideoUpload({
      ownerUserId: auth.user.id, requestId, checksum: received.checksum, name, bytes: received.bytes,
      ...metadata, postizMediaId: uploaded.id, postizPath: uploaded.path
    }, connection), request.signal);
    return success(recorded.video, recorded.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof VideoUploadError) return failure(error.message, error.code, error.status);
    if (error instanceof VideoUploadRequestConflictError) return failure(error.message, "REQUEST_ID_CONFLICT", 409);
    if (request.signal.aborted) return failure("Video upload was cancelled.", "UPLOAD_CANCELLED", 499);
    if (error instanceof PostizConnectionError) return failure(error.message, "POSTIZ_UPLOAD_FAILED", error.status);
    console.error("[video-upload] video storage was unavailable; verify the migration and SELECT/INSERT permissions");
    return failure("Video storage is unavailable. Ask an administrator to check the video migration, then try again.", "STORAGE_UNAVAILABLE", 503);
  } finally {
    try {
      if (temporaryDirectory) await removeVideoUploadTempFile(temporaryDirectory);
    } finally {
      releaseSlot?.();
    }
  }
}
