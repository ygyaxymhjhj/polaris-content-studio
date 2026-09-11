export type Platform =
  | "website"
  | "facebook"
  | "threads"
  | "linkedin"
  | "x"
  | "instagram"
  | "short_video"
  | "community"
  | "push"
  | "kol_live"
  | "faq";

export type AssetStatus = "draft" | "needs_review" | "approved" | "revision_required";
export type RiskLevel = "low" | "medium" | "high";

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
  factIds: string[];
  riskFlags: string[];
  status: AssetStatus;
  meta?: Record<string, unknown>;
  updatedAt: string;
}

export interface GenerateResponse {
  assets: ContentAsset[];
  usedFallback: boolean;
}

export const PLATFORM_META: Record<Platform, { label: string; short: string; accent: string; icon: string }> = {
  website: { label: "Website SEO", short: "WEB", accent: "#ffbd66", icon: "◎" },
  facebook: { label: "Facebook", short: "f", accent: "#6da8ff", icon: "f" },
  threads: { label: "Threads", short: "@", accent: "#9e9aa6", icon: "@" },
  linkedin: { label: "LinkedIn", short: "in", accent: "#5d9df5", icon: "in" },
  x: { label: "X / Twitter", short: "X", accent: "#a7a7b2", icon: "𝕏" },
  instagram: { label: "Instagram", short: "IG", accent: "#ee7d9f", icon: "◎" },
  short_video: { label: "Short video", short: "VID", accent: "#b78cff", icon: "▶" },
  community: { label: "App Community", short: "COM", accent: "#67d9b4", icon: "⌁" },
  push: { label: "App Push", short: "PUSH", accent: "#ff946e", icon: "◒" },
  kol_live: { label: "KOL LIVE", short: "LIVE", accent: "#ff6e72", icon: "●" },
  faq: { label: "FAQ", short: "FAQ", accent: "#7fc7ff", icon: "?" }
};

export const DEFAULT_PLATFORMS: Platform[] = [
  "website",
  "facebook",
  "threads",
  "linkedin",
  "x",
  "instagram",
  "short_video",
  "community",
  "push",
  "kol_live",
  "faq"
];
