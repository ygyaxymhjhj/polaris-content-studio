import { createHmac } from "node:crypto";
import type { SocialAccount } from "./types";
import { DEFAULT_PLATFORMS, type Platform } from "./types";

export interface PostizConfig {
  apiUrl: string;
  apiKey: string;
}

export function getPostizConfig(): PostizConfig | null {
  const apiUrl = (process.env.POSTIZ_API_URL || "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.POSTIZ_API_KEY || "").trim();
  if (!apiUrl || !apiKey) return null;
  return { apiUrl, apiKey };
}

export function getPostizApiBaseUrl(apiUrl: string): string {
  const baseUrl = apiUrl.replace(/\/+$/, "").replace(/\/public\/v1$/, "");
  return baseUrl.endsWith("/api") ? baseUrl : `${baseUrl}/api`;
}

export function isPostizOAuthConfigured(): boolean {
  return Boolean(getPostizConfig() && process.env.POSTIZ_JWT_SECRET?.trim());
}

export class PostizConnectionError extends Error {
  constructor(message: string, public readonly status: number = 502) {
    super(message);
    this.name = "PostizConnectionError";
  }
}

export async function createPostizAuthorizationUrl(provider: Platform, redirectUrl: string): Promise<string> {
  if (!DEFAULT_PLATFORMS.includes(provider)) {
    throw new PostizConnectionError("Select a supported platform.", 400);
  }
  const config = getPostizConfig();
  if (!config) {
    throw new PostizConnectionError("Postiz is not configured on the server. Set POSTIZ_API_URL and POSTIZ_API_KEY.", 503);
  }
  const secret = process.env.POSTIZ_JWT_SECRET?.trim();
  if (!secret) {
    throw new PostizConnectionError("Direct authorisation requires POSTIZ_JWT_SECRET to match the Postiz server's JWT_SECRET.", 503);
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  // Accounts are fetched live from Postiz, so no public webhook or local account mirror is needed.
  const payload = Buffer.from(JSON.stringify({
    apiKey: config.apiKey, provider, redirectUrl, webhookUrl: "", iat: issuedAt, exp: issuedAt + 600
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");

  try {
    const response = await fetch(`${getPostizApiBaseUrl(config.apiUrl)}/enterprise/url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: `${header}.${payload}.${signature}` }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
    if (response.status === 404) {
      throw new PostizConnectionError("This Postiz instance does not support direct authorisation. Open Postiz to connect instead.");
    }
    if (!response.ok) {
      throw new PostizConnectionError("Postiz could not create an authorisation link. Check its API key, JWT secret and platform configuration.");
    }

    const responseText = (await response.text()).trim();
    let authorizationUrl: unknown = responseText;
    try { authorizationUrl = JSON.parse(responseText); } catch { /* Postiz versions return either a string or a JSON string. */ }
    if (typeof authorizationUrl !== "string" || !authorizationUrl) {
      throw new PostizConnectionError("Postiz could not create an authorisation link. Check its API key, JWT secret and platform configuration.");
    }
    const parsedUrl = new URL(authorizationUrl);
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
      throw new PostizConnectionError("Postiz returned an invalid authorisation link.");
    }
    return parsedUrl.href;
  } catch (error) {
    if (error instanceof PostizConnectionError) throw error;
    // Never expose a provider response or a signed params token: it contains the server API key.
    throw new PostizConnectionError("Could not reach Postiz to start authorisation. Please try again.");
  }
}

/**
 * Browser-reachable Postiz base URL for the "connect a new channel" hand-off.
 * The server may reach Postiz via localhost while members browse over the LAN
 * address, so POSTIZ_UI_URL wins when set; otherwise POSTIZ_API_URL with an
 * "/api" suffix stripped is the best guess.
 */
export function getPostizUiUrl(): string | null {
  const explicit = (process.env.POSTIZ_UI_URL || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const config = getPostizConfig();
  if (!config) return null;
  return getPostizApiBaseUrl(config.apiUrl).replace(/\/api$/, "") || null;
}

export async function fetchPostizIntegrations(): Promise<{ configured: boolean; accounts: SocialAccount[]; error?: string }> {
  const config = getPostizConfig();
  if (!config) {
    return { configured: false, accounts: [] };
  }
  try {
    const base = getPostizApiBaseUrl(config.apiUrl);
    const response = await fetch(`${base}/public/v1/integrations`, {
      method: "GET",
      headers: {
        Authorization: config.apiKey,
        "x-api-key": config.apiKey
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { configured: true, accounts: [], error: `Postiz API error (${response.status}): ${text.slice(0, 160)}` };
    }
    const data = (await response.json()) as unknown;
    interface RawIntegration {
      id?: string | number;
      identifier?: string;
      name?: string;
      username?: string;
      provider?: string;
      type?: string;
      picture?: string;
      disabled?: boolean;
    }
    const list = Array.isArray(data) ? (data as RawIntegration[]) : Array.isArray((data as { data?: unknown })?.data) ? ((data as { data: RawIntegration[] }).data) : [];
    const accounts: SocialAccount[] = list.map((item) => ({
      id: String(item.id || item.identifier || ""),
      name: String(item.name || item.username || item.identifier || "Social Account"),
      identifier: String(item.identifier || item.provider || item.type || "").toLowerCase(),
      picture: typeof item.picture === "string" ? item.picture : undefined,
      disabled: Boolean(item.disabled)
    })).filter(a => a.id);
    return { configured: true, accounts };
  } catch (error) {
    const cause = error instanceof Error && (error as { cause?: { message?: string; code?: string } }).cause;
    const detail = cause ? `${error instanceof Error ? error.message : "Error"} (${cause.code || cause.message || String(cause)})` : (error instanceof Error ? error.message : "Failed to connect");
    return {
      configured: true,
      accounts: [],
      error: detail
    };
  }
}

export interface PostizPublishRequest {
  integrationId: string;
  content: string;
  imageUrl?: string;
  publishAt?: string;
  platform?: string;
}

const DEFAULT_POSTIZ_SETTINGS: Record<string, object> = {
  x: { __type: "x", who_can_reply_post: "everyone" },
  instagram: { __type: "instagram", post_type: "post" },
  facebook: { __type: "facebook" },
  threads: { __type: "threads" },
  linkedin: { __type: "linkedin" }
};

async function uploadMediaToPostiz(
  config: PostizConfig,
  imageUrl: string
): Promise<{ id: string; path: string } | null> {
  try {
    let buffer: Buffer;
    let mimeType = "image/jpeg";
    let filename = "image.jpg";

    if (imageUrl.startsWith("data:")) {
      const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return null;
      mimeType = match[1];
      buffer = Buffer.from(match[2], "base64");
      const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
      filename = `upload.${ext}`;
    } else {
      const res = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      buffer = Buffer.from(await res.arrayBuffer());
      const headerType = res.headers.get("content-type");
      if (headerType) mimeType = headerType.split(";")[0].trim();
      const pathname = new URL(imageUrl).pathname;
      const name = pathname.split("/").pop();
      if (name && name.includes(".")) {
        filename = name;
      } else {
        const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
        filename = `upload.${ext}`;
      }
    }

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

    const base = getPostizApiBaseUrl(config.apiUrl);
    const uploadRes = await fetch(`${base}/public/v1/upload`, {
      method: "POST",
      headers: {
        Authorization: config.apiKey
      },
      body: form,
      signal: AbortSignal.timeout(30000)
    });

    if (!uploadRes.ok) {
      console.error("[postiz] upload failed with status", uploadRes.status);
      return null;
    }

    const data = (await uploadRes.json()) as { id?: string; path?: string };
    if (data?.id && data?.path) {
      return { id: String(data.id), path: String(data.path) };
    }
    return null;
  } catch (err) {
    console.error("[postiz] upload media error", err);
    return null;
  }
}

function extractPostizError(errorRaw: unknown): string {
  if (!errorRaw) return "Postiz 投递失败，未返回具体原因";
  try {
    const str = typeof errorRaw === "string" ? errorRaw : JSON.stringify(errorRaw);
    if (str.includes("credits-depleted") || str.includes("credits depleted")) {
      return "X (Twitter) 开发者账号 API 额度已耗尽 (HTTP 402: credits depleted)，请在 X Developer Portal 检查或充值 API 额度";
    }
    if (str.includes("Status is a duplicate") || str.includes("duplicate")) {
      return "推文内容重复，被平台风控拦截 (duplicate post)";
    }
    if (str.includes("User is over daily status update limit")) {
      return "已达每日发帖频率上限 (daily status limit exceeded)";
    }
    const match = str.match(/"detail":"([^"]+)"/);
    if (match) return `平台返回错误: ${match[1]}`;
    const msgMatch = str.match(/"message":"([^"]+)"/);
    if (msgMatch) return `投递错误: ${msgMatch[1]}`;
    return `投递失败: ${str.slice(0, 150)}`;
  } catch {
    return String(errorRaw).slice(0, 150);
  }
}

export async function publishToPostiz(req: PostizPublishRequest): Promise<{ success: boolean; postId?: string; url?: string; queued?: boolean; error?: string }> {
  const config = getPostizConfig();
  if (!config) {
    return { success: false, error: "Postiz is not configured. Please set POSTIZ_API_URL and POSTIZ_API_KEY in environment." };
  }

  const isScheduled = Boolean(req.publishAt && new Date(req.publishAt).getTime() > Date.now());
  const postDate = isScheduled && req.publishAt ? new Date(req.publishAt).toISOString() : new Date().toISOString();

  let images: Array<{ id: string; path: string }> = [];
  if (req.imageUrl) {
    const uploaded = await uploadMediaToPostiz(config, req.imageUrl);
    if (uploaded) {
      images = [uploaded];
    } else {
      console.warn("[postiz] image upload failed or was skipped; proceeding with text-only post");
    }
  }

  const normalizedPlatform = (req.platform || "x").toLowerCase();
  const settings = DEFAULT_POSTIZ_SETTINGS[normalizedPlatform] || { __type: normalizedPlatform };

  const payload = {
    type: isScheduled ? "schedule" : "now",
    date: postDate,
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: req.integrationId },
        value: [
          {
            content: req.content,
            image: images
          }
        ],
        settings
      }
    ]
  };

  try {
    const base = getPostizApiBaseUrl(config.apiUrl);
    const response = await fetch(`${base}/public/v1/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: config.apiKey,
        "x-api-key": config.apiKey
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return { success: false, error: `Postiz API error (${response.status}): ${errText.slice(0, 300)}` };
    }

    const resJson = await response.json().catch(() => ({}));
    const firstItem = Array.isArray(resJson) ? resJson[0] : resJson;
    const postId = firstItem?.postId || firstItem?.id;

    if (!postId) {
      return { success: true, postId: "post-" + Date.now() };
    }

    // For scheduled posts, Postiz simply stores the schedule in its queue
    if (isScheduled) {
      return { success: true, postId: String(postId), queued: true };
    }

    // For immediate posts, poll Postiz for the execution state to ensure it actually went live
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const checkRes = await fetch(`${base}/public/posts/${encodeURIComponent(postId)}`, {
          headers: { Authorization: config.apiKey, "x-api-key": config.apiKey },
          signal: AbortSignal.timeout(8000)
        });
        if (!checkRes.ok) continue;
        const checkData = await checkRes.json();
        const postDetail = Array.isArray(checkData) ? checkData[0] : checkData;
        if (!postDetail) continue;

        if (postDetail.state === "PUBLISHED") {
          return {
            success: true,
            postId: String(postId),
            url: postDetail.releaseURL || undefined
          };
        }

        if (postDetail.state === "ERROR") {
          return {
            success: false,
            postId: String(postId),
            error: extractPostizError(postDetail.error)
          };
        }
      } catch {
        // Continue polling if a single status check times out
      }
    }

    // If still queued/processing after polling window, mark as queued
    return { success: true, postId: String(postId), queued: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to publish post to Postiz"
    };
  }
}
