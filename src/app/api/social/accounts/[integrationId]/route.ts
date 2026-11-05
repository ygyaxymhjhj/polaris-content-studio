import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, findUserById, unauthorized } from "@/lib/auth";
import { getSocialAccount, isAccountAssignedTo, replaceAccountAssignments } from "@/lib/social-accounts";
import { isSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const forbidden = () => json({ error: "Only administrators can assign social accounts.", code: "FORBIDDEN" }, 403);
// Postiz integration ids are opaque slugs; the same shape check as asset ids in the publishes route.
const integrationIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const userIdPattern = /^[a-f0-9-]{36}$/i;
const assignSchema = z.object({ userIds: z.array(z.string().regex(userIdPattern)).max(100) }).strict();

/**
 * Administrator assignment: replaces the complete set of members allowed to use a channel. An empty
 * list returns it to the unassigned pool (administrators only). This endpoint is the only write path
 * for assignments, and members can never call it.
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
    return json({ error: "Provide userIds as a list of member ids." }, 400);
  }

  const account = await getSocialAccount(integrationId);
  if (!account) {
    return json({ error: "This account is not in the local registry yet. Refresh the account list and retry." }, 404);
  }
  const userIds = [...new Set(body.userIds)];
  for (const userId of userIds) {
    const member = await findUserById(userId);
    if (!member) return json({ error: "That member does not exist." }, 400);
    // Existing disabled assignees stay removable; only new disabled assignments are refused.
    if (member.disabled && !isAccountAssignedTo(account, userId)) {
      return json({ error: "That member is disabled and cannot be assigned accounts." }, 400);
    }
  }

  if (!await replaceAccountAssignments(integrationId, userIds, auth.user.id)) {
    return json({ error: "This account is not in the local registry yet. Refresh the account list and retry." }, 404);
  }
  return json({ ok: true, integrationId, userIds });
}
