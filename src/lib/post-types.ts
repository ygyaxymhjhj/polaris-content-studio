import type { SocialPlatform } from "./types";

/**
 * Client-safe types for manual posts. Kept out of the storage layer so browser components can
 * import them without pulling mysql2 into the bundle.
 */

export const POST_TARGET_STATUSES = ["not_started", "submitting", "accepted", "rejected", "failed", "pending_unknown"] as const;
export type PostTargetStatus = typeof POST_TARGET_STATUSES[number];

/** Derived, per-post view of its targets. "attention" covers failures, unknown results and partial delivery. */
export const MANUAL_POST_STATUSES = ["draft", "pushing", "pushed", "attention"] as const;
export type ManualPostStatus = typeof MANUAL_POST_STATUSES[number];

export interface PostTarget {
  integrationId: string;
  platform: string;
  accountName: string;
  status: PostTargetStatus;
  /** Post version that was handed to Postiz; 0 while nothing has been submitted. */
  snapshotVersion: number;
  postizPostId: string | null;
  auditId: string | null;
  warning: string | null;
  error: string | null;
  submittedAt: string | null;
}

export interface ManualPostListItem {
  id: string;
  title: string;
  excerpt: string;
  hasImage: boolean;
  hasVideo?: boolean;
  /** Updated-at epoch milliseconds; the thumbnail URL uses it to bust the browser cache. */
  imageVersion: number;
  status: ManualPostStatus;
  targetCount: number;
  acceptedCount: number;
  rejectedCount?: number;
  platforms: string[];
  /** False once any target reached Postiz (or its result is unknown): the frozen snapshot is no longer editable. */
  editable: boolean;
  deletable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManualPostDetail {
  id: string;
  title: string;
  content: string;
  /** Same-origin image URL, or null when no image is attached. */
  imageUrl: string | null;
  /** Owner-bound upload reference; preview through /api/media/uploads/:id. */
  videoMediaId?: string | null;
  imageName: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  version: number;
  editable: boolean;
  /** Why the post is read-only, when it is. */
  frozenReason: "accepted" | "rejected" | "submitting" | "pending_unknown" | null;
  createdAt: string;
  updatedAt: string;
  targets: PostTarget[];
}

export interface PostsCounts {
  all: number;
  draft: number;
  pushing: number;
  pushed: number;
  attention: number;
}

export interface PostsListResponse {
  enabled: boolean;
  posts: ManualPostListItem[];
  total: number;
  page: number;
  perPage: number;
  counts: PostsCounts;
}

export interface OverviewActivity {
  id: string;
  kind: "created" | "updated" | "submitted" | "accepted" | "rejected" | "failed" | "pending";
  postId: string;
  title: string;
  platform: string | null;
  accountName: string | null;
  at: string;
}

export interface OverviewResponse {
  enabled: boolean;
  generatedAt: string;
  counts: Omit<PostsCounts, "all"> & { total: number };
  activity: OverviewActivity[];
}

/** True while every target is still safe to change: nothing reached Postiz and nothing is in flight. */
export function isTargetSetEditable(targets: Pick<PostTarget, "status">[]): boolean {
  return !targets.some((target) => target.status === "accepted" || target.status === "rejected" || target.status === "submitting" || target.status === "pending_unknown");
}

export function postStatusFromTargets(targets: Pick<PostTarget, "status">[]): ManualPostStatus {
  const accepted = targets.filter((target) => target.status === "accepted").length;
  const submitting = targets.filter((target) => target.status === "submitting").length;
  const unsettled = targets.filter((target) => target.status === "failed" || target.status === "pending_unknown" || target.status === "rejected").length;
  if (submitting > 0) return "pushing";
  if (unsettled > 0) return "attention";
  if (accepted > 0 && accepted === targets.length) return "pushed";
  // Some accounts accepted while others were never submitted: the post is still incomplete.
  if (accepted > 0) return "attention";
  return "draft";
}

export function platformLabel(platform: string): string {
  return platform || "unknown";
}

export function isSupportedPlatform(value: string): value is SocialPlatform {
  return value === "facebook" || value === "threads" || value === "linkedin" || value === "x" || value === "instagram" || value === "youtube";
}

export const POST_CONTENT_MAX_LENGTH = 20000;
export const POST_TITLE_MAX_LENGTH = 255;
export const MAX_POST_TARGETS = 10;

/** MySQL DATETIME strings arrive without a zone; they are always written as UTC. */
export function parsePostTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function formatPostTimestamp(value: string | null | undefined, locale?: string): string {
  const parsed = parsePostTimestamp(value);
  return parsed ? parsed.toLocaleString(locale) : "";
}

export const POST_STATUS_LABEL: Record<ManualPostStatus, string> = {
  draft: "Local draft",
  pushing: "Submitting",
  pushed: "Pushed",
  attention: "Needs attention"
};

export const POST_TARGET_STATUS_LABEL: Record<PostTargetStatus, string> = {
  not_started: "Not submitted",
  submitting: "Submitting…",
  accepted: "Draft accepted",
  rejected: "Review rejected",
  failed: "Failed",
  pending_unknown: "Needs review"
};

/**
 * Documented limits for the supported channels. They only gate the account they belong to:
 * a post that is too long for X can still be handed to Facebook, and Instagram alone requires an
 * image, so one failure never blocks the other accounts.
 */
export const PLATFORM_POST_RULES: Record<SocialPlatform, { maxCharacters: number; requiresImage: boolean }> = {
  x: { maxCharacters: 280, requiresImage: false },
  threads: { maxCharacters: 500, requiresImage: false },
  instagram: { maxCharacters: 2200, requiresImage: true },
  linkedin: { maxCharacters: 3000, requiresImage: false },
  facebook: { maxCharacters: 63206, requiresImage: false },
  youtube: { maxCharacters: 5000, requiresImage: false }
};

export function platformRuleFor(platform: string): { maxCharacters: number; requiresImage: boolean } | null {
  return isSupportedPlatform(platform) ? PLATFORM_POST_RULES[platform] : null;
}

export function youtubePostError(title: string | undefined, content: string, hasVideo: boolean): string {
  if (!hasVideo) return "YouTube requires an MP4 video.";
  const videoTitle = title?.trim() ?? "";
  if (Array.from(videoTitle).length < 2 || Array.from(videoTitle).length > 100 || /[<>]/.test(videoTitle)) {
    return "YouTube requires a video title of 2–100 characters without < or >.";
  }
  if (Array.from(content).length > 5000) return "YouTube descriptions cannot exceed 5,000 characters.";
  return "";
}
