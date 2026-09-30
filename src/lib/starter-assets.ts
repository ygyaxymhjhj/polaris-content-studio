import { channelVoice } from "./social-guidelines";
import { dominantSourceLanguage } from "./source-config";
import { PLATFORM_META } from "./types";
import type { ContentAsset, GenerateResponse, Platform, ProjectConfig, SourceAnalysis } from "./types";

/**
 * Column-name prefixes found on finance news headlines — the same forms the import classifier
 * recognises as market news. They belong to the source, not to the draft: opening a post with
 * "财经快讯：" would read like the app runs its own news column. Longer labels come first so a
 * multi-word name such as "Bản tin tài chính" is stripped whole instead of leaving "tài chính".
 */
const COLUMN_LABEL = /^(?:(?:财经|金融|市场)\s*(?:快讯|早报|晚报|日报|新闻|资讯|简讯)|財經(?:新聞|資訊|快訊)|金融市场综述|(?:bản tin|tin tức|điểm tin)\s*tài chính|bản tin|tin nhanh|điểm tin|financial news(?:\s+roundup|\s+digest)?|market roundup|daily digest|news flash)[：:\s|｜\-–—]*/iu;

/** Headline without its source column label; a label-only title keeps its original wording. */
function stripColumnLabel(value: string): string {
  const stripped = value.replace(COLUMN_LABEL, "").trim();
  return stripped || value;
}

