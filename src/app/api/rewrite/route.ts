import { rewriteAsset } from "@/lib/ai";
import { ContentAsset, MAX_TURNS, PLATFORM_META, ProjectConfig, RewriteMessage, SourceAnalysis } from "@/lib/types";
import { NextResponse } from "next/server";

const MAX_CANDIDATES = 3;

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      config?: ProjectConfig;
      analysis?: SourceAnalysis;
      asset?: ContentAsset;
      turns?: RewriteMessage[];
      instruction?: string;
      count?: number;
    };
    if (!body.config || !body.analysis?.facts?.length || !body.asset) {
      return NextResponse.json({ error: "A reviewed source analysis and an existing asset are required" }, { status: 400 });
    }
    if (!Object.hasOwn(PLATFORM_META, body.asset.platform)) {
      return NextResponse.json({ error: "This asset has an unknown platform" }, { status: 400 });
    }
    const instruction = String(body.instruction || "").trim();
    if (!instruction) {
      return NextResponse.json({ error: "A revision instruction is required" }, { status: 400 });
    }
    if (!process.env.AI_API_KEY) {
      return NextResponse.json({ error: "No AI provider is configured, so this asset cannot be rewritten" }, { status: 503 });
    }
    const facts = body.analysis.facts.filter(fact => fact.verified && fact.usableOnSocial);
    if (!facts.length) {
      return NextResponse.json({ error: "Confirm at least one fact usable on social before rewriting" }, { status: 400 });
    }

    const count = Math.min(MAX_CANDIDATES, Math.max(1, Number(body.count) || 2));
    const turns = Array.isArray(body.turns) ? body.turns.slice(-MAX_TURNS) : [];
    const result = await rewriteAsset(body.config, { ...body.analysis, facts }, body.asset, turns, instruction, count);
    if (!result.candidates.length) {
      const error = result.reason
        || (result.rejected ? `The model returned ${result.rejected} option(s), but none matched the ${body.asset.platform} format. Try again.` : "");
      return NextResponse.json({ error: error || "The model returned no usable revision. Try again or rephrase the instruction." }, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Rewrite failed" }, { status: 500 });
  }
}
