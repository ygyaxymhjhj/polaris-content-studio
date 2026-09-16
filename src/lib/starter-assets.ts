import { ASSET_SPECS } from "./asset-specs";
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
  const rawTitle = config.title;
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
      title: l("Title", "标题", "Tiêu đề"), body: l("Body", "正文", "Nội dung"), caption: l("Posting caption", "发布配文", "Chú thích bài đăng"),
      visual: l("Suggested production: neutral editorial fact cards. No fabricated screenshots, testimony or performance charts.", "制作建议：中性的编辑事实卡片，不制作虚假截图、证言或收益图。", "Gợi ý sản xuất: thẻ thông tin trung lập. Không dựng ảnh chụp, lời chứng hay biểu đồ lợi nhuận giả."),
      fallback: l("Local starter draft: source excerpts remain in their original language. Review completeness, language and attribution before publication.", "本地初稿：事实摘录保留原文语言。发布前请检查完整性、语言和归因。", "Bản nháp cục bộ: trích đoạn giữ nguyên ngôn ngữ nguồn. Kiểm tra độ đầy đủ, ngôn ngữ và quy thuộc trước khi đăng.")
    };
    const cta = [config.cta || l("Read the full article", "阅读完整文章", "Đọc toàn bộ bài viết"), url].filter(Boolean).join("\n");
    const options = [label.context, label.details, label.limits, l("Another question (comment below)", "其他问题（请留言）", "Câu hỏi khác (bình luận bên dưới)")];
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
    for (let variant = 0; variant < ASSET_SPECS[platform].count; variant++) {
      const ordered = variant === 1 ? [...texts].reverse() : texts;
      const blocks = ordered.join("\n\n");
      let content = "";
      let meta: Record<string, unknown> = { visualBrief: label.visual };
      let assetType = "content_asset";
      switch (platform) {
        case "facebook":
          assetType = "short_post";
          content = [variant ? label.question : title, label.context, blocks, label.caution, variant ? title : label.question, cta].join("\n\n");
          meta = { visualBrief: label.visual, imageText: title, firstComment: [label.caution, cta].join("\n\n") };
          break;
        case "website":
          assetType = "seo_package";
          content = `# ${title}\n\n## ${label.context}\n\n${texts[0]}\n\n## ${label.details}\n\n${texts.slice(1).join("\n\n") || label.unknown}\n\n## ${label.limits}\n\n${label.caution}\n\n${cta}`;
          meta = { seoTitle: rawTitle, metaDescription: texts[0].slice(0, 160), slug: title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, ""), keyTerms: analysis.keyTerms };
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
        case "short_video": {
          assetType = "video_script";
          const times = ["0–3s", "3–15s", "15–35s", "35–52s", "52–60s"];
          const narration = [title, texts[0], texts.slice(1).join("\n") || label.unknown, label.caution, cta];
          const shots = times.map((time, i) => ({ time, narration: narration[i], onScreen: i === 0 ? title : i === times.length - 1 ? config.cta : label.context, visual: label.visual }));
          // The caption stays a single sentence, as required by the platform voice rules.
          const caption = title;
          content = shots.map(s => `${s.time}\n${l("Narration", "口播", "Lời đọc")}: ${s.narration}\n${l("On-screen text", "屏幕文字", "Chữ trên màn hình")}: ${s.onScreen}\n${s.visual}`).join("\n\n") + `\n\n${label.caption}\n${caption}`;
          meta = { duration: "40-70s", shots, caption, timingNote: l("Suggested timings; read aloud and shorten before recording.", "时间为制作建议，录制前请试读并精简。", "Thời lượng gợi ý; đọc thử và rút gọn trước khi quay.") };
          break;
        }
        case "community":
          assetType = "poll";
          content = [title, all, label.question, options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n"), `${l("Pinned reply", "置顶回复", "Phản hồi ghim")}\n${label.caution}\n${cta}`].join("\n\n");
          meta = { options, pinnedReply: `${label.caution}\n${cta}` };
          break;
        case "push": {
          assetType = "push_notification";
          const pushTitle = [l("Article update", "文章更新", "Cập nhật bài viết"), l("Want more context?", "想了解完整背景？", "Bạn muốn hiểu rõ hơn?"), l("Read the source", "阅读原文", "Đọc bài viết nguồn")][variant];
          const pushBody = title.length <= 100 ? title : l("Read the full article for details and context.", "阅读完整文章，了解详细信息与背景。", "Đọc toàn bộ bài viết để xem chi tiết và bối cảnh.");
          content = `${label.title}: ${pushTitle}\n${label.body}: ${pushBody}`;
          meta = { pushTitle, pushBody, audience: config.audience, sendWindow: l("Proposed: editor to select local time", "建议：由编辑选择当地时间", "Đề xuất: biên tập viên chọn giờ địa phương"), frequency: l("Proposed: at most one notification for this article, subject to approval", "建议：本文最多一条通知，需审批", "Đề xuất: tối đa một thông báo cho bài này, cần phê duyệt") };
          break;
        }
        case "kol_live": {
          assetType = "live_outline";
          const segments = [
            { time: "0–3 min", topic: label.title, hostScript: `${title}\n${label.caution}` },
            { time: "3–12 min", topic: label.context, hostScript: all },
            { time: "12–22 min", topic: label.details, hostScript: options.slice(0, 3).map((q, i) => `${q}?\n${texts[i] || label.unknown}`).join("\n\n") },
            { time: "22–28 min", topic: label.question, hostScript: `${label.question}\n${label.unknown}` },
            { time: "28–30 min", topic: label.limits, hostScript: `${label.caution}\n${cta}` }
          ];
          const promoCopy = [title, texts[0], label.question, cta].join("\n\n");
          content = segments.map(s => `${s.time} — ${s.topic}\n${s.hostScript}`).join("\n\n") + `\n\n${label.caption}\n${promoCopy}`;
          meta = { segments, promoCopy, duration: "30 min" };
          break;
        }
        case "faq": {
          assetType = "faq_set";
          const questions = [
            { question: l("What does the article cover?", "这篇文章讲了什么？", "Bài viết đề cập điều gì?"), answer: `${title}\n${texts[0]}` },
            { question: l("What details are available?", "原文提供了哪些细节？", "Bài viết cung cấp chi tiết nào?"), answer: texts.slice(1).join("\n\n") || label.unknown },
            { question: l("Has this been independently verified here?", "这些信息在此独立核实了吗？", "Thông tin đã được xác minh độc lập tại đây chưa?"), answer: label.caution },
            { question: l("What if my question is not covered?", "原文未解答的问题怎么办？", "Nếu bài viết chưa giải đáp câu hỏi của tôi thì sao?"), answer: label.unknown },
            { question: l("Where can I read the context?", "在哪里查看完整背景？", "Tôi có thể đọc bối cảnh đầy đủ ở đâu?"), answer: url || label.unknown }
          ];
          content = questions.map((q, i) => `${i + 1}. ${q.question}\n${q.answer}`).join("\n\n");
          meta = { questions };
          break;
        }
      }
      assets.push({ id: `local-${platform}-${variant + 1}`, platform, assetType, title: `${title} · ${variant + 1}`, variant: String.fromCharCode(65 + variant), content, cta: config.cta, ...(url && platform === "push" ? { deepLink: url } : {}), factIds: facts.map(f => f.id), riskFlags: [label.fallback, ...(languageWarning ? [languageWarning] : [])], status: "needs_review", updatedAt: new Date().toISOString(), meta, generationMode: "local" });
    }
  }
  return { assets, usedFallback: true };
}
