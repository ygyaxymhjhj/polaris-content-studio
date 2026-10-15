import { NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { database, databaseConfigured } from "@/lib/project-db";
import type { RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const assetIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const responseHeaders = { "Cache-Control": "no-store" };
const submissionColumns = `p.id, p.asset_id, p.integration_id, p.postiz_post_id, p.status,
  p.published_url, p.created_at, t.state AS tracking_state, t.review_status, t.save_action,
  t.rejected_detected_at, t.release_url, t.postiz_publish_date, t.confirmed_at`;

interface SubmissionRow extends RowDataPacket {
  id: string;
  asset_id: string;
  integration_id: string;
  postiz_post_id: string | null;
  status: "drafted" | "published" | "queued" | "failed";
  published_url: string | null;
  created_at: string | Date;
  tracking_state: string | null;
  review_status: string | null;
  save_action: string | null;
  rejected_detected_at: string | Date | null;
  release_url: string | null;
  postiz_publish_date: string | Date | null;
  confirmed_at: string | Date | null;
}

function formatTimestamp(timestamp: string | Date | null): string | null {
  if (!timestamp) return null;
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
  }
  const normalizedTimestamp = timestamp.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalizedTimestamp);
  const parsedTimestamp = new Date(hasTimezone ? normalizedTimestamp : `${normalizedTimestamp}Z`);
  return Number.isNaN(parsedTimestamp.getTime()) ? null : parsedTimestamp.toISOString();
}

function parseIdentifiers(value: string | null, pattern: RegExp): string[] | null {
  if (value === null) return [];
  const identifiers = value.split(",");
  if (identifiers.length > 200 || identifiers.some((identifier) => !pattern.test(identifier))) return null;
  return identifiers;
}

function formatSubmission(row: SubmissionRow) {
  const submittedAt = formatTimestamp(row.created_at);
  if (!submittedAt) throw new Error("Invalid submission timestamp");
  const published = row.tracking_state === "PUBLISHED";
  return {
    auditId: row.id,
    postId: row.postiz_post_id ?? null,
    assetId: row.asset_id,
    integrationId: row.integration_id,
    publishStatus: published ? "published" : row.status,
    reviewStatus: row.review_status === "pending" || row.review_status === "rejected" ? row.review_status : "unknown",
    rejectedDetectedAt: formatTimestamp(row.rejected_detected_at),
    submittedAt,
    postizState: ["DRAFT", "QUEUE", "PUBLISHED", "ERROR"].includes(row.tracking_state ?? "") ? row.tracking_state : null,
    saveAction: ["pass", "update", "draft", "schedule", "now"].includes(row.save_action ?? "") ? row.save_action : null,
    publishedUrl: published ? row.release_url || row.published_url : row.published_url,
    publishedAt: published ? formatTimestamp(row.postiz_publish_date) || formatTimestamp(row.confirmed_at) : null
  };
}

export async function GET(request: Request) {
  const auth = await currentUser();
  if (!auth) {
    const response = unauthorized();
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const url = new URL(request.url);
  const parameterNames = ["projectId", "auditIds", "assetIds"];
  if (url.search.length > 16000 || new TextEncoder().encode(url.search).byteLength > 8192
      || [...url.searchParams.keys()].some((name) => !parameterNames.includes(name))
      || parameterNames.some((name) => url.searchParams.getAll(name).length > 1)) {
    return NextResponse.json({ error: "Invalid submission status query." }, { status: 400, headers: responseHeaders });
  }
  const projectId = url.searchParams.get("projectId");
  const auditIds = parseIdentifiers(url.searchParams.get("auditIds"), uuidPattern);
  const assetIds = parseIdentifiers(url.searchParams.get("assetIds"), assetIdPattern);
  if ((projectId !== null && !uuidPattern.test(projectId)) || !auditIds || !assetIds
      || auditIds.length + assetIds.length === 0 || auditIds.length + assetIds.length > 200) {
    return NextResponse.json({ error: "Invalid submission identifiers." }, { status: 400, headers: responseHeaders });
  }
  if (!databaseConfigured()) {
    return NextResponse.json({ error: "Submission storage is unavailable." }, { status: 503, headers: responseHeaders });
  }

  try {
    // Project ownership is mandatory even for administrators; omitted projects mean private,
    // unprojected submissions, never all of the requester's projects.
    const ownershipFilter = projectId !== null
      ? "p.project_id = ? AND pr.owner_hash = ?"
      : "p.project_id IS NULL AND p.published_by = ?";
    const ownershipParameters = projectId !== null ? [projectId, auth.ownerHash] : [auth.user.id];
    const projectJoin = projectId !== null ? "JOIN projects pr ON pr.id = p.project_id" : "";
    const rowsByAuditId = new Map<string, SubmissionRow>();

    if (auditIds.length) {
      const [rows] = await database().execute<SubmissionRow[]>(
        `SELECT ${submissionColumns} FROM social_publishes p
         LEFT JOIN social_post_tracking t ON t.publish_audit_id = p.id
         ${projectJoin}
         WHERE ${ownershipFilter} AND p.id IN (${auditIds.map(() => "?").join(",")})
         ORDER BY p.created_at DESC, p.id DESC`,
        [...ownershipParameters, ...auditIds]
      );
      for (const row of rows) rowsByAuditId.set(row.id, row);
    }
    if (assetIds.length) {
      // Rank only accepted submissions. A newer failed attempt must not replace the last
      // successful hand-off, and a global history limit would starve older asset groups.
      const [rows] = await database().execute<SubmissionRow[]>(
        `SELECT ranked.* FROM (
           SELECT ${submissionColumns},
             ROW_NUMBER() OVER (PARTITION BY p.asset_id ORDER BY p.created_at DESC, p.id DESC) AS submission_rank
           FROM social_publishes p
           LEFT JOIN social_post_tracking t ON t.publish_audit_id = p.id
           ${projectJoin}
           WHERE ${ownershipFilter} AND p.asset_id IN (${assetIds.map(() => "?").join(",")})
             AND p.status IN ('drafted', 'queued', 'published')
         ) ranked WHERE ranked.submission_rank = 1`,
        [...ownershipParameters, ...assetIds]
      );
      for (const row of rows) rowsByAuditId.set(row.id, row);
    }
    return NextResponse.json({ submissions: [...rowsByAuditId.values()].map(formatSubmission) }, { headers: responseHeaders });
  } catch {
    console.error("[social/submission-status] query failed");
    return NextResponse.json({ error: "Could not load submission status." }, { status: 503, headers: responseHeaders });
  }
}
