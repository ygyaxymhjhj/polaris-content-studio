import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  adoptLegacyProjects,
  createSession,
  findUserByUsername,
  hashPassword,
  legacyOwnerCookie,
  sessionCookie,
  sessionCookieOptions,
  verifyPassword
} from "@/lib/auth";
import { databaseConfigured } from "@/lib/project-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const loginSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) });

// ponytail: in-process throttle, cleared on restart. One systemd instance makes it sufficient;
// move the counters into the sessions table if this ever runs behind a load balancer.
const attempts = new Map<string, { count: number; resetAt: number }>();
const maxAttempts = 5;
const windowMs = 5 * 60_000;

function isThrottled(key: string) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) { attempts.delete(key); return false; }
  return entry.count >= maxAttempts;
}

function recordFailure(key: string) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    if (attempts.size > 1000) for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
    attempts.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    entry.count += 1;
  }
}

// Verified against when the username does not exist, so response time does not reveal whether an
// account is real. Built lazily because it costs one scrypt call.
let decoyHash: string | undefined;

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "Same-origin request required" }, 403);
  if (!databaseConfigured()) return json({ error: "This deployment has no account storage configured." }, 503);
  // Unauthenticated endpoint: refuse an oversized body before buffering it.
  if (Number(request.headers.get("content-length") || 0) > 4096) return json({ error: "Invalid request." }, 413);

  let credentials: z.infer<typeof loginSchema>;
  try {
    credentials = loginSchema.parse(await request.json());
  } catch {
    return json({ error: "Enter a username and password." }, 400);
  }

  const key = credentials.username.toLowerCase();
  if (isThrottled(key)) return json({ error: "Too many failed attempts. Try again in a few minutes." }, 429);

  const account = await findUserByUsername(credentials.username);
  decoyHash ??= hashPassword(randomBytes(32).toString("hex"));
  const passwordMatches = verifyPassword(credentials.password, account?.passwordHash ?? decoyHash);

  if (!account || !passwordMatches) {
    recordFailure(key);
    return json({ error: "Incorrect username or password." }, 401);
  }
  if (account.disabled) return json({ error: "This account is disabled. Ask an administrator to re-enable it." }, 403);

  attempts.delete(key);
  const token = await createSession(account.id);
  const claimed = await adoptLegacyProjects(account.id, request.cookies.get(legacyOwnerCookie)?.value);
  if (claimed) console.log(`[auth] adopted ${claimed} anonymous project(s) into ${account.username}`);

  const response = json({
    user: { id: account.id, username: account.username, displayName: account.displayName, role: account.role },
    claimed
  });
  response.cookies.set(sessionCookie, token, sessionCookieOptions(request.nextUrl.protocol === "https:"));
  // Retire the anonymous identity only once its projects have actually moved across.
  if (claimed > 0) response.cookies.delete(legacyOwnerCookie);
  return response;
}
