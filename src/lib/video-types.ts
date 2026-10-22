export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface VideoAttachment {
  id: string;
  name: string;
  bytes: number;
  width: number;
  height: number;
  durationSeconds: number;
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
