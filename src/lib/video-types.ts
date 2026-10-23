export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface VideoAttachment {
  id: string;
  name: string;
  bytes: number;
  width: number;
  height: number;
  durationSeconds: number;
}

export interface VideoProcessingJob {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  phase: "validating" | "converting" | "saving";
  video?: VideoAttachment;
  error?: string;
  code?: string;
}

export function isVideoMediaId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function getVideoPreviewUrl(id: string): string {
  return `/api/media/uploads/${id}`;
}

export function isVideoAttachment(value: unknown): value is VideoAttachment {
  if (typeof value !== "object" || value === null) return false;
  const video = value as Record<string, unknown>;
  return isVideoMediaId(video.id)
    && typeof video.name === "string" && video.name.length > 0 && video.name.length <= 255
    && typeof video.bytes === "number" && Number.isInteger(video.bytes) && video.bytes > 0 && video.bytes <= MAX_VIDEO_UPLOAD_BYTES
    && typeof video.width === "number" && Number.isInteger(video.width) && video.width > 0
    && typeof video.height === "number" && Number.isInteger(video.height) && video.height > 0
    && typeof video.durationSeconds === "number" && Number.isFinite(video.durationSeconds) && video.durationSeconds > 0;
}

export function isVideoUploadResponse(value: unknown): value is { video: VideoAttachment } {
  return typeof value === "object" && value !== null && "video" in value && isVideoAttachment(value.video);
}

export function isVideoProcessingResponse(value: unknown): value is { job: VideoProcessingJob } {
  if (typeof value !== "object" || value === null || !("job" in value)
    || typeof value.job !== "object" || value.job === null) return false;
  const job = value.job as Record<string, unknown>;
  if (!isVideoMediaId(job.id) || typeof job.state !== "string" || !["queued", "running", "succeeded", "failed", "cancelled"].includes(job.state)
    || typeof job.phase !== "string" || !["validating", "converting", "saving"].includes(job.phase)) return false;
  if (job.error !== undefined && (typeof job.error !== "string" || job.error.length > 512)) return false;
  if (job.code !== undefined && (typeof job.code !== "string" || !/^[A-Z0-9_]{1,64}$/.test(job.code))) return false;
  return job.state === "succeeded" ? isVideoAttachment(job.video) : job.video === undefined;
}
