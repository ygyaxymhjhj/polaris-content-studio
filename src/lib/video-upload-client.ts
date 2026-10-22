import { isVideoUploadResponse, MAX_VIDEO_UPLOAD_BYTES, type VideoAttachment } from "./video-types";
import { createClientId } from "./client-id";

export function validateVideoUpload(file: File): void {
  if (!/\.mp4$/i.test(file.name) || (file.type !== "video/mp4" && file.type !== "")) {
    throw new Error("Use a JPG, PNG, WebP image or an MP4 video.");
  }
  if (!file.size) throw new Error("Choose a non-empty MP4 video.");
  if (file.size > MAX_VIDEO_UPLOAD_BYTES) throw new Error("This video exceeds 100 MB. Choose an MP4 up to 100 MB.");
}

const uploadErrors: Record<string, string> = {
  VIDEO_TOO_LARGE: "This video exceeds 100 MB. Choose an MP4 up to 100 MB.",
  EMPTY_VIDEO: "Choose a non-empty MP4 video.",
  INVALID_VIDEO: "Convert this file to an H.264 MP4 with optional AAC audio, then try again.",
  UNSUPPORTED_VIDEO: "Convert this file to an H.264 MP4 with optional AAC audio, then try again.",
  FFPROBE_UNAVAILABLE: "Video validation is unavailable. Ask an administrator to check the server.",
  UPLOAD_TIMEOUT: "Video upload timed out. Please try again.",
  UPLOAD_READ_FAILED: "Could not upload this video. Please try again.",
  INCOMPLETE_UPLOAD: "Could not upload this video. Please try again.",
  STORAGE_UNAVAILABLE: "Video storage is unavailable. Ask an administrator to check storage.",
  POSTIZ_UNAVAILABLE: "Video uploads are unavailable. Ask an administrator to check the publishing service.",
  POSTIZ_UPLOAD_FAILED: "Could not save the video to the publishing service. Please try again.",
  UPLOAD_BUSY: "Too many video uploads. Wait and try again."
};

export function uploadVideo(file: File, signal: AbortSignal, onProgress: (percent: number) => void): Promise<VideoAttachment> {
  validateVideoUpload(file);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (error?: Error, video?: VideoAttachment) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (video) resolve(video);
    };
    request.open("POST", "/api/media/uploads");
    request.timeout = 600_000;
    request.setRequestHeader("Content-Type", "video/mp4");
    request.setRequestHeader("X-Upload-Request-Id", createClientId());
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
    };
    request.upload.onload = () => onProgress(100);
    request.onload = () => {
      let data: unknown;
      try { data = JSON.parse(request.responseText); } catch { /* A gateway may return HTML. */ }
      if ((request.status === 200 || request.status === 201) && isVideoUploadResponse(data)) {
        finish(undefined, data.video);
      } else {
        const failure = data as { code?: string; error?: string } | undefined;
        finish(new Error(uploadErrors[failure?.code || ""] || failure?.error || "Could not upload this video. Please try again."));
      }
    };
    request.onerror = () => finish(new Error("Could not upload this video. Please try again."));
    request.ontimeout = () => finish(new Error("Video upload timed out. Please try again."));
    request.onabort = () => finish(new DOMException("Video upload was cancelled.", "AbortError"));
    if (signal.aborted) { finish(new DOMException("Video upload was cancelled.", "AbortError")); return; }
    signal.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
}
