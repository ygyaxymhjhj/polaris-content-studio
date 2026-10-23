import { execFile, type ChildProcess, type ExecFileException } from "node:child_process";
import { chmod, lstat, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { MAX_VIDEO_UPLOAD_BYTES } from "./video-types";
import { inspectVideoFile, VideoUploadError, type InspectedVideoFile, type ValidatedVideoMetadata } from "./video-validation";

const CONVERSION_TIMEOUT_MS = 300_000;
// These are this service's resource budgets, not official platform upload limits.
const MAX_SOURCE_DIMENSION = 8192;
const MAX_SOURCE_PIXELS = 33_554_432;
const MAX_SOURCE_FRAME_RATE = 240;
const MAX_SOURCE_DURATION_SECONDS = 3600;

interface CompatibilityPlan {
  encodeVideo: boolean;
  encodeAudio: boolean;
  dropIncompatibleAudioTracks: boolean;
  width: number;
  height: number;
  frameRate: number | null;
  normalizeFrameRate: boolean;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  throw new VideoUploadError(timedOut ? "Video processing timed out. Try again." : "Video upload was cancelled.",
    timedOut ? "UPLOAD_TIMEOUT" : "UPLOAD_CANCELLED", timedOut ? 408 : 499);
}

function conversionFailed(): VideoUploadError {
  return new VideoUploadError("This MP4 could not be converted safely. Try exporting it as an H.264 MP4 with AAC audio.", "VIDEO_CONVERSION_FAILED", 400);
}

function tooLarge(): VideoUploadError {
  return new VideoUploadError("The compatible video exceeds 100 MiB. Choose a smaller or shorter MP4.", "VIDEO_TOO_LARGE", 413);
}

function readRatio(value: string | undefined, separator: ":" | "/"): number | null {
  if (!value) return null;
  const parts = value.split(separator);
  if (parts.length !== 2 || parts.some(part => !/^\d+$/.test(part))) return null;
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

function planCompatibility(inspected: InspectedVideoFile): CompatibilityPlan {
  const { video, width, height, durationSeconds } = inspected;
  const averageRate = readRatio(video.avg_frame_rate, "/");
  const nominalRate = readRatio(video.r_frame_rate, "/");
  const frameRate = averageRate ?? nominalRate;
  // VFR timestamp bases can inflate r_frame_rate; use it only to request normalization, never to reject a source.
  const normalizeFrameRate = averageRate === null || averageRate > 30 || (nominalRate !== null && nominalRate > 30);
  if (Math.max(width, height) > MAX_SOURCE_DIMENSION || width * height > MAX_SOURCE_PIXELS
    || durationSeconds > MAX_SOURCE_DURATION_SECONDS || (averageRate !== null && averageRate > MAX_SOURCE_FRAME_RATE)
    || inspected.streams.some(stream => Number(stream.duration) > MAX_SOURCE_DURATION_SECONDS)) {
    throw new VideoUploadError("This MP4 exceeds this service's processing budget: at most 8192 pixels per side, 33.6 million pixels, 240 fps and one hour.",
      "VIDEO_RESOURCE_LIMIT", 400);
  }

  const rawRotation = video.side_data_list?.find(sideData => typeof sideData.rotation === "number")?.rotation
    ?? Number(video.tags?.rotate || 0);
  const rotation = ((rawRotation % 360) + 360) % 360;
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) {
    throw new VideoUploadError("This MP4 has an unsupported display rotation. Export it with a standard orientation and try again.", "UNSUPPORTED_VIDEO", 400);
  }
  const aspectRatio = readRatio(video.sample_aspect_ratio, ":") ?? 1;
  const unrotatedWidth = width * aspectRatio;
  const displayWidth = rotation === 90 || rotation === 270 ? height : unrotatedWidth;
  const displayHeight = rotation === 90 || rotation === 270 ? unrotatedWidth : height;
  const scale = Math.min(1, 1920 / Math.max(displayWidth, displayHeight), 1080 / Math.min(displayWidth, displayHeight));
  const outputWidth = Math.max(2, Math.floor(displayWidth * scale / 2) * 2);
  const outputHeight = Math.max(2, Math.floor(displayHeight * scale / 2) * 2);
  const encodeVideo = video.codec_name !== "h264" || video.pix_fmt !== "yuv420p"
    || Number(video.bits_per_raw_sample || 8) > 8
    || width % 2 !== 0 || height % 2 !== 0 || Math.max(width, height) > 1920 || Math.min(width, height) > 1080
    || normalizeFrameRate || rotation !== 0 || aspectRatio !== 1;
  if (inspected.audio && (!Number.isInteger(inspected.audio.index) || inspected.audio.index < 0 || !inspected.audio.codec_name)) {
    throw new VideoUploadError("This MP4 contains an invalid audio stream. Export it again and retry.", "UNSUPPORTED_VIDEO", 400);
  }
  const dropIncompatibleAudioTracks = inspected.streams.some(stream => stream.codec_type === "audio"
    && stream.index !== inspected.audio?.index && stream.codec_name !== "aac");
  return { encodeVideo, encodeAudio: !!inspected.audio && inspected.audio.codec_name !== "aac", dropIncompatibleAudioTracks,
    width: outputWidth, height: outputHeight, frameRate, normalizeFrameRate };
}

async function readLocalVideoSize(filePath: string): Promise<number> {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw conversionFailed();
  if (details.size > MAX_VIDEO_UPLOAD_BYTES) throw tooLarge();
  if (details.size <= 0) throw new VideoUploadError("Choose a non-empty MP4 file.", "EMPTY_VIDEO", 400);
  return details.size;
}

async function ensureNewOutput(inputPath: string, outputPath: string): Promise<void> {
  if (!isAbsolute(outputPath) || resolve(inputPath) === resolve(outputPath) || dirname(resolve(inputPath)) !== dirname(resolve(outputPath))) {
    throw conversionFailed();
  }
  const directory = await lstat(dirname(outputPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw conversionFailed();
  const existing = await lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw conversionFailed();
}

function buildConversionArguments(inputPath: string, outputPath: string, inspected: InspectedVideoFile, plan: CompatibilityPlan): string[] {
  // Autorotation is enabled by default; explicit boolean syntax differs between FFmpeg versions.
  const arguments_ = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-xerror", "-max_alloc", "67108864",
    "-filter_threads", "2", "-filter_complex_threads", "2", "-threads", "2",
    "-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0",
    "-probesize", "8388608", "-analyzeduration", "5000000", "-i", inputPath,
    "-map", `0:${inspected.video.index}`
  ];
  if (inspected.audio) arguments_.push("-map", `0:${inspected.audio.index}`);
  arguments_.push("-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1", "-sn", "-dn");
  if (plan.encodeVideo) {
    const filters = [`scale=${plan.width}:${plan.height}`, "setsar=1"];
    if (plan.normalizeFrameRate) filters.push("fps=30");
    arguments_.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "main",
      "-pix_fmt", "yuv420p", "-vf", filters.join(","), "-metadata:s:v:0", "rotate=0");
  } else arguments_.push("-c:v", "copy");
  if (inspected.audio) arguments_.push("-c:a", plan.encodeAudio ? "aac" : "copy");
  if (plan.encodeAudio) arguments_.push("-b:a", "192k");
  arguments_.push("-threads", "2", "-movflags", "+faststart", "-fs", String(MAX_VIDEO_UPLOAD_BYTES), "-f", "mp4", outputPath);
  return arguments_;
}

/** Never settles until close, even when execFile's callback precedes process termination. */
async function runConversion(arguments_: string[], outputPath: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let child: ChildProcess | undefined;
  let failure: VideoUploadError | undefined;
  let processClosed = false;
  const stop = (error: VideoUploadError) => {
    failure ??= error;
    if (!processClosed) child?.kill("SIGKILL");
  };
  const abort = () => {
    try { throwIfAborted(signal); } catch (error) { stop(error as VideoUploadError); }
  };
  const timeout = setTimeout(() => stop(new VideoUploadError("Video conversion exceeded the five-minute processing limit. Try a smaller or shorter MP4.",
    "VIDEO_CONVERSION_TIMEOUT", 504)), CONVERSION_TIMEOUT_MS);
  let watching = false;
  const watcher = setInterval(() => {
    if (watching || processClosed) return;
    watching = true;
    void stat(outputPath).then(details => {
      if (!processClosed && details.size > MAX_VIDEO_UPLOAD_BYTES) stop(tooLarge());
    }).catch((error: NodeJS.ErrnoException) => {
      if (!processClosed && error.code !== "ENOENT") stop(conversionFailed());
    }).finally(() => { watching = false; });
  }, 100);
  signal.addEventListener("abort", abort, { once: true });
  try {
    let complete!: (error: ExecFileException | null) => void;
    const completed = new Promise<ExecFileException | null>(resolve => { complete = resolve; });
    child = execFile(process.env.FFMPEG_PATH?.trim() || "ffmpeg", arguments_, {
      encoding: "utf8", maxBuffer: 64 * 1024, killSignal: "SIGKILL", windowsHide: true
    }, error => { complete(error); });
    const closed = new Promise<void>(resolve => { child!.once("close", () => { processClosed = true; resolve(); }); });
    // Cover an abort between the initial check and listener/process registration.
    if (signal.aborted) abort();
    const error = await completed;
    if (failure) child.kill("SIGKILL");
    await closed;
    throwIfAborted(signal);
    if (failure) throw failure;
    if (error?.code === "ENOENT") {
      throw new VideoUploadError("Video conversion is unavailable. Ask an administrator to install ffmpeg or set FFMPEG_PATH, then retry.", "FFMPEG_UNAVAILABLE", 503);
    }
    if (error) throw conversionFailed();
  } finally {
    clearTimeout(timeout);
    clearInterval(watcher);
    signal.removeEventListener("abort", abort);
  }
}

function assertCompleteOutput(source: InspectedVideoFile, output: InspectedVideoFile, plan: CompatibilityPlan): void {
  const resultPlan = planCompatibility(output);
  const durationTolerance = Math.max(0.1, Math.min(0.25, 2 / (plan.frameRate === null ? 30 : Math.min(plan.frameRate, 30))));
  const videoSourceDuration = Number(source.video.duration);
  const videoOutputDuration = Number(output.video.duration);
  const audioSourceDuration = Number(source.audio?.duration);
  const audioOutputDuration = Number(output.audio?.duration);
  if (resultPlan.encodeVideo || resultPlan.encodeAudio || resultPlan.dropIncompatibleAudioTracks || (!!source.audio !== !!output.audio)
    || Math.abs(source.durationSeconds - output.durationSeconds) > durationTolerance
    || (Number.isFinite(videoSourceDuration) && videoSourceDuration > 0
      && (!Number.isFinite(videoOutputDuration) || Math.abs(videoSourceDuration - videoOutputDuration) > durationTolerance))
    || (Number.isFinite(audioSourceDuration) && audioSourceDuration > 0
      && (!Number.isFinite(audioOutputDuration) || Math.abs(audioSourceDuration - audioOutputDuration) > durationTolerance))) {
    throw new VideoUploadError("Video conversion did not preserve the complete video. Choose a smaller MP4 or export it again.", "VIDEO_CONVERSION_INCOMPLETE", 400);
  }
}

export async function prepareCompatibleVideo(
  inputPath: string,
  outputPath: string,
  signal: AbortSignal,
  onConverting?: () => Promise<void>
): Promise<{ filePath: string; metadata: ValidatedVideoMetadata; bytes: number; converted: boolean }> {
  let removeOutput = false;
  try {
    throwIfAborted(signal);
    if (!isAbsolute(inputPath)) throw conversionFailed();
    const sourceBytes = await readLocalVideoSize(inputPath);
    const source = await inspectVideoFile(inputPath, signal);
    const plan = planCompatibility(source);
    if (!plan.encodeVideo && !plan.encodeAudio && !plan.dropIncompatibleAudioTracks) {
      throwIfAborted(signal);
      return { filePath: inputPath, metadata: { width: source.width, height: source.height, durationSeconds: source.durationSeconds },
        bytes: sourceBytes, converted: false };
    }
    await ensureNewOutput(inputPath, outputPath);
    await onConverting?.();
    throwIfAborted(signal);
    removeOutput = true;
    await runConversion(buildConversionArguments(inputPath, outputPath, source, plan), outputPath, signal);
    await chmod(outputPath, 0o600);
    const bytes = await readLocalVideoSize(outputPath);
    const output = await inspectVideoFile(outputPath, signal);
    assertCompleteOutput(source, output, plan);
    throwIfAborted(signal);
    return { filePath: outputPath, metadata: { width: output.width, height: output.height, durationSeconds: output.durationSeconds }, bytes, converted: true };
  } catch (error) {
    if (removeOutput) {
      await rm(outputPath, { force: true }).catch(() => {
        console.error("[video-upload] partial conversion cleanup failed; check temporary disk capacity");
      });
    }
    throwIfAborted(signal);
    if (error instanceof VideoUploadError) throw error;
    throw conversionFailed();
  }
}
