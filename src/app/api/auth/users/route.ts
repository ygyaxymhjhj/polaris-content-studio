import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createUser, currentUser, listUsers, unauthorized, updateMember } from "@/lib/auth";
import { isSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const forbidden = () => json({ error: "Only administrators can manage members.", code: "FORBIDDEN" }, 403);
const password = z.string().min(8).max(200);
const idSchema = z.uuid();
const createSchema = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,64}$/),
  displayName: z.string().trim().min(1).max(128),
  password
}).strict();
const updateSchema = z.discriminatedUnion("action", [
  z.object({ id: idSchema, action: z.literal("password"), password }).strict(),
  z.object({ id: idSchema, action: z.enum(["disable", "enable"]) }).strict(),
  z.object({ id: idSchema, action: z.literal("set-role"), role: z.enum(["admin", "member"]) }).strict()
]);

export async function GET() {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (auth.user.role !== "admin") return forbidden();
  return json({ users: await listUsers(), currentUserId: auth.user.id });
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (auth.user.role !== "admin") return forbidden();

  let body: z.infer<typeof createSchema>;
  try { body = createSchema.parse(await request.json()); }
  catch { return json({ error: "Username must be 3-64 letters, digits, dot, underscore or hyphen; password at least 8 characters." }, 400); }

  try {
    const id = await createUser(auth, body.username, body.displayName, body.password);
    return id ? json({ id }) : forbidden();
  } catch (error) {
    if ((error as { code?: string })?.code === "ER_DUP_ENTRY") return json({ error: "That username is already taken." }, 409);
    console.error("[users] create failed", error);
    return json({ error: "Could not create the account." }, 503);
  }
}

export async function PATCH(request: NextRequest) {
  if (!isSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (auth.user.role !== "admin") return forbidden();

  let body: z.infer<typeof updateSchema>;
  try { body = updateSchema.parse(await request.json()); }
  catch { return json({ error: "Invalid member update." }, 400); }

  try {
    const { id, ...update } = body;
    const result = await updateMember(auth, id, update);
    if (result === "forbidden") return forbidden();
    if (result === "missing") return json({ error: "Member not found." }, 404);
    if (result === "self") return json({ error: update.action === "disable"
      ? "You cannot disable your own account."
      : "You cannot change your own role." }, 400);
    if (result === "protected") return json({ error: "The bootstrap administrator cannot be demoted or disabled." }, 400);
    return json({ ok: true, ...(update.action === "set-role" ? { changed: result === "updated" } : {}) });
  } catch (error) {
    console.error("[users] update failed", error);
    return json({ error: "Could not update the account." }, 503);
  }
}
