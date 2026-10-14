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
  status: "drafted" | "published" | "queued" | "failed";
  tracking_state: "DRAFT" | "QUEUE" | "PUBLISHED" | "ERROR" | null;
  release_url: string | null;
  postiz_publish_date: string | Date | null;
  confirmed_at: string | Date | null;
  error: string | null;
  created_at: string;
}

function formatTrackingTimestamp(timestamp: string | Date | null): string | null {
  if (!timestamp) return null;
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
  }
  const normalizedTimestamp = timestamp.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalizedTimestamp);
  const parsedDate = new Date(hasTimezone ? normalizedTimestamp : `${normalizedTimestamp}Z`);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
}

/**
 * Publish history stays visible to every signed-in member, but scoped to their own projects: a row
 * is readable only when its project belongs to the requester (or, for rows without a project, when
 * the requester published it). Projects are private per account and asset ids like "local-x" are
 * guessable, so ownership is enforced here rather than left to the caller.
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
          `SELECT p.*, t.state AS tracking_state, t.release_url, t.postiz_publish_date, t.confirmed_at FROM social_publishes p
             LEFT JOIN social_post_tracking t ON t.publish_audit_id = p.id
             LEFT JOIN projects pr ON pr.id = p.project_id
            WHERE p.asset_id = ? AND (pr.owner_hash = ? OR (p.project_id IS NULL AND p.published_by = ?))
            ORDER BY p.created_at DESC LIMIT 50`,
          [assetId, auth.ownerHash, auth.user.id]
        )
      : await database().execute<PublishRow[]>(
          `SELECT p.*, t.state AS tracking_state, t.release_url, t.postiz_publish_date, t.confirmed_at FROM social_publishes p
             LEFT JOIN social_post_tracking t ON t.publish_audit_id = p.id
             JOIN projects pr ON pr.id = p.project_id
            WHERE p.project_id = ? AND pr.owner_hash = ?
            ORDER BY p.created_at DESC LIMIT 50`,
          [projectId, auth.ownerHash]
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
      publishedUrl: row.tracking_state === "PUBLISHED" ? row.release_url || row.published_url : row.published_url,
      publishedAt: row.tracking_state === "PUBLISHED"
        ? formatTrackingTimestamp(row.postiz_publish_date || row.confirmed_at)
        : null,
      scheduledAt: row.scheduled_at,
      status: row.tracking_state === "PUBLISHED" ? "published" : row.status,
      error: row.error,
      createdAt: new Date(row.created_at).toISOString()
    }));
    return NextResponse.json({ publishes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[social/publishes] query failed", error);
    return NextResponse.json({ error: "Could not load publish history." }, { status: 503 });
  }
}
