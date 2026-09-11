import { askModel, fallbackAnalysis } from "@/lib/ai";
import { NextResponse } from "next/server";
import { SourceAnalysis } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const article = String(body.article || "").trim();
    const title = String(body.title || "Untitled article");
    if (!article) return NextResponse.json({ error: "Article content is required" }, { status: 400 });

    const fallback = fallbackAnalysis(article, title);
    const result = await askModel<SourceAnalysis>(
      "You are a source verification editor. Return JSON only. Extract only facts explicitly present in the article. Keep source excerpts exact. Flag legal, financial, regulatory, broker, scam, and investment-related claims as high risk.",
      `Analyze this article and return: summaryShort, summaryLong, keyTerms, riskFlags, and facts. Each fact needs id (F001...), type (claim|number|date|entity|quote), text, sourceExcerpt, sourceLocation, verified false, usableOnSocial true, riskLevel (low|medium|high).\n\nTITLE: ${title}\nARTICLE:\n${article}`
    );
    return NextResponse.json(result || fallback);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Analysis failed" }, { status: 500 });
  }
}
