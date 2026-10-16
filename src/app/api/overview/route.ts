import { NextRequest, NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { overviewSnapshot, sweepStaleSubmissions } from "@/lib/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const withinValues = { "24h": 86_400_000, "7d": 7 * 86_400_000 } as const;

/**
 * Manual-post overview for the signed-in user. Counts are always the full totals; the `within`
 * parameter only narrows the recent-activity window.
 */
export async function GET(request: NextRequest) {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) {
    return NextResponse.json(
      { enabled: false, generatedAt: new Date().toISOString(), counts: { total: 0, draft: 0, pushing: 0, pushed: 0, attention: 0 }, activity: [] },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  const within = request.nextUrl.searchParams.get("within") === "7d" ? "7d" : "24h";
  try {
    await sweepStaleSubmissions(auth.user.id);
    const snapshot = await overviewSnapshot(auth.user.id, withinValues[within]);
    return NextResponse.json(
      { enabled: true, generatedAt: new Date().toISOString(), ...snapshot },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[overview] failed", error);
    return NextResponse.json({ error: "The overview could not be loaded. Refresh and try again.", code: "STORAGE_UNAVAILABLE" }, { status: 503 });
  }
}
