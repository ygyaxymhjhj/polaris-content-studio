import { isVideoProcessingResponse, isVideoUploadResponse, MAX_VIDEO_UPLOAD_BYTES, type VideoAttachment, type VideoProcessingJob } from "./video-types";
import { createClientId } from "./client-id";

export type VideoProcessingPhase = "queued" | "validating" | "converting" | "saving";

const pollIntervalMilliseconds = 2000;
const jobRequestTimeoutMilliseconds = 15_000;
const processingDeadlineMilliseconds = 20 * 60_000;
const maximumTransientRetries = 3;
const unknownProcessingStatus = "Could not confirm video processing status. The job may still be running. Do not upload the file again.";
const processingDeadlineMessage = "Video processing is taking longer than expected. The job may still be running. Do not upload the file again.";

export class VideoProcessingStatusError extends Error {
  constructor(message: string, public readonly job: VideoProcessingJob) {
    super(message);
    this.name = "VideoProcessingStatusError";
  }
}

class VideoJobReadError extends Error {
  constructor(public readonly retryable: boolean) {
    super(unknownProcessingStatus);
  }
}

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
  FFMPEG_UNAVAILABLE: "Video conversion is unavailable. Ask an administrator to check the server.",
  VIDEO_CONVERSION_FAILED: "Could not convert this video to H.264. Please try another MP4.",
  VIDEO_CONVERSION_TIMEOUT: "Video conversion timed out. Please try another MP4.",
  VIDEO_PROCESSING_FAILED: "Could not process this video. Please try another MP4.",
  VIDEO_RESOURCE_LIMIT: "This video exceeds the processing limits. Choose a smaller or shorter MP4.",
  UPLOAD_TIMEOUT: "Video upload timed out. Please try again.",
  UPLOAD_READ_FAILED: "Could not upload this video. Please try again.",
  INCOMPLETE_UPLOAD: "Could not upload this video. Please try again.",
  STORAGE_UNAVAILABLE: "Video storage is unavailable. Ask an administrator to check storage.",
  POSTIZ_UNAVAILABLE: "Video uploads are unavailable. Ask an administrator to check the publishing service.",
  POSTIZ_UPLOAD_FAILED: "Could not save the video to the publishing service. Please try again.",
  UPLOAD_BUSY: "Too many video uploads. Wait and try again."
};

function createAbortError(): DOMException {
  return new DOMException("Video upload was cancelled.", "AbortError");
}

function getSafeUploadError(value: unknown, fallback = "Could not upload this video. Please try again."): Error {
  const code = typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" ? value.code : "";
  return new Error(Object.hasOwn(uploadErrors, code) ? uploadErrors[code] : fallback);
}

function waitForNextPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(createAbortError()); return; }
    const abort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readVideoJob(jobId: string, signal: AbortSignal, timeoutMilliseconds: number): Promise<VideoProcessingJob> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, timeoutMilliseconds);
  try {
    let response: Response;
    try {
      response = await fetch(`/api/media/video-jobs/${jobId}`, {
        method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal
      });
    } catch {
      throw new VideoJobReadError(true);
    }
    if (!response.ok) throw new VideoJobReadError(response.status === 408 || response.status === 429 || response.status >= 500);
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new VideoJobReadError(controller.signal.aborted); }
    if (!isVideoProcessingResponse(data) || data.job.id !== jobId) throw new VideoJobReadError(false);
    return data.job;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}

