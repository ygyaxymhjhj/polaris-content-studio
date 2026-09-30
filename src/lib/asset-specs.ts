import { channelVoice } from "./social-guidelines";
import { dominantSourceLanguage } from "./source-config";
import { PLATFORM_META } from "./types";
import type { ContentAsset, Platform, ProjectConfig } from "./types";

export const ASSET_SPECS: Record<Platform, { count: number; brief: string; minLength: number; notes: string[] }> = {
  facebook: { count: 1, minLength: 250, notes: ["visualBrief", "imageText", "firstComment"], brief: "One complete, independently publishable Facebook post: rewrite the source into a short caption — clear, focused and easy to read. One caption carries one core message, so pick the most notable, information-rich part of the article instead of retelling everything. The first line states the point directly — what happened and what matters most — and carries the most striking sourced figure when the article has one; never invent or force a figure in. After the first line, add only the necessary information (a key figure, a development, essential context) in one or two short paragraphs; never one long block, and never a walk through background, cause, events, outcome and impact in source order. Do not apply a fixed “hook → body → CTA” template: when no question or CTA follows naturally, end once the information is complete. Every post must carry at least one emoji/icon chosen for this specific content and used in moderation, and end with hashtags directly relevant to the content — never piled on. Target roughly 60-150 English/Vietnamese words or 250-350 Chinese characters when the source supports it; a shorter honest draft beats padding. Do not output an outline, a teaser only, or instructions such as 'explain why it matters'. Include the real destination URL if provided; otherwise omit the link. meta: visualBrief (production direction, not evidence), imageText (short factual on-image headline), firstComment (optional publishable follow-up). Do NOT put visual directions into content." },
  threads: { count: 1, minLength: 120, notes: ["opening", "body"], brief: "One complete Threads post made of exactly two parts: 1 opening sentence + 1 main body paragraph. The opening sentence must be engaging and say immediately what the post is about; the body keeps only the most essential information and reads short, clear and continuous. Keep the whole post within 500 characters. meta.opening and meta.body hold the two parts exactly as published. Do not output numbered replies and do not invent audience opinions." },
  linkedin: { count: 1, minLength: 450, notes: ["visualBrief"], brief: "One professional post in English with a factual opening, context, 2-3 evidence-led points, implications explicitly framed as interpretation, and a closing question/CTA. 5-7 readable paragraphs; target 200-350 English words if supported. Avoid fake personal experience and generic business filler. meta.visualBrief describes an optional editorial graphic." },
  x: { count: 1, minLength: 120, notes: ["post"], brief: "One single X post in fast-news style, <=280 characters including any link (conservative raw count). Lead with the most important information; keep sentences short and information-dense. If the real article link is included, the post alone must still tell readers what the news is. meta.post holds the exact publishable text. Do not write a multi-post thread." },
  instagram: { count: 1, minLength: 350, notes: ["slides", "caption", "visualBrief"], brief: "One 6-slide carousel. content must contain final copy for each numbered slide plus a separately labeled publishable caption and CTA. Slides: hook, context, fact 1, fact 2 or limitation, what remains uncertain, recap/CTA. Keep slide copy short; no invented advice when source has no recommendations. meta.slides: six objects with title, body, visualDirection; meta.caption, slideCount=6, visualBrief. Visuals must not imply fabricated documentary evidence." }
};

/**
 * The one canonical asset type per platform, used by the AI normalisation and kept in sync with the
 * offline template by the test suite. The model cannot know this taxonomy, so its guess is never
 * trusted: without this, a carousel got labelled "slideshow copy" again.
 */
export const ASSET_TYPES: Record<Platform, string> = {
  facebook: "short_post",
  threads: "discussion_thread",
  linkedin: "professional_insight",
  x: "short_post",
  instagram: "carousel"
};

export function assetQualityIssues(asset: ContentAsset, configured?: ProjectConfig["language"]): string[] {
  const spec = ASSET_SPECS[asset.platform];
  const issues: string[] = [];
  if (asset.content.length < spec.minLength) issues.push("Draft may be too brief for this format; check source coverage");
  for (const key of spec.notes) {
    const value = asset.meta?.[key];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) issues.push(`Missing delivery field: ${key}`);
  }
  if (asset.platform === "instagram" && (!Array.isArray(asset.meta?.slides) || asset.meta.slides.length !== 6)) issues.push("Carousel requires six slides");
  if (asset.platform === "x" && typeof asset.meta?.post === "string" && asset.meta.post.length > 280) issues.push("Check X post character limit");
  // A channel with one fixed output language cannot be corrected by changing the project language, so
  // copy that came back in another one is reported: generation retries on these issues, and the editor
  // sees the mismatch when the model insists. Channels that follow config.language are left alone,
  // because a draft written before a language change is not a defect worth flagging on every asset.
  // Offline drafts are skipped too: the template cannot translate at all and reports that itself.
  const voice = configured && asset.generationMode !== "local" ? channelVoice(asset.platform, configured) : undefined;
  if (voice?.fixed) {
    const detected = dominantSourceLanguage(asset.content);
    if (detected !== voice.language) issues.push(`${PLATFORM_META[asset.platform].label} publishes in ${voice.language}; this draft reads as ${detected}. Rewrite it in ${voice.language} before publishing`);
  }
  return issues;
}
