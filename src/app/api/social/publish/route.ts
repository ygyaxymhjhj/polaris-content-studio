import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { publishToPostiz } from "@/lib/postiz";
import { currentUser, unauthorized } from "@/lib/auth";
import { database, databaseConfigured } from "@/lib/project-db";

export const dynamic = "force-dynamic";

/** MySQL DATETIME values are written as explicit UTC strings; the pool sets timezone "Z". */
const utc = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

/**
 * Append one audit row per attempt so "who published what, where, when" stays answerable. The
 * audit never changes the publish outcome: once content has left for Postiz it cannot be rolled
 * back, so a failed audit write is logged and swallowed rather than reported as a publish failure.
 */
async function writePublishAudit(entry: {
  projectId?: string;
  assetId: string;
  platform: string;
  integrationId: string;
  accountName: string;
  publishedBy: string;
  publishedByName: string;
  contentPreview: string;
  postizPostId?: string;
  publishedUrl?: string;
  scheduledAt?: string;
  status: "published" | "failed";
  error?: string;
}) {
  if (!databaseConfigured()) {
    console.error("[social/publish] audit skipped: database is not configured");
    return;
  }
  try {
    await database().execute(
      `INSERT INTO social_publishes
         (id, project_id, asset_id, platform, integration_id, account_name, published_by, published_by_name,
          content_preview, postiz_post_id, published_url, scheduled_at, status, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        randomUUID(),
        entry.projectId || null,
        entry.assetId,
        entry.platform,
        entry.integrationId,
        entry.accountName,
        entry.publishedBy,
        entry.publishedByName,
        entry.contentPreview,
        entry.postizPostId || null,
        entry.publishedUrl || null,
        entry.scheduledAt ? utc(new Date(entry.scheduledAt)) : null,
        entry.status,
        entry.error || null
      ]
    );
  } catch (error) {
    console.error("[social/publish] audit write failed", error);
  }
}

export async function POST(request: Request) {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  try {
    const body = (await request.json()) as {
      assetId?: string;
      integrationId?: string;
      content?: string;
      imageUrl?: string;
      publishAt?: string;
      projectId?: string;
      platform?: string;
      accountName?: string;
    };

    if (!body.integrationId) {
      return NextResponse.json({ error: "Target social channel integration ID is required" }, { status: 400 });
    }
    if (!body.content || !body.content.trim()) {
      return NextResponse.json({ error: "Post content cannot be empty" }, { status: 400 });
    }
    const platform = (body.platform || "").trim() || "unknown";
    const accountName = (body.accountName || "").trim() || body.integrationId;

    const result = await publishToPostiz({
      integrationId: body.integrationId,
      content: body.content.trim(),
      imageUrl: body.imageUrl?.trim() || undefined,
      publishAt: body.publishAt,
      platform
    });

    await writePublishAudit({
      projectId: body.projectId,
      assetId: body.assetId || "unknown",
      platform,
      integrationId: body.integrationId,
      accountName,
      publishedBy: auth.user.id,
      publishedByName: auth.user.displayName,
      contentPreview: body.content.trim().slice(0, 200),
      postizPostId: result.postId,
      publishedUrl: result.url,
      scheduledAt: result.success && body.publishAt ? body.publishAt : undefined,
      status: result.success ? "published" : "failed",
      error: result.error
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Failed to publish" }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      assetId: body.assetId,
      postId: result.postId,
      publishedUrl: result.url,
      queued: Boolean(result.queued),
      publishedAt: new Date().toISOString()
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Publish request failed" },
      { status: 500 }
    );
  }
}
