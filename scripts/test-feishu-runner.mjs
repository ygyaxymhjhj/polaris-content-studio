#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";
import { getWorkerExitCode, readWorkerConfiguration, runSocialNotifications, validateWorkerToken, validateWorkerUrl, workerPath } from "./run-social-notifications.mjs";
import { checkFeishuNotifications } from "./check-feishu-notifications.mjs";

const fakeToken = "test-only-notification-token-1234567890";
const environment = { SOCIAL_NOTIFICATIONS_TOKEN: fakeToken };
const safeSummary = { sent: 1, failed: 0, skipped: 0, checked: 2, confirmed: 1, locked: false };

test("worker warnings fail the run even without delivery failures; lock skips succeed", () => {
  assert.equal(getWorkerExitCode({ ...safeSummary, failed: 0, warning: "Processing unavailable" }), 1);
  assert.equal(getWorkerExitCode({ ...safeSummary, failed: 1 }), 1);
  assert.equal(getWorkerExitCode({ ...safeSummary, locked: true }), 0);
  assert.equal(getWorkerExitCode(safeSummary), 0);
});

test("worker URL only accepts exact private or loopback destinations", () => {
  for (const hostname of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "192.168.220.109:13300", "10.0.0.2", "172.16.0.2", "172.31.255.255"]) {
    assert.equal(new URL(validateWorkerUrl(`http://${hostname}${workerPath}`)).pathname, workerPath);
  }
  for (const invalidUrl of [
    `https://example.com${workerPath}`, `http://8.8.8.8${workerPath}`, `http://172.32.0.1${workerPath}`,
    `http://169.254.169.254${workerPath}`, `http://user:password@127.0.0.1${workerPath}`,
    `http://127.0.0.1${workerPath}?secret=value`, `http://127.0.0.1${workerPath}#fragment`,
    `http://127.0.0.1${workerPath}/`, "http://127.0.0.1/api/other/../internal/social-notifications",
    `http://2130706433${workerPath}`, `http://127.1${workerPath}`, `http://0x7f000001${workerPath}`,
    `ftp://127.0.0.1${workerPath}`, `http://127.0.0.1${workerPath}?`, `http://127.0.0.1${workerPath}#`
  ]) assert.throws(() => validateWorkerUrl(invalidUrl));
});

test("token validation happens before any network request", async () => {
  for (const token of [undefined, "short", "x".repeat(31), `${"x".repeat(32)}\n`, `${"x".repeat(32)} secret`, "\u5bc6".repeat(32)]) {
    assert.throws(() => validateWorkerToken(token));
  }
  assert.equal(validateWorkerToken("x".repeat(32)), "x".repeat(32));
  assert.equal(readWorkerConfiguration(environment).url, `http://127.0.0.1:3000${workerPath}`);
  let fetchCalled = false;
  await assert.rejects(runSocialNotifications({ environment: {}, fetchImplementation: async () => { fetchCalled = true; } }), /SOCIAL_NOTIFICATIONS_TOKEN/);
  assert.equal(fetchCalled, false);
});

