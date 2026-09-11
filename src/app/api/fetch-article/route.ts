import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { isIP } from "node:net";
import { NextResponse } from "next/server";

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
  const paragraphs = container.find("h1, h2, h3, p, li, blockquote").toArray().map((item) => normalizedText($(item).text())).filter((text) => text.length > 20);
  const uniqueParagraphs = paragraphs.filter((text, index) => paragraphs.indexOf(text) === index);
  const text = normalizedText(uniqueParagraphs.join("\n\n")).slice(0, MAX_ARTICLE_CHARS);
  return {
    title: title || "Imported article",
    text,
    canonical,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    characterCount: text.length,
    truncated: text.length >= MAX_ARTICLE_CHARS
  };
}

async function fetchPublicPage(initialUrl: URL) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PolarisContentStudio/1.0; +https://example.com/bot)",
        Accept: "text/html,application/xhtml+xml"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000)
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: currentUrl };
    const location = response.headers.get("location");
    if (!location) return { response, url: currentUrl };
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
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return NextResponse.json({ error: "Please enter a valid article URL" }, { status: 400 });
    }
    if (!["http:", "https:"].includes(url.protocol)) return NextResponse.json({ error: "Only HTTP and HTTPS URLs are supported" }, { status: 400 });
    if (url.username || url.password || isPrivateHost(url)) return NextResponse.json({ error: "This URL is not allowed" }, { status: 400 });

    const { response, url: finalUrl } = await fetchPublicPage(url);
    if (!response.ok) return NextResponse.json({ error: `The page returned HTTP ${response.status}` }, { status: 502 });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) return NextResponse.json({ error: "This URL does not contain an HTML article" }, { status: 415 });

    const html = await response.text();
    const protection = protectionMessage(html);
    if (protection) return NextResponse.json({ error: protection, code: "ANTI_BOT_VERIFICATION" }, { status: 424 });
    const article = extractArticle(html, finalUrl.toString());
    const isNewsDetail = /\/newsdetail\//i.test(new URL(finalUrl).pathname);
    if (article.text.length < (isNewsDetail ? 300 : 80)) return NextResponse.json({ error: "Could not find enough article text on this page. Try the browser crawler or paste the article instead.", code: "ARTICLE_CONTENT_INCOMPLETE" }, { status: 422 });
    return NextResponse.json({ ...article, sourceUrl: finalUrl.toString() });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError" ? "The page took too long to respond" : error instanceof Error ? error.message : "Could not fetch article";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
