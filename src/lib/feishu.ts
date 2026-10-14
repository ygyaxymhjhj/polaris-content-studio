import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { database } from "@/lib/project-db";

export type FeishuConfig = {
  enabled: boolean;
  notifyDrafts: boolean;
  notifyPublished: boolean;
  version: number;
  webhookUrl: string;
  signingSecret?: string;
};

export type FeishuSettings = {
  enabled: boolean;
  notifyDrafts: boolean;
  notifyPublished: boolean;
  webhookConfigured: boolean;
  signingConfigured: boolean;
  encryptionReady: boolean;
  version: number;
  updatedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastWorkerAt: string | null;
  lastDeliveryError: string | null;
};

export class FeishuError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 503, public readonly retryable = false) {
    super(message);
    this.name = "FeishuError";
  }
}

export function asFeishuError(error: unknown): FeishuError {
  return error instanceof FeishuError ? error : new FeishuError("Feishu settings are unavailable. Check the database migration and service configuration.", "FEISHU_UNAVAILABLE", 503, true);
}

type ConfigRow = RowDataPacket & {
  enabled: number; notify_drafts: number; notify_published: number;
  encrypted_credentials: string | null; version: number; updated_at: string;
  last_test_at: string | null; last_test_ok: number | null; last_test_error: string | null;
  last_worker_at: string | null; last_delivery_error: string | null;
};
type Credentials = { webhookUrl: string; signingSecret?: string };
const columns = "enabled, notify_drafts, notify_published, encrypted_credentials, version, updated_at, last_test_at, last_test_ok, last_test_error, last_worker_at, last_delivery_error";
const credentialsSchema = z.object({ webhookUrl: z.string(), signingSecret: z.string().max(2048).optional() }).strict();
export const feishuUpdateSchema = z.object({
  enabled: z.boolean(), notifyDrafts: z.boolean(), notifyPublished: z.boolean(),
  webhookUrl: z.string().max(2048).optional(), signingSecret: z.string().max(2048).optional(),
  clearWebhook: z.boolean().optional(), clearSigningSecret: z.boolean().optional()
}).strict().refine(input => !(input.clearWebhook && input.webhookUrl) && !(input.clearSigningSecret && input.signingSecret));
export type FeishuSettingsInput = z.infer<typeof feishuUpdateSchema>;

function encryptionKey(): Buffer {
  const encodedKey = process.env.FEISHU_ENCRYPTION_KEY;
  if (!encodedKey || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) {
    throw new FeishuError("Configure FEISHU_ENCRYPTION_KEY as a base64-encoded 32-byte key.", "FEISHU_ENCRYPTION_UNAVAILABLE");
  }
  const decodedKey = Buffer.from(encodedKey, "base64");
  if (decodedKey.length !== 32 || decodedKey.toString("base64") !== encodedKey) {
    throw new FeishuError("Configure FEISHU_ENCRYPTION_KEY as a base64-encoded 32-byte key.", "FEISHU_ENCRYPTION_UNAVAILABLE");
  }
  return decodedKey;
}

export function validateFeishuWebhook(webhookUrl: string): string {
  // Validate the original string too: URL normalization must not hide encoded paths or dot segments.
  if (!/^https:\/\/open\.feishu\.cn(?::443)?\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{16,128}$/.test(webhookUrl)) {
    throw new FeishuError("Use an official Feishu custom-bot HTTPS webhook without query parameters.", "FEISHU_INVALID_WEBHOOK", 400);
  }
  const parsedUrl = new URL(webhookUrl);
  if (parsedUrl.hostname !== "open.feishu.cn" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || (parsedUrl.port && parsedUrl.port !== "443")) {
    throw new FeishuError("Invalid Feishu webhook address.", "FEISHU_INVALID_WEBHOOK", 400);
  }
  return webhookUrl;
}

function encryptCredentials(credentials: Credentials, key: Buffer): string {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: initializationVector.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
}

