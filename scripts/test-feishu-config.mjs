import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
const { NextRequest } = nativeRequire("next/server");
const webhookUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-4333-8444-555555555555";
const replacementUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const signingSecret = "synthetic-signing-secret";
const encryptionKey = Buffer.alloc(32, 7);
const fakeProcess = { env: { FEISHU_ENCRYPTION_KEY: encryptionKey.toString("base64") } };
const administratorId = "11111111-1111-4111-8111-111111111111";
let clock = 1_700_000_000_000;
let shortenDeadline = false;
let row;
let databaseFailure = false;
let afterCommit;
let auth = { user: { id: administratorId, role: "admin" } };
const statements = [];
const fetchCalls = [];
let fetchHandler = async () => Response.json({ code: 0 });
class FixedDate extends Date { static now() { return clock; } }
const timestamp = () => new Date(clock).toISOString().slice(0, 23).replace("T", " ");

function loadModule(path, mocks = {}) {
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", "fetch", "process", "Date", "setTimeout", "clearTimeout", outputText)(
    name => mocks[name] ?? nativeRequire(name), compiled, compiled.exports,
    async (...arguments_) => { fetchCalls.push(arguments_); return fetchHandler(...arguments_); },
    fakeProcess, FixedDate, (callback, delay) => setTimeout(callback, shortenDeadline ? 5 : delay), clearTimeout
  );
  return compiled.exports;
}

const execute = async (sql, parameters = []) => {
  statements.push({ sql, parameters });
  if (databaseFailure) throw new Error(`ER_BAD_FIELD_ERROR ${webhookUrl} ${signingSecret}`);
  if (sql.startsWith("INSERT")) {
    row ??= { enabled: 0, notify_drafts: 0, notify_published: 0, encrypted_credentials: null, version: 1, updated_at: timestamp(), last_test_at: null, last_test_ok: null, last_test_error: null, last_worker_at: null, last_delivery_error: null };
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith("SELECT")) return [row ? [{ ...row }] : []];
  if (sql.includes("SET enabled=?")) {
    const [enabled, notifyDrafts, notifyPublished, encryptedCredentials, updatedBy] = parameters;
    Object.assign(row, { enabled, notify_drafts: notifyDrafts, notify_published: notifyPublished, encrypted_credentials: encryptedCredentials, updated_by: updatedBy, updated_at: timestamp(), version: row.version + 1 });
    return [{ affectedRows: 1 }];
  }
  if (sql.includes("SET last_test_at=")) {
    assert.match(sql, /last_test_at <= UTC_TIMESTAMP\(3\) - INTERVAL 30 SECOND/);
    if (row.last_test_at && clock - Date.parse(`${row.last_test_at.replace(" ", "T")}Z`) < 30_000) return [{ affectedRows: 0 }];
    Object.assign(row, { last_test_at: timestamp(), last_test_ok: null, last_test_error: null });
    return [{ affectedRows: 1 }];
  }
  if (sql.includes("SET last_test_ok=")) {
    assert.match(sql, /AND version=\? AND last_test_at=\?/);
    if (parameters[3] !== row.version || parameters[4] !== row.last_test_at) return [{ affectedRows: 0 }];
    Object.assign(row, { last_test_ok: parameters[0], last_test_error: parameters[1] });
    return [{ affectedRows: 1 }];
  }
  throw new Error(`Unexpected synthetic SQL: ${sql}`);
};
let transactionQueue = Promise.resolve();
const pool = {
  execute,
  async getConnection() {
    let unlock;
    let snapshot;
    return {
      execute,
      async beginTransaction() {
        const previousTransaction = transactionQueue;
        transactionQueue = new Promise(resolve => { unlock = resolve; });
        await previousTransaction;
        snapshot = row ? { ...row } : undefined;
      },
      async commit() { unlock(); unlock = undefined; const callback = afterCommit; afterCommit = undefined; await callback?.(); },
      async rollback() { if (unlock) { row = snapshot; unlock(); unlock = undefined; } },
      release() { assert.equal(unlock, undefined, "Every connection must finish its transaction"); }
    };
  }
};
const feishu = loadModule("src/lib/feishu.ts", { "@/lib/project-db": { database: () => pool } });
const sameOrigin = loadModule("src/lib/same-origin.ts");
const mocks = { "@/lib/auth": { currentUser: async () => auth }, "@/lib/feishu": feishu, "@/lib/same-origin": sameOrigin };
const settingsRoute = loadModule("src/app/api/admin/feishu/route.ts", mocks);
const testRoute = loadModule("src/app/api/admin/feishu/test/route.ts", mocks);
const flags = { enabled: false, notifyDrafts: true, notifyPublished: true };
const request = (method, body = {}, origin = "https://studio.example", headers = {}) => new NextRequest(`https://studio.example/api/admin/feishu${method === "POST" ? "/test" : ""}`, {
  method, headers: { origin, "content-type": "application/json", ...headers },
  ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
});
function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [webhookUrl, replacementUrl, signingSecret, fakeProcess.env.FEISHU_ENCRYPTION_KEY, "encrypted_credentials", "ciphertext"]) {
    if (secret) assert.ok(!serialized.includes(secret), "Public responses must not disclose credentials");
  }
}
async function expectError(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof feishu.FeishuError);
    assert.equal(error.code, code);
    assertNoSecrets({ message: error.message });
    return true;
  });
}

