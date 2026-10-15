import { processSocialNotifications } from "./social-notifications";
import { databaseConfigured } from "./project-db";

type SchedulerState = {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  shutdown: (() => void) | null;
};

const schedulerGlobal = globalThis as typeof globalThis & { polarisSocialNotificationScheduler?: SchedulerState };
const state = schedulerGlobal.polarisSocialNotificationScheduler ??= { timer: null, inFlight: false, shutdown: null };

async function runNotifications(): Promise<void> {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const summary = await processSocialNotifications();
    if (summary.warning || summary.failed > 0) {
      console.warn("[social-notifications] Worker reported incomplete processing; retrying on the next tick.");
    }
  } catch {
    console.warn("[social-notifications] Worker failed; retrying on the next tick.");
  } finally {
    state.inFlight = false;
  }
}

function scheduleNextTick(milliseconds: number): void {
  state.timer = setTimeout(() => {
    // Schedule before awaiting work: slow or hanging requests never shift the cadence or overlap.
    scheduleNextTick(60_000);
    void runNotifications();
  }, milliseconds);
  state.timer.unref();
}

export function stopSocialNotificationScheduler(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.shutdown) {
    process.off("SIGTERM", state.shutdown);
    process.off("SIGINT", state.shutdown);
    state.shutdown = null;
  }
  // An existing worker keeps its lease and in-flight guard until it actually settles.
}

export function startSocialNotificationScheduler(): void {
  if (state.timer) return;
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const enabled = process.env.SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED;
  if (enabled === "false" || (process.env.NODE_ENV !== "production" && enabled !== "true")) return;
  if (process.env.VERCEL) {
    console.warn("[social-notifications] In-process scheduling is unsupported on Vercel; use an external runner.");
    return;
  }
  if (!databaseConfigured()) {
    console.warn("[social-notifications] Scheduler not started: database is not configured.");
    return;
  }
  state.shutdown = stopSocialNotificationScheduler;
  process.on("SIGTERM", state.shutdown);
  process.on("SIGINT", state.shutdown);
  scheduleNextTick(5_000);
}