function decryptCredentials(encryptedCredentials: string, key: Buffer): Credentials {
  try {
    const envelope = z.object({ version: z.literal(1), iv: z.string(), tag: z.string(), ciphertext: z.string() }).strict().parse(JSON.parse(encryptedCredentials));
    const initializationVector = Buffer.from(envelope.iv, "base64");
    const authenticationTag = Buffer.from(envelope.tag, "base64");
    if (initializationVector.length !== 12 || authenticationTag.length !== 16) throw new Error("Invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, initializationVector);
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
    const credentials = credentialsSchema.parse(JSON.parse(plaintext));
    validateFeishuWebhook(credentials.webhookUrl);
    return credentials;
  } catch {
    throw new FeishuError("Stored Feishu credentials could not be decrypted. Provide both a new webhook and signing secret, or a new webhook with clearSigningSecret=true; alternatively clearWebhook=true to reset.", "FEISHU_CREDENTIALS_INVALID");
  }
}

function safeSettings(row?: ConfigRow): FeishuSettings {
  let key: Buffer | undefined;
  try { key = encryptionKey(); } catch { /* GET remains available before the server key is configured. */ }
  let credentials: Credentials | undefined;
  let invalidCredentials = false;
  if (row?.encrypted_credentials && key) {
    try { credentials = decryptCredentials(row.encrypted_credentials, key); }
    catch { invalidCredentials = true; }
  }
  // Operational errors are deliberately classified instead of echoing arbitrary persisted provider text.
  const safeDiagnostic = (value: string | null | undefined) => value ? "Feishu delivery failed. Check credentials and service availability." : null;
  return {
    enabled: Number(row?.enabled) === 1, notifyDrafts: Number(row?.notify_drafts) === 1, notifyPublished: Number(row?.notify_published) === 1,
    webhookConfigured: Boolean(row?.encrypted_credentials), signingConfigured: Boolean(credentials?.signingSecret), encryptionReady: Boolean(key),
    version: Number(row?.version ?? 1), updatedAt: row?.updated_at ?? null,
    lastTestAt: row?.last_test_at ?? null, lastTestOk: row?.last_test_ok == null ? null : Number(row.last_test_ok) === 1,
    lastTestError: safeDiagnostic(row?.last_test_error), lastWorkerAt: row?.last_worker_at ?? null,
    lastDeliveryError: invalidCredentials ? "Stored Feishu credentials are invalid. Replace or clear the credentials." : safeDiagnostic(row?.last_delivery_error)
  };
}

function configFromRow(row: ConfigRow): FeishuConfig | null {
  if (!row.encrypted_credentials) return null;
  return { enabled: Number(row.enabled) === 1, notifyDrafts: Number(row.notify_drafts) === 1, notifyPublished: Number(row.notify_published) === 1, version: Number(row.version), ...decryptCredentials(row.encrypted_credentials, encryptionKey()) };
}

export async function readFeishuConfig(): Promise<FeishuConfig | null> {
  try {
    const [rows] = await database().execute<ConfigRow[]>(`SELECT ${columns} FROM workspace_feishu_config WHERE id=?`, [1]);
    return rows[0] ? configFromRow(rows[0]) : null;
  } catch (error) { throw asFeishuError(error); }
}

export async function readFeishuSettings(): Promise<FeishuSettings> {
  try {
    const [rows] = await database().execute<ConfigRow[]>(`SELECT ${columns} FROM workspace_feishu_config WHERE id=?`, [1]);
    return safeSettings(rows[0]);
  } catch (error) { throw asFeishuError(error); }
}

async function lockConfig(connection: PoolConnection): Promise<ConfigRow> {
  await connection.execute("INSERT INTO workspace_feishu_config (id, enabled, notify_drafts, notify_published, version, updated_at) VALUES (?,0,0,0,1,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=id", [1]);
  const [rows] = await connection.execute<ConfigRow[]>(`SELECT ${columns} FROM workspace_feishu_config WHERE id=? FOR UPDATE`, [1]);
  return rows[0];
}

export async function updateFeishuSettings(input: FeishuSettingsInput, userId: string): Promise<FeishuSettings> {
  const parsedInput = feishuUpdateSchema.safeParse(input);
  if (!parsedInput.success) throw new FeishuError("Invalid Feishu settings.", "FEISHU_INVALID_INPUT", 400);
  const key = encryptionKey();
  let connection: PoolConnection | undefined;
  try {
    connection = await database().getConnection();
    await connection.beginTransaction();
    const row = await lockConfig(connection);
    // Read and merge under the row lock, so concurrent partial saves cannot erase credentials.
    const replacesAllCredentials = input.clearWebhook || (input.webhookUrl && (input.signingSecret || input.clearSigningSecret));
    let previous: Credentials | undefined;
    let previousCredentialsInvalid = false;
    if (row.encrypted_credentials) {
      try { previous = decryptCredentials(row.encrypted_credentials, key); }
      catch (error) {
        if (!replacesAllCredentials) throw error;
        previousCredentialsInvalid = true;
      }
    }
    const webhookUrl = input.clearWebhook ? undefined : input.webhookUrl || previous?.webhookUrl;
    const signingSecret = input.clearSigningSecret || input.clearWebhook ? undefined : input.signingSecret || previous?.signingSecret;
    if (webhookUrl) validateFeishuWebhook(webhookUrl);
    if (input.enabled && !webhookUrl) throw new FeishuError("Configure a webhook before enabling Feishu notifications.", "FEISHU_WEBHOOK_REQUIRED", 400);
    const credentialsChanged = previousCredentialsInvalid || webhookUrl !== previous?.webhookUrl || signingSecret !== previous?.signingSecret;
    const flagsChanged = input.enabled !== (Number(row.enabled) === 1)
      || input.notifyDrafts !== (Number(row.notify_drafts) === 1)
      || input.notifyPublished !== (Number(row.notify_published) === 1);
    if (!credentialsChanged && !flagsChanged) {
      const settings = safeSettings(row);
      await connection.commit();
      return settings;
    }
    const encryptedCredentials = webhookUrl ? encryptCredentials({ webhookUrl, ...(signingSecret ? { signingSecret } : {}) }, key) : null;
    await connection.execute("UPDATE workspace_feishu_config SET enabled=?, notify_drafts=?, notify_published=?, encrypted_credentials=?, version=version+1, updated_by=?, updated_at=UTC_TIMESTAMP(3) WHERE id=?", [Number(input.enabled), Number(input.notifyDrafts), Number(input.notifyPublished), encryptedCredentials, userId, 1]);
    const [rows] = await connection.execute<ConfigRow[]>(`SELECT ${columns} FROM workspace_feishu_config WHERE id=?`, [1]);
    const settings = safeSettings(rows[0]);
    await connection.commit();
    return settings;
  } catch (error) {
    if (connection) await connection.rollback().catch(() => undefined);
    throw asFeishuError(error);
  } finally { connection?.release(); }
}

async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        void reader.cancel().catch(() => undefined);
        throw new FeishuError("Feishu payload exceeds the size limit.", "FEISHU_BODY_TOO_LARGE", 413);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

export async function readFeishuRequestBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new FeishuError("Use an application/json request body.", "FEISHU_INVALID_INPUT", 400);
  }
  if (Number(request.headers.get("content-length")) > 8192) throw new FeishuError("Feishu settings exceed the size limit.", "FEISHU_BODY_TOO_LARGE", 413);
  const body = await readBoundedBody(request.body, 8192);
  try { return JSON.parse(body); }
  catch { throw new FeishuError("Invalid JSON request body.", "FEISHU_INVALID_INPUT", 400); }
}

