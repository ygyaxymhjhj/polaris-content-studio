import { NextRequest, NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { isSameOrigin } from "@/lib/same-origin";
import { duplicateManualPost } from "@/lib/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const postIdPattern = /^[a-f0-9-]{36}$/i;

/**
 * Copy for a new draft. Only the text and image travel: targets, Postiz ids and audit ids are
 * deliberately dropped so the copy can be checked and resubmitted on its own.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ postId: string }> }) {
  if (!isSameOrigin(request)) return json({ error: "Same-origin request required." }, 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return json({ error: "Posts storage is unavailable.", code: "STORAGE_UNAVAILABLE" }, 503);
  const { postId } = await context.params;
  if (!postIdPattern.test(postId)) return json({ error: "Invalid post identifier." }, 400);
  try {
    const post = await duplicateManualPost(auth.user.id, postId);
    if (!post) return json({ error: "Post not found." }, 404);
    return json({ post }, 201);
  } catch (error) {
    console.error("[posts] duplicate failed", error);
    return json({ error: "The post could not be copied. Try again.", code: "STORAGE_UNAVAILABLE" }, 503);
  }
}