async function cancelVideoJob(jobId: string): Promise<void> {
  // Cancellation must survive the upload signal that initiated it, including Safari.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), jobRequestTimeoutMilliseconds);
  try {
    await fetch(`/api/media/video-jobs/${jobId}`, {
      method: "DELETE", credentials: "same-origin", cache: "no-store", signal: controller.signal
    });
  } catch {
    // Best effort: an abandoned session must not retain timers or cancel a replacement job.
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export function uploadVideo(
  file: File,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
  onProcessing?: (phase: VideoProcessingPhase) => void
): Promise<VideoAttachment> {
  validateVideoUpload(file);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const session = new AbortController();
    const deadline = Date.now() + processingDeadlineMilliseconds;
    let settled = false;
    let knownJob: VideoProcessingJob | undefined;
    const abort = () => {
      if (settled) return;
      if (knownJob) void cancelVideoJob(knownJob.id);
      request.abort();
      finish(createAbortError());
    };
    const finish = (error?: Error, video?: VideoAttachment) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      session.abort();
      if (error) reject(error);
      else if (video) resolve(video);
    };

    request.open("POST", "/api/media/uploads");
    request.timeout = 600_000;
    request.setRequestHeader("Content-Type", "video/mp4");
    request.setRequestHeader("X-Upload-Request-Id", createClientId());
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.upload.onprogress = event => {
      if (!settled && event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
    };
    request.upload.onload = () => { if (!settled) onProgress(100); };
    request.onload = () => {
      if (settled) return;
      let data: unknown;
      try { data = JSON.parse(request.responseText); } catch { /* A gateway may return HTML. */ }
      if ((request.status === 200 || request.status === 201) && isVideoUploadResponse(data)) {
        finish(undefined, data.video);
      } else if (request.status === 202 && isVideoProcessingResponse(data)) {
        knownJob = data.job;
        void pollVideoProcessing(data.job, session.signal, onProcessing, deadline).then(video => finish(undefined, video), error => finish(error));
      } else {
        finish(getSafeUploadError(data));
      }
    };
    request.onerror = () => finish(new Error("Could not upload this video. Please try again."));
    request.ontimeout = () => finish(new Error("Video upload timed out. Please try again."));
    request.onabort = () => finish(createAbortError());
    if (signal.aborted) { finish(createAbortError()); return; }
    signal.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
}

async function pollVideoProcessing(
  initialJob: VideoProcessingJob,
  signal: AbortSignal,
  onProcessing: ((phase: VideoProcessingPhase) => void) | undefined,
  deadline: number
): Promise<VideoAttachment> {
  let job = initialJob;
  let consecutiveFailures = 0;
  while (true) {
    if (signal.aborted) throw createAbortError();
    if (job.state === "succeeded" && job.video) return job.video;
    if (job.state === "failed") throw getSafeUploadError(job, "Could not process this video. Please try another MP4.");
    if (job.state === "cancelled") throw createAbortError();
    if (job.state !== "queued" && job.state !== "running") throw new VideoProcessingStatusError(unknownProcessingStatus, job);
    onProcessing?.(job.state === "queued" ? "queued" : job.phase);
    const remainingMilliseconds = deadline - Date.now();
    if (remainingMilliseconds <= 0) throw new VideoProcessingStatusError(processingDeadlineMessage, job);
    await waitForNextPoll(signal, Math.min(pollIntervalMilliseconds, remainingMilliseconds));
    if (Date.now() >= deadline) throw new VideoProcessingStatusError(processingDeadlineMessage, job);
    try {
      const nextJob = await readVideoJob(job.id, signal, Math.min(jobRequestTimeoutMilliseconds, deadline - Date.now()));
      if (signal.aborted) throw createAbortError();
      if (Date.now() >= deadline) throw new VideoProcessingStatusError(processingDeadlineMessage, job);
      job = nextJob;
      consecutiveFailures = 0;
    } catch (error) {
      if (signal.aborted) throw createAbortError();
      if (Date.now() >= deadline) throw new VideoProcessingStatusError(processingDeadlineMessage, job);
      consecutiveFailures += 1;
      if (!(error instanceof VideoJobReadError) || !error.retryable || consecutiveFailures > maximumTransientRetries) {
        throw new VideoProcessingStatusError(unknownProcessingStatus, job);
      }
    }
  }
}

export function resumeVideoProcessing(
  job: VideoProcessingJob,
  signal: AbortSignal,
  onProcessing?: (phase: VideoProcessingPhase) => void
): Promise<VideoAttachment> {
  if (!isVideoProcessingResponse({ job })) return Promise.reject(new Error(unknownProcessingStatus));
  return new Promise((resolve, reject) => {
    const session = new AbortController();
    let settled = false;
    const finish = (error?: Error, video?: VideoAttachment) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      session.abort();
      if (error) reject(error);
      else if (video) resolve(video);
    };
    const abort = () => {
      if (settled) return;
      void cancelVideoJob(job.id);
      finish(createAbortError());
    };
    if (signal.aborted) { finish(createAbortError()); return; }
    signal.addEventListener("abort", abort, { once: true });
    void pollVideoProcessing(job, session.signal, onProcessing, Date.now() + processingDeadlineMilliseconds)
      .then(video => finish(undefined, video), error => finish(error));
  });
}