test("runner uses bearer, empty POST, redirect rejection and whitelisted summary", async () => {
  const summary = await runSocialNotifications({ environment, fetchImplementation: async (url, options) => {
    assert.equal(url, `http://127.0.0.1:3000${workerPath}`);
    assert.equal(options.method, "POST");
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${fakeToken}`);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ ...safeSummary, token: fakeToken, accountName: "private", warning: fakeToken });
  } });
  assert.deepEqual(summary, { ...safeSummary, warning: "Notification processing needs attention." });
  assert.ok(!JSON.stringify(summary).includes(fakeToken));
});

test("runner never echoes HTTP error bodies or network diagnostic secrets", async () => {
  await assert.rejects(runSocialNotifications({ environment, fetchImplementation: async () => new Response(fakeToken, { status: 401 }) }), /Worker request failed \(HTTP 401\)\.$/);
  await assert.rejects(runSocialNotifications({ environment, fetchImplementation: async () => { throw new Error(`secret=${fakeToken}`); } }), /^Error: Worker request failed\. Check internal service availability\.$/);
  await assert.rejects(runSocialNotifications({ environment, fetchImplementation: async () => { throw new Error(`Worker secret=${fakeToken}`); } }), /^Error: Worker request failed\. Check internal service availability\.$/);
});

test("runner aborts stalled requests and validates runtime bounds", async () => {
  let aborted = false;
  await assert.rejects(runSocialNotifications({ environment, timeoutMilliseconds: 10, fetchImplementation: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  }) }), /timed out/);
  assert.equal(aborted, true);
  for (const timeoutMilliseconds of [0, -1, 55_001, 1.5]) {
    await assert.rejects(runSocialNotifications({ environment, timeoutMilliseconds, fetchImplementation: async () => { assert.fail("Unexpected fetch"); } }), /timeout must/);
  }
});

test("runner rejects malformed or oversized summaries", async () => {
  for (const payload of [{ ...safeSummary, sent: -1 }, { ...safeSummary, failed: "0" }, { ...safeSummary, locked: "false" }, null]) {
    await assert.rejects(runSocialNotifications({ environment, fetchImplementation: async () => Response.json(payload) }), /Invalid worker summary/);
  }
  await assert.rejects(runSocialNotifications({ environment, fetchImplementation: async () => new Response("x".repeat(16_385)) }), /size limit/);
});

test("runner timeout also covers a stalled response body", async () => {
  await assert.rejects(runSocialNotifications({
    environment,
    timeoutMilliseconds: 10,
    fetchImplementation: async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () => controller.error(new Error(fakeToken)), { once: true });
      }
    }))
  }), /Worker request timed out/);
});

function createPreflightConnection({ enabled = false, missingColumn = false, missingGrant = false } = {}) {
  const columnsByTable = {
    workspace_feishu_config: "id enabled notify_drafts notify_published encrypted_credentials version updated_by updated_at last_test_at last_test_ok last_test_error last_worker_at last_delivery_error",
    social_post_tracking: "publish_audit_id postiz_post_id state release_url postiz_publish_date confirmed_at submitted_at next_check_at last_checked_at check_attempts last_error notify_published config_version",
    social_notification_outbox: "id publish_audit_id event_type event_time status attempts next_attempt_at lease_token lease_expires_at sent_at last_error config_version payload"
  };
  return {
    async execute(sql, parameters) {
      assert.ok(sql.startsWith("SELECT "), "Preflight must not mutate storage");
      if (sql.startsWith("SELECT DATABASE()")) return [[{ schema_name: "polaris_content_studio" }]];
      if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
        const columnNames = columnsByTable[parameters[1]].split(" ");
        return [(missingColumn ? columnNames.slice(1) : columnNames).map((columnName) => ({ COLUMN_NAME: columnName }))];
      }
      assert.equal(sql, "SELECT enabled FROM workspace_feishu_config WHERE id=?");
      return [[{ enabled: Number(enabled) }]];
    },
    async query(sql) {
      assert.equal(sql, "SHOW GRANTS FOR CURRENT_USER()");
      return [[{ grant: `GRANT ${missingGrant ? "SELECT" : "SELECT, INSERT, UPDATE"} ON \`polaris_content_studio\`.* TO 'polaris_app'@'%'` }]];
    }
  };
}

test("disabled notification preflight works without secrets but external worker validation requires token", async () => {
  assert.deepEqual(await checkFeishuNotifications(createPreflightConnection(), { environment: {} }), { enabled: false, workerReady: false });
  await assert.rejects(checkFeishuNotifications(createPreflightConnection(), { environment: {}, requireWorker: true }), /SOCIAL_NOTIFICATIONS_TOKEN/);
  assert.deepEqual(await checkFeishuNotifications(createPreflightConnection(), { environment, requireWorker: true }), { enabled: false, workerReady: true });
});

test("enabled production preflight requires encryption key and schema grants, not external worker secrets", async () => {
  await assert.rejects(checkFeishuNotifications(createPreflightConnection({ enabled: true }), { environment: {} }), /FEISHU_ENCRYPTION_KEY/);
  const enabledEnvironment = { NODE_ENV: "production", FEISHU_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
  assert.deepEqual(await checkFeishuNotifications(createPreflightConnection({ enabled: true }), { environment: enabledEnvironment }), { enabled: true, workerReady: false });
  for (const encryptionKey of ["invalid", Buffer.alloc(31, 7).toString("base64"), `${enabledEnvironment.FEISHU_ENCRYPTION_KEY}\n`, `${"A".repeat(42)}B=`]) {
    await assert.rejects(checkFeishuNotifications(createPreflightConnection({ enabled: true }), {
      environment: { ...enabledEnvironment, FEISHU_ENCRYPTION_KEY: encryptionKey }
    }), /FEISHU_ENCRYPTION_KEY/);
  }
  await assert.rejects(checkFeishuNotifications(createPreflightConnection({ missingColumn: true }), { environment }), /schema is incomplete/);
  await assert.rejects(checkFeishuNotifications(createPreflightConnection({ missingGrant: true }), { environment }), /grants/);
});

test("explicit external worker preflight still validates token and private URL for enabled notifications", async () => {
  const enabledEnvironment = { FEISHU_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
  for (const token of [undefined, "short", `${fakeToken}\n`]) {
    await assert.rejects(checkFeishuNotifications(createPreflightConnection({ enabled: true }), {
      environment: { ...enabledEnvironment, SOCIAL_NOTIFICATIONS_TOKEN: token }, requireWorker: true
    }), /SOCIAL_NOTIFICATIONS_TOKEN/);
  }
  for (const invalidUrl of [`https://example.com${workerPath}`, `http://127.0.0.1${workerPath}?secret=value`]) {
    await assert.rejects(checkFeishuNotifications(createPreflightConnection({ enabled: true }), {
      environment: { ...enabledEnvironment, ...environment, SOCIAL_NOTIFICATIONS_INTERNAL_URL: invalidUrl }, requireWorker: true
    }), /Worker URL/);
  }
  assert.deepEqual(await checkFeishuNotifications(createPreflightConnection({ enabled: true }), {
    environment: { ...enabledEnvironment, ...environment }, requireWorker: true
  }), { enabled: true, workerReady: true });
});
