import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { isSameOrigin } from "@/lib/same-origin";
import { readBoundedJson } from "@/lib/request-body";
import { MAX_POST_IMAGE_DATA_URL_LENGTH, validatePostImage } from "@/lib/post-media";
import { findImageRequest, imageAttachment, recordImageUpload } from "@/lib/image-uploads";
import { uploadImageToPostiz, getTrustedPostizMediaUrl } from "@/lib/postiz";
import { requestPublicPage } from "@/lib/article-collector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({
  requestId: z.string().uuid(),
  dataUrl: z.string().max(MAX_POST_IMAGE_DATA_URL_LENGTH).optional(),
  sourceUrl: z.string().url().max(4096).optional(),
  name: z.string().max(255).optional()
}).strict().refine(value => Boolean(value.dataUrl) !== Boolean(value.sourceUrl));
// ponytail: one upload per owner per process; use distributed limits if replicas are introduced.
const uploadingOwners = new Set<string>();
const failure = (error: string, code: string, status: number) => NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });

async function importPublicImage(url: string, signal: AbortSignal): Promise<string> {
  const page = await requestPublicPage(url, 0, 30 * 1024 * 1024, signal);
  if (page.status !== 200 || !page.body.length) throw new Error("Image download failed.");
  const image = sharp(page.body, { failOn: "warning", limitInputPixels: 40_000_000, animated: false });
  const metadata = await image.metadata();
  if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new Error("Invalid source image.");
  let edge = 2048;
  while (edge >= 64) {
    signal.throwIfAborted();
    const bytes = await sharp(page.body, { failOn: "warning", limitInputPixels: 40_000_000, animated: false })
      .rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).toFormat(metadata.format as "jpeg" | "png" | "webp").toBuffer();
    if (bytes.length <= 1024 * 1024) return `data:image/${metadata.format};base64,${bytes.toString("base64")}`;
    edge = Math.floor(edge * 0.75);
  }
  throw new Error("Source image is too large.");
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return failure("Same-origin request required.", "FORBIDDEN", 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return failure("Image storage is unavailable.", "STORAGE_UNAVAILABLE", 503);
  const body = await readBoundedJson(request, MAX_POST_IMAGE_DATA_URL_LENGTH + 8192);
  if (!body.ok) return failure("Invalid image upload request.", "INVALID_IMAGE", body.reason === "too_large" ? 413 : 400);
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) return failure("Invalid image upload request.", "INVALID_IMAGE", 400);
  const ownerUserId = auth.user.id;
  if (uploadingOwners.has(ownerUserId) || uploadingOwners.size >= 4) return failure("Another image is uploading. Please try again.", "UPLOAD_BUSY", 429);
  uploadingOwners.add(ownerUserId);
  try {
    const requestId = parsed.data.requestId.toLowerCase();
    // Fingerprint the request, not downloaded bytes: a completed import replays even if its source expires.
    const checksum = createHash("sha256").update(JSON.stringify([parsed.data.dataUrl ?? null, parsed.data.sourceUrl ?? null, parsed.data.name ?? null])).digest("hex");
    const existing = await findImageRequest(ownerUserId, requestId);
    if (existing) {
      if (existing.checksum !== checksum) return failure("The image upload request has changed.", "REQUEST_CONFLICT", 409);
      return NextResponse.json({ image: imageAttachment(existing) }, { headers: { "Cache-Control": "no-store" } });
    }
    request.signal.throwIfAborted();
    const dataUrl = parsed.data.dataUrl ?? await importPublicImage(parsed.data.sourceUrl!, request.signal);
    if (request.signal.aborted) return failure("Image upload was cancelled.", "UPLOAD_CANCELLED", 400);
    const validated = await validatePostImage(dataUrl, parsed.data.name);
    if (!validated.ok) return failure(validated.error, "INVALID_IMAGE", 400);
    request.signal.throwIfAborted();
    const image = validated.image;
    const media = await uploadImageToPostiz(image.dataUrl, request.signal);
    if (request.signal.aborted && !media) return failure("Image upload was cancelled.", "UPLOAD_CANCELLED", 400);
    if (!media) return failure("Could not upload this image. Please try again.", "IMAGE_UPLOAD_FAILED", 502);
    const stored = await recordImageUpload({
      ownerUserId, requestId, checksum, postizMediaId: media.id, postizPath: getTrustedPostizMediaUrl(media.path),
      name: image.filename, bytes: Buffer.from(image.dataUrl.split(",")[1], "base64").byteLength,
      width: image.width, height: image.height, thumbnailDataUrl: image.thumbnailDataUrl
    });
    return NextResponse.json({ image: imageAttachment(stored) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    if (request.signal.aborted) return failure("Image upload was cancelled.", "UPLOAD_CANCELLED", 400);
    return failure("Could not save this image. Check the publishing service and image storage, then retry.", "IMAGE_STORAGE_FAILED", 503);
  } finally {
    uploadingOwners.delete(ownerUserId);
  }
}