export async function sendFeishuMessage(config: FeishuConfig, text: string): Promise<void> {
  encryptionKey();
  const webhookUrl = validateFeishuWebhook(config.webhookUrl);
  const timestamp = String(Math.floor(Date.now() / 1000));
  // Feishu text messages interpret <at> tags; fullwidth brackets prevent user content from mentioning recipients.
  const literalText = text.replace(/</g, "＜").replace(/>/g, "＞");
  const body = JSON.stringify({
    ...(config.signingSecret ? { timestamp, sign: createHmac("sha256", `${timestamp}\n${config.signingSecret}`).update("").digest("base64") } : {}),
    msg_type: "text", content: { text: literalText }
  });
  if (Buffer.byteLength(body, "utf8") > 20 * 1024) throw new FeishuError("Feishu message exceeds 20 KB.", "FEISHU_BODY_TOO_LARGE", 413);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new FeishuError("Feishu request timed out.", "FEISHU_TIMEOUT", 504, true));
    }, 5000);
  });
  try {
    await Promise.race([deadline, (async () => {
      const response = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "error", signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new FeishuError("Feishu rejected the notification request.", "FEISHU_HTTP_ERROR", 502, response.status === 429 || response.status >= 500);
      }
      let result: unknown;
      try { result = JSON.parse(await readBoundedBody(response.body, 16 * 1024)); }
      catch { throw new FeishuError("Feishu returned an invalid response.", "FEISHU_INVALID_RESPONSE", 502); }
      if (!result || typeof result !== "object" || !("code" in result) || result.code !== 0) {
        throw new FeishuError("Feishu did not accept the notification. Check the bot configuration.", "FEISHU_REJECTED", 502);
      }
    })()]);
  } catch (error) {
    if (error instanceof FeishuError) throw error;
    throw new FeishuError("Could not contact Feishu securely.", "FEISHU_NETWORK_ERROR", 502, true);
  } finally { if (timeout) clearTimeout(timeout); }
}

