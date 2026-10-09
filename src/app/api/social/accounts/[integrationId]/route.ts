import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, findUserById, unauthorized } from "@/lib/auth";
import { assignAccount, getSocialAccount } from "@/lib/social-accounts";
import { isSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const forbidden = () => json({ error: "Only administrators can assign social accounts.", code: "FORBIDDEN" }, 403);
// Postiz integration ids are opaque slugs; the same shape check as asset ids in the publishes route.
const integrationIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const assignSchema = z.object({ ownerUserId: z.string().regex(/^[a-f0-9-]{36}$/i).nullable() }).strict();

/**
 * Administrator assignment: gives a channel to a member or returns it to the unassigned pool.
 * Ownership is what the channels list filters on and the publish route enforces, so this endpoint
 * is administrator-only and same-origin guarded, matching the member-management API.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ integrationId: string }> }) {
  if (!isSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (auth.user.role !== "admin") return forbidden();

  const { integrationId } = await context.params;
  if (!integrationIdPattern.test(integrationId)) return json({ error: "Invalid account identifier." }, 400);

  let body: z.infer<typeof assignSchema>;
  try {
    body = assignSchema.parse(await request.json());
  } catch {
    return json({ error: "Provide ownerUserId as a member id, or null to unassign." }, 400);
  }

  const account = await getSocialAccount(integrationId);
  if (!account) {
    return json({ error: "This account is not in the local registry yet. Refresh the account list and retry." }, 404);
  }
  if (body.ownerUserId) {
    const member = await findUserById(body.ownerUserId);
    if (!member) return json({ error: "That member does not exist." }, 400);
    if (member.disabled) return json({ error: "That member is disabled and cannot own accounts." }, 400);
  }

  await assignAccount(integrationId, body.ownerUserId, auth.user.id);
  return json({ ok: true, integrationId, ownerUserId: body.ownerUserId });
}
