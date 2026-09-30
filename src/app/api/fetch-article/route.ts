import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { collectArticle, CollectionError } from "@/lib/article-collector";
import { ACW_BROWSER_UA, fetchWithAcwBypass, getCachedAcwCookie, isAcwChallengePage } from "@/lib/acw-challenge";

export const runtime = "nodejs";
export const maxDuration = 180;

const MAX_ARTICLE_CHARS = 120_000;

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isPrivateHost(url: URL) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "localhost.localdomain"].includes(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (isIP(hostname) === 4) return isPrivateIpv4(hostname);
  if (isIP(hostname) === 6) return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80");
  return false;
}

function normalizedText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function candidateScore(element: cheerio.Cheerio<AnyNode>) {
  const paragraphs = element.find("h1, h2, h3, p, li, blockquote").toArray().map((item) => normalizedText(element.find(item).text())).filter((text) => text.length > 35);
  return paragraphs.join("\n\n").length + paragraphs.length * 80;
}

function extractLeadImage($: cheerio.CheerioAPI, container: cheerio.Cheerio<AnyNode>, sourceUrl: string): string | undefined {
  const metaCandidates = [
    $('meta[property="og:image"]').attr("content"),
    $('meta[property="og:image:url"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
    $('meta[property="twitter:image"]').attr("content"),
    $('meta[itemprop="image"]').attr("content"),
    $('link[rel="image_src"]').attr("href")
  ];
  for (const candidate of metaCandidates) {
    if (!candidate || typeof candidate !== "string") continue;
    try {
      const resolved = new URL(candidate.trim(), sourceUrl).href;
      if (/^https?:\/\//i.test(resolved) && !/favicon|logo(\.|_|-)|avatar/i.test(resolved)) return resolved;
    } catch { /* Ignore invalid URL. */ }
  }
  const images = container.find("img").toArray().concat($("article img, main img, #articleInfo img, .article-content img, .entry-content img, .post-content img").toArray());
  for (const el of images) {
    const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-original") || $(el).attr("data-actualsrc");
    if (!src || typeof src !== "string" || src.startsWith("data:") || /\.svg(\?|$)/i.test(src)) continue;
    try {
      const resolved = new URL(src.trim(), sourceUrl).href;
      if (/^https?:\/\//i.test(resolved) && !/favicon|avatar|icon|badge/i.test(resolved)) return resolved;
    } catch { /* Ignore invalid URL. */ }
  }
  for (const candidate of metaCandidates) {
    if (!candidate || typeof candidate !== "string") continue;
    try {
      const resolved = new URL(candidate.trim(), sourceUrl).href;
      if (/^https?:\/\//i.test(resolved)) return resolved;
    } catch { /* Ignore. */ }
  }
  return undefined;
}

function protectionMessage(html: string) {
  const lower = html.toLowerCase();
  if (lower.includes("aliyunwaf") || lower.includes("acw_sc__v2") || lower.includes("please slide to verify") || lower.includes("access verification")) {
    return "This page is protected by an anti-bot or slide verification. Ask the site owner to allowlist the crawler, or use DOCX/paste instead.";
  }
  return null;
}

function extractArticle(html: string, sourceUrl: string) {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, footer, header, aside, form, svg, iframe, .advertisement, .ads, .cookie, .newsletter").remove();

  const title = normalizedText($("meta[property='og:title']").attr("content") || $("h1").first().text() || $("title").first().text());
  const canonical = $("link[rel='canonical']").attr("href") || $("meta[property='og:url']").attr("content") || sourceUrl;
  const dedicatedArticle = $("#articleInfo").first();
  const candidates = $(".article-c, .article-info, .news-detail, article, main, [role='main'], .article-body, .article-content, .post-content, .entry-content, .story-body, .post").toArray();
  const best = dedicatedArticle.length ? dedicatedArticle.get(0) : candidates.sort((a, b) => candidateScore($(b)) - candidateScore($(a)))[0] || $("body").get(0);
  const container = best ? $(best) : $("body");
  container.find(".about, .article-r, .next-pre, .label, .article-tyzd, .share-channels, .auther").remove();
  const imageUrl = extractLeadImage($, container, canonical || sourceUrl);
  const paragraphs = container.find("h1, h2, h3, p, li, blockquote").toArray().map((item) => normalizedText($(item).text())).filter((text) => text.length > 20);
  const uniqueParagraphs = paragraphs.filter((text, index) => paragraphs.indexOf(text) === index);
  const text = normalizedText(uniqueParagraphs.join("\n\n")).slice(0, MAX_ARTICLE_CHARS);
  return {
    title: title || "Imported article",
    text,
    canonical,
    imageUrl,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    characterCount: text.length,
    truncated: text.length >= MAX_ARTICLE_CHARS
  };
}

async function fetchPublicPage(initialUrl: URL, options: { cookie?: string; userAgent?: string } = {}) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent": options.userAgent ?? "Mozilla/5.0 (compatible; PolarisContentStudio/1.0; +https://example.com/bot)",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.5",
        ...(options.cookie ? { Cookie: options.cookie, Referer: currentUrl.toString() } : {})
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000)
    });
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: currentUrl, setCookies };
    const location = response.headers.get("location");
    if (!location) return { response, url: currentUrl, setCookies };
    const nextUrl = new URL(location, currentUrl);
    if (!["http:", "https:"].includes(nextUrl.protocol) || nextUrl.username || nextUrl.password || isPrivateHost(nextUrl)) throw new Error("The page redirected to a URL that is not allowed");
    currentUrl = nextUrl;
  }
  throw new Error("Too many redirects");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: string };
    const rawUrl = String(body.url || "").trim();
    // Opt-in rollout: keep the existing local workflow until the target site passes server acceptance.
    if (process.env.ARTICLE_COLLECTOR_V2 === "true") return NextResponse.json(await collectArticle(rawUrl));
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return NextResponse.json({ error: "Please enter a valid article URL" }, { status: 400 });
    }
    if (!["http:", "https:"].includes(url.protocol)) return NextResponse.json({ error: "Only HTTP and HTTPS URLs are supported" }, { status: 400 });
    if (url.username || url.password || isPrivateHost(url)) return NextResponse.json({ error: "This URL is not allowed" }, { status: 400 });

    const cachedCookie = getCachedAcwCookie(url.host);
    const { response, url: finalUrl } = await fetchPublicPage(url, cachedCookie ? { cookie: cachedCookie } : {});
    if (response.status === 401 || response.status === 403) return NextResponse.json({
      error: "The source website denied access from this server. Open the article normally and paste its text, or import article JSON exported from a working local instance. The previous article has not been replaced.",
      code: "SOURCE_ACCESS_DENIED",
      upstreamStatus: response.status
    }, { status: 424 });
    if (!response.ok) return NextResponse.json({ error: `The page returned HTTP ${response.status}` }, { status: 502 });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) return NextResponse.json({ error: "This URL does not contain an HTML article" }, { status: 415 });

    let html = await response.text();
    let effectiveUrl = finalUrl;
    if (isAcwChallengePage(html)) {
      try {
        // Aliyun WAF challenge: run the page's own script in a VM sandbox to
        // obtain the acw_sc__v2 cookie, then re-request with the session pair.
        const bypassed = await fetchWithAcwBypass(url, async (cookie) => {
          const page = await fetchPublicPage(url, { cookie, userAgent: ACW_BROWSER_UA });
          return { html: await page.response.text(), finalUrl: page.url.toString(), setCookies: page.setCookies };
        });
        html = bypassed.html;
        effectiveUrl = new URL(bypassed.finalUrl);
      } catch {
        return NextResponse.json({ error: "This page is protected by an anti-bot verification that could not be solved. Paste the article or use the browser extension instead.", code: "ANTI_BOT_VERIFICATION" }, { status: 424 });
      }
    }
    const protection = protectionMessage(html);
    if (protection) return NextResponse.json({ error: protection, code: "ANTI_BOT_VERIFICATION" }, { status: 424 });
    const article = extractArticle(html, effectiveUrl.toString());
    const isNewsDetail = /\/newsdetail\//i.test(effectiveUrl.pathname);
    if (article.text.length < (isNewsDetail ? 300 : 80)) return NextResponse.json({ error: "Could not find enough article text on this page. Try the browser crawler or paste the article instead.", code: "ARTICLE_CONTENT_INCOMPLETE" }, { status: 422 });
    return NextResponse.json({ ...article, sourceUrl: effectiveUrl.toString() });
  } catch (error) {
    if (error instanceof CollectionError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    const message = error instanceof Error && error.name === "TimeoutError" ? "The page took too long to respond" : error instanceof Error ? error.message : "Could not fetch article";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
