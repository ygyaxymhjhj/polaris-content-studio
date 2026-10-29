import { NextRequest, NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { getImageUploads } from "@/lib/image-uploads";
import { isImageMediaId } from "@/lib/image-types";
import { postImageBuffer } from "@/lib/post-media";
import { getTrustedPostizMediaUrl } from "@/lib/postiz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const failure = (status: number) => NextResponse.json({ error: "Image not found." }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: NextRequest, context: { params: Promise<{ mediaId: string }> }) {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return failure(503);
  const { mediaId } = await context.params;
  if (!isImageMediaId(mediaId)) return failure(404);
  try {
    const [image] = await getImageUploads(auth.user.id, [mediaId]);
    if (request.nextUrl.searchParams.get("size") === "thumb") {
      const decoded = postImageBuffer(image.thumbnailDataUrl);
      if (!decoded) return failure(503);
      return new NextResponse(new Uint8Array(decoded.buffer), { headers: {
        "Content-Type": decoded.contentType, "Content-Length": String(decoded.buffer.length),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"
      } });
    }
    const url = getTrustedPostizMediaUrl(image.postizPath);
    if (request.nextUrl.searchParams.get("download") === "1") {
      const upstream = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store" });
      if (!upstream.ok || !upstream.body) return failure(503);
      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_500_000) { await reader.cancel(); return failure(503); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const contentType = upstream.headers.get("content-type")?.split(";")[0].trim();
      if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) return failure(503);
      return new NextResponse(new Uint8Array(Buffer.concat(chunks)), { headers: {
        "Content-Type": contentType, "Content-Length": String(size), "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
      } });
    }
    const response = NextResponse.redirect(url, 307);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return failure(404);
  }
}
