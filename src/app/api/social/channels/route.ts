import { NextResponse } from "next/server";
import { fetchPostizIntegrations, getPostizUiUrl, isPostizOAuthConfigured } from "@/lib/postiz";
import { currentUser, unauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  const result = await fetchPostizIntegrations();
  return NextResponse.json({ ...result, uiUrl: getPostizUiUrl(), oauthConfigured: isPostizOAuthConfigured() }, {
    headers: { "Cache-Control": "no-store" }
  });
}
