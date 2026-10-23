import { processVideoProcessingJobs } from "./video-processing";
import { databaseConfigured } from "./project-db";

type WorkerState = {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  wakeRequested: boolean;
  shutdown: (() => void) | null;
};
const workerGlobal = globalThis as typeof globalThis & { polarisVideoProcessingWorker?: WorkerState };
const state = workerGlobal.polarisVideoProcessingWorker ??= { timer: null, inFlight: null, wakeRequested: false, shutdown: null };

export function wakeVideoProcessingWorker(): Promise<void> {
  if (!databaseConfigured() || process.env.VERCEL || process.env.NEXT_PHASE === "phase-production-build") return Promise.resolve();
  state.wakeRequested = true;
  if (state.inFlight) return state.inFlight;
  state.inFlight = (async () => {
    try {
      do {
        state.wakeRequested = false;
        if (await processVideoProcessingJobs() === 1) state.wakeRequested = true;
      } while (state.wakeRequested);
    } catch {
      console.warn("[video-processing] Worker incomplete; durable jobs will be reconciled on the next tick.");
    } finally { state.inFlight = null; }
  })();
  return state.inFlight;
}

function scheduleTick(delay: number): void {
  state.timer = setTimeout(() => {
    scheduleTick(5_000);
    void wakeVideoProcessingWorker();
  }, delay);
  state.timer.unref();
}

export function stopVideoProcessingScheduler(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.shutdown) {
    process.off("SIGTERM", state.shutdown);
    process.off("SIGINT", state.shutdown);
    state.shutdown = null;
  }
}

export function startVideoProcessingScheduler(): void {
  if (state.timer || process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const enabled = process.env.VIDEO_PROCESSING_SCHEDULER_ENABLED;
  if (enabled === "false" || (process.env.NODE_ENV !== "production" && enabled !== "true")) return;
  if (process.env.VERCEL || !databaseConfigured()) return;
  state.shutdown = stopVideoProcessingScheduler;
  process.on("SIGTERM", state.shutdown);
  process.on("SIGINT", state.shutdown);
  scheduleTick(1_000);
}
