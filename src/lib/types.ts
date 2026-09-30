export type Platform =
  | "facebook"
  | "threads"
  | "linkedin"
  | "x"
  | "instagram";

export type AssetStatus = "draft" | "needs_review" | "approved" | "revision_required";
export type RiskLevel = "low" | "medium" | "high";
export type PublishStatus = "unpublished" | "publishing" | "published" | "failed";

export interface SocialAccount {
  id: string;
  name: string;
  identifier: string;
  picture?: string;
  disabled?: boolean;
}

export interface FactItem {
  id: string;
  type: "claim" | "number" | "date" | "entity" | "quote";
  text: string;
  sourceExcerpt: string;
  sourceLocation: string;
  verified: boolean;
  usableOnSocial: boolean;
  riskLevel: RiskLevel;
}

export interface SourceAnalysis {
  /** Source was reviewed by the team; extracted fact rows were not individually reviewed. */
  sourceReviewBasis?: "team-reviewed-article";
  summaryShort: string;
  summaryLong: string;
  keyTerms: string[];
  facts: FactItem[];
  riskFlags: string[];
}

export interface ProjectConfig {
  name: string;
  title: string;
  category: string;
  language: "en" | "vi" | "zh";
  audience: string;
  cta: string;
  websiteUrl: string;
  sourceUrl: string;
  tone: string;
  publishDate: string;
  imageUrl?: string;
}

export interface ContentAsset {
  id: string;
  platform: Platform;
  assetType: string;
  generationMode?: "ai" | "local";
  variant?: string;
  title: string;
  hook?: string;
  content: string;
  cta?: string;
  deepLink?: string;
  imageUrl?: string;
  publishStatus?: PublishStatus;
  publishedUrl?: string;
  publishedAt?: string;
  publishError?: string;
  targetAccountId?: string;
  factIds: string[];
  riskFlags: string[];
  status: AssetStatus;
  meta?: Record<string, unknown>;
  updatedAt: string;
  /** Adopted AI revisions, newest last. The UI keeps this capped at MAX_REVISIONS. */
  revisions?: RewriteRecord[];
}

export interface GenerateResponse {
  assets: ContentAsset[];
  usedFallback: boolean;
}

export const MAX_REVISIONS = 3;
/** Rewrite turns are advisory context, not a transcript: the draft itself carries every adopted change. */
export const MAX_TURNS = 40;

/** One turn of the rewrite conversation. Assistant turns carry a short change summary, not the draft. */
export interface RewriteMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** False marks assistant turns whose options were never adopted, so the next request reads the rejected direction as negative context. */
  adopted?: boolean;
}

/** Snapshot taken before an AI revision is adopted, so the change can be reverted. */
export interface RewriteSnapshot {
  title: string;
  content: string;
  cta?: string;
  meta?: Record<string, unknown>;
  factIds: string[];
}

export interface RewriteRecord {
  at: string;
  instruction: string;
  before: RewriteSnapshot;
}

export interface RewriteCandidate {
  asset: ContentAsset;
  issues: string[];
  changeSummary: string;
}

export interface RewriteResponse {
  candidates: RewriteCandidate[];
  /** Turns dropped from the prompt because they did not fit the model's context window. */
  droppedTurns: number;
  /** Options the model returned that failed validation; only set when no candidate survived. */
  rejected?: number;
  /** Why no candidate survived, when the provider call itself failed. */
  reason?: string;
}

/**
 * The channels Polaris publishes to. Every one of them is a social platform with its own voice
 * rules; the pack contains one asset per channel.
 */
export const PLATFORM_META: Record<Platform, { label: string; short: string; accent: string; icon: string }> = {
  facebook: { label: "Facebook", short: "f", accent: "#6da8ff", icon: "f" },
  threads: { label: "Threads", short: "@", accent: "#9e9aa6", icon: "@" },
  linkedin: { label: "LinkedIn", short: "in", accent: "#5d9df5", icon: "in" },
  x: { label: "X / Twitter", short: "X", accent: "#a7a7b2", icon: "𝕏" },
  instagram: { label: "Instagram", short: "IG", accent: "#ee7d9f", icon: "◎" }
};

export const DEFAULT_PLATFORMS: Platform[] = [
  "facebook",
  "threads",
  "linkedin",
  "x",
  "instagram"
];
