export const MAX_POST_IMAGES = 10;

export interface ImageAttachment {
  id: string;
  name: string;
  bytes: number;
  width: number;
  height: number;
}

export function isImageMediaId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

export function areImageMediaIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_POST_IMAGES && value.every(isImageMediaId)
    && new Set(value.map(id => id.toLowerCase())).size === value.length;
}

export function getImagePreviewUrl(id: string, size: "full" | "thumb" = "full"): string {
  return `/api/media/images/${encodeURIComponent(id)}${size === "thumb" ? "?size=thumb" : ""}`;
}

export function imageSelectionError(platform: string, count: number, hasVideo: boolean): string {
  if (count && hasVideo) return "Attach either images or one MP4 video, not both.";
  if (count > MAX_POST_IMAGES) return "Attach up to 10 images.";
  if (["x", "twitter"].includes(platform.toLowerCase()) && count > 4) return "X supports up to 4 images.";
  if (platform.toLowerCase() === "youtube" && count) return "YouTube requires an MP4 video.";
  return "";
}
