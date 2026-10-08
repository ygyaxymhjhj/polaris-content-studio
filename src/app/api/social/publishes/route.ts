import { NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { database, databaseConfigured } from "@/lib/project-db";
import type { RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assetIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const projectIdPattern = /^[a-f0-9-]{36}$/i;

interface PublishRow extends RowDataPacket {
  id: string;
  project_id: string | null;
  asset_id: string;
  platform: string;
  integration_id: string;
  account_name: string;
  published_by: string;
  published_by_name: string;
  content_preview: string;
  postiz_post_id: string | null;
  published_url: string | null;
  scheduled_at: string | null;
  status: "published" | "failed";
  error: string | null;
  created_at: string;
}

/**
 * Publish history is visible to every signed-in member: in a shared-pool model the audit answers
 * "who published what, where, when" for the whole team, not just for the publisher.
 */
export async function GET(request: Request) {
  const auth = await currentUser();
  if (!auth) return unauthorized();

  const url = new URL(request.url);
  const assetId = (url.searchParams.get("assetId") || "").trim();
  const projectId = (url.searchParams.get("projectId") || "").trim();
  if (!assetId && !projectId) {
    return NextResponse.json({ error: "Pass assetId or projectId to query publish history." }, { status: 400 });
  }
  if ((assetId && !assetIdPattern.test(assetId)) || (projectId && !projectIdPattern.test(projectId))) {
    return NextResponse.json({ error: "Invalid identifier." }, { status: 400 });
  }
  if (!databaseConfigured()) {
    return NextResponse.json({ publishes: [], configured: false });
  }

  try {
    const [rows] = assetId
      ? await database().execute<PublishRow[]>(
          "SELECT * FROM social_publishes WHERE asset_id=? ORDER BY created_at DESC LIMIT 50",
          [assetId]
        )
      : await database().execute<PublishRow[]>(
          "SELECT * FROM social_publishes WHERE project_id=? ORDER BY created_at DESC LIMIT 50",
          [projectId]
        );
    const publishes = (rows as unknown as PublishRow[]).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      assetId: row.asset_id,
      platform: row.platform,
      integrationId: row.integration_id,
      accountName: row.account_name,
      publishedBy: row.published_by,
      publishedByName: row.published_by_name,
      contentPreview: row.content_preview,
      postizPostId: row.postiz_post_id,
      publishedUrl: row.published_url,
      scheduledAt: row.scheduled_at,
      status: row.status,
      error: row.error,
      createdAt: new Date(row.created_at).toISOString()
    }));
    return NextResponse.json({ publishes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[social/publishes] query failed", error);
    return NextResponse.json({ error: "Could not load publish history." }, { status: 503 });
  }
}
