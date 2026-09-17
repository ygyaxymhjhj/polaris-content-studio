import { z } from "zod";
import type { ContentAsset, ProjectConfig, RewriteMessage, SourceAnalysis } from "./types";
import type { ImportedSource } from "./source-config";

const str = z.string().max(150000);
const strings = z.array(str).max(1000);
const platform = z.enum(["website", "facebook", "threads", "linkedin", "x", "instagram", "short_video", "community", "push", "kol_live", "faq"]);
const config = z.object({ name: str, title: str, category: str, language: z.enum(["en", "vi", "zh"]), audience: str, cta: str, websiteUrl: str, sourceUrl: str, tone: str, publishDate: str });
const fact = z.object({ id: str, type: z.enum(["claim", "number", "date", "entity", "quote"]), text: str, sourceExcerpt: str, sourceLocation: str, verified: z.boolean(), usableOnSocial: z.boolean(), riskLevel: z.enum(["low", "medium", "high"]) });
const metadata = z.record(z.string(), z.unknown());
const before = z.object({ title: str, content: str, cta: str.optional(), meta: metadata.optional(), factIds: strings });
const asset = z.object({ id: str, platform, assetType: str, generationMode: z.enum(["ai", "local"]).optional(), variant: str.optional(), title: str, hook: str.optional(), content: str, cta: str.optional(), deepLink: str.optional(), factIds: strings, riskFlags: strings, status: z.enum(["draft", "needs_review", "approved", "revision_required"]), meta: metadata.optional(), updatedAt: str, revisions: z.array(z.object({ at: str, instruction: str, before })).max(40).optional() });
export const projectSchema = z.object({
  schemaVersion: z.literal(1), config, sourceText: str, sourceName: str, sourcePending: z.boolean(),
  importedSource: z.object({ text: str, title: str.optional(), sourceUrl: str.optional() }).nullable(),
  editedConfig: z.array(z.enum(["name", "title", "category", "language", "audience", "cta", "websiteUrl", "sourceUrl", "tone", "publishDate"])).max(20),
  analysis: z.object({ sourceReviewBasis: z.literal("team-reviewed-article").optional(), summaryShort: str, summaryLong: str, keyTerms: strings, riskFlags: strings, facts: z.array(fact).max(2000) }).nullable(),
  assets: z.array(asset).max(200), selectedPlatforms: z.array(platform).max(11),
  threads: z.record(z.string(), z.array(z.object({ role: z.enum(["user", "assistant"]), text: str, at: str })).max(100)),
  usedFallback: z.boolean(), generationRun: z.string().max(100)
});
export interface ProjectSnapshot {
  schemaVersion: 1; config: ProjectConfig; sourceText: string; sourceName: string; sourcePending: boolean;
  importedSource: ImportedSource | null; editedConfig: (keyof ProjectConfig)[]; analysis: SourceAnalysis | null;
  assets: ContentAsset[]; selectedPlatforms: z.infer<typeof platform>[]; threads: Record<string, RewriteMessage[]>;
  usedFallback: boolean; generationRun: string;
}
export interface SavedProject { id: string; name: string; version: number; updatedAt: string; assetCount: number; }
export const saveProjectSchema = z.object({ id: z.uuid(), version: z.number().int().min(0).max(2147483646), snapshot: projectSchema });
