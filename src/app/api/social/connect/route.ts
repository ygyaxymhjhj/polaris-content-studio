import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { createPostizAuthorizationUrl, PostizConnectionError } from "@/lib/postiz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stateCookie = "polaris-postiz-connect";
const connectSchema = z.object({ provider: z.enum(["facebook", "threads", "linkedin", "x", "instagram"]) }).strict();
const hashState = (userId: string, state: string) => createHash("sha256").update(`${userId}:${state}`).digest("hex");
const cookieOptions = (request: NextRequest) => ({
  httpOnly: true, sameSite: "lax" as const, secure: request.nextUrl.protocol === "https:",
  path: "/api/social/connect", maxAge: 600
});
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

// Like the shared channel list, connecting is available to every signed-in workspace member.
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin) {
    return json({ error: "Same-origin request required." }, 403);
  }
  const auth = await currentUser();
  if (!auth) return unauthorized();

  const body = connectSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: "Select a supported platform." }, 400);

  const state = randomBytes(32).toString("hex");
  const redirectUrl = new URL("/api/social/connect", request.nextUrl.origin);
  redirectUrl.searchParams.set("state", state);
  try {
    const url = await createPostizAuthorizationUrl(body.data.provider, redirectUrl.href);
    const response = json({ url });
    response.cookies.set(stateCookie, hashState(auth.user.id, state), cookieOptions(request));
    return response;
  } catch (error) {
    if (error instanceof PostizConnectionError) return json({ error: error.message }, error.status);
    return json({ error: "Could not reach Postiz to start authorisation. Please try again." }, 502);
  }
}

// Postiz owns the provider callback and tokens. This callback only validates our browser hand-off.
export async function GET(request: NextRequest) {
  const auth = await currentUser();
  const state = request.nextUrl.searchParams.get("state") || "";
  const expectedState = request.cookies.get(stateCookie)?.value || "";
  const validState = Boolean(auth && /^[a-f0-9]{64}$/.test(state) && /^[a-f0-9]{64}$/.test(expectedState)
    && timingSafeEqual(Buffer.from(hashState(auth.user.id, state), "hex"), Buffer.from(expectedState, "hex")));
  const destination = new URL(auth ? "/?view=accounts" : "/login", request.nextUrl.origin);
  if (auth) destination.searchParams.set("connection", validState ? "returned" : "invalid");
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(stateCookie, "", { ...cookieOptions(request), maxAge: 0 });
  return response;
}
