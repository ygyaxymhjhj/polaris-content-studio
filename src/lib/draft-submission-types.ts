export const DRAFT_SUBMISSION_STATES = ["queued", "running", "succeeded", "failed", "unknown"] as const;
export type DraftSubmissionState = typeof DRAFT_SUBMISSION_STATES[number];

/** Owner-only projection. Content, images, permissions and lease tokens never leave the server. */
export interface DraftSubmissionTask {
  id: string;
  kind: "asset" | "manual";
  sourceId: string;
  projectId: string | null;
  integrationId: string;
  state: DraftSubmissionState;
  auditId: string | null;
  postId: string | null;
  warning: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export function isDraftSubmissionTask(value: unknown): value is DraftSubmissionTask {
  if (!value || typeof value !== "object") return false;
  const task = value as DraftSubmissionTask;
  return typeof task.id === "string" && typeof task.sourceId === "string" && typeof task.integrationId === "string"
    && (task.kind === "asset" || task.kind === "manual") && DRAFT_SUBMISSION_STATES.includes(task.state)
    && (task.projectId === null || typeof task.projectId === "string")
    && [task.auditId, task.postId, task.warning, task.error, task.finishedAt].every(field => field === null || typeof field === "string")
    && typeof task.createdAt === "string" && typeof task.updatedAt === "string";
}
