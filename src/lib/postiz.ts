import { createHmac } from "node:crypto";
import { openAsBlob } from "node:fs";
import sharp from "sharp";
import type { SocialAccount } from "./types";
import { youtubePostError } from "./post-types";
import { imageSelectionError } from "./image-types";
import { DEFAULT_PLATFORMS, type SocialPlatform } from "./types";

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

export async function createPostizAuthorizationUrl(provider: SocialPlatform | "linkedin-page", redirectUrl: string): Promise<string> {
  if (provider !== "linkedin-page" && provider !== "youtube" && !DEFAULT_PLATFORMS.includes(provider)) {
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
    if (provider === "x" && ["api.x.com", "api.twitter.com", "x.com", "twitter.com"].includes(parsedUrl.hostname)
      && ["/oauth/authenticate", "/oauth/authorize"].includes(parsedUrl.pathname)) {
      // Postiz reuses X's signed-in account by default; adding an account must allow a different login.
      parsedUrl.searchParams.set("force_login", "true");
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
  title?: string;
  content: string;
  imageUrl?: string;
  uploadedMedia?: { id: string; path: string };
  uploadedImages?: Array<{ id: string; path: string }>;
  platform?: string;
}

const DEFAULT_POSTIZ_SETTINGS: Record<string, object> = {
  x: { __type: "x", who_can_reply_post: "everyone" },
  instagram: { __type: "instagram", post_type: "post" },
  "instagram-standalone": { __type: "instagram-standalone", post_type: "post" },
  facebook: { __type: "facebook", post_type: "post" },
  threads: { __type: "threads" },
  linkedin: { __type: "linkedin" }
};

/** Only server-registered media can become a preview redirect; never accept a browser-supplied URL. */
export function getTrustedPostizMediaUrl(path: string): string {
  const config = getPostizConfig();
  if (!config) throw new PostizConnectionError("Postiz is not configured on the server.", 503);
  try {
    const mediaUrl = new URL(path);
    if (!/^https?:$/.test(mediaUrl.protocol) || mediaUrl.username || mediaUrl.password
      || path.includes(config.apiKey) || decodeURIComponent(path).includes(config.apiKey)) throw new Error();
    const explicitOrigins = process.env.POSTIZ_MEDIA_ORIGINS?.trim();
    // The documented cloud upload response uses uploads.postiz.com; self-hosted origins remain explicit.
    const allowedOrigins = explicitOrigins
      ? explicitOrigins.split(/[\s,]+/).map(origin => {
        const parsedOrigin = new URL(origin);
        if (!/^https?:$/.test(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password
          || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) throw new Error();
        return parsedOrigin.origin;
      })
      : [new URL(config.apiUrl).origin, new URL(getPostizUiUrl() || config.apiUrl).origin, "https://uploads.postiz.com"];
    if (!allowedOrigins.includes(mediaUrl.origin)) throw new Error();
    return mediaUrl.href;
  } catch {
    throw new PostizConnectionError("Postiz returned an untrusted media URL. Ask an administrator to check POSTIZ_MEDIA_ORIGINS.", 502);
  }
}

/** File-backed Blob keeps the 100 MiB video off the JavaScript heap; no image helper behavior changes. */
export async function uploadVideoFileToPostiz(filePath: string, signal?: AbortSignal): Promise<{ id: string; path: string }> {
  const config = getPostizConfig();
  if (!config) throw new PostizConnectionError("Postiz is not configured on the server.", 503);
  const uploadSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180_000)]);
  try {
    uploadSignal.throwIfAborted();
    const file = await openAsBlob(filePath, { type: "video/mp4" });
    const form = new FormData();
    form.append("file", file, "video.mp4");
    form.append("adjust", "false");
    // Await the aborting fetch itself: racing it against cancellation would delete a still-read file.
    const response = await fetch(`${getPostizApiBaseUrl(config.apiUrl)}/public/v1/upload`, {
      method: "POST", headers: { Authorization: config.apiKey }, body: form,
      redirect: "error", cache: "no-store", signal: uploadSignal
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PostizConnectionError(`Postiz could not store the video (HTTP ${response.status}). Try uploading again.`);
    }
    if (!response.body) throw new PostizConnectionError("Postiz returned an invalid video upload response.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 64 * 1024) {
          await reader.cancel().catch(() => undefined);
          throw new PostizConnectionError("Postiz returned an invalid video upload response.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    if (!isPostizRecord(data) || typeof data.id !== "string" || !data.id.trim() || data.id.length > 191
      || typeof data.path !== "string" || data.path.length > 4096 || (data.status !== undefined && data.status !== "ready")) {
      throw new PostizConnectionError("Postiz returned an invalid or unfinished video upload response.");
    }
    uploadSignal.throwIfAborted();
    return { id: data.id, path: getTrustedPostizMediaUrl(data.path) };
  } catch (error) {
    if (error instanceof PostizConnectionError) throw error;
    throw new PostizConnectionError("The video could not be stored in Postiz. Try uploading again.");
  }
}

const MAX_POSTIZ_IMAGE_BYTES = 30 * 1024 * 1024;
// Article images need not meet the editor's 2048px cap; bound decoder resources to 40 megapixels.
const MAX_POSTIZ_IMAGE_PIXELS = 40_000_000;

async function uploadMediaToPostiz(
  config: PostizConfig,
  imageUrl: string,
  signal?: AbortSignal
): Promise<{ id: string; path: string } | null> {
  try {
    signal?.throwIfAborted();
    let buffer: Buffer;
    if (imageUrl.startsWith("data:")) {
      // Reject encoded size before the regex captures or Buffer.from allocates decoded bytes.
      if (imageUrl.length > 4 * Math.ceil(MAX_POSTIZ_IMAGE_BYTES / 3) + 64) return null;
      const match = imageUrl.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) return null;
      buffer = Buffer.from(match[1], "base64");
    } else {
      const res = await fetch(imageUrl, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      if (Number(res.headers.get("content-length")) > MAX_POSTIZ_IMAGE_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!res.body) return null;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_POSTIZ_IMAGE_BYTES) {
            await reader.cancel().catch(() => undefined);
            return null;
          }
          chunks.push(value);
        }
        buffer = Buffer.concat(chunks, bytes);
      } finally {
        reader.releaseLock();
      }
    }

    if (!buffer.length || buffer.length > MAX_POSTIZ_IMAGE_BYTES) return null;
    const image = sharp(buffer, { failOn: "warning", limitInputPixels: MAX_POSTIZ_IMAGE_PIXELS, animated: false });
    const metadata = await image.metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)
      || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) return null;
    // Metadata alone accepts some corrupt files. Force pixel decoding without changing uploaded bytes.
    await image.resize(1, 1, { fit: "inside" }).raw().toBuffer();
    const mimeType = `image/${metadata.format}`;
    const filename = `upload.${metadata.format === "jpeg" ? "jpg" : metadata.format}`;

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

    signal?.throwIfAborted();
    const base = getPostizApiBaseUrl(config.apiUrl);
    const uploadRes = await fetch(`${base}/public/v1/upload`, {
      method: "POST",
      headers: {
        Authorization: config.apiKey
      },
      body: form,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
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
  } catch {
    console.error("[postiz] image validation or upload failed");
    return null;
  }
}

