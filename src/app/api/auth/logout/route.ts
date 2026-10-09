import { NextRequest, NextResponse } from "next/server";
import { destroySession, legacyOwnerCookie, sessionCookie, sessionCookieOptions } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { isSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Same-origin request required" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  // Drop the server-side row too, so the token is dead even if the cookie outlives it.
  if (databaseConfigured()) await destroySession(request.cookies.get(sessionCookie)?.value);

  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(sessionCookie, "", { ...sessionCookieOptions(request.nextUrl.protocol === "https:"), maxAge: 0 });
  response.cookies.delete(legacyOwnerCookie);
  return response;
}
