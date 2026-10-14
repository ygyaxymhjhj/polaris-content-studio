import { NextResponse } from "next/server";
import { publishToPostiz } from "@/lib/postiz";
import { currentUser, unauthorized } from "@/lib/auth";
import { getSocialAccount } from "@/lib/social-accounts";
import { database, databaseConfigured } from "@/lib/project-db";
import { deliverSocialNotifications, recordSocialSubmission } from "@/lib/social-notifications";
import type { RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notificationPendingWarning = "Draft submitted, but notification delivery is pending. Do not submit again.";
const registrationWarning = "Draft submitted, but submission tracking could not be saved. Do not submit again.";
const projectIdPattern = /^[a-f0-9-]{36}$/i;

export async function POST(request: Request) {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  try {
    let payload: unknown;
    try { payload = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    const body = payload as Record<string, unknown>;
    const stringFields = ["assetId", "integrationId", "content", "imageUrl", "publishAt", "projectId", "platform", "accountName"];
    if (stringFields.some((field) => body[field] !== undefined && typeof body[field] !== "string")) {
      return NextResponse.json({ error: "Submission fields must be strings." }, { status: 400 });
    }
    const integrationId = (body.integrationId as string | undefined)?.trim();
    const content = (body.content as string | undefined)?.trim();
    const projectId = body.projectId as string | undefined;
    const assetId = body.assetId as string | undefined;
    const publishAt = body.publishAt as string | undefined;

    if (!integrationId) {
      return NextResponse.json({ error: "Target social channel integration ID is required" }, { status: 400 });
    }
    if (!content) {
      return NextResponse.json({ error: "Post content cannot be empty" }, { status: 400 });
    }
    if (projectId !== undefined) {
      if (!projectIdPattern.test(projectId)) {
        return NextResponse.json({ error: "Invalid project identifier." }, { status: 400 });
      }
      if (!databaseConfigured()) {
        return NextResponse.json({ error: "Project storage is unavailable." }, { status: 503 });
      }
      const [projects] = await database().execute<RowDataPacket[]>(
        "SELECT id FROM projects WHERE id=? AND owner_hash=?", [projectId, auth.ownerHash]
      );
      if (!projects.length) {
        return NextResponse.json({ error: "This project does not belong to you.", code: "FORBIDDEN" }, { status: 403 });
      }
    }

    // The registry is the server-side source of truth for the audit name and platform; the request
    // body is only a fallback for channels that have not been synced into the registry yet.
    const account = await getSocialAccount(integrationId);

    // Ownership gate: members may only publish to channels assigned to them.
    // Administrators keep full access. Refusals never reach Postiz and never write an audit row.
    if (auth.user.role !== "admin" && (!account || account.ownerUserId !== auth.user.id)) {
      return NextResponse.json(
        { error: "This social account is not assigned to you. Ask an administrator to assign it.", code: "FORBIDDEN" },
        { status: 403 }
      );
    }
    // publishAt is still accepted and validated so older clients get a clear error instead of a
    // silent change of behaviour, but it no longer reaches Postiz: Polaris only creates drafts.
    if (publishAt && Number.isNaN(Date.parse(publishAt))) {
      return NextResponse.json({ error: "publishAt must be a valid date-time." }, { status: 400 });
    }

    const platform = account?.provider || (body.platform as string | undefined)?.trim() || "unknown";
    const accountName = account?.accountName || (body.accountName as string | undefined)?.trim() || integrationId;

    const result = await publishToPostiz({
      integrationId,
      content,
      imageUrl: (body.imageUrl as string | undefined)?.trim() || undefined,
      platform
    });

    const warnings: string[] = [];
    if (result.warning) warnings.push(result.warning);
    if (result.success && !result.postId && !result.warning) {
      warnings.push("Draft submitted, but Postiz returned no post ID. Publication tracking is unavailable. Do not submit again.");
    }
    let auditId: string | undefined;
    try {
      const registration = await recordSocialSubmission({
        projectId,
        assetId: assetId || "unknown",
        platform,
        integrationId,
        accountName,
        publishedBy: auth.user.id,
        publishedByName: auth.user.displayName,
        contentPreview: content.slice(0, 200),
        postizPostId: result.postId,
        status: result.success ? "drafted" : "failed",
        error: result.error
      });
      auditId = registration.auditId;
      if (registration.warning) warnings.push(registration.warning);
      if (result.success && !auditId && !registration.warning) warnings.push(registrationWarning);
    } catch {
      console.error("[social/publish] submission registration failed");
      if (result.success) warnings.push(registrationWarning);
    }

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Failed to create the Postiz draft" }, { status: 502 });
    }
    if (auditId) {
      try {
        const delivery = await deliverSocialNotifications({ auditId, limit: 1 });
        if (delivery.failed > 0) warnings.push(notificationPendingWarning);
      } catch {
        warnings.push(notificationPendingWarning);
      }
    }

    return NextResponse.json({
      success: true,
      assetId,
      postId: result.postId,
      ...(warnings.length ? { warning: [...new Set(warnings)].join(" ") } : {}),
      // Kept under its original key for existing clients; it is the moment the draft was handed to
      // Postiz, not a publish time.
      publishedAt: new Date().toISOString()
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Draft request failed" },
      { status: 500 }
    );
  }
}
