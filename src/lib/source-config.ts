import type { ProjectConfig } from "./types";

export interface ImportedSource {
  text: string;
  title?: string;
  sourceUrl?: string;
  canonical?: string;
}

export function detectSourceLanguage(source: ImportedSource): ProjectConfig["language"] {
  const text = `${source.title || ""}\n${source.text.slice(0, 4000)}`;
  if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) return "vi";
  if (/[\u3400-\u9fff]/u.test(text)) return "zh";
  try {
    const path = new URL(source.sourceUrl || source.canonical || "").pathname;
    if (/^\/vi\//i.test(path)) return "vi";
    if (/^\/(zh|zh-cn|zh-tw|cn)\//i.test(path)) return "zh";
  } catch { /* Text imports do not have a URL. */ }
  return "en";
}

function categoryFor(text: string): string {
  // Classify the stated headline topic before considering incidental body mentions.
  // These are editorial suggestions, never an assertion about readers or broker safety.
  if (/bản tin tài chính|tin tức tài chính|điểm tin tài chính|financial (?:news|roundup|digest)|market roundup|财经(?:早报|晚报|新闻|资讯|快讯)|財經(?:新聞|資訊|快訊)|金融市场综述/i.test(text)) return "Market news";
  if (/\b(?:brent|wti|crude oil|commodities)\b|dầu (?:brent|thô)|hàng hóa|原油|大宗商品|布伦特|布蘭特/i.test(text)) return "Commodities";
  if (/\bforex\b|ngoại hối|外[汇匯]/i.test(text)) return "Forex";
  if (/\bgold\b|\bvàng\b|黄金|黃金/i.test(text)) return "Gold";
  if (/\bbroker\b|nhà môi giới|sàn giao dịch|交易商|券商/i.test(text)) return "Broker";
  return "";
}

const audiences: Record<string, Record<ProjectConfig["language"], string>> = {
  "Market news": { zh: "关注财经要闻与全球市场动态的读者", vi: "Độc giả theo dõi tin tài chính và diễn biến thị trường toàn cầu", en: "Readers following financial news and global market developments" },
  Commodities: { zh: "关注原油及大宗商品市场的读者", vi: "Độc giả quan tâm đến dầu thô và thị trường hàng hóa", en: "Readers following crude oil and commodity markets" },
  Gold: { zh: "关注黄金市场与相关政策的读者", vi: "Độc giả quan tâm đến thị trường vàng và chính sách liên quan", en: "Readers following gold markets and related policy" },
  Forex: { zh: "关注外汇市场与交易行业动态的读者", vi: "Độc giả theo dõi thị trường ngoại hối và ngành giao dịch", en: "Readers following foreign exchange markets and the trading industry" },
  Broker: { zh: "关注交易商服务、监管与运营信息的读者", vi: "Độc giả quan tâm đến dịch vụ, quản lý và hoạt động của nhà môi giới", en: "Readers following broker services, regulation and operations" }
};

const defaults = {
  en: { audience: "Readers interested in this article’s topic", cta: "Read the full article" },
  zh: { audience: "关注本文主题的读者", cta: "阅读完整文章" },
  vi: { audience: "Độc giả quan tâm đến chủ đề của bài viết", cta: "Đọc toàn bộ bài viết" }
};

/** Preserve editor overrides; replace previous automatic values on every import. */
export function alignSourceConfig(current: ProjectConfig, source: ImportedSource, edited: ReadonlySet<keyof ProjectConfig>): ProjectConfig {
  const title = source.title?.trim() || source.text.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 160) || "";
  const language = edited.has("language") ? current.language : detectSourceLanguage(source);
  const category = edited.has("category") ? current.category : categoryFor(title) || categoryFor(source.text.slice(0, 1500));
  const suggestions: Partial<ProjectConfig> = {
    name: title,
    title,
    category,
    language,
    ...defaults[language],
    audience: audiences[category]?.[language] || defaults[language].audience,
    websiteUrl: source.canonical || source.sourceUrl || ""
  };
  const result = { ...current, sourceUrl: source.sourceUrl || "" };
  for (const key of Object.keys(suggestions) as (keyof ProjectConfig)[]) {
    if (!edited.has(key)) Object.assign(result, { [key]: suggestions[key] });
  }
  return result;
}
