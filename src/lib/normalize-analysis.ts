import type { FactItem, SourceAnalysis } from "./types";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown, max = 2000): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
function label(value: unknown): string {
  if (typeof value === "string") return text(value, 600);
  const object = record(value);
  for (const key of ["message", "description", "reason", "text", "term", "name", "label", "risk"]) {
    if (typeof object[key] === "string") return text(object[key], 600);
  }
  return "";
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return [...new Set(value.map(label).filter(Boolean))];
  return [...new Set(Object.entries(record(value)).flatMap(([key, entry]) => {
    const values = Array.isArray(entry) ? entry : [entry];
    return values.map(label).filter(Boolean).map(item => `${key}: ${item}`);
  }))];
}

/** Normalize both API and client boundaries. Model JSON is never assumed to match TS types. */
export function normalizeAnalysis(value: unknown, article: string, title: string): SourceAnalysis {
  const data = record(value);
  const rows = Array.isArray(data.facts) ? data.facts : [];
  const types = new Set(["claim", "number", "date", "entity", "quote"]);
  const levels = new Set(["low", "medium", "high"]);
  const flags = strings(data.riskFlags);
  const seen = new Set<string>();
  const facts: FactItem[] = [];
  const source = normalized(article);
  for (const row of rows) {
    const fact = record(row);
    const content = text(fact.text);
    if (!content || seen.has(normalized(content))) continue;
    seen.add(normalized(content));
    const excerpt = text(fact.sourceExcerpt);
    const supported = Boolean(excerpt && source.includes(normalized(excerpt)));
    const id = `F${String(facts.length + 1).padStart(3, "0")}`;
    if (!supported) flags.push(`${id}: Source excerpt is missing or does not match the article; excluded from social output until reviewed.`);
    facts.push({
      id,
      type: types.has(String(fact.type)) ? fact.type as FactItem["type"] : "claim",
      text: content,
      sourceExcerpt: excerpt,
      sourceLocation: text(fact.sourceLocation, 300) || "Source article",
      verified: false,
      usableOnSocial: supported && fact.usableOnSocial !== false,
      riskLevel: !supported || !levels.has(String(fact.riskLevel)) ? "high" : fact.riskLevel as FactItem["riskLevel"]
    });
  }
  if (!facts.length) throw new Error("AI returned no usable facts. Please retry analysis; your article has been kept.");
  return {
    summaryShort: text(data.summaryShort, 500) || title,
    summaryLong: text(data.summaryLong, 4000) || text(data.summaryShort, 1000) || title,
    keyTerms: strings(data.keyTerms).slice(0, 40),
    riskFlags: [...new Set(flags)],
    facts
  };
}

export function analysisChunks(article: string, limit = 2200): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of article.split(/\n\s*\n/).filter(Boolean)) {
    if (current && current.length + paragraph.length + 2 > limit) { chunks.push(current); current = ""; }
    let remaining = paragraph;
    while (remaining.length > limit) {
      let end = remaining.lastIndexOf(" ", limit);
      if (end < limit / 2) end = limit;
      chunks.push(remaining.slice(0, end));
      remaining = remaining.slice(end).trimStart();
    }
    current = current ? `${current}\n\n${remaining}` : remaining;
  }
  if (current) chunks.push(current);
  return chunks;
}
