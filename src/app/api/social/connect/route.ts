import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { createPostizAuthorizationUrl, fetchPostizIntegrations, PostizConnectionError } from "@/lib/postiz";
import { completeConnectAttempt, createConnectAttempt } from "@/lib/social-accounts";
import { isSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stateCookie = "polaris-postiz-connect";
const returnViewSchema = z.enum(["workspace", "facts", "assets", "export", "accounts", "settings"]);
const connectSchema = z.object({
  provider: z.enum(["facebook", "threads", "linkedin", "x", "instagram", "youtube"]),
  returnView: returnViewSchema.optional()
}).strict();
const hashState = (userId: string, state: string) => createHash("sha256").update(`${userId}:${state}`).digest("hex");
const cookieOptions = (secure: boolean) => ({
  httpOnly: true, sameSite: "lax" as const, secure,
  path: "/api/social/connect", maxAge: 600
});
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

type ConnectionOutcome = "returned" | "invalid" | "unauthenticated" | "error" | "unconfirmed" | "conflict";

function completionResponse(request: NextRequest, outcome: ConnectionOutcome, returnView = "accounts", state = "") {
  const parsedView = returnViewSchema.safeParse(returnView);
  const parameters = new URLSearchParams({ connection: outcome, view: parsedView.success ? parsedView.data : "accounts" });
  const retryable = outcome === "error" || outcome === "unconfirmed";
  if (retryable) parameters.set("retry", `/api/social/connect?state=${state}`);
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      Location: `/social/connect/complete?${parameters.toString()}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    }
  });
  if (!retryable) {
    const secure = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
    response.cookies.set(stateCookie, "", { ...cookieOptions(secure), maxAge: 0 });
  }
  return response;
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return json({ error: "Same-origin request required." }, 403);
  }
  // Only the Origin already accepted by the CSRF guard may determine the browser callback URL.
  const browserOrigin = new URL(request.headers.get("origin")!);
  if (!["http:", "https:"].includes(browserOrigin.protocol)) {
    return json({ error: "Same-origin HTTP request required." }, 403);
  }
  const auth = await currentUser();
  if (!auth) return unauthorized();

  const body = connectSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: "Select a supported platform." }, 400);

  const state = randomBytes(32).toString("hex");
  const stateHash = hashState(auth.user.id, state);
  const redirectUrl = new URL("/api/social/connect", browserOrigin.origin);
  redirectUrl.searchParams.set("state", state);

  const returnView = body.data.returnView ?? "workspace";
  const provider = body.data.provider === "linkedin" ? "linkedin-page" : body.data.provider;

  let snapshotIds: string[];
  try {
    const current = await fetchPostizIntegrations();
    if (!current.configured) return json({ error: "Postiz is not configured." }, 503);
    if (current.error) return json({ error: "Could not read accounts before authorisation. Please try again." }, 502);
    snapshotIds = current.accounts.map((account) => account.id);
  } catch {
    return json({ error: "Could not read accounts before authorisation. Please try again." }, 502);
  }
  try {
    await createConnectAttempt({ stateHash, userId: auth.user.id, provider, snapshotIds, returnView });
  } catch {
    return json({ error: "Could not save this connection attempt. Please try again." }, 503);
  }

  try {
    const url = await createPostizAuthorizationUrl(provider, redirectUrl.href);
    const response = json({ url });
    response.cookies.set(stateCookie, stateHash, cookieOptions(browserOrigin.protocol === "https:"));
    return response;
  } catch (error) {
    if (error instanceof PostizConnectionError) return json({ error: error.message }, error.status);
    return json({ error: "Could not reach Postiz to start authorisation. Please try again." }, 502);
  }
}

export async function GET(request: NextRequest) {
  const rawState = request.nextUrl.searchParams.get("state") || "";
  // Postiz appends its own "?added=..." to our return URL, which can pollute the state value
  // ("abc?added=x"); the random hex part before the first extra "?" is still intact.
  const state = /^[a-f0-9]{64}$/.test(rawState) ? rawState : rawState.split("?")[0];
  let auth: Awaited<ReturnType<typeof currentUser>>;
  try {
    auth = await currentUser();
  } catch {
    return completionResponse(request, "error", "accounts", /^[a-f0-9]{64}$/.test(state) ? state : "");
  }
  if (!auth) return completionResponse(request, "unauthenticated");
  const expectedState = request.cookies.get(stateCookie)?.value || "";
  const validState = Boolean(auth && /^[a-f0-9]{64}$/.test(state) && /^[a-f0-9]{64}$/.test(expectedState)
    && timingSafeEqual(Buffer.from(hashState(auth.user.id, state), "hex"), Buffer.from(expectedState, "hex")));

  if (!validState) return completionResponse(request, "invalid");
  try {
    // Finish Postiz network I/O before starting the short, row-locked ownership transaction.
    const current = await fetchPostizIntegrations();
    if (!current.configured || current.error) return completionResponse(request, "error", "accounts", state);
    const result = await completeConnectAttempt(expectedState, auth.user.id, current.accounts);
    return completionResponse(request, result.outcome, result.returnView, state);
  } catch {
    // A transient failure leaves both the attempt and the browser cookie available for a retry.
    return completionResponse(request, "error", "accounts", state);
  }
}
