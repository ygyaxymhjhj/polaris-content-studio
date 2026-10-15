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
  platform?: string;
}

const DEFAULT_POSTIZ_SETTINGS: Record<string, object> = {
  x: { __type: "x", who_can_reply_post: "everyone" },
  instagram: { __type: "instagram", post_type: "post" },
  facebook: { __type: "facebook", post_type: "post" },
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

export interface PostizPostDetails {
  id: string;
  state: "DRAFT" | "QUEUE" | "PUBLISHED" | "ERROR";
  releaseUrl?: string;
  publishDate?: string;
}

const MAX_POSTIZ_POST_RESPONSE_BYTES = 10 * 1024 * 1024;

function isPostizRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPostizPostState(state: unknown): state is PostizPostDetails["state"] {
  return state === "DRAFT" || state === "QUEUE" || state === "PUBLISHED" || state === "ERROR";
}

function validatePostizReleaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const releaseUrl = new URL(value);
    if ((releaseUrl.protocol !== "http:" && releaseUrl.protocol !== "https:") || releaseUrl.username || releaseUrl.password) {
      return undefined;
    }
    return releaseUrl.href;
  } catch {
    return undefined;
  }
}

function validatePostizPublishDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const isoDateTime = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  const dateMatch = value.match(isoDateTime);
  if (!dateMatch || !Number.isFinite(Date.parse(value))) return undefined;
  // Date.parse normalizes impossible calendar dates such as February 30.
  const calendarDate = new Date(`${dateMatch[1]}T00:00:00Z`);
  if (calendarDate.toISOString().slice(0, 10) !== dateMatch[1]) return undefined;
  return value;
}

async function readPostizPostsResponse(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > MAX_POSTIZ_POST_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new PostizConnectionError("Postiz returned too many posts. Retry with a smaller date range.");
  }
  if (!response.body) throw new PostizConnectionError("Postiz returned an invalid posts response.");

  const reader = response.body.getReader();
  const responseChunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (responseBytes > MAX_POSTIZ_POST_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PostizConnectionError("Postiz returned too many posts. Retry with a smaller date range.");
      }
      responseChunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(responseChunks, responseBytes).toString("utf8"));
}

/**
 * Lists requested posts in the caller's complete date range; missing/unknown posts are omitted.
 * GET /posts has no pagination: docs.postiz.com/public-api/posts/list and upstream GetPostsDto /
 * PostsRepository.getPosts expose only date range/customer, with no take/skip/cursor. Callers may
 * split large ranges into weeks; this function never silently truncates to the last 30 days.
 */
export async function fetchPostizPostDetails(
  postIds: string[],
  range: { startDate: Date; endDate: Date }
): Promise<Map<string, PostizPostDetails>> {
  const detailsById = new Map<string, PostizPostDetails>();
  if (postIds.length === 0) return detailsById;

  if (!(range.startDate instanceof Date) || !(range.endDate instanceof Date)
    || !Number.isFinite(range.startDate.getTime()) || !Number.isFinite(range.endDate.getTime())
    || range.startDate > range.endDate) {
    throw new PostizConnectionError("Select a valid Postiz post date range.", 400);
  }

  const config = getPostizConfig();
  if (!config) {
    throw new PostizConnectionError("Postiz is not configured on the server.", 503);
  }

  try {
    const listUrl = new URL(`${getPostizApiBaseUrl(config.apiUrl)}/public/v1/posts`);
    listUrl.searchParams.set("startDate", range.startDate.toISOString());
    listUrl.searchParams.set("endDate", range.endDate.toISOString());

    const response = await fetch(listUrl, {
      method: "GET",
      headers: {
        Authorization: config.apiKey,
        "x-api-key": config.apiKey
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PostizConnectionError(`Postiz could not list posts (HTTP ${response.status}). Please try again.`);
    }

    const data = await readPostizPostsResponse(response);
    if (!isPostizRecord(data) || !Array.isArray(data.posts)) {
      throw new PostizConnectionError("Postiz returned an invalid posts response.");
    }

    const requestedIds = new Set(postIds);
    for (const post of data.posts) {
      if (!isPostizRecord(post) || typeof post.id !== "string" || !post.id.trim()
        || !requestedIds.has(post.id) || !isPostizPostState(post.state)) continue;
      const details: PostizPostDetails = { id: post.id, state: post.state };
      const releaseUrl = validatePostizReleaseUrl(post.releaseURL);
      const publishDate = validatePostizPublishDate(post.publishDate);
      if (releaseUrl) details.releaseUrl = releaseUrl;
      if (publishDate) details.publishDate = publishDate;
      detailsById.set(post.id, details);
    }
    return detailsById;
  } catch (error) {
    if (error instanceof PostizConnectionError) throw error;
    // Provider bodies and transport errors can contain credentials or private account details.
    throw new PostizConnectionError("Could not read posts from Postiz. Please try again.");
  }
}

/** Legacy status client: the last 30 days only; missing posts or connection errors return null. */
export async function fetchPostizPostStatus(postIds: string[]): Promise<Map<string, string | null>> {
  const statuses = new Map<string, string | null>(postIds.map(postId => [postId, null]));
  if (postIds.length === 0) return statuses;
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  try {
    const details = await fetchPostizPostDetails(postIds, { startDate, endDate });
    for (const postId of postIds) statuses.set(postId, details.get(postId)?.state ?? null);
  } catch {
    // Existing browser clients depend on null-on-error; workers must use the throwing details API.
  }
  return statuses;
}

/**
 * Hands one asset to Postiz as a draft. Polaris never publishes or schedules: the returned post id
 * points at a draft that an administrator reviews and promotes inside Postiz. The request carries
 * no publish time, so nothing here can turn into a live post.
 */
export async function publishToPostiz(req: PostizPublishRequest): Promise<{ success: boolean; postId?: string; error?: string; warning?: string }> {
  const config = getPostizConfig();
  if (!config) {
    return { success: false, error: "Postiz is not configured. Please set POSTIZ_API_URL and POSTIZ_API_KEY in environment." };
  }

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
    type: "draft",
    // Postiz requires a date on every create call, drafts included. It is the moment the draft was
    // written, not a publish time; promoting the draft in Postiz sets the real one.
    date: new Date().toISOString(),
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

    const responseData: unknown = await response.json().catch(() => null);
    const firstItem: unknown = Array.isArray(responseData) ? responseData[0] : responseData;
    if (isPostizRecord(firstItem)) {
      for (const upstreamId of [firstItem.postId, firstItem.id]) {
        if (typeof upstreamId === "string" && upstreamId.trim()) {
          return { success: true, postId: upstreamId };
        }
      }
    }
    // Acceptance and tracking are separate: never invent an ID or invite a duplicate submission.
    return { success: true, warning: "Postiz accepted the draft, but post tracking is unavailable because it returned no post ID." };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create the Postiz draft"
    };
  }
}