export async function uploadImageToPostiz(imageUrl: string, signal?: AbortSignal): Promise<{ id: string; path: string } | null> {
  const config = getPostizConfig();
  return config ? uploadMediaToPostiz(config, imageUrl, signal) : null;
}

export interface PostizPostDetails {
  id: string;
  state: "DRAFT" | "QUEUE" | "PUBLISHED" | "ERROR";
  saveAction?: "pass" | "update" | "draft" | "schedule" | "now" | null;
  group?: string;
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
      if (post.saveAction === null || post.saveAction === "pass" || post.saveAction === "update"
        || post.saveAction === "draft" || post.saveAction === "schedule" || post.saveAction === "now") {
        details.saveAction = post.saveAction;
      }
      if (typeof post.group === "string") details.group = post.group;
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
 * points at a draft that an administrator reviews and promotes inside Postiz. The required `date`
 * field does not schedule anything while the request's type is fixed to "draft".
 */
export async function publishToPostiz(req: PostizPublishRequest): Promise<{ success: boolean; postId?: string; error?: string; warning?: string }> {
  const config = getPostizConfig();
  if (!config) {
    return { success: false, error: "Postiz is not configured. Please set POSTIZ_API_URL and POSTIZ_API_KEY in environment." };
  }

  if (req.uploadedMedia || req.uploadedImages !== undefined || req.platform?.toLowerCase() === "youtube") return createStrictDraft(req);
  let images: Array<{ id: string; path: string }> = [];
  if (req.imageUrl) {
    const uploaded = await uploadMediaToPostiz(config, req.imageUrl);
    if (uploaded) {
      images = [uploaded];
    } else {
      return { success: false, error: "The post image could not be validated or uploaded. No draft was created." };
    }
  }

  const result = await createDraftPost(config, draftPayload(req, images));
  if (!result.ok) return { success: false, error: result.error };
  // Acceptance and tracking are separate: never invent an ID or invite a duplicate submission.
  return result.postId
    ? { success: true, postId: result.postId }
    : { success: true, warning: "Postiz accepted the draft, but post tracking is unavailable because it returned no post ID." };
}

/**
 * Builds the create-draft payload. The `date` is required by the Postiz create endpoint and is the
 * moment the draft was written, not a publish time: promoting the draft inside Postiz sets the real
 * one, and `type` stays "draft" so nothing here can go live on its own.
 * Contract: https://docs.postiz.com/public-api/posts/create
 */
function draftPayload(req: PostizPublishRequest, images: Array<{ id: string; path: string }>) {
  const normalizedPlatform = (req.platform || "x").toLowerCase();
  const settings = normalizedPlatform === "youtube"
    ? { __type: "youtube", title: req.title?.trim() || "", type: "private" }
    : DEFAULT_POSTIZ_SETTINGS[normalizedPlatform] || { __type: normalizedPlatform };

  return {
    type: "draft",
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
}

type DraftPostResult =
  | { ok: true; postId: string | null }
  | { ok: false; error: string; uncertain: boolean };

/**
 * Creates one Postiz draft. A transport failure is reported as uncertain because the request may
 * still have been processed upstream; HTTP error responses are definite refusals.
 */
async function createDraftPost(config: PostizConfig, payload: object): Promise<DraftPostResult> {
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
      redirect: "error",
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, uncertain: false, error: `Postiz API error (${response.status}). The draft could not be created.` };
    }

