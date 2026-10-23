import { NextRequest, NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { isSameOrigin } from "@/lib/same-origin";
import { cancelVideoProcessingJob, getVideoProcessingJob } from "@/lib/video-processing";
import { isVideoMediaId } from "@/lib/video-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ jobId: string }> };

async function readOrCancel(request: NextRequest, context: Context, cancel: boolean) {
  if (cancel && !isSameOrigin(request)) return json({ error: "Same-origin request required.", code: "FORBIDDEN" }, 403);
  try {
    const auth = await currentUser();
    if (!auth) return unauthorized();
    const { jobId } = await context.params;
    if (!isVideoMediaId(jobId)) return json({ error: "Video processing job not found.", code: "NOT_FOUND" }, 404);
    const operation = cancel ? cancelVideoProcessingJob : getVideoProcessingJob;
    const job = await operation(auth.user.id, jobId.toLowerCase(), request.signal);
    if (!job) return json({ error: "Video processing job not found.", code: "NOT_FOUND" }, 404);
    return json({ job });
  } catch {
    return json({ error: "Video processing storage is unavailable. Try again shortly.", code: "STORAGE_UNAVAILABLE" }, 503);
  }
}

export function GET(request: NextRequest, context: Context) { return readOrCancel(request, context, false); }
export function DELETE(request: NextRequest, context: Context) { return readOrCancel(request, context, true); }
