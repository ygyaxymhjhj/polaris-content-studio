export async function register() {
  // The explicit runtime branch also keeps Node database dependencies out of the Edge bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const videoSchedulerEnabled = process.env.VIDEO_PROCESSING_SCHEDULER_ENABLED;
    const shouldStartVideoScheduler = !process.env.VERCEL && videoSchedulerEnabled !== "false"
      && (process.env.NODE_ENV === "production" || videoSchedulerEnabled === "true");
    if (shouldStartVideoScheduler) {
      const { startVideoProcessingScheduler } = await import("./lib/video-processing-scheduler");
      startVideoProcessingScheduler();
    }
    const draftSchedulerEnabled = process.env.DRAFT_SUBMISSIONS_SCHEDULER_ENABLED;
    const shouldStartDraftScheduler = !process.env.VERCEL && draftSchedulerEnabled !== "false"
      && (process.env.NODE_ENV === "production" || draftSchedulerEnabled === "true");
    if (shouldStartDraftScheduler) {
      const { startDraftSubmissionScheduler } = await import("./lib/draft-submission-scheduler");
      startDraftSubmissionScheduler();
    }
    const enabled = process.env.SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED;
    if (enabled === "false" || (process.env.NODE_ENV !== "production" && enabled !== "true")) return;
    if (process.env.VERCEL) {
      console.warn("[social-notifications] In-process scheduling is unsupported on Vercel; use an external runner.");
      return;
    }
    const { startSocialNotificationScheduler } = await import("./lib/social-notification-scheduler");
    startSocialNotificationScheduler();
  }
}
