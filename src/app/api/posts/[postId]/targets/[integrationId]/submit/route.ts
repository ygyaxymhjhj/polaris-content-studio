import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { isSameOrigin } from "@/lib/same-origin";
import { submitPostTarget } from "@/lib/post-submission";
import { readBoundedJson } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const failure = (message: string, status: number, code?: string) => NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
const postIdPattern = /^[a-f0-9-]{36}$/i;
const integrationIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const submitSchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483646),
  expectedAuditId: z.string().uuid().optional()
}).strict();

/**
 * Submits (or retries) one account of a manual post. A rejected retry also binds the current audit:
 * the content and image always come from the saved row, so a race between two tabs can never hand
 * Postiz text the owner has not seen.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ postId: string; integrationId: string }> }) {
  if (!isSameOrigin(request)) return failure("Same-origin request required.", 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return failure("Posts storage is unavailable.", 503, "STORAGE_UNAVAILABLE");

  const { postId, integrationId } = await context.params;
  if (!postIdPattern.test(postId)) return failure("Invalid post identifier.", 400, "INVALID");
  if (!integrationIdPattern.test(integrationId)) return failure("Invalid account identifier.", 400, "INVALID");

  const body = await readBoundedJson(request, 4096);
  if (!body.ok) return failure("Invalid submission request body.", 400, "INVALID");
  const parsed = submitSchema.safeParse(body.value);
  if (!parsed.success) return failure("Invalid submission request body.", 400, "INVALID");

  try {
    const outcome = await submitPostTarget({
      userId: auth.user.id,
      userName: auth.user.displayName,
      isAdmin: auth.user.role === "admin",
      postId,
      integrationId,
      expectedVersion: parsed.data.expectedVersion,
      expectedAuditId: parsed.data.expectedAuditId
    });
    switch (outcome.kind) {
      case "ok":
        return NextResponse.json({ post: outcome.post }, { headers: { "Cache-Control": "no-store" } });
      case "not_found":
        return failure("Post not found.", 404, "NOT_FOUND");
      case "target_missing":
        return failure("That account is not a target of this post. Save the account selection first.", 404, "TARGET_MISSING");
      case "conflict":
        return failure("This post changed in another tab. Reload it before submitting.", 409, "CONFLICT");
      case "in_flight":
        return failure("A submission for this account is already running. Wait for it to finish.", 409, "IN_FLIGHT");
      case "unconfirmed":
        return failure("The previous attempt's result is unknown. Check Postiz before submitting again.", 409, "UNCONFIRMED");
      case "validation":
        return failure(outcome.message, 400, "VALIDATION");
      case "forbidden":
        return failure(outcome.message, 403, "FORBIDDEN");
      case "postiz_unavailable":
        return failure(outcome.message, 502, "POSTIZ_UNAVAILABLE");
      default:
        return failure("Unexpected submission state.", 500, "INVALID");
    }
  } catch (error) {
    console.error("[posts] submit failed", error);
    return failure("The submission failed before Postiz answered. Check the account result before trying again.", 503, "SUBMIT_FAILED");
  }
}
