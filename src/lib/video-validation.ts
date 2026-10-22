import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, opendir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_VIDEO_UPLOAD_BYTES } from "./video-types";

export class VideoUploadError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = "VideoUploadError";
  }
}

const globalVideoUploads = globalThis as typeof globalThis & {
  polarisVideoUploadOwners?: Set<string>;
  polarisVideoTempSweep?: Promise<void>;
};

export function acquireVideoUploadSlot(ownerUserId: string): () => void {
  const owners = globalVideoUploads.polarisVideoUploadOwners ??= new Set<string>();
  // ponytail: two uploads per process, one per owner; coordinate externally before adding replicas.
  if (owners.has(ownerUserId) || owners.size >= 2) {
    throw new VideoUploadError("Another video is being processed. Wait for it to finish and try again.", "UPLOAD_BUSY", 429);
  }
  owners.add(ownerUserId);
  return () => { owners.delete(ownerUserId); };
}

/** A bounded, one-time best-effort sweep; never follows links or touches unrelated temporary files. */
async function sweepOldVideoDirectories(): Promise<void> {
  const directory = await opendir(tmpdir());
  let inspected = 0;
  let removed = 0;
  for await (const entry of directory) {
    if (++inspected > 200 || removed >= 20) break;
    if (!entry.isDirectory() || !/^polaris-video-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
    const candidate = join(tmpdir(), entry.name);
    const details = await stat(candidate).catch(() => null);
    if (details && details.mtimeMs < Date.now() - 24 * 60 * 60 * 1000) {
      await rm(candidate, { recursive: true, force: true });
      removed++;
    }
  }
}

export async function createVideoUploadTempFile(): Promise<{ directory: string; filePath: string }> {
  globalVideoUploads.polarisVideoTempSweep ??= sweepOldVideoDirectories().catch(() => {
    console.warn("[video-upload] stale temporary file cleanup was unavailable");
  });
  await globalVideoUploads.polarisVideoTempSweep;
  const directory = await mkdtemp(join(tmpdir(), "polaris-video-"));
  return { directory, filePath: join(directory, "video.mp4") };
}

export async function removeVideoUploadTempFile(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    console.error("[video-upload] temporary file cleanup failed; check temporary disk capacity");
  }
}

export function readVideoFilename(encodedName: string | null): string {
  let filename: string;
  try {
    if (!encodedName || encodedName.length > 4096) throw new Error();
    filename = decodeURIComponent(encodedName);
  } catch {
    throw new VideoUploadError("Choose an MP4 file with a valid filename.", "INVALID_FILENAME", 400);
  }
  if (filename.length > 255 || !/\.mp4$/i.test(filename) || /[\u0000-\u001f\u007f/\\]/.test(filename)) {
    throw new VideoUploadError("Choose an MP4 file with a valid filename (at most 255 characters).", "INVALID_FILENAME", 400);
  }
  return filename;
}

export function readVideoContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new VideoUploadError("Invalid video upload length.", "INVALID_UPLOAD", 400);
  }
  const length = Number(value);
  if (length > MAX_VIDEO_UPLOAD_BYTES) {
    throw new VideoUploadError("The video is too large. Choose an MP4 up to 100 MB.", "VIDEO_TOO_LARGE", 413);
  }
  return length;
}

function throwIfUploadAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  throw new VideoUploadError(timedOut ? "Video upload timed out. Try again on a faster connection." : "Video upload was cancelled.",
    timedOut ? "UPLOAD_TIMEOUT" : "UPLOAD_CANCELLED", timedOut ? 408 : 499);
}

