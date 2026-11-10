import { NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { database } from "@/lib/project-db";
import type { AdminPublishHistoryResponse, AdminPublishStatus } from "@/lib/admin-publish-types";
import type { RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 50;
const json = (data: unknown, status = 200) => NextResponse.json(data, {
  status,
  headers: { "Cache-Control": "no-store" }
});

type Timestamp = string | null;

interface PublishRow extends RowDataPacket {
  id: string;
  platform: string;
  account_name: string;
  published_by_name: string;
  status: "drafted" | "queued" | "published" | "failed";
  tracking_state: "DRAFT" | "QUEUE" | "PUBLISHED" | "ERROR" | null;
  review_status: "unknown" | "pending" | "rejected" | null;
  scheduled_at: Timestamp;
  postiz_publish_date: Timestamp;
  confirmed_at: Timestamp;
  last_checked_at: Timestamp;
  rejected_detected_at: Timestamp;
  created_at: string;
}

function formatTimestamp(value: Timestamp): Timestamp {
  if (!value) return null;
  // The MySQL pool returns DATETIME as UTC strings without a zone.
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function statusFor(row: PublishRow): AdminPublishStatus {
  if (row.tracking_state === "PUBLISHED") return "published";
  if (row.tracking_state === "ERROR" || row.status === "failed") return "failed";
  if (row.tracking_state === "QUEUE") return "queued";
  if (row.tracking_state === "DRAFT" && row.review_status === "rejected") return "rejected";
  if (row.status === "published" || row.status === "queued") return row.status;
  if (row.tracking_state === "DRAFT" && row.review_status === "pending") return "pending_review";
  return "drafted";
}

function readPositiveInteger(value: string | null, fallback: number, max: number) {
  if (value === null) return fallback;
  const number = Number(value);
  return /^[1-9]\d*$/.test(value) && number <= max ? number : null;
}

/** Admin-only summary; never read project snapshots, content previews, URLs or upstream error text. */
export async function GET(request: Request) {
  try {
    const auth = await currentUser();
    if (!auth) return unauthorized();
    if (auth.user.role !== "admin") return json({ error: "Only administrators can view AI publish history.", code: "FORBIDDEN" }, 403);

    const params = new URL(request.url).searchParams;
    const page = readPositiveInteger(params.get("page"), 1, Math.floor(Number.MAX_SAFE_INTEGER / MAX_PER_PAGE));
    const perPage = readPositiveInteger(params.get("perPage"), DEFAULT_PER_PAGE, MAX_PER_PAGE);
    if (page === null || perPage === null) return json({ error: "Invalid pagination." }, 400);

    // Pre-queue AI audits either had a project or used known studio asset IDs. Manual posts
    // have no project and use UUIDs, including when their post or target was deleted.
    const [rows] = await database().execute<PublishRow[]>(
      `SELECT p.id, p.platform, p.account_name, p.published_by_name, p.status, p.scheduled_at, p.created_at,
          tracking.state AS tracking_state, tracking.review_status, tracking.postiz_publish_date,
          tracking.confirmed_at, tracking.last_checked_at, tracking.rejected_detected_at
        FROM social_publishes p
        LEFT JOIN social_post_tracking tracking ON tracking.publish_audit_id = p.id
          AND CAST(tracking.postiz_post_id AS BINARY) = CAST(p.postiz_post_id AS BINARY)
        WHERE NOT EXISTS (
          SELECT 1 FROM draft_submissions manual_submission
          WHERE manual_submission.owner_user_id = p.published_by AND manual_submission.kind = 'manual'
            AND manual_submission.project_id IS NULL AND manual_submission.source_id = p.asset_id
            AND manual_submission.audit_id = p.id AND manual_submission.integration_id = p.integration_id
        ) AND (
          EXISTS (
            SELECT 1 FROM draft_submissions asset_submission
            WHERE asset_submission.owner_user_id = p.published_by AND asset_submission.kind = 'asset'
              AND asset_submission.project_id <=> p.project_id AND asset_submission.source_id = p.asset_id
              AND asset_submission.audit_id = p.id AND asset_submission.integration_id = p.integration_id
          ) OR p.project_id IS NOT NULL OR p.asset_id LIKE 'ai-%' OR p.asset_id LIKE 'local-%' OR p.asset_id LIKE 'fallback-%'
        )
        ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`, [perPage + 1, (page - 1) * perPage]
    );
    const result: AdminPublishHistoryResponse = {
      publishes: rows.slice(0, perPage).map((row) => {
        const status = statusFor(row);
        return {
          id: row.id,
          platform: row.platform,
          accountName: row.account_name,
          submitter: row.published_by_name,
          status,
          attemptedAt: formatTimestamp(row.created_at),
          scheduledAt: formatTimestamp(row.scheduled_at),
          publishedAt: status === "published" ? formatTimestamp(row.postiz_publish_date || row.confirmed_at) : null,
          lastCheckedAt: formatTimestamp(row.last_checked_at),
          rejectedAt: status === "rejected" ? formatTimestamp(row.rejected_detected_at) : null,
          errorCode: status === "failed" ? row.tracking_state === "ERROR" ? "publishing_failed" : "submission_failed" : null
        };
      }),
      hasNext: rows.length > perPage
    };
    return json(result);
  } catch {
    console.error("[admin/publishes] could not load AI publish history");
    return json({ error: "Could not load AI publish history." }, 503);
  }
}
