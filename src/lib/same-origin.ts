import type { NextRequest } from "next/server";

/**
 * CSRF guard for mutating routes, tolerant of reverse proxies and tunnels.
 *
 * Compares the Origin hostname against the hostname(s) the request arrived with (Host and
 * X-Forwarded-Host headers), ignoring scheme and port. Those parts are deliberately not compared:
 * public tunnels (Cloudflare, cloudflared, frp, VPN gateways) terminate TLS and forward with
 * X-Forwarded-Proto=https plus a rewritten Host, which makes Next.js build request.url with a
 * different scheme/host than the browser's Origin — a full-origin comparison then rejects
 * legitimate same-site requests with "Same-origin request required" (e.g. login through the
 * public domain). Cross-site requests are still rejected because their Origin hostname matches
 * none of the request's hostnames.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHostname: string;
  try {
    originHostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const hostnames = [request.headers.get("host"), request.headers.get("x-forwarded-host"), request.nextUrl.host]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1).toLowerCase() : value.split(":")[0].toLowerCase());
  return hostnames.includes(originHostname);
}
