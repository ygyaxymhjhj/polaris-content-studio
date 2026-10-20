import type { ContentAsset } from "./types";
import { isDraftSubmissionTask, type DraftSubmissionTask } from "./draft-submission-types";
import { markSubmissionSucceeded } from "./submission-status";

export async function fetchAssetDraftTasks(sourceIds: string[], projectId: string, signal?: AbortSignal): Promise<DraftSubmissionTask[]> {
  const tasks: DraftSubmissionTask[] = [];
  for (let offset = 0; offset < sourceIds.length; offset += 64) {
    const parameters = new URLSearchParams({ sourceIds: sourceIds.slice(offset, offset + 64).join(",") });
    if (projectId) parameters.set("projectId", projectId);
    const response = await fetch(`/api/social/draft-submissions?${parameters}`, { cache: "no-store", signal });
    if (!response.ok) throw new Error("Draft status could not be loaded.");
    const result: { tasks?: unknown[] } = await response.json();
    if (!Array.isArray(result.tasks) || !result.tasks.every(isDraftSubmissionTask)) throw new Error("Invalid draft status response.");
    tasks.push(...result.tasks);
  }
  return tasks;
}

export function mergeDraftTask(asset: ContentAsset, task: DraftSubmissionTask): ContentAsset {
  if (task.kind !== "asset" || task.sourceId !== asset.id) return asset;
  if (asset.submissionTask && asset.submissionTask.createdAt > task.createdAt) return asset;
  if (asset.submissionTask?.id === task.id) {
    const currentState = asset.submissionTask.state;
    if ((["succeeded", "failed", "unknown"].includes(currentState) && ["queued", "running"].includes(task.state))
      || (currentState === "running" && task.state === "queued")) return asset;
  }
  const binding = { id: task.id, state: task.state, createdAt: task.createdAt, warning: task.warning };
  const shouldRestoreSuccess = task.state === "succeeded"
    && (asset.publishStatus === "publishing" || asset.publishStatus === "pending_unknown");
  if (JSON.stringify(asset.submissionTask) === JSON.stringify(binding) && !shouldRestoreSuccess) return asset;
  if (task.state === "succeeded") {
    if (asset.submission?.auditId === task.auditId && asset.submission?.postId === task.postId) {
      return {
        ...asset, submissionTask: binding,
        publishStatus: shouldRestoreSuccess ? (asset.publishedAt || asset.publishedUrl ? "published" : "drafted") : asset.publishStatus,
        publishError: shouldRestoreSuccess ? undefined : asset.publishError
      };
    }
    return { ...markSubmissionSucceeded(asset, { auditId: task.auditId, postId: task.postId || undefined,
      publishedAt: task.finishedAt || task.updatedAt }, task.integrationId), submissionTask: binding };
  }
  return {
    ...asset, submissionTask: binding, targetAccountId: task.integrationId,
    publishStatus: task.state === "failed" ? "failed" : task.state === "unknown" ? "pending_unknown" : "publishing",
    publishError: task.error || (task.state === "unknown" ? "Result unconfirmed. Check the publishing engine before submitting again." : undefined)
  };
}
