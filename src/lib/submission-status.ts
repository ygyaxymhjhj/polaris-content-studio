import type { ContentAsset, SubmissionStatusSnapshot } from "./types";

type StatusFields = Pick<ContentAsset, "publishStatus" | "reviewStatus" | "rejectedDetectedAt" | "submission" | "publishedAt" | "publishedUrl" | "publishError" | "targetAccountId">;

export function getPersistedAssets(assets: ContentAsset[]): ContentAsset[] {
  return assets.map(asset => {
    const persisted = { ...asset };
    delete persisted.reviewStatus;
    delete persisted.rejectedDetectedAt;
    return persisted;
  });
}

/** Bound both identifier count and encoded URL size, including project scoping. */
export function getSubmissionStatusQueries(assets: ContentAsset[], projectId: string): URLSearchParams[] {
  const identifiers = assets.filter(shouldPollSubmission).map(asset => ({
    parameter: asset.submission ? "auditIds" : "assetIds",
    value: asset.submission?.auditId ?? asset.id
  }));
  const queries: URLSearchParams[] = [];
  let parameters = new URLSearchParams(projectId ? { projectId } : {});
  let count = 0;
  for (const identifier of identifiers) {
    const candidate = new URLSearchParams(parameters);
    const existing = candidate.get(identifier.parameter);
    candidate.set(identifier.parameter, existing ? `${existing},${identifier.value}` : identifier.value);
    if (count && (count >= 64 || new TextEncoder().encode(candidate.toString()).length > 8000)) {
      queries.push(parameters);
      parameters = new URLSearchParams(projectId ? { projectId } : {});
      count = 0;
    }
    const chunkIdentifiers = parameters.get(identifier.parameter);
    parameters.set(identifier.parameter, chunkIdentifiers ? `${chunkIdentifiers},${identifier.value}` : identifier.value);
    count += 1;
  }
  if (count) queries.push(parameters);
  return queries;
}

function isSubmissionStatusSnapshot(value: unknown): value is SubmissionStatusSnapshot {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const boundedString = (field: unknown) => typeof field === "string" && field.length > 0 && field.length <= 150000;
  const nullableString = (field: unknown) => field === null || boundedString(field);
  const timestamp = (field: unknown) => boundedString(field) && Number.isFinite(Date.parse(field as string));
  return boundedString(entry.auditId) && nullableString(entry.postId) && boundedString(entry.assetId)
    && boundedString(entry.integrationId) && timestamp(entry.submittedAt)
    && ["drafted", "published", "queued", "failed"].includes(entry.publishStatus as string)
    && ["unknown", "pending", "rejected"].includes(entry.reviewStatus as string)
    && (entry.rejectedDetectedAt === null || timestamp(entry.rejectedDetectedAt))
    && (entry.publishedAt === null || timestamp(entry.publishedAt)) && nullableString(entry.publishedUrl)
    && [null, "DRAFT", "QUEUE", "PUBLISHED", "ERROR"].includes(entry.postizState as string | null)
    && [null, "pass", "update", "draft", "schedule", "now"].includes(entry.saveAction as string | null);
}

export function getSubmissionBindingKey(asset: ContentAsset): string {
  return JSON.stringify(asset.submission ?? null);
}

export function shouldPollSubmission(asset: ContentAsset): boolean {
  if (asset.publishStatus === "publishing" || asset.publishStatus === "failed") return false;
  // A present, untracked submission is deliberately not a legacy asset.
  if (asset.submission && !asset.submission.auditId) return false;
  return asset.publishStatus === "drafted" || asset.publishStatus === "queued"
    || asset.reviewStatus === "rejected" || (!asset.submission && asset.publishStatus === "published")
    || Boolean(asset.submission && (!asset.reviewStatus || asset.reviewStatus === "pending" || asset.reviewStatus === "unknown"));
}

export function getAssetStatusFields(asset: StatusFields): StatusFields {
  return {
    publishStatus: asset.publishStatus, reviewStatus: asset.reviewStatus,
    rejectedDetectedAt: asset.rejectedDetectedAt, submission: asset.submission,
    publishedAt: asset.publishedAt, publishedUrl: asset.publishedUrl,
    publishError: asset.publishError, targetAccountId: asset.targetAccountId
  };
}

/** Merge only server facts; an open editor's copy, images and revision history stay untouched. */
export function mergeSubmissionStatus(
  current: ContentAsset,
  requested: ContentAsset,
  snapshots: unknown[]
): ContentAsset {
  if (current.id !== requested.id || current.publishStatus === "publishing" || current.publishStatus === "failed"
    || getSubmissionBindingKey(current) !== getSubmissionBindingKey(requested)
    || current.targetAccountId !== requested.targetAccountId) return current;
  const binding = current.submission;
  if (binding && !binding.auditId) return current;
  const snapshot = snapshots.filter(isSubmissionStatusSnapshot).find(entry => entry.assetId === current.id && (binding
    ? entry.auditId === binding.auditId && entry.postId === binding.postId
    : !requested.submission && (!current.targetAccountId || entry.integrationId === current.targetAccountId)));
  if (!snapshot) return current;
  const statusFields: StatusFields = {
    publishStatus: snapshot.publishStatus, reviewStatus: snapshot.reviewStatus,
    rejectedDetectedAt: snapshot.rejectedDetectedAt ?? undefined,
    submission: { auditId: snapshot.auditId, postId: snapshot.postId, submittedAt: snapshot.submittedAt },
    targetAccountId: snapshot.integrationId,
    // submittedAt is not the time the post went live.
    publishedAt: snapshot.publishedAt ?? undefined, publishedUrl: snapshot.publishedUrl ?? undefined,
    publishError: snapshot.publishStatus === "failed" ? current.publishError : undefined
  };
  if (JSON.stringify(getAssetStatusFields(current)) === JSON.stringify(statusFields)) return current;
  return { ...current, ...statusFields };
}

export function markSubmissionSucceeded(
  asset: ContentAsset,
  result: { auditId: string | null; postId?: string; publishedAt: string },
  accountId: string
): ContentAsset {
  return {
    ...asset, publishStatus: "drafted", reviewStatus: "pending", rejectedDetectedAt: undefined,
    publishedAt: undefined, publishedUrl: undefined, publishError: undefined, targetAccountId: accountId,
    submission: { auditId: result.auditId ?? null, postId: result.postId ?? null, submittedAt: result.publishedAt }
  };
}

export function getPublishBadge(asset: Pick<ContentAsset, "publishStatus" | "reviewStatus">): { className: string; label: string } {
  if (asset.publishStatus === "publishing") return { className: "publishing", label: "Submitting…" };
  if (asset.publishStatus === "published") return { className: "published", label: "Published" };
  if (asset.publishStatus === "failed") return { className: "failed", label: "Publish failed" };
  if (asset.reviewStatus === "rejected") return { className: "rejected", label: "Review rejected" };
  if (asset.publishStatus === "drafted") return { className: "drafted", label: "Pending review" };
  if (asset.publishStatus === "queued") return { className: "drafted", label: "Scheduled" };
  return { className: "unpublished", label: "Unpublished" };
}
