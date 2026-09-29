// Solves Aliyun WAF "acw_sc__v2" JS challenges without a headless browser.
// Validated flow against wikifxtips.com:
//   1. GET the page -> WAF answers with a challenge page (renderData + obfuscated JS)
//      and issues an "acw_tc" session cookie.
//   2. Execute the challenge page's own script in a Node VM sandbox; it sets
//      document.cookie = "acw_sc__v2=...".
//   3. Re-request with "acw_tc=...; acw_sc__v2=..." -> real page HTML.
// The solved cookie pair stays valid per session (acw_tc Max-Age is 1800s), so it is
// cached per host and reused by batch crawls until it expires or stops working.

import vm from "node:vm";

export const ACW_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CHALLENGE_SCRIPT_TIMEOUT_MS = 30_000;
const COOKIE_TTL_MS = 25 * 60 * 1000;
const MAX_BYPASS_ROUNDS = 3;

export function isAcwChallengePage(html: string) {
  return html.includes("aliyun_waf_aa") || (html.includes('id="renderData"') && html.includes("acw_sc__v2"));
}

function extractAcwCookieValues(setCookies: string[]) {
  const jar = new Map<string, string>();
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if ((name === "acw_tc" || name === "acw_sc__v2") && value) jar.set(name, value);
  }
  return jar;
}

function formatCookieHeader(jar: Map<string, string>) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

const cookieCache = new Map<string, { header: string; expiresAt: number }>();

export function getCachedAcwCookie(host: string) {
  const key = host.toLowerCase();
  const cached = cookieCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.header;
  cookieCache.delete(key);
  return undefined;
}

function cacheAcwCookieHeader(host: string, header: string) {
  if (header) cookieCache.set(host.toLowerCase(), { header, expiresAt: Date.now() + COOKIE_TTL_MS });
}

function solveChallengeCookie(challengeHtml: string, pageUrl: string, userAgent: string) {
  const scripts = [...challengeHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  const renderData = challengeHtml.match(/<textarea id="renderData"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "";
  if (!scripts.length) throw new Error("The challenge page contains no script to execute");

  const capturedCookies: string[] = [];
  const locationShim: Record<string, unknown> = { _href: pageUrl, reload: () => {}, replace: () => {} };
  Object.defineProperty(locationShim, "href", {
    get: () => locationShim._href,
    set: (value: unknown) => { locationShim._href = String(value); }
  });

  const documentShim: Record<string, unknown> = {
    referrer: "",
    getElementById: (id: string) => (id === "renderData" ? { innerHTML: renderData } : { innerHTML: "", style: {} }),
    createElement: () => ({ tagName: "", style: {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, removeChild() {}, getContext: () => null, addEventListener() {}, innerHTML: "", textContent: "" }),
    addEventListener: () => {}, removeEventListener: () => {},
    documentElement: { style: {} }, head: { appendChild() {} }, body: { appendChild() {}, style: {} },
    write: () => {}, writeln: () => {}, createEvent: () => ({ initEvent() {} }),
    querySelector: () => null, querySelectorAll: () => []
  };
  documentShim._cookie = "";
  Object.defineProperty(documentShim, "cookie", {
    get: () => documentShim._cookie,
    set: (value: unknown) => { capturedCookies.push(String(value)); documentShim._cookie = String(value); }
  });
  documentShim.location = locationShim;

  const sandbox: Record<string, unknown> = {
    document: documentShim, location: locationShim,
    navigator: { userAgent, platform: "MacIntel", language: "zh-CN", languages: ["zh-CN", "zh", "en"], appVersion: userAgent, vendor: "Google Inc.", hardwareConcurrency: 8, maxTouchPoints: 0, webdriver: false },
    console: { log: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1055, colorDepth: 24, pixelDepth: 24 },
    history: { length: 1, pushState: () => {}, replaceState: () => {} },
    performance: { now: () => Date.now(), timing: {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    chrome: { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} }
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.top = sandbox; sandbox.parent = sandbox;

  const context = vm.createContext(sandbox);
  for (const [index, code] of scripts.entries()) {
    vm.runInContext(code, context, { timeout: CHALLENGE_SCRIPT_TIMEOUT_MS, filename: `acw-challenge-${index}.js` });
  }

  const solved = capturedCookies.map(cookie => cookie.match(/acw_sc__v2=([^;]+)/)?.[1]).find(Boolean);
  if (!solved) throw new Error("The challenge script did not produce acw_sc__v2");
  return solved;
}

export interface AcwPageResponse { html: string; finalUrl: string; setCookies: string[] }
export type AcwPageFetcher = (cookie?: string) => Promise<AcwPageResponse>;

// Navigates the URL until it stops serving a challenge page, solving each challenge
// round, then caches the working cookie pair for the host.
export async function fetchWithAcwBypass(url: URL, requestPage: AcwPageFetcher): Promise<AcwPageResponse> {
  let page = await requestPage();
  for (let round = 0; round < MAX_BYPASS_ROUNDS; round += 1) {
    if (!isAcwChallengePage(page.html)) return page;
    const solved = solveChallengeCookie(page.html, page.finalUrl, ACW_BROWSER_UA);
    const jar = extractAcwCookieValues(page.setCookies);
    jar.set("acw_sc__v2", solved);
    const solvedCookieHeader = formatCookieHeader(jar);
    page = await requestPage(solvedCookieHeader);
    if (!isAcwChallengePage(page.html)) {
      // The success response re-issues no acw cookie, so cache the cookie string
      // that actually passed verification, for reuse by batch crawls (~25 min).
      cacheAcwCookieHeader(url.host, solvedCookieHeader);
      return page;
    }
  }
  throw new Error("Could not pass the anti-bot verification");
}
