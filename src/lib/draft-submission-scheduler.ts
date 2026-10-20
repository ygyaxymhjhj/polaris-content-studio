import { processDraftSubmissions } from "./draft-submissions";
import { databaseConfigured } from "./project-db";

type WorkerState = {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  wakeRequested: boolean;
  shutdown: (() => void) | null;
};
const workerGlobal = globalThis as typeof globalThis & { polarisDraftSubmissionWorker?: WorkerState };
const state = workerGlobal.polarisDraftSubmissionWorker ??= { timer: null, inFlight: null, wakeRequested: false, shutdown: null };
const batchSize = 4;

export function wakeDraftSubmissionWorker(): Promise<void> {
  if (!databaseConfigured()) return Promise.resolve();
  state.wakeRequested = true;
  if (state.inFlight) return state.inFlight;
  state.inFlight = (async () => {
    try {
      do {
        state.wakeRequested = false;
        const processed = await processDraftSubmissions(batchSize);
        if (processed === batchSize) state.wakeRequested = true;
      } while (state.wakeRequested);
    } catch {
      console.warn("[draft-submissions] Worker incomplete; durable jobs will be recovered on the next tick.");
    } finally {
      state.inFlight = null;
    }
  })();
  return state.inFlight;
}

function scheduleTick(delay: number): void {
  state.timer = setTimeout(() => {
    scheduleTick(5_000);
    void wakeDraftSubmissionWorker();
  }, delay);
  state.timer.unref();
}

export function stopDraftSubmissionScheduler(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.shutdown) {
    process.off("SIGTERM", state.shutdown);
    process.off("SIGINT", state.shutdown);
    state.shutdown = null;
  }
}

export function startDraftSubmissionScheduler(): void {
  if (state.timer || process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const enabled = process.env.DRAFT_SUBMISSIONS_SCHEDULER_ENABLED;
  if (enabled === "false" || (process.env.NODE_ENV !== "production" && enabled !== "true")) return;
  if (process.env.VERCEL || !databaseConfigured()) return;
  state.shutdown = stopDraftSubmissionScheduler;
  process.on("SIGTERM", state.shutdown);
  process.on("SIGINT", state.shutdown);
  scheduleTick(1_000);
}
