import { NextRequest, NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { listDraftSubmissions } from "@/lib/draft-submissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  const parameters = request.nextUrl.searchParams;
  const ids = parameters.get("ids")?.split(",").filter(Boolean);
  const sourceIds = parameters.get("sourceIds")?.split(",").filter(Boolean);
  const projectId = parameters.get("projectId") || undefined;
  const identifiers = ids || sourceIds;
  if (!identifiers?.length || identifiers.length > 64 || (ids && sourceIds)
    || identifiers.some(value => !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
    || (projectId && !/^[a-f0-9-]{36}$/i.test(projectId))) {
    return NextResponse.json({ error: "Invalid task query." }, { status: 400 });
  }
  try {
    const tasks = await listDraftSubmissions(auth.user.id, { ids, sourceIds, projectId });
    return NextResponse.json({ tasks }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Draft storage is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