async function runReviewRegressions() {
  fetchHandler = async () => Response.json({ code: 0 });
  auth = { user: { id: administratorId, role: "admin" } };
  const failures = [];
  const verify = async (name, operation) => {
    try { await operation(); console.log(`PASS: ${name}`); }
    catch (error) { failures.push(name); console.log(`FAIL: ${name} (${error.code || error.name})`); }
  };
  await feishu.updateFeishuSettings({ ...flags, webhookUrl, signingSecret }, administratorId);
  await verify("draft text cannot inject all-member or individual mentions", async () => {
    const config = await feishu.readFeishuConfig();
    await feishu.sendFeishuMessage(config, 'Summary: <at user_id="all">Everyone</at> and <at user_id="ou_synthetic">Alice</at>');
    const text = JSON.parse(fetchCalls.at(-1)[1].body).content.text;
    assert.equal(text, 'Summary: ＜at user_id="all"＞Everyone＜/at＞ and ＜at user_id="ou_synthetic"＞Alice＜/at＞');
    assert.ok(!text.includes("<at"));
    const previousFetchCount = fetchCalls.length;
    await expectError(() => feishu.sendFeishuMessage(config, "<>".repeat(4000)), "FEISHU_BODY_TOO_LARGE");
    assert.equal(fetchCalls.length, previousFetchCount, "The byte bound must apply after fullwidth substitution");
  });
  await verify("administrator display name cannot inject a mention", async () => {
    row.last_test_at = null;
    auth = { user: { id: administratorId, role: "admin", displayName: '<at user_id="all">Administrator</at>' } };
    assert.equal((await testRoute.POST(request("POST"))).status, 200);
    const text = JSON.parse(fetchCalls.at(-1)[1].body).content.text;
    assert.equal(text, '[Polaris] 飞书通知测试\n操作人：＜at user_id="all"＞Administrator＜/at＞');
    assert.ok(!text.includes("<at"));
  });
  await verify("unchanged flags and same credentials preserve version and ciphertext", async () => {
    const before = { ...row };
    const previousUpdates = statements.filter(statement => statement.sql.includes("SET enabled=?")).length;
    for (const input of [flags, { ...flags, webhookUrl, signingSecret }, { ...flags, webhookUrl: "", signingSecret: "" }]) {
      const view = await feishu.updateFeishuSettings(input, administratorId);
      assert.equal(view.version, before.version);
      assert.deepEqual(row, before);
    }
    assert.equal(statements.filter(statement => statement.sql.includes("SET enabled=?")).length, previousUpdates);
  });
  await verify("destination changes and each notification toggle increment version", async () => {
    let previousVersion = row.version;
    await feishu.updateFeishuSettings({ ...flags, webhookUrl: replacementUrl }, administratorId);
    assert.equal(row.version, ++previousVersion);
    for (const input of [
      { ...flags, enabled: true },
      { ...flags, enabled: true, notifyDrafts: false },
      { ...flags, enabled: true, notifyDrafts: false, notifyPublished: false },
      { ...flags, webhookUrl }
    ]) {
      await feishu.updateFeishuSettings(input, administratorId);
      assert.equal(row.version, ++previousVersion);
    }
  });
  await verify("proxy PATCH accepts forwarded public hostname", async () => {
    const response = await settingsRoute.PATCH(new NextRequest("http://localhost:3000/api/admin/feishu", {
      method: "PATCH", headers: { origin: "https://studio.example", "x-forwarded-host": "studio.example", "content-type": "application/json" }, body: JSON.stringify(flags)
    }));
    assert.equal(response.status, 200);
  });
  await verify("proxy test returns success and uses sanitized trusted display name", async () => {
    row.last_test_at = null;
    auth = { user: { id: administratorId, role: "admin", displayName: "Alice\r\nForged\u2028Line" } };
    const response = await testRoute.POST(new NextRequest("http://localhost:3000/api/admin/feishu/test", {
      method: "POST", headers: { origin: "https://studio.example", host: "studio.example", "content-type": "application/json" }, body: "{}"
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.equal(JSON.parse(fetchCalls.at(-1)[1].body).content.text, "[Polaris] 飞书通知测试\n操作人：Alice Forged Line");
  });
  await verify("test without display name uses Admin fallback", async () => {
    row.last_test_at = null;
    auth = { user: { id: administratorId, role: "admin" } };
    assert.equal((await testRoute.POST(request("POST"))).status, 200);
    assert.equal(JSON.parse(fetchCalls.at(-1)[1].body).content.text, "[Polaris] 飞书通知测试\n操作人：Admin");
  });
  const originalCiphertext = row.encrypted_credentials;
  await verify("corrupted credentials keep GET available and disclose no secrets", async () => {
    row.encrypted_credentials = "corrupted synthetic ciphertext";
    const response = await settingsRoute.GET();
    assert.equal(response.status, 200);
    const view = await response.json();
    assert.equal(view.webhookConfigured, true);
    assert.equal(view.signingConfigured, false);
    assert.match(view.lastDeliveryError, /credentials/i);
    assertNoSecrets(view);
  });
  await verify("partial replacement of corrupted credentials explains full recovery", async () => {
    row.encrypted_credentials = "corrupted synthetic ciphertext";
    await assert.rejects(() => feishu.updateFeishuSettings({ ...flags, webhookUrl }, administratorId), error => {
      assert.equal(error.code, "FEISHU_CREDENTIALS_INVALID");
      assert.match(error.message, /clearSigningSecret/);
      assertNoSecrets({ message: error.message });
      return true;
    });
  });
  for (const recovery of ["corrupted", "rotated-key"]) {
    await verify(`${recovery} credentials support full replacement`, async () => {
      row.encrypted_credentials = recovery === "corrupted" ? "corrupted synthetic ciphertext" : originalCiphertext;
      fakeProcess.env.FEISHU_ENCRYPTION_KEY = (recovery === "rotated-key" ? Buffer.alloc(32, 9) : encryptionKey).toString("base64");
      const priorVersion = row.version;
      await feishu.updateFeishuSettings({ ...flags, webhookUrl: replacementUrl, signingSecret }, administratorId);
      assert.equal(row.version, priorVersion + 1);
      assert.equal((await feishu.readFeishuConfig()).webhookUrl, replacementUrl);
    });
  }
  fakeProcess.env.FEISHU_ENCRYPTION_KEY = encryptionKey.toString("base64");
  row.encrypted_credentials = originalCiphertext;
  await verify("version changed after reservation cancels test before network", async () => {
    row.last_test_at = null;
    const previousFetchCount = fetchCalls.length;
    afterCommit = () => { row.version += 1; };
    const response = await testRoute.POST(request("POST"));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "FEISHU_CONFIG_CHANGED");
    assert.equal(fetchCalls.length, previousFetchCount);
  });
  await verify("in-flight test result cannot overwrite newer configuration", async () => {
    row.last_test_at = null;
    fetchHandler = async () => { row.version += 1; return Response.json({ code: 0 }); };
    await testRoute.POST(request("POST"));
    assert.equal(row.last_test_ok, null);
    fetchHandler = async () => Response.json({ code: 0 });
  });
  assert.deepEqual(failures, [], "Focused review regressions must all pass");
}

if (process.argv.includes("--review-regressions")) {
  await runReviewRegressions();
  console.log("All focused review regressions passed; no external requests were sent.");
  process.exit(0);
}

assert.equal(await feishu.readFeishuConfig(), null);
const defaults = await feishu.readFeishuSettings();
assert.equal(defaults.enabled, false);
assert.equal(defaults.notifyDrafts, false);
assert.equal(defaults.notifyPublished, false);
assert.equal(defaults.version, 1);
assertNoSecrets(defaults);
await expectError(() => feishu.updateFeishuSettings({ ...flags, enabled: true }, administratorId), "FEISHU_WEBHOOK_REQUIRED");
assert.equal(row, undefined, "Failed initial saves must roll back the singleton insert");
await feishu.updateFeishuSettings({ ...flags, webhookUrl, signingSecret }, administratorId);
assert.equal(row.version, 2);
const envelope = JSON.parse(row.encrypted_credentials);
assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "iv", "tag", "version"]);
assert.equal(envelope.version, 1);
const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(envelope.iv, "base64"));
decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString()), { webhookUrl, signingSecret });
assertNoSecrets(await feishu.readFeishuSettings());
assert.deepEqual(await feishu.readFeishuConfig(), { ...flags, version: 2, webhookUrl, signingSecret });

