import { channelVoice } from "./social-guidelines";
import { dominantSourceLanguage } from "./source-config";
import { PLATFORM_META } from "./types";
import type { ContentAsset, Platform, ProjectConfig } from "./types";

export const ASSET_SPECS: Record<Platform, { count: number; brief: string; minLength: number; notes: string[] }> = {
  website: { count: 1, minLength: 500, notes: ["seoTitle", "metaDescription", "slug"], brief: "One complete website article, not just an SEO summary. Write a headline, lead, 3-5 meaningful sections with H2 headings, source-backed details, a concise conclusion and CTA. Target 500-800 English/Vietnamese words or 800-1200 Chinese characters only if evidence supports it. meta: seoTitle, metaDescription, slug, keyTerms. Do not copy a source date into publication date." },
  facebook: { count: 2, minLength: 350, notes: ["visualBrief", "imageText", "firstComment"], brief: "Two independently publishable Facebook posts: A news/explainer angle, B a reader-question angle. Each content must include an engaging factual opening, context, 2-4 concrete sourced details, a cautious takeaway and a natural question or CTA. Use 4-7 readable paragraphs, optional short bullets and 0-3 relevant hashtags. Target 150-250 English/Vietnamese words or 250-450 Chinese characters when source supports it. Do not output an outline, a teaser only, or instructions such as 'explain why it matters'. Include the real destination URL if provided; otherwise omit the link. meta: visualBrief (production direction, not evidence), imageText (short factual on-image headline), firstComment (optional publishable follow-up). Do NOT put visual directions into content." },
  threads: { count: 1, minLength: 120, notes: ["opening", "body"], brief: "One complete Threads post made of exactly two parts: 1 opening sentence + 1 main body paragraph. The opening sentence must be engaging and say immediately what the post is about; the body keeps only the most essential information and reads short, clear and continuous. Keep the whole post within 500 characters. meta.opening and meta.body hold the two parts exactly as published. Do not output numbered replies and do not invent audience opinions." },
  linkedin: { count: 1, minLength: 450, notes: ["visualBrief"], brief: "One professional post in English with a factual opening, context, 2-3 evidence-led points, implications explicitly framed as interpretation, and a closing question/CTA. 5-7 readable paragraphs; target 200-350 English words if supported. Avoid fake personal experience and generic business filler. meta.visualBrief describes an optional editorial graphic." },
  x: { count: 1, minLength: 120, notes: ["post"], brief: "One single X post in fast-news style, <=280 characters including any link (conservative raw count). Lead with the most important information; keep sentences short and information-dense. If the real article link is included, the post alone must still tell readers what the news is. meta.post holds the exact publishable text. Do not write a multi-post thread." },
  instagram: { count: 1, minLength: 350, notes: ["slides", "caption", "visualBrief"], brief: "One 6-slide carousel. content must contain final copy for each numbered slide plus a separately labeled publishable caption and CTA. Slides: hook, context, fact 1, fact 2 or limitation, what remains uncertain, recap/CTA. Keep slide copy short; no invented advice when source has no recommendations. meta.slides: six objects with title, body, visualDirection; meta.caption, slideCount=6, visualBrief. Visuals must not imply fabricated documentary evidence." },
  short_video: { count: 1, minLength: 300, notes: ["duration", "caption"], brief: "One complete voiceover copy for a vertical 40-70 second video: the exact spoken text, written the way it is said, with no timestamps, on-screen text, emoji, hashtags or shot direction mixed in. Budget realistic speech length in the requested language and read the copy back silently so it flows naturally without stumbles or repeats. Take the story from the article's own content and do not force one structure onto every video; if it needs more time to be told properly, write longer rather than cutting context. meta.duration states the target runtime (for example 40-70s or 60s); meta.caption is a single posting caption. Never use 'explain this' instead of actual narration." },
  community: { count: 1, minLength: 220, notes: ["options", "pinnedReply"], brief: "One complete community post with title, factual context, an open question, 4 neutral poll choices, invitation to comment and a written moderator pinned reply. Include all publishable text in content. meta.options is four strings; meta.pinnedReply. Poll asks about information needs, not invented survey results or buy/sell recommendations." },
  push: { count: 3, minLength: 25, notes: ["pushTitle", "pushBody", "audience", "sendWindow", "frequency"], brief: "Three push variants: news-led, question-led, read-more-led. Each has an actual short title <=40 characters and body <=100 characters, localized and not sensational. content clearly labels title and body; meta.pushTitle and meta.pushBody contain exact copy. Include cta and deepLink only if real URL exists. meta.audience, sendWindow, frequency must be explicitly labeled proposed settings, not actual user analytics or scheduled sends. No automatic sending, false urgency, or placeholder URLs." },
  kol_live: { count: 1, minLength: 400, notes: ["segments", "promoCopy"], brief: "One usable 30-minute LIVE run-of-show with timed opening, source-backed explanation, 3 discussion questions with factual talking points, audience Q&A and closing CTA. Include written opening and closing, not just topic names. Unknown questions must be referred back for verification. Include a publishable promotional post in content and meta.promoCopy; meta.segments with time/topic/hostScript. Proposed running time is a production suggestion, not a source fact." },
  faq: { count: 1, minLength: 300, notes: ["questions"], brief: "One FAQ with 5-8 complete question-and-answer pairs specific to the source. Each answer must actually answer the question using available facts; if unknown, state that the source does not specify. Include all Q&A in content and meta.questions as question/answer objects. Do not repeat 'read the article' as every answer. Finish with source CTA." }
};

/**
 * The one canonical asset type per platform, used by the AI normalisation and kept in sync with the
 * offline template by the test suite. The model cannot know this taxonomy, so its guess is never
 * trusted: without this, a voiceover copy got labelled "video script" again.
 */
export const ASSET_TYPES: Record<Platform, string> = {
  website: "seo_package",
  facebook: "short_post",
  threads: "discussion_thread",
  linkedin: "professional_insight",
  x: "short_post",
  instagram: "carousel",
  short_video: "voiceover_copy",
  community: "poll",
  push: "push_notification",
  kol_live: "live_outline",
  faq: "faq_set"
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
  if (asset.platform === "short_video") {
    const seconds = Number(/(\d+)/.exec(String(asset.meta?.duration || ""))?.[1]);
    if (Number.isFinite(seconds) && (seconds < 40 || seconds > 70)) issues.push("Short video should target a 40-70 second runtime");
  }
  if (asset.platform === "push" && (String(asset.meta?.pushTitle || "").length > 40 || String(asset.meta?.pushBody || "").length > 100)) issues.push("Push copy exceeds the starter character budget");
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
