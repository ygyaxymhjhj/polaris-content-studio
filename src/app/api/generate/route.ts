import { fallbackAssets, generateWithAI } from "@/lib/ai";
import { FactItem, PLATFORM_META, Platform, ProjectConfig, SourceAnalysis } from "@/lib/types";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  let body: { config: ProjectConfig; analysis: SourceAnalysis; platforms: Platform[] } | null = null;
  try {
    body = await request.json() as { config: ProjectConfig; analysis: SourceAnalysis; platforms: Platform[] };
    if (!body.config || !body.analysis?.facts?.length) {
      return NextResponse.json({ error: "A reviewed source analysis is required" }, { status: 400 });
    }
    if (!Array.isArray(body.platforms) || !body.platforms.length || body.platforms.some(platform => !Object.hasOwn(PLATFORM_META, platform))) {
      return NextResponse.json({ error: "Select valid platforms before generation" }, { status: 400 });
    }
    const facts = (body.analysis.facts as FactItem[]).filter(fact => fact.verified && fact.usableOnSocial);
    if (!facts.length) return NextResponse.json({ error: "Confirm at least one fact usable on social before generating" }, { status: 400 });
    const analysis = { ...body.analysis, facts };
    const result = await generateWithAI(body.config, analysis, body.platforms || []);
    return NextResponse.json(result);
  } catch (error) {
    if (body?.config && body.analysis) {
      return NextResponse.json(fallbackAssets(body.config, body.analysis, body.platforms || []));
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Generation failed" }, { status: 500 });
  }
}
