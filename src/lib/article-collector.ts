import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import * as cheerio from "cheerio";

export class CollectionError extends Error {
  constructor(public code: string, message: string, public status = 502) { super(message); }
}
const LIMIT = 4 * 1024 * 1024;
const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(ip, prefix, "ipv6");
export function isBlockedAddress(address: string) {
  // BlockList also recognises IPv4-mapped IPv6 addresses against the IPv4 entries.
  if (!isIP(address)) return true;
  return blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}
export function publicUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CollectionError("INVALID_URL", "Please enter a valid article URL", 400); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port)) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || (isIP(host) && isBlockedAddress(host))) throw new CollectionError("UNSAFE_URL", "This URL is not allowed", 400);
  url.hash = "";
  return url;
}
export interface PublicPage { url: string; status: number; headers: Record<string, string>; body: Buffer }

/** Resolve once, reject private answers, and pin that answer to the actual connection. */
export async function requestPublicPage(raw: string, redirects = 0, maxBytes = LIMIT): Promise<PublicPage> {
  if (redirects > 4) throw new CollectionError("TOO_MANY_REDIRECTS", "Too many redirects");
  const url = publicUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => isBlockedAddress(item.address))) throw new CollectionError("UNSAFE_URL", "The URL resolves to a private or reserved address", 400);
  const selected = addresses.find(item => item.family === 4) || addresses[0];
  const page = await new Promise<PublicPage>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const timer = setTimeout(() => req.destroy(new CollectionError("SOURCE_TIMEOUT", "The source website timed out", 504)), 15000);
    const req = transport.request(url, {
      agent: false,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PolarisContentStudio/1.0; +https://example.com/bot)", Accept: "text/html,application/xhtml+xml,*/*;q=0.5", "Accept-Encoding": "identity" },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      }
    }, response => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;
      const status = response.statusCode || 502;
      // Do not download bodies for redirects or access-denied pages.
      if ([301, 302, 303, 307, 308, 401, 403, 429].includes(status)) {
        clearTimeout(timer); response.destroy(); resolve({ url: url.href, status, headers, body: Buffer.alloc(0) }); return;
      }
      const encoding = headers["content-encoding"];
      const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
      const stream = decoder ? response.pipe(decoder) : response;
      const chunks: Buffer[] = []; let size = 0; let wireSize = 0;
      response.on("data", chunk => { wireSize += chunk.length; if (wireSize > maxBytes) req.destroy(new CollectionError("ARTICLE_TOO_LARGE", "Source page exceeds the download limit", 413)); });
      response.on("error", error => { clearTimeout(timer); reject(error); });
      stream.on("error", error => { req.destroy(); reject(error); });
      stream.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) { stream.destroy(); req.destroy(new CollectionError("ARTICLE_TOO_LARGE", "Source page exceeds the download limit", 413)); }
        else chunks.push(Buffer.from(chunk));
      });
      stream.on("end", () => { clearTimeout(timer); resolve({ url: url.href, status, headers, body: Buffer.concat(chunks) }); });
    });
    req.on("error", error => { clearTimeout(timer); reject(error); });
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(page.status) && page.headers.location) return requestPublicPage(new URL(page.headers.location, page.url).href, redirects + 1, maxBytes);
  return page;
}
function checkResponse(page: PublicPage) {
  if ([401, 403].includes(page.status)) throw new CollectionError("SOURCE_ACCESS_DENIED", "The source website denied server access. The article has not been imported. Site-owner approval is required for this server.", 424);
  if (page.status === 429) throw new CollectionError("SOURCE_RATE_LIMITED", "The source website is limiting requests. Please try later.", 429);
  if (page.status < 200 || page.status >= 300) throw new CollectionError("SOURCE_HTTP_ERROR", `The source website returned HTTP ${page.status}`);
}
const normal = (text: string) => text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
export function extractPublicArticle(html: string, sourceUrl: string) {
  const $ = cheerio.load(html);
  const title = normal($("h1").first().text() || $('meta[property="og:title"]').attr("content") || $("title").text());
  if (/access denied|just a moment|verify you are human|access verification/i.test(title) || /aliyunwaf|acw_sc__v2|please slide to verify|challenge-running/i.test(html)) throw new CollectionError("SOURCE_ACCESS_DENIED", "The source website requires verification. Server collection has stopped.", 424);
  $("script,style,noscript,nav,footer,header,aside,form,svg,iframe,[hidden],[aria-hidden='true'],.ads,.advertisement,.about,.related,.related-posts,.share-channels,.auther,.next-pre,.next-pre-mobile,.article-r").remove();
  const dedicated = $("#articleInfo, [itemprop='articleBody']").first();
  const specific = $(".article-body,.article-content,.post-content,.entry-content,.story-body").toArray();
  const candidates = specific.length ? specific : $("article,main,[role='main']").toArray();
  const score = (node: typeof candidates[number]) => $(node).find("p").toArray().reduce((sum, p) => sum + normal($(p).text()).length, 0);
  const best = dedicated.length ? dedicated.get(0) : candidates.sort((a, b) => score(b) - score(a))[0];
  if (!best) return null;
  const container = $(best);
  container.find("br").replaceWith("\n");
  const paragraphs = container.find("h1,h2,h3,h4,p,li,blockquote,figcaption,tr").toArray().filter(node => !$(node).find("p,li,blockquote,tr").length).map(node => normal($(node).text())).filter(Boolean);
  const text = normal(paragraphs.length ? paragraphs.join("\n\n") : container.text());
  if (text.length < (/\/newsdetail\//i.test(sourceUrl) ? 300 : 80)) return null;
  if (text.length > 120000) throw new CollectionError("ARTICLE_TOO_LARGE", "Article exceeds 120,000 characters", 413);
  return { title: title || "Imported article", text, canonical: sourceUrl, sourceUrl, characterCount: text.length, wordCount: text.split(/\s+/).filter(Boolean).length, truncated: false };
}

async function renderPublicPage(url: string) {
  if (process.env.ARTICLE_RENDER_BROWSER !== "true") throw new CollectionError("ARTICLE_CONTENT_INCOMPLETE", "The public page did not contain enough article text. Browser rendering is unavailable.", 422);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"], ...(process.env.ARTICLE_BROWSER_EXECUTABLE ? { executablePath: process.env.ARTICLE_BROWSER_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    let failure: Error | undefined; let requests = 0; let bytes = 0;
    await context.route("**/*", async route => {
      const request = route.request();
      const mainDocument = request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame();
      try {
        // The browser never makes direct network requests: all resources use the pinned public fetch.
        if (request.method() !== "GET" || ["image", "media", "font", "websocket"].includes(request.resourceType()) || ++requests > 60 || bytes > 12 * 1024 * 1024) { await route.abort(); return; }
        const result = await requestPublicPage(request.url(), 0, 2 * 1024 * 1024); bytes += result.body.length;
        if (mainDocument) checkResponse(result);
        const headers = { ...result.headers };
        for (const key of ["content-length", "content-encoding", "transfer-encoding", "set-cookie", "connection"]) delete headers[key];
        await route.fulfill({ status: result.status, headers, body: result.body });
      } catch (error) {
        if (mainDocument) failure = error instanceof Error ? error : new Error("Render failed");
        await route.abort().catch(() => undefined);
      }
    });
    // WebSocket traffic is not covered by HTTP routing.
    await context.routeWebSocket(/.*/, socket => socket.close());
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(error => { throw failure || error; });
    let article = null;
    for (let i = 0; i < 5; i++) {
      if (failure) throw failure;
      article = extractPublicArticle(await page.content(), page.url());
      if (article) break;
      await page.waitForTimeout(1000);
    }
    return article;
  } finally { await browser.close(); }
}

// One process-wide queue/cache: coalesce identical requests and cap shared browser/resource use.
type Article = NonNullable<ReturnType<typeof extractPublicArticle>> & { collectionMode: "html" | "browser"; fetchedAt: string; cached: boolean };
const cache = new Map<string, { expires: number; article?: Article; error?: CollectionError }>();
const pending = new Map<string, Promise<Article>>();
let active = 0;
const queue: (() => void)[] = [];
async function slot() { if (active >= 2) await new Promise<void>(resolve => queue.push(resolve)); else active++; }
function release() { const next = queue.shift(); if (next) next(); else active--; }
export async function collectArticle(raw: string): Promise<Article> {
  const key = publicUrl(raw).href;
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) {
    if (saved.error) throw saved.error;
    return { ...saved.article!, cached: true };
  }
  const running = pending.get(key);
  if (running) return running;
  if (pending.size >= 10) throw new CollectionError("COLLECTOR_BUSY", "The article collector is busy. Please try shortly.", 429);
  const job = (async () => {
    await slot();
    try {
      const page = await requestPublicPage(key);
      checkResponse(page); // Explicit denial NEVER triggers browser, alternate IP or proxy retry.
      if (!/text\/html|application\/xhtml\+xml/i.test(page.headers["content-type"] || "")) throw new CollectionError("NOT_HTML", "This URL is not an HTML article", 415);
      const direct = extractPublicArticle(page.body.toString("utf8"), page.url);
      const result = direct || await renderPublicPage(page.url);
      if (!result) throw new CollectionError("ARTICLE_CONTENT_INCOMPLETE", "Could not extract enough article text. The current source was not replaced.", 422);
      const article: Article = { ...result, collectionMode: direct ? "html" : "browser", fetchedAt: new Date().toISOString(), cached: false };
      if (cache.size >= 30) cache.delete(cache.keys().next().value!);
      cache.set(key, { article, expires: Date.now() + 10 * 60 * 1000 });
      return article;
    } catch (error) {
      if (error instanceof CollectionError && ["SOURCE_ACCESS_DENIED", "SOURCE_RATE_LIMITED"].includes(error.code)) {
        if (cache.size >= 30) cache.delete(cache.keys().next().value!);
        cache.set(key, { error, expires: Date.now() + 60 * 1000 });
      }
      throw error;
    } finally { release(); }
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}
