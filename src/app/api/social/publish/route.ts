import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { isSameOrigin } from "@/lib/same-origin";
import { readBoundedJson } from "@/lib/request-body";
import { MAX_IMAGE_DATA_URL_LENGTH } from "@/lib/image-upload";
import { enqueueAssetSubmission } from "@/lib/draft-submissions";
import { wakeDraftSubmissionWorker } from "@/lib/draft-submission-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({
  assetId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  integrationId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  content: z.string().trim().min(1).max(20000),
  imageUrl: z.string().max(MAX_IMAGE_DATA_URL_LENGTH).optional(),
  projectId: z.string().uuid().optional(),
  platform: z.string().max(32).optional(),
  accountName: z.string().max(255).optional(),
  requestId: z.string().uuid(),
  expectedAuditId: z.string().uuid().optional(),
  publishAt: z.string().refine(value => !value || Number.isFinite(Date.parse(value))).optional()
}).strict();
const failure = (error: string, status: number, code: string) => NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return failure("Same-origin request required.", 403, "FORBIDDEN");
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return failure("Draft storage is unavailable.", 503, "STORAGE_UNAVAILABLE");
  const body = await readBoundedJson(request, MAX_IMAGE_DATA_URL_LENGTH + 100_000);
  if (!body.ok) return failure("Invalid submission request body.", 400, "INVALID");
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) return failure("Invalid submission request body.", 400, "INVALID");
  if (parsed.data.imageUrl && !/^(data:image\/(jpeg|png|webp);base64,|https?:\/\/)/i.test(parsed.data.imageUrl)) {
    return failure("Invalid post image.", 400, "INVALID");
  }
  try {
    const outcome = await enqueueAssetSubmission({ ...parsed.data, userId: auth.user.id, isAdmin: auth.user.role === "admin" });
    if (outcome.kind === "queued") {
      after(wakeDraftSubmissionWorker);
      return NextResponse.json({ accepted: true, task: outcome.task }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (outcome.kind === "forbidden") return failure(outcome.message, 403, "FORBIDDEN");
    if (outcome.kind === "validation") return failure(outcome.message, 400, "INVALID");
    return failure(outcome.kind === "unconfirmed" ? "The previous result is unknown. Check the publishing engine before submitting again."
      : "An existing submission or changed review binding prevents another submission. Refresh its status.", 409, outcome.kind.toUpperCase());
  } catch {
    return failure("Draft storage is unavailable. Check local submission status before trying again.", 503, "STORAGE_UNAVAILABLE");
  }
}