await Promise.all([
  feishu.updateFeishuSettings({ ...flags, signingSecret: "synthetic-updated-secret" }, administratorId),
  feishu.updateFeishuSettings({ ...flags, webhookUrl: replacementUrl }, administratorId)
]);
assert.equal((await feishu.readFeishuConfig()).signingSecret, "synthetic-updated-secret");
assert.equal((await feishu.readFeishuConfig()).webhookUrl, replacementUrl);
assert.equal(row.version, 4);
assert.ok(statements.some(statement => statement.sql.endsWith("FOR UPDATE")));
await feishu.updateFeishuSettings({ ...flags, signingSecret: "", webhookUrl: "" }, administratorId);
assert.equal((await feishu.readFeishuConfig()).webhookUrl, replacementUrl);
await feishu.updateFeishuSettings({ ...flags, clearSigningSecret: true }, administratorId);
assert.equal((await feishu.readFeishuConfig()).signingSecret, undefined);
await feishu.updateFeishuSettings({ ...flags, webhookUrl, signingSecret }, administratorId);
const validCiphertext = row.encrypted_credentials;
const tampered = JSON.parse(validCiphertext);
const changedBytes = Buffer.from(tampered.ciphertext, "base64");
changedBytes[0] ^= 1;
tampered.ciphertext = changedBytes.toString("base64");
row.encrypted_credentials = JSON.stringify(tampered);
await expectError(() => feishu.readFeishuConfig(), "FEISHU_CREDENTIALS_INVALID");
await feishu.updateFeishuSettings({ ...flags, clearWebhook: true }, administratorId);
assert.equal(await feishu.readFeishuConfig(), null, "Corrupted credentials can be explicitly cleared");
row.encrypted_credentials = validCiphertext;
for (const invalidKey of [undefined, "not-base64", Buffer.alloc(31).toString("base64"), `${encryptionKey.toString("base64")}\n`]) {
  fakeProcess.env.FEISHU_ENCRYPTION_KEY = invalidKey;
  assert.equal((await feishu.readFeishuSettings()).encryptionReady, false);
  await expectError(() => feishu.readFeishuConfig(), "FEISHU_ENCRYPTION_UNAVAILABLE");
  await expectError(() => feishu.updateFeishuSettings(flags, administratorId), "FEISHU_ENCRYPTION_UNAVAILABLE");
  await expectError(() => feishu.sendFeishuMessage({ ...flags, version: 1, webhookUrl }, "test"), "FEISHU_ENCRYPTION_UNAVAILABLE");
}
fakeProcess.env.FEISHU_ENCRYPTION_KEY = encryptionKey.toString("base64");
console.log("PASS: safe defaults; AES-256-GCM envelope and tamper rejection; missing/invalid keys; locked concurrent secret merges; explicit clear; monotonic versions.");