export async function testFeishuSettings(name: string): Promise<FeishuSettings> {
  encryptionKey();
  let connection: PoolConnection | undefined;
  let config: FeishuConfig;
  let reservedAt: string;
  try {
    connection = await database().getConnection();
    await connection.beginTransaction();
    const row = await lockConfig(connection);
    const savedConfig = configFromRow(row);
    if (!savedConfig) throw new FeishuError("Save a Feishu webhook before sending a test.", "FEISHU_WEBHOOK_REQUIRED", 400);
    config = savedConfig;
    const [reservation] = await connection.execute<ResultSetHeader>("UPDATE workspace_feishu_config SET last_test_at=UTC_TIMESTAMP(3), last_test_ok=NULL, last_test_error=NULL WHERE id=? AND (last_test_at IS NULL OR last_test_at <= UTC_TIMESTAMP(3) - INTERVAL 30 SECOND)", [1]);
    if (reservation.affectedRows !== 1) throw new FeishuError("Wait 30 seconds before sending another test.", "FEISHU_TEST_RATE_LIMITED", 429, true);
    const [rows] = await connection.execute<ConfigRow[]>(`SELECT ${columns} FROM workspace_feishu_config WHERE id=?`, [1]);
    reservedAt = rows[0].last_test_at!;
    await connection.commit();
  } catch (error) {
    if (connection) await connection.rollback().catch(() => undefined);
    throw asFeishuError(error);
  } finally { connection?.release(); }
  let failure: FeishuError | undefined;
  try {
    const currentConfig = await readFeishuConfig();
    if (!currentConfig || currentConfig.version !== config.version) {
      throw new FeishuError("Feishu settings changed. Retry the test with the saved configuration.", "FEISHU_CONFIG_CHANGED", 409);
    }
    const displayName = (typeof name === "string" ? name : "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 128) || "Admin";
    // A save after this check cannot recall an in-flight request; never hold a SQL lock across network I/O.
    await sendFeishuMessage(currentConfig, `[Polaris] 飞书通知测试\n操作人：${displayName}`);
  }
  catch (error) { failure = asFeishuError(error); }
  try {
    await database().execute("UPDATE workspace_feishu_config SET last_test_ok=?, last_test_error=? WHERE id=? AND version=? AND last_test_at=?", [failure ? 0 : 1, failure ? `${failure.code}: ${failure.message}`.slice(0, 512) : null, 1, config.version, reservedAt]);
  } catch (error) { throw asFeishuError(error); }
  if (failure) throw failure;
  return readFeishuSettings();
}
