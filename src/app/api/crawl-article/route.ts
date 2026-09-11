import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 180;

const CRAWLER_TIMEOUT = 120_000;

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isPrivateIp(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80");
  return false;
}

async function assertSafeUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "localhost.localdomain" || hostname.endsWith(".local") || hostname.endsWith(".internal") || isPrivateIp(hostname)) {
    throw new Error("This URL is not allowed");
  }

  if (!isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true });
    if (addresses.some(({ address }) => isPrivateIp(address))) throw new Error("This URL resolves to a private network address");
  }

  return url;
}

function runCrawler(url: string, output: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const script = path.join(process.cwd(), "scripts", "crawl-article.mjs");
    const child = spawn(process.execPath, [script, url, `--output=${output}`, `--timeout=${CRAWLER_TIMEOUT}`], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The browser crawler timed out. Complete the verification within two minutes and try again."));
    }, CRAWLER_TIMEOUT + 45_000);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `Browser crawler exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function POST(request: Request) {
  let workdir: string | undefined;
  try {
    const body = await request.json() as { url?: string };
    const rawUrl = String(body.url || "").trim();
    if (!rawUrl) return NextResponse.json({ error: "Please enter an article URL" }, { status: 400 });

    const url = await assertSafeUrl(rawUrl);
    if (process.env.ARTICLE_CRAWLER_LOCAL_BROWSER === "false") {
      return NextResponse.json({
        error: "This deployment does not have an interactive browser crawler. Ask the site owner for API/RSS access, or upload/paste the article.",
        code: "MANUAL_CRAWLER_DISABLED"
      }, { status: 409 });
    }

    workdir = await mkdtemp(path.join(tmpdir(), "polaris-article-"));
    const output = path.join(workdir, "article.json");
    await runCrawler(url.toString(), output);
    const article = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    if (typeof article.text !== "string" || article.text.trim().length < 80) throw new Error("The crawler did not find enough article text");
    return NextResponse.json(article);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not crawl article";
    return NextResponse.json({ error: message, code: "ARTICLE_CRAWLER_FAILED" }, { status: 502 });
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