/** Offline drafts use exact reviewed source text; they cannot translate or add facts. */
export function starterAssets(config: ProjectConfig, analysis: SourceAnalysis, platforms: Platform[]): GenerateResponse {
  const facts = analysis.facts.filter(f => f.verified && f.usableOnSocial);
  const url = config.websiteUrl || config.sourceUrl;
  const title = stripColumnLabel(config.title);
  const texts = facts.map(f => f.text);
  const all = texts.join("\n\n");
  const assets: ContentAsset[] = [];
  if (!facts.length) return { assets, usedFallback: true };
  for (const platform of platforms) {
    // "Prompt Social.md" fixes some channels to a single output language, so everything written
    // around the quoted source text uses the language this channel actually publishes in.
    const { language, fixed } = channelVoice(platform, config.language);
    const l = (en: string, zh: string, vi: string) => language === "zh" ? zh : language === "vi" ? vi : en;
    const label = {
      context: l("What the source says", "原文信息", "Thông tin từ bài viết"),
      details: l("Key details", "关键细节", "Chi tiết chính"),
      limits: l("Scope and limitations", "信息范围与限制", "Phạm vi và giới hạn"),
      caution: l("These points reflect the source article, not independent verification or investment advice. Please check the original context.", "以上内容依据原文整理，并非独立核实结果或投资建议，请结合原文语境阅读。", "Các thông tin này được tổng hợp từ bài viết, không phải kết quả xác minh độc lập hay lời khuyên đầu tư. Vui lòng đọc trong ngữ cảnh gốc."),
      question: l("Which detail would you like us to explain further?", "你希望进一步了解哪一项细节？", "Bạn muốn tìm hiểu thêm chi tiết nào?"),
      unknown: l("The reviewed source does not provide further details.", "已审核来源未提供更多细节。", "Nguồn đã duyệt không cung cấp thêm chi tiết."),
      caption: l("Posting caption", "发布配文", "Chú thích bài đăng"),
      visual: l("Suggested production: neutral editorial fact cards. No fabricated screenshots, testimony or performance charts.", "制作建议：中性的编辑事实卡片，不制作虚假截图、证言或收益图。", "Gợi ý sản xuất: thẻ thông tin trung lập. Không dựng ảnh chụp, lời chứng hay biểu đồ lợi nhuận giả."),
      fallback: l("Local starter draft: source excerpts remain in their original language. Review completeness, language and attribution before publication.", "本地初稿：事实摘录保留原文语言。发布前请检查完整性、语言和归因。", "Bản nháp cục bộ: trích đoạn giữ nguyên ngôn ngữ nguồn. Kiểm tra độ đầy đủ, ngôn ngữ và quy thuộc trước khi đăng.")
    };
    const cta = [config.cta || l("Read the full article", "阅读完整文章", "Đọc toàn bộ bài viết"), url].filter(Boolean).join("\n");
    // This template copies reviewed source text verbatim and cannot translate it, so anything left in
    // another language has to be named. The quoted text and the short fields are tested separately: a
    // Vietnamese title or CTA inside an otherwise English draft would be diluted away by a single
    // measurement over the whole draft, and the draft would look ready to publish.
    const sourceLanguage = dominantSourceLanguage(all);
    const mismatched = [
      sourceLanguage !== language ? `the quoted facts (${sourceLanguage})` : "",
      title && dominantSourceLanguage(title) !== language ? "the title" : "",
      config.cta && dominantSourceLanguage(config.cta) !== language ? "the call to action" : ""
    ].filter(Boolean);
    // Only a fixed channel has a publishing rule of its own; everywhere else this is the project
    // setting, and calling it a platform rule would misstate why the copy has to change.
    const languageRule = fixed ? `${PLATFORM_META[platform].label} publishes in ${language} only` : `The project output language is ${language}`;
    const mismatchedList = mismatched.length > 1 ? `${mismatched.slice(0, -1).join(", ")} and ${mismatched.at(-1)}` : mismatched[0] || "";
    const languageWarning = mismatchedList
      ? `${languageRule}. The offline template cannot translate, so ${mismatchedList} must be rewritten in ${language} before publishing.`
      : "";
    let content = "";
    let meta: Record<string, unknown> = { visualBrief: label.visual };
    let assetType = "content_asset";
    switch (platform) {
      case "facebook":
        assetType = "short_post";
        // One short post per the platform rules: the headline states the point first and the
        // reviewed source text follows. The template adds no forced question or wrap-up of its own.
        content = [title, label.context, all, label.caution, cta].join("\n\n");
        meta = { visualBrief: label.visual, imageText: title, firstComment: [label.caution, cta].join("\n\n") };
        break;
      case "linkedin":
        assetType = "professional_insight";
        content = [title, label.context, all, label.caution, label.question, cta].join("\n\n");
        break;
      case "threads": {
        assetType = "discussion_thread";
        const opening = title;
        const body = all;
        content = [opening, body, label.caution, cta].join("\n\n");
        meta = { opening, body };
        break;
      }
      case "x": {
        assetType = "short_post";
        // Preserve exact statements even when over budget; flag rather than silently truncate facts.
        const post = [title, texts[0], cta].join("\n\n");
        content = post;
        meta = { post };
        break;
      }
      case "instagram": {
        assetType = "carousel";
        const slides = [
          { title, body: "" },
          { title: label.context, body: texts[0] },
          { title: label.details, body: texts[1] || label.unknown },
          { title: label.details, body: texts.slice(2).join("\n") || label.unknown },
          { title: label.limits, body: label.caution },
          { title: label.question, body: cta }
        ].map(s => ({ ...s, visualDirection: label.visual }));
        const caption = [title, label.caution, label.question, cta].join("\n\n");
        content = slides.map((s, i) => `${i + 1}/6 — ${s.title}\n${s.body}`).join("\n\n") + `\n\n${label.caption}\n${caption}`;
        meta = { slides, slideCount: 6, caption, visualBrief: label.visual };
        break;
      }
    }
    assets.push({ id: `local-${platform}`, platform, assetType, title, content, cta: config.cta, imageUrl: config.imageUrl || undefined, publishStatus: "unpublished", factIds: facts.map(f => f.id), riskFlags: [label.fallback, ...(languageWarning ? [languageWarning] : [])], status: "needs_review", updatedAt: new Date().toISOString(), meta, generationMode: "local" });
  }
  return { assets, usedFallback: true };
}
