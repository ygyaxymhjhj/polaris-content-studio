#!/usr/bin/env node

import fs from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const urlArg = args.find((arg) => !arg.startsWith("--"));
const outputArg = args.find((arg) => arg.startsWith("--output="));
const output = outputArg ? outputArg.slice("--output=".length) : "crawl-output.json";
const headless = args.includes("--headless");
const timeoutArg = args.find((arg) => arg.startsWith("--timeout="));
const verificationTimeout = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : 120_000;

if (!urlArg || args.includes("--help")) {
  console.log(`Usage: npm run crawl:article -- <url> [options]\n\nOptions:\n  --output=<file>   Output JSON path (default: crawl-output.json)\n  --headless        Do not open a visible browser; fails on human verification\n  --timeout=<ms>    Time allowed for manual verification (default: 120000)\n\nFor protected pages, leave the default visible-browser mode and complete the\nverification yourself. The crawler does not bypass CAPTCHA or anti-bot checks.`);
  process.exit(args.includes("--help") ? 0 : 1);
}

let target;
try {
  target = new URL(urlArg);
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported");
} catch (error) {
  console.error(`Invalid URL: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}

function isVerification(text, title) {
  const sample = `${title}\n${text.slice(0, 1500)}`.toLowerCase();
  return title.toLowerCase() === "verification" || /access verification|please slide|slide to verify|verify you are human|captcha|安全验证|滑块验证/.test(sample);
}

async function extractPage(page) {
  return page.evaluate(() => {
    const normalize = (value) => value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const selectors = [".article-c", ".article-info", ".news-detail", "article", "main", "[role='main']", ".article-body", ".article-content", ".post-content", ".entry-content", ".story-body", ".post"];
    const score = (element) => {
      const values = Array.from(element.querySelectorAll("h1, h2, h3, p, li, blockquote")).map((node) => normalize(node.textContent || "")).filter((value) => value.length > 35);
      return values.join("\n\n").length + values.length * 80;
    };
    const dedicatedArticle = document.querySelector("#articleInfo");
    const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const root = dedicatedArticle || candidates.sort((a, b) => score(b) - score(a))[0] || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, nav, footer, header, aside, form, svg, iframe, .advertisement, .ads, .cookie, .newsletter, .about, .article-r, .next-pre, .label, .article-tyzd, .share-channels, .auther").forEach((node) => node.remove());
    const values = Array.from(clone.querySelectorAll("h1, h2, h3, p, li, blockquote")).map((node) => normalize(node.textContent || "")).filter((value) => value.length > 20);
    const unique = values.filter((value, index) => values.indexOf(value) === index);
    const text = normalize(unique.join("\n\n")).slice(0, 120000);
    return {
      title: normalize(document.querySelector("meta[property='og:title']")?.getAttribute("content") || document.querySelector("h1")?.textContent || document.title) || "Imported article",
      text,
      canonical: document.querySelector("link[rel='canonical']")?.getAttribute("href") || document.querySelector("meta[property='og:url']")?.getAttribute("content") || location.href,
      sourceUrl: location.href,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      characterCount: text.length,
      truncated: text.length >= 120000
    };
  });
}

const browser = await chromium.launch({ headless });
const context = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1440, height: 900 },
  userAgent: "Mozilla/5.0 (compatible; PolarisContentCrawler/1.0)"
});
const page = await context.newPage();

try {
  console.log(`Opening ${target.toString()}`);
  await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3_000);

  let title = await page.title();
  let bodyText = await page.locator("body").innerText().catch(() => "");
  if (isVerification(bodyText, title)) {
    if (headless) throw new Error("This page requires human verification. Run without --headless and complete it in the browser window.");
    console.log("A human verification page was detected.");
    console.log(`Complete the verification in the opened browser window. Waiting up to ${verificationTimeout}ms...`);
    const started = Date.now();
    while (Date.now() - started < verificationTimeout) {
      await page.waitForTimeout(1_000);
      title = await page.title();
      bodyText = await page.locator("body").innerText().catch(() => "");
      if (!isVerification(bodyText, title) && bodyText.length > 300) break;
    }
    if (isVerification(bodyText, title)) throw new Error("Verification was not completed before timeout");
  }

  const article = await extractPage(page);
  if (!article.text || article.text.length < 80) throw new Error("Could not find enough article text on the page");
  const result = { ...article, fetchedAt: new Date().toISOString(), crawlerMode: "playwright" };
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`Saved ${result.wordCount.toLocaleString()} words to ${output}`);
} catch (error) {
  console.error(`Crawler failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
