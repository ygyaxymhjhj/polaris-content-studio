import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { isSameOrigin } from "@/lib/same-origin";
import { createManualPost, listManualPosts, PostMediaValidationError, sweepStaleSubmissions, type PostAccountSnapshot } from "@/lib/posts";
import { validatePostImage } from "@/lib/post-media";
import { areImageMediaIds } from "@/lib/image-types";
import { listAccountOwners } from "@/lib/social-accounts";
import { readBoundedJson } from "@/lib/request-body";
import { MAX_POST_TARGETS, POST_CONTENT_MAX_LENGTH, POST_TITLE_MAX_LENGTH } from "@/lib/post-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const failure = (message: string, status: number, code?: string) => json({ error: message, ...(code ? { code } : {}) }, status);

/** The largest post body: one image data URL plus text. Bounded before parsing. */
const MAX_POST_BODY_BYTES = 4 * 1024 * 1024;

const integrationIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const createSchema = z.object({
  title: z.string().max(POST_TITLE_MAX_LENGTH).optional(),
  content: z.string().max(POST_CONTENT_MAX_LENGTH).optional(),
  imageDataUrl: z.string().max(3_000_000).nullable().optional(),
  videoMediaId: z.string().uuid().nullable().optional(),
  imageMediaIds: z.custom<string[]>(areImageMediaIds).optional(),
  imageName: z.string().max(POST_TITLE_MAX_LENGTH).optional(),
  integrationIds: z.array(z.string().regex(integrationIdPattern)).max(MAX_POST_TARGETS).optional()
}).strict().refine(value => value.imageMediaIds?.length
  ? !value.imageDataUrl && !value.videoMediaId
  : value.imageMediaIds !== undefined || !value.imageDataUrl || !value.videoMediaId);

const updatedWithinValues = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;

/** Turns the selected integration ids into registry snapshots, rejecting ids the caller cannot use. */
async function resolveTargets(
  userId: string,
  isAdmin: boolean,
  integrationIds: string[] | undefined
): Promise<{ ok: true; targets: PostAccountSnapshot[] } | { ok: false; message: string }> {
  if (!integrationIds?.length) return { ok: true, targets: [] };
  const owners = await listAccountOwners();
  const targets: PostAccountSnapshot[] = [];
  for (const integrationId of [...new Set(integrationIds)]) {
    const record = owners.get(integrationId);
    if (!record) return { ok: false, message: "That social account is not in the local registry yet. Refresh the account list and try again." };
    // Members may only target their own channels; administrators keep full access, matching the
    // publish route. Refusals never reach Postiz.
    if (!isAdmin && record.ownerUserId !== userId) {
      return { ok: false, message: "One of the selected accounts is not assigned to you. Ask an administrator to assign it." };
    }
    targets.push({ integrationId, platform: record.provider || "", accountName: record.accountName || integrationId });
  }
  return { ok: true, targets };
}

export async function GET(request: NextRequest) {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return json({ enabled: false, posts: [], total: 0, page: 1, perPage: 20, counts: { all: 0, draft: 0, pushing: 0, pushed: 0, attention: 0 } });
  try {
    // A list read is also where stale in-flight submissions surface as needs-review.
    await sweepStaleSubmissions(auth.user.id);

    const parameters = request.nextUrl.searchParams;
    const status = parameters.get("status") || "all";
    if (!["all", "draft", "pushing", "pushed", "attention"].includes(status)) {
      return failure("Unknown post status filter.", 400);
    }
    const within = parameters.get("updatedWithin") || "all";
    if (!["all", "24h", "7d", "30d", "all"].includes(within)) return failure("Unknown updated-within filter.", 400);
    const page = Math.max(1, Number(parameters.get("page")) || 1);
    const perPage = Math.min(50, Math.max(1, Number(parameters.get("perPage")) || 20));

    const result = await listManualPosts(auth.user.id, {
      status: status as "all" | "draft" | "pushing" | "pushed" | "attention",
      search: (parameters.get("search") || "").slice(0, 120),
      platform: (parameters.get("platform") || "").slice(0, 32),
      integrationId: (parameters.get("account") || "").slice(0, 64),
      updatedSince: within === "all" ? 0 : Date.now() - updatedWithinValues[within as keyof typeof updatedWithinValues],
      page,
      perPage
    });
    return json({ enabled: true, posts: result.items, total: result.total, page, perPage, counts: result.counts });
  } catch (error) {
    console.error("[posts] list failed", error);
    return failure("Posts storage is unavailable. Refresh and try again.", 503, "STORAGE_UNAVAILABLE");
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return failure("Same-origin request required.", 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return failure("Posts storage is unavailable.", 503, "STORAGE_UNAVAILABLE");

  const body = await readBoundedJson(request, MAX_POST_BODY_BYTES);
  if (!body.ok) {
    if (body.reason === "too_large") return failure("The post is too large. Use a smaller image.", 413, "TOO_LARGE");
    return failure("Invalid post request body.", 400, "INVALID");
  }
  const parsed = createSchema.safeParse(body.value);
  if (!parsed.success) return failure("Invalid post request body.", 400, "INVALID");

  const title = (parsed.data.title || "").trim();
  const content = parsed.data.content || "";
  // An untouched editor page must not create a record: something has to have been written.
  if (!title && !content.trim() && !(parsed.data.imageMediaIds === undefined ? parsed.data.imageDataUrl : parsed.data.imageMediaIds.length) && !parsed.data.videoMediaId) {
    return failure("Write something before saving this post.", 400, "EMPTY_POST");
  }

  let image = null;
  if (parsed.data.imageMediaIds === undefined && parsed.data.imageDataUrl) {
    const validated = await validatePostImage(parsed.data.imageDataUrl, parsed.data.imageName);
    if (!validated.ok) return failure(validated.error, 400, "INVALID_IMAGE");
    image = validated.image;
  }

  try {
    const targets = await resolveTargets(auth.user.id, auth.user.role === "admin", parsed.data.integrationIds);
    if (!targets.ok) return failure(targets.message, 400, "INVALID_TARGET");
    const post = await createManualPost(auth.user.id, { title, content, image, imageMediaIds: parsed.data.imageMediaIds, videoMediaId: parsed.data.videoMediaId, targets: targets.targets });
    return json({ post }, 201);
  } catch (error) {
    if (error instanceof PostMediaValidationError) return failure(error.message, 400, "INVALID_MEDIA");
    console.error("[posts] create failed", error);
    return failure("The post could not be saved. Try again.", 503, "STORAGE_UNAVAILABLE");
  }
}
