import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { isSameOrigin } from "@/lib/same-origin";
import { deleteManualPost, getManualPost, PostMediaValidationError, sweepStaleSubmissions, updateManualPost } from "@/lib/posts";
import { validatePostImage } from "@/lib/post-media";
import { areImageMediaIds } from "@/lib/image-types";
import { listAccountOwners } from "@/lib/social-accounts";
import { readBoundedJson } from "@/lib/request-body";
import { MAX_POST_TARGETS, POST_CONTENT_MAX_LENGTH, POST_TITLE_MAX_LENGTH } from "@/lib/post-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const failure = (message: string, status: number, code?: string) => json({ error: message, ...(code ? { code } : {}) }, status);
const postIdPattern = /^[a-f0-9-]{36}$/i;
const MAX_POST_BODY_BYTES = 4 * 1024 * 1024;

const integrationIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const updateSchema = z.object({
  version: z.number().int().min(1).max(2147483646),
  title: z.string().max(POST_TITLE_MAX_LENGTH).optional(),
  content: z.string().max(POST_CONTENT_MAX_LENGTH).optional(),
  /** Omitted keeps the stored image, null removes it, a data URL replaces it. */
  imageDataUrl: z.string().max(3_000_000).nullable().optional(),
  videoMediaId: z.string().uuid().nullable().optional(),
  imageMediaIds: z.custom<string[]>(areImageMediaIds).optional(),
  imageName: z.string().max(POST_TITLE_MAX_LENGTH).optional(),
  integrationIds: z.array(z.string().regex(integrationIdPattern)).max(MAX_POST_TARGETS).optional()
}).strict().refine(value => value.imageMediaIds?.length
  ? !value.imageDataUrl && !value.videoMediaId
  : value.imageMediaIds !== undefined || !value.imageDataUrl || !value.videoMediaId);

async function readPostId(context: { params: Promise<{ postId: string }> }): Promise<string | null> {
  const { postId } = await context.params;
  return postIdPattern.test(postId) ? postId : null;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ postId: string }> }) {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return failure("Posts storage is unavailable.", 503, "STORAGE_UNAVAILABLE");
  const postId = await readPostId(context);
  if (!postId) return failure("Invalid post identifier.", 400, "INVALID");
  try {
    await sweepStaleSubmissions(auth.user.id);
    const post = await getManualPost(auth.user.id, postId);
    if (!post) return failure("Post not found.", 404, "NOT_FOUND");
    return json({ post });
  } catch (error) {
    console.error("[posts] read failed", error);
    return failure("Posts storage is unavailable. Refresh and try again.", 503, "STORAGE_UNAVAILABLE");
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ postId: string }> }) {
  if (!isSameOrigin(request)) return failure("Same-origin request required.", 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return failure("Posts storage is unavailable.", 503, "STORAGE_UNAVAILABLE");
  const postId = await readPostId(context);
  if (!postId) return failure("Invalid post identifier.", 400, "INVALID");

  const body = await readBoundedJson(request, MAX_POST_BODY_BYTES);
  if (!body.ok) {
    if (body.reason === "too_large") return failure("The post is too large. Use a smaller image.", 413, "TOO_LARGE");
    return failure("Invalid post request body.", 400, "INVALID");
  }
  const parsed = updateSchema.safeParse(body.value);
  if (!parsed.success) return failure("Invalid post request body.", 400, "INVALID");

  const patch: Parameters<typeof updateManualPost>[3] = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title.trim();
  if (parsed.data.content !== undefined) patch.content = parsed.data.content;
  if (parsed.data.videoMediaId !== undefined) patch.videoMediaId = parsed.data.videoMediaId;
  if (parsed.data.imageMediaIds !== undefined) {
    patch.imageMediaIds = parsed.data.imageMediaIds;
  } else if (parsed.data.imageDataUrl === null) {
    patch.image = { kind: "remove" };
  } else if (typeof parsed.data.imageDataUrl === "string") {
    const validated = await validatePostImage(parsed.data.imageDataUrl, parsed.data.imageName);
    if (!validated.ok) return failure(validated.error, 400, "INVALID_IMAGE");
    patch.image = { kind: "set", image: validated.image };
  }

  try {
    if (parsed.data.integrationIds) {
      const owners = await listAccountOwners();
      const targets = [];
      for (const integrationId of [...new Set(parsed.data.integrationIds)]) {
        const record = owners.get(integrationId);
        if (!record) return failure("That social account is not in the local registry yet. Refresh the account list and try again.", 400, "INVALID_TARGET");
        if (auth.user.role !== "admin" && record.ownerUserId !== auth.user.id) {
          return failure("One of the selected accounts is not assigned to you. Ask an administrator to assign it.", 400, "INVALID_TARGET");
        }
        targets.push({ integrationId, platform: record.provider || "", accountName: record.accountName || integrationId });
      }
      patch.targets = targets;
    }

    const result = await updateManualPost(auth.user.id, postId, parsed.data.version, patch);
    if (result.kind === "not_found") return failure("Post not found.", 404, "NOT_FOUND");
    if (result.kind === "conflict") {
      return failure("This post changed in another tab. Reload it before saving.", 409, "CONFLICT");
    }
    if (result.kind === "frozen") {
      return failure("The post has already been handed to Postiz and its snapshot is read-only. Copy it as a new draft to change the text.", 409, "POST_FROZEN");
    }
    return json({ post: result.post });
  } catch (error) {
    if (error instanceof PostMediaValidationError) return failure(error.message, 400, "INVALID_MEDIA");
    console.error("[posts] update failed", error);
    return failure("The post could not be saved. Keep this page open and try again.", 503, "STORAGE_UNAVAILABLE");
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ postId: string }> }) {
  if (!isSameOrigin(request)) return failure("Same-origin request required.", 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return failure("Posts storage is unavailable.", 503, "STORAGE_UNAVAILABLE");
  const postId = await readPostId(context);
  if (!postId) return failure("Invalid post identifier.", 400, "INVALID");
  try {
    const result = await deleteManualPost(auth.user.id, postId);
    if (result.kind === "not_found") return failure("Post not found.", 404, "NOT_FOUND");
    if (result.kind === "frozen") {
      return failure("A Postiz draft already exists for this post, so it cannot be deleted here. Delete the draft in Postiz instead.", 409, "POST_FROZEN");
    }
    return json({ deleted: true });
  } catch (error) {
    console.error("[posts] delete failed", error);
    return failure("The post could not be deleted. Try again.", 503, "STORAGE_UNAVAILABLE");
  }
}
