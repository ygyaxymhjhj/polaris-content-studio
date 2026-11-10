export type AdminPublishStatus = "drafted" | "pending_review" | "rejected" | "queued" | "published" | "failed";

export interface AdminPublishHistoryResponse {
  publishes: {
    id: string;
    platform: string;
    accountName: string;
    submitter: string;
    status: AdminPublishStatus;
    attemptedAt: string | null;
    scheduledAt: string | null;
    publishedAt: string | null;
    lastCheckedAt: string | null;
    rejectedAt: string | null;
    errorCode: "submission_failed" | "publishing_failed" | null;
  }[];
  hasNext: boolean;
}
