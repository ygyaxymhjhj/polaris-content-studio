import type { SocialAccount } from "./types";

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

export async function fetchPostizIntegrations(): Promise<{ configured: boolean; accounts: SocialAccount[]; error?: string }> {
  const config = getPostizConfig();
  if (!config) {
    return { configured: false, accounts: [] };
  }
  try {
    const response = await fetch(`${config.apiUrl}/public/v1/integrations`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
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
    return {
      configured: true,
      accounts: [],
      error: error instanceof Error ? error.message : "Failed to connect to Postiz service"
    };
  }
}

export interface PostizPublishRequest {
  integrationId: string;
  content: string;
  imageUrl?: string;
  publishAt?: string;
}

export async function publishToPostiz(req: PostizPublishRequest): Promise<{ success: boolean; postId?: string; url?: string; error?: string }> {
  const config = getPostizConfig();
  if (!config) {
    return { success: false, error: "Postiz is not configured. Please set POSTIZ_API_URL and POSTIZ_API_KEY in environment." };
  }

  const isScheduled = Boolean(req.publishAt && new Date(req.publishAt).getTime() > Date.now());
  const postDate = isScheduled && req.publishAt ? new Date(req.publishAt).toISOString() : new Date().toISOString();
  const media = req.imageUrl ? [{ type: "image", url: req.imageUrl }] : [];

  const payload = {
    type: isScheduled ? "schedule" : "now",
    date: postDate,
    posts: [
      {
        integration: { id: req.integrationId },
        value: {
          content: req.content,
          ...(media.length ? { media, image: [req.imageUrl] } : {})
        }
      }
    ]
  };

  try {
    const response = await fetch(`${config.apiUrl}/public/v1/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "x-api-key": config.apiKey
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return { success: false, error: `Postiz API error (${response.status}): ${errText.slice(0, 200)}` };
    }

    const resJson = await response.json().catch(() => ({}));
    const postId = resJson.id || resJson.postId || (Array.isArray(resJson) && resJson[0]?.id) || "post-" + Date.now();
    const url = resJson.url || resJson.permalink || (Array.isArray(resJson) && resJson[0]?.url) || undefined;

    return { success: true, postId: String(postId), url };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to publish post to Postiz"
    };
  }
}
