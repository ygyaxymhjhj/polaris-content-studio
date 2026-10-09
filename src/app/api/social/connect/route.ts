import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { createPostizAuthorizationUrl, fetchPostizIntegrations, PostizConnectionError } from "@/lib/postiz";
import { claimNewAccounts, consumeConnectAttempt, createConnectAttempt } from "@/lib/social-accounts";
import { isSameOrigin } from "@/lib/same-origin";

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

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return json({ error: "Same-origin request required." }, 403);
  }
  const auth = await currentUser();
  if (!auth) return unauthorized();

  const body = connectSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: "Select a supported platform." }, 400);

  const state = randomBytes(32).toString("hex");
  const stateHash = hashState(auth.user.id, state);
  const redirectUrl = new URL("/api/social/connect", request.nextUrl.origin);
  redirectUrl.searchParams.set("state", state);

  // The snapshot is taken before the authorisation URL exists, so any channel created later in this
  // flow is "new" and can be claimed for this member on return. Both the snapshot and the attempt
  // record are best-effort: a failure only means the new channel needs an administrator's assignment.
  let snapshotIds: string[] | null = null;
  try {
    const current = await fetchPostizIntegrations();
    if (current.configured && !current.error) snapshotIds = current.accounts.map((account) => account.id);
  } catch (snapshotError) {
    console.error("[social/connect] snapshot failed; a new channel will need admin assignment", snapshotError);
  }
  try {
    await createConnectAttempt({ stateHash, userId: auth.user.id, provider: body.data.provider, snapshotIds });
  } catch (attemptError) {
    console.error("[social/connect] attempt record failed; a new channel will need admin assignment", attemptError);
  }

  try {
    const url = await createPostizAuthorizationUrl(body.data.provider, redirectUrl.href);
    const response = json({ url });
    response.cookies.set(stateCookie, stateHash, cookieOptions(request));
    return response;
  } catch (error) {
    if (error instanceof PostizConnectionError) return json({ error: error.message }, error.status);
    return json({ error: "Could not reach Postiz to start authorisation. Please try again." }, 502);
  }
}

export async function GET(request: NextRequest) {
  const auth = await currentUser();
  const rawState = request.nextUrl.searchParams.get("state") || "";
  // Postiz appends its own "?added=..." to our return URL, which can pollute the state value
  // ("abc?added=x"); the random hex part before the first extra "?" is still intact.
  const state = /^[a-f0-9]{64}$/.test(rawState) ? rawState : rawState.split("?")[0];
  const expectedState = request.cookies.get(stateCookie)?.value || "";
  const validState = Boolean(auth && /^[a-f0-9]{64}$/.test(state) && /^[a-f0-9]{64}$/.test(expectedState)
    && timingSafeEqual(Buffer.from(hashState(auth.user.id, state), "hex"), Buffer.from(expectedState, "hex")));

  if (validState && auth) {
    // Claiming is best-effort: the return redirect must land even when Postiz or the database hiccups,
    // and a failed claim only means the new channel stays unassigned until an administrator places it.
    try {
      const attempt = await consumeConnectAttempt(expectedState, auth.user.id);
      if (attempt) {
        const current = await fetchPostizIntegrations();
        if (current.configured && !current.error) {
          await claimNewAccounts({
            userId: auth.user.id,
            provider: attempt.provider,
            snapshotIds: attempt.snapshotIds,
            liveAccounts: current.accounts
          });
        }
      }
    } catch (error) {
      console.error("[social/connect] claim failed; a new channel will need admin assignment", error);
    }
  }

  const destination = new URL(auth ? "/?view=accounts" : "/login", request.nextUrl.origin);
  if (auth) destination.searchParams.set("connection", validState ? "returned" : "invalid");
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(stateCookie, "", { ...cookieOptions(request), maxAge: 0 });
  return response;
}
