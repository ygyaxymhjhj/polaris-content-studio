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
  // Topic hints, not a claim that the article or broker is fraudulent.
  if (/\bforex\b|ngoại hối|外[汇匯]/i.test(text)) return "Forex";
  if (/\bgold\b|\bvàng\b|黄金|黃金/i.test(text)) return "Gold";
  if (/\bbroker\b|nhà môi giới|sàn giao dịch|交易商|券商/i.test(text)) return "Broker";
  return "";
}

const defaults = {
  en: { audience: "Readers interested in this article’s topic", cta: "Read the full article" },
  zh: { audience: "关注本文主题的读者", cta: "阅读完整文章" },
  vi: { audience: "Độc giả quan tâm đến chủ đề của bài viết", cta: "Đọc toàn bộ bài viết" }
};

/** Preserve editor overrides; replace previous automatic values on every import. */
export function alignSourceConfig(current: ProjectConfig, source: ImportedSource, edited: ReadonlySet<keyof ProjectConfig>): ProjectConfig {
  const title = source.title?.trim() || source.text.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 160) || "";
  const language = edited.has("language") ? current.language : detectSourceLanguage(source);
  const category = categoryFor(title) || categoryFor(source.text.slice(0, 1500));
  const suggestions: Partial<ProjectConfig> = {
    name: title,
    title,
    category,
    language,
    ...defaults[language],
    websiteUrl: source.canonical || source.sourceUrl || ""
  };
  const result = { ...current, sourceUrl: source.sourceUrl || "" };
  for (const key of Object.keys(suggestions) as (keyof ProjectConfig)[]) {
    if (!edited.has(key)) Object.assign(result, { [key]: suggestions[key] });
  }
  return result;
}
