import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { processSocialNotifications } from "@/lib/social-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 50;

function jsonResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const expectedToken = process.env.SOCIAL_NOTIFICATIONS_TOKEN;
  if (!expectedToken || expectedToken.length < 32 || /[^\x21-\x7e]/.test(expectedToken)) {
    return jsonResponse({ error: "Notification worker is not configured." }, 503);
  }
  const authorization = request.headers.get("authorization") || "";
  const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBytes = Buffer.from(expectedToken);
  const suppliedBytes = Buffer.from(suppliedToken);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }
  // No caller-supplied statuses, destinations, or identities enter the worker.
  if (request.body) {
    const reader = request.body.getReader();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bodyDeadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Body read timed out")), 2000);
    });
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), bodyDeadline]);
        if (done) break;
        if (value.length) {
          void reader.cancel().catch(() => undefined);
          return jsonResponse({ error: "The worker accepts an empty body only." }, 400);
        }
      }
    } catch {
      void reader.cancel().catch(() => undefined);
      return jsonResponse({ error: "The worker accepts an empty body only." }, 400);
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
  }
  try {
    const summary = await processSocialNotifications();
    return jsonResponse({
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
      checked: summary.checked,
      confirmed: summary.confirmed,
      locked: summary.locked,
      ...(summary.warning ? { warning: "Notification processing needs attention." } : {})
    });
  } catch {
    return jsonResponse({ error: "Notification processing is unavailable." }, 503);
  }
}