/** Writes only the current stream chunk; Content-Length is an early check, never the byte limit. */
export async function streamVideoUpload(
  request: Request,
  filePath: string,
  expectedBytes: number | null,
  signal: AbortSignal
): Promise<{ bytes: number; checksum: string }> {
  throwIfUploadAborted(signal);
  if (!request.body) throw new VideoUploadError("Choose a non-empty MP4 file.", "EMPTY_VIDEO", 400);
  const reader = request.body.getReader();
  const checksum = createHash("sha256");
  let bytes = 0;
  let completed = false;
  const cancelRead = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancelRead, { once: true });
  try {
    const file = await open(filePath, "wx", 0o600);
    try {
      while (true) {
        throwIfUploadAborted(signal);
        const { done, value } = await reader.read();
        throwIfUploadAborted(signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_VIDEO_UPLOAD_BYTES) {
          throw new VideoUploadError("The video is too large. Choose an MP4 up to 100 MB.", "VIDEO_TOO_LARGE", 413);
        }
        checksum.update(value);
        await file.writeFile(value);
      }
      if (bytes === 0) throw new VideoUploadError("Choose a non-empty MP4 file.", "EMPTY_VIDEO", 400);
      if (expectedBytes !== null && expectedBytes !== bytes) {
        throw new VideoUploadError("The video upload was incomplete. Upload the file again.", "INCOMPLETE_UPLOAD", 400);
      }
      completed = true;
      return { bytes, checksum: checksum.digest("hex") };
    } finally {
      await file.close();
    }
  } catch (error) {
    throwIfUploadAborted(signal);
    if (error instanceof VideoUploadError) throw error;
    // Neither a body transport error nor a filesystem error may disclose a private path.
    throw new VideoUploadError("The video could not be received. Check your connection and try again.", "UPLOAD_READ_FAILED", 400);
  } finally {
    signal.removeEventListener("abort", cancelRead);
    if (!completed) cancelRead();
    reader.releaseLock();
  }
}

export interface ValidatedVideoMetadata {
  width: number;
  height: number;
  durationSeconds: number;
}

interface ProbeResult {
  format?: { format_name?: string; duration?: string; tags?: { major_brand?: string } };
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }>;
}

export async function validateVideoFile(filePath: string, signal?: AbortSignal): Promise<ValidatedVideoMetadata> {
  const probeSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
  let completeProbe!: (result: { error: ExecFileException | null; stdout: string }) => void;
  const probeResult = new Promise<{ error: ExecFileException | null; stdout: string }>(resolve => { completeProbe = resolve; });
  const child = execFile(process.env.FFPROBE_PATH?.trim() || "ffprobe", [
    "-v", "error", "-max_alloc", "67108864", "-threads", "1",
    "-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0",
    "-probesize", "8388608", "-analyzeduration", "5000000",
    "-show_entries", "format=format_name,duration:format_tags=major_brand:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic",
    "-of", "json", "-i", filePath
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL", signal: probeSignal, windowsHide: true },
  (error, stdout) => { completeProbe({ error, stdout }); });
  // Abort can invoke execFile's callback before the child exits. Keep its slot/file until close.
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); });
  const result = await probeResult;
  // Node 20's signal abort can send SIGTERM and clear execFile's timeout before close.
  if (probeSignal.aborted) child.kill("SIGKILL");
  await closed;
  if (signal?.aborted) throwIfUploadAborted(signal);
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new VideoUploadError("Video validation is unavailable. Ask an administrator to install ffprobe or set FFPROBE_PATH, then retry.", "FFPROBE_UNAVAILABLE", 503);
    }
    throw new VideoUploadError("This MP4 could not be validated. Convert it to an H.264 MP4 with optional AAC audio and try again.", "INVALID_VIDEO", 400);
  }

  let probe: ProbeResult;
  try {
    probe = JSON.parse(result.stdout) as ProbeResult;
    if (!probe || typeof probe !== "object") throw new Error();
  } catch {
    throw new VideoUploadError("This MP4 could not be validated. Convert it to H.264 MP4 and try again.", "INVALID_VIDEO", 400);
  }
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videos = streams.filter(stream => stream.codec_type === "video");
  const video = videos[0];
  const durationSeconds = Number(probe.format?.duration);
  const supportedBrand = /^(isom|iso[2-9]|mp4[12]|avc1|dash)$/.test(probe.format?.tags?.major_brand?.trim() || "");
  if (!probe.format?.format_name?.split(",").includes("mp4") || !supportedBrand
    || videos.length !== 1 || !video || video.codec_name !== "h264" || video.disposition?.attached_pic
    || !Number.isInteger(video.width) || !Number.isInteger(video.height) || !video.width || !video.height || video.width < 0 || video.height < 0
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0
    || streams.some(stream => stream.codec_type !== "video" && (stream.codec_type !== "audio" || stream.codec_name !== "aac"))) {
    throw new VideoUploadError("Use an MP4 containing one H.264 video and optional AAC audio. Convert this file and try again.", "UNSUPPORTED_VIDEO", 400);
  }
  return { width: video.width, height: video.height, durationSeconds };
}
