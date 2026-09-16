import type { ImportedSource } from "./source-config";

/** Browser messages are untrusted: accept only plain article fields, never HTML or credentials. */
export function validateBrowserArticle(value: unknown): ImportedSource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.text !== "string" || source.text.trim().length < 80 || source.text.length > 120000) return null;
  if (typeof source.title !== "string" || source.title.length > 500) return null;
  if (typeof source.sourceUrl !== "string" || source.sourceUrl.length > 2048) return null;
  try {
    const url = new URL(source.sourceUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return { title: source.title.trim(), text: source.text.trim(), sourceUrl: url.href, canonical: url.href };
  } catch { return null; }
}
