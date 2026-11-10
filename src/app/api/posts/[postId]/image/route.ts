import { NextRequest, NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";
import { getPostImage, getSubmittedAttachment } from "@/lib/posts";
import { getTrustedPostizMediaUrl } from "@/lib/postiz";
import { postImageBuffer } from "@/lib/post-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postIdPattern = /^[a-f0-9-]{36}$/i;

/**
 * Serves a post image to its owner only. The bytes live inline in the posts row, so this route is
 * the single place that checks ownership before handing them out; the `v` query parameter is a
 * cache-buster, and the response is private because a shared cache must never store it.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ postId: string }> }) {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (!databaseConfigured()) return NextResponse.json({ error: "Posts storage is unavailable." }, { status: 503 });
  const { postId } = await context.params;
  if (!postIdPattern.test(postId)) return NextResponse.json({ error: "Invalid post identifier." }, { status: 400 });
  const size = request.nextUrl.searchParams.get("size") === "thumb" ? "thumb" : "full";
  try {
    const attachment = request.nextUrl.searchParams.get("attachment");
    const version = Number(request.nextUrl.searchParams.get("v"));
    const missing = () => NextResponse.json({ error: "No attachment on this post." }, { status: 404, headers: { "Cache-Control": "no-store" } });
    if (attachment !== null && (auth.user.role !== "admin" || !Number.isSafeInteger(version) || version < 1 ||
      !/^(inline|video|[0-9]{1,2})$/.test(attachment))) return missing();
    const stored = attachment === null ? await getPostImage(auth.user.id, postId, size)
      : await getSubmittedAttachment(postId, version, attachment, size === "thumb");
    if (!stored) return missing();
    if ("path" in stored && typeof stored.path === "string") {
      const response = NextResponse.redirect(getTrustedPostizMediaUrl(stored.path), 307);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    if (!stored.dataUrl) return missing();
    const decoded = postImageBuffer(stored.dataUrl);
    if (!decoded) return NextResponse.json({ error: "Stored image is unreadable." }, { status: 500 });
    return new NextResponse(new Uint8Array(decoded.buffer), {
      status: 200,
      headers: {
        "Content-Type": decoded.contentType,
        "Content-Length": String(decoded.buffer.byteLength),
        "Cache-Control": "private, max-age=120",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    console.error("[posts] image read failed", error);
    return NextResponse.json({ error: "The image could not be read." }, { status: 503 });
  }
}