for (const invalidUrl of [
  webhookUrl.replace("https:", "http:"), webhookUrl.replace("open.feishu.cn", "evil.example"),
  webhookUrl.replace("open.feishu.cn", "open.feishu.cn.evil.example"), webhookUrl.replace("open.feishu.cn", "user@open.feishu.cn"),
  webhookUrl.replace("open.feishu.cn", "open.feishu.cn:444"), `${webhookUrl}?token=secret`, `${webhookUrl}#secret`,
  webhookUrl.replace("/hook/", "/hook%2f"), webhookUrl.replace("/hook/", "/x/../hook/"), `${webhookUrl}/`, `${webhookUrl}\n`
]) assert.throws(() => feishu.validateFeishuWebhook(invalidUrl), error => error.code === "FEISHU_INVALID_WEBHOOK");
assert.equal(feishu.validateFeishuWebhook(webhookUrl.replace("open.feishu.cn", "open.feishu.cn:443")), webhookUrl.replace("open.feishu.cn", "open.feishu.cn:443"));
const config = await feishu.readFeishuConfig();
await feishu.sendFeishuMessage(config, "synthetic notification");
const [sentUrl, sentOptions] = fetchCalls.at(-1);
assert.equal(sentUrl, webhookUrl);
assert.equal(sentOptions.redirect, "error");
assert.equal(sentOptions.method, "POST");
assert.ok(sentOptions.signal instanceof AbortSignal);
assert.deepEqual(JSON.parse(sentOptions.body), { timestamp: "1700000000", sign: "6xIUSxIl44gnnWVqSOU/+VndIHzBElfLIeAHbjeSvtQ=", msg_type: "text", content: { text: "synthetic notification" } });
await expectError(() => feishu.sendFeishuMessage(config, "large".repeat(5000)), "FEISHU_BODY_TOO_LARGE");
fetchHandler = async () => Response.json({ code: 19021, msg: `${webhookUrl} ${signingSecret}` });
await expectError(() => feishu.sendFeishuMessage(config, "test"), "FEISHU_REJECTED");
fetchHandler = async () => Response.json({ code: "0" });
await expectError(() => feishu.sendFeishuMessage(config, "test"), "FEISHU_REJECTED");
fetchHandler = async () => new Response("x".repeat(16 * 1024 + 1));
await expectError(() => feishu.sendFeishuMessage(config, "test"), "FEISHU_INVALID_RESPONSE");
fetchHandler = async () => new Response("unavailable", { status: 503 });
await assert.rejects(() => feishu.sendFeishuMessage(config, "test"), error => error.retryable === true && error.code === "FEISHU_HTTP_ERROR");
fetchHandler = async (_url, options) => { assert.equal(options.redirect, "error"); throw new TypeError(`redirect ${webhookUrl} ${signingSecret}`); };
await expectError(() => feishu.sendFeishuMessage(config, "test"), "FEISHU_NETWORK_ERROR");
shortenDeadline = true;
fetchHandler = async () => new Promise(() => undefined);
await expectError(() => feishu.sendFeishuMessage(config, "test"), "FEISHU_TIMEOUT");
assert.equal(fetchCalls.at(-1)[1].signal.aborted, true);
fetchHandler = async () => new Response(new ReadableStream({ start() {} }));
await expectError(() => feishu.sendFeishuMessage(config, "test"), "FEISHU_TIMEOUT");
shortenDeadline = false;
fetchHandler = async () => Response.json({ code: 0 });
console.log("PASS: fixed official signing vector; strict webhook allowlist; 20 KB requests/16 KB responses; HTTP/provider failures; redirect refusal; fetch/body deadlines; sanitized errors.");