    const responseData: unknown = await response.json().catch(() => null);
    const firstItem: unknown = Array.isArray(responseData) ? responseData[0] : responseData;
    if (isPostizRecord(firstItem)) {
      for (const upstreamId of [firstItem.postId, firstItem.id]) {
        if (typeof upstreamId === "string" && upstreamId.trim()) {
          return { ok: true, postId: upstreamId };
        }
      }
    }
    return { ok: true, postId: null };
  } catch {
    return { ok: false, uncertain: true, error: "The connection to Postiz was interrupted. Check Postiz before retrying this draft." };
  }
}

export interface StrictDraftResult {
  success: boolean;
  postId?: string;
  error?: string;
  warning?: string;
  /**
   * True when the create call failed at the transport layer: Postiz may or may not have created the
   * draft, so callers must not retry automatically.
   */
  uncertain?: boolean;
}

/**
 * Creates a Postiz draft for content that must not degrade silently. A failed image upload aborts
 * the submission instead of sending a text-only draft, and transport
 * failures are flagged as uncertain so the caller can record "needs review" instead of a failure.
 * Polaris still only ever creates drafts.
 */
export async function createStrictDraft(req: PostizPublishRequest): Promise<StrictDraftResult> {
  const config = getPostizConfig();
  if (!config) {
    return { success: false, error: "Postiz is not configured on the server. Set POSTIZ_API_URL and POSTIZ_API_KEY." };
  }

  if (req.uploadedImages !== undefined && (!Array.isArray(req.uploadedImages) || req.imageUrl !== undefined)) {
    return { success: false, error: "Choose uploaded images or an inline image, not both. No draft was created." };
  }
  const mediaError = imageSelectionError(req.platform || "x", req.uploadedImages?.length ?? Number(Boolean(req.imageUrl)), Boolean(req.uploadedMedia));
  if (mediaError) return { success: false, error: mediaError };
  if (req.uploadedMedia && req.imageUrl) {
    return { success: false, error: "Choose either an image or an uploaded video, not both. No draft was created." };
  }
  if (req.platform?.toLowerCase() === "youtube") {
    const error = youtubePostError(req.title, req.content, Boolean(req.uploadedMedia));
    if (error) return { success: false, error };
  }
  let images: Array<{ id: string; path: string }> = [];
  if (req.uploadedMedia) {
    try {
      if (!req.uploadedMedia.id.trim() || req.uploadedMedia.id.length > 191) throw new Error();
      images = [{ id: req.uploadedMedia.id, path: getTrustedPostizMediaUrl(req.uploadedMedia.path) }];
    } catch {
      return { success: false, error: "The uploaded video reference is invalid. Upload it again. No draft was created." };
    }
  }
  if (req.uploadedImages?.length) {
    try {
      images = req.uploadedImages.map(image => {
        if (!image.id.trim() || image.id.length > 191) throw new Error();
        return { id: image.id, path: getTrustedPostizMediaUrl(image.path) };
      });
    } catch {
      return { success: false, error: "The uploaded image references are invalid. Upload them again. No draft was created." };
    }
  }
  if (req.imageUrl) {
    const uploaded = await uploadMediaToPostiz(config, req.imageUrl);
    if (!uploaded) {
      // No create call happens here, so the result is a definite failure rather than uncertain.
      return { success: false, error: "The post image could not be uploaded to Postiz. No draft was created for this account." };
    }
    images = [uploaded];
  }

  const result = await createDraftPost(config, draftPayload(req, images));
  if (!result.ok) {
    return { success: false, error: result.error, ...(result.uncertain ? { uncertain: true } : {}) };
  }
  return result.postId
    ? { success: true, postId: result.postId }
    : { success: true, warning: "Postiz accepted the draft but returned no post ID, so publication tracking is unavailable." };
}
