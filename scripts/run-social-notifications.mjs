#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import nextEnvironment from "@next/env";

export const workerPath = "/api/internal/social-notifications";
export const defaultWorkerUrl = `http://127.0.0.1:3000${workerPath}`;
export const workerTimeoutMilliseconds = 55_000;

class WorkerResponseError extends Error {}

export function validateWorkerToken(token) {
  if (typeof token !== "string" || token.length < 32 || /[^\x21-\x7e]/.test(token)) {
    throw new Error("SOCIAL_NOTIFICATIONS_TOKEN must contain at least 32 printable non-space ASCII characters.");
  }
  return token;
}

export function validateWorkerUrl(value) {
  if (typeof value !== "string") throw new Error("Invalid notification worker URL.");
  let parsedUrl;
  try { parsedUrl = new URL(value); } catch { throw new Error("Invalid notification worker URL."); }
  const hostname = parsedUrl.hostname;
  const octets = hostname.split(".").map(Number);
  const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) && octets.every((octet) => octet >= 0 && octet <= 255);
  const isPrivateIpv4 = isIpv4 && (
    octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
  );
  const isLocalHostname = hostname === "localhost" || hostname === "[::1]";
  // Compare the raw form as well: normalization must not conceal dot segments or numeric host aliases.
  const rawAuthority = value.match(/^https?:\/\/([^/]+)\/api\/internal\/social-notifications$/)?.[1];
  const canonicalAuthority = `${hostname}${parsedUrl.port ? `:${parsedUrl.port}` : ""}`;
  const defaultPortAuthority = `${hostname}:${parsedUrl.protocol === "https:" ? "443" : "80"}`;
  if (!(isPrivateIpv4 || isLocalHostname) || !["http:", "https:"].includes(parsedUrl.protocol) ||
      parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash ||
      parsedUrl.pathname !== workerPath || !rawAuthority ||
      (rawAuthority !== canonicalAuthority && rawAuthority !== defaultPortAuthority)) {
    throw new Error("Worker URL must use HTTP(S), a loopback or private IPv4 address, and the exact internal worker path, without credentials, query, or fragment.");
  }
  return parsedUrl.href;
}

export function readWorkerConfiguration(environment = process.env) {
  return {
    token: validateWorkerToken(environment.SOCIAL_NOTIFICATIONS_TOKEN),
    url: validateWorkerUrl(environment.SOCIAL_NOTIFICATIONS_INTERNAL_URL || defaultWorkerUrl)
  };
}

export function getWorkerExitCode(summary) {
  return summary.failed > 0 || summary.warning ? 1 : 0;
}

function selectSafeSummary(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new WorkerResponseError("Invalid worker summary.");
  const summary = {};
  for (const field of ["sent", "failed", "skipped", "checked", "confirmed"]) {
    if (!Number.isSafeInteger(payload[field]) || payload[field] < 0) throw new WorkerResponseError("Invalid worker summary.");
    summary[field] = payload[field];
  }
  if (typeof payload.locked !== "boolean") throw new WorkerResponseError("Invalid worker summary.");
  summary.locked = payload.locked;
  if (payload.warning) summary.warning = "Notification processing needs attention.";
  return summary;
}

async function readSafeResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new WorkerResponseError("Invalid worker summary.");
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > 16_384) {
        await reader.cancel();
        throw new WorkerResponseError("Worker summary exceeds the size limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new WorkerResponseError("Invalid worker summary."); }
  return selectSafeSummary(payload);
}

export async function runSocialNotifications({
  environment = process.env,
  fetchImplementation = globalThis.fetch,
  timeoutMilliseconds = workerTimeoutMilliseconds
} = {}) {
  const configuration = readWorkerConfiguration(environment);
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > workerTimeoutMilliseconds) {
    throw new Error("Worker timeout must be between 1 and 55000 milliseconds.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetchImplementation(configuration.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${configuration.token}` },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkerResponseError(`Worker request failed (HTTP ${response.status}).`);
    }
    return await readSafeResponse(response);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Worker request timed out.");
    if (error instanceof WorkerResponseError) throw error;
    throw new Error("Worker request failed. Check internal service availability.");
  } finally { clearTimeout(timeout); }
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  nextEnvironment.loadEnvConfig(process.cwd());
  try {
    const summary = await runSocialNotifications();
    console.log(`Social notifications: ${JSON.stringify(summary)}`);
    process.exitCode = getWorkerExitCode(summary);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
