import { NextRequest, NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { getTrustedPostizMediaUrl } from "@/lib/postiz";
import { isVideoMediaId } from "@/lib/video-types";
import { getVideoUpload } from "@/lib/video-uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const failure = (error: string, code: string, status: number) =>
  NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(_request: NextRequest, context: { params: Promise<{ mediaId: string }> }) {
  if (!databaseConfigured()) return failure("Video storage is unavailable.", "STORAGE_UNAVAILABLE", 503);
  try {
    const auth = await currentUser();
    if (!auth) return unauthorized();
    const { mediaId } = await context.params;
    if (!isVideoMediaId(mediaId)) return failure("Video not found.", "NOT_FOUND", 404);
    // Administrators do not bypass media ownership. The URL is never accepted from query parameters.
    const video = await getVideoUpload(auth.user.id, mediaId.toLowerCase());
    if (!video) return failure("Video not found.", "NOT_FOUND", 404);
    const response = NextResponse.redirect(getTrustedPostizMediaUrl(video.postizPath), 307);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return failure("Video preview is unavailable. Ask an administrator to check storage and the trusted media origin.", "PREVIEW_UNAVAILABLE", 503);
  }
}
