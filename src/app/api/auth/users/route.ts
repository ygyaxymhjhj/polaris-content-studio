import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createUser, currentUser, listUsers, setDisabled, setPassword, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const forbidden = () => json({ error: "Only administrators can manage members.", code: "FORBIDDEN" }, 403);
const sameOrigin = (request: NextRequest) => request.headers.get("origin") === new URL(request.url).origin;
const password = z.string().min(8).max(200);
const idSchema = z.string().regex(/^[a-f0-9-]{36}$/i);
const createSchema = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,64}$/),
  displayName: z.string().trim().min(1).max(128),
  password
}).strict();
const updateSchema = z.object({ id: idSchema, action: z.enum(["password", "disable", "enable"]), password: password.optional() }).strict();

export async function GET() {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (auth.user.role !== "admin") return forbidden();
  return json({ users: await listUsers(), currentUserId: auth.user.id });
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (auth.user.role !== "admin") return forbidden();

  let body: z.infer<typeof createSchema>;
  try { body = createSchema.parse(await request.json()); }
  catch { return json({ error: "Username must be 3-64 letters, digits, dot, underscore or hyphen; password at least 8 characters." }, 400); }

  try {
    return json({ id: await createUser(body.username, body.displayName, body.password) });
  } catch (error) {
    if ((error as { code?: string })?.code === "ER_DUP_ENTRY") return json({ error: "That username is already taken." }, 409);
    console.error("[users] create failed", error);
    return json({ error: "Could not create the account." }, 503);
  }
}

export async function PATCH(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const auth = await currentUser();
  if (!auth) return unauthorized();
  if (auth.user.role !== "admin") return forbidden();

  let body: z.infer<typeof updateSchema>;
  try { body = updateSchema.parse(await request.json()); }
  catch { return json({ error: "Invalid member update." }, 400); }

  // Refuse to lock yourself out; another administrator can disable you if needed.
  if (body.action === "disable" && body.id === auth.user.id) return json({ error: "You cannot disable your own account." }, 400);
  if (body.action === "password" && !body.password) return json({ error: "A new password of at least 8 characters is required." }, 400);

  try {
    if (body.action === "password") await setPassword(body.id, body.password!);
    else await setDisabled(body.id, body.action === "disable");
    return json({ ok: true });
  } catch (error) {
    console.error("[users] update failed", error);
    return json({ error: "Could not update the account." }, 503);
  }
}