for (const [role, expectedStatus] of [[undefined, 401], ["member", 403]]) {
  auth = role ? { user: { id: administratorId, role } } : null;
  const previousQueries = statements.length;
  for (const response of [await settingsRoute.GET(), await settingsRoute.PATCH(request("PATCH", flags)), await testRoute.POST(request("POST"))]) {
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assertNoSecrets(await response.json());
  }
  assert.equal(statements.length, previousQueries, "Unauthorized requests must not read or write settings");
}
auth = { user: { id: administratorId, role: "admin" } };
for (const origin of ["https://evil.example", ""]) {
  assert.equal((await settingsRoute.PATCH(request("PATCH", flags, origin))).status, 403);
  assert.equal((await testRoute.POST(request("POST", {}, origin))).status, 403);
}
assert.equal((await settingsRoute.PATCH(request("PATCH", { ...flags, extra: true }))).status, 400);
assert.equal((await settingsRoute.PATCH(request("PATCH", { ...flags, enabled: "false" }))).status, 400);
assert.equal((await settingsRoute.PATCH(request("PATCH", { ...flags, webhookUrl, clearWebhook: true }))).status, 400);
assert.equal((await settingsRoute.PATCH(request("PATCH", { ...flags, signingSecret, clearSigningSecret: true }))).status, 400);
const previousVersion = row.version;
assert.equal((await settingsRoute.PATCH(request("PATCH", { ...flags, webhookUrl: `${webhookUrl}?secret=synthetic` }))).status, 400);
assert.equal(row.version, previousVersion, "Rejected saves must not change the configuration version");
assert.equal((await settingsRoute.PATCH(request("PATCH", "{"))).status, 400);
assert.equal((await settingsRoute.PATCH(request("PATCH", "x".repeat(8193)))).status, 413);
assert.equal((await settingsRoute.PATCH(request("PATCH", flags, undefined, { "content-length": "8193" }))).status, 413);
assert.equal((await settingsRoute.PATCH(request("PATCH", flags, undefined, { "content-type": "text/plain" }))).status, 400);
assert.equal((await settingsRoute.PATCH(request("PATCH", flags))).status, 200);
assert.equal((await testRoute.POST(request("POST", { webhookUrl: replacementUrl }))).status, 400);
const safeResponse = await settingsRoute.GET();
assert.equal(safeResponse.status, 200);
assertNoSecrets(await safeResponse.json());
row.last_test_error = `${webhookUrl} ${signingSecret}`;
row.last_delivery_error = `${webhookUrl} ${signingSecret}`;
assertNoSecrets(await (await settingsRoute.GET()).json());
const tests = await Promise.all([testRoute.POST(request("POST")), testRoute.POST(request("POST"))]);
assert.deepEqual(tests.map(response => response.status).sort(), [200, 429]);
assert.equal(tests.find(response => response.status === 429).headers.get("retry-after"), "30");
assert.equal(row.enabled, 0, "Saved but disabled configuration can send an explicit administrator test");
assert.equal(row.last_test_ok, 1);
assert.equal(fetchCalls.at(-1)[0], webhookUrl);
clock += 30_000;
fetchHandler = async () => Response.json({ code: 1, msg: `${webhookUrl} ${signingSecret}` });
const failedTest = await testRoute.POST(request("POST"));
assert.equal(failedTest.status, 502);
assert.equal(row.last_test_ok, 0);
assertNoSecrets(await failedTest.json());
assertNoSecrets({ lastTestError: row.last_test_error });
databaseFailure = true;
const unavailable = await settingsRoute.GET();
assert.equal(unavailable.status, 503);
assertNoSecrets(await unavailable.json());
databaseFailure = false;
console.log("PASS: real admin GET/PATCH/test routes; 401/403 and shared same-origin CSRF; strict Zod/8 KB bodies; secret-free GET/errors; saved-config tests; database-atomic 30-second limit; sanitized schema 503.");
await runReviewRegressions();
console.log("All Feishu synthetic tests passed; no external requests or real notifications were sent.");
