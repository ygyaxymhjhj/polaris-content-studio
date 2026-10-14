// Real internal route with a synthetic environment and worker API; no server/network/database.
// node scripts/test-feishu-internal.mjs
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import typescript from "typescript";
import { validateWorkerToken } from "./run-social-notifications.mjs";

const nativeRequire = createRequire(import.meta.url);
const { NextResponse } = nativeRequire("next/server");
const syntheticToken = "test-only-internal-token-1234567890";
const privateUrl = "https://feishu.example.test/synthetic-private-webhook";
const privateIdentity = "synthetic-private-applicant";
const fakeProcess = { env: {} };
const workerCalls = [];
const safeSummary = { sent: 2, failed: 1, skipped: 3, checked: 4, confirmed: 1, locked: false };
let workerSummary;
let workerFailure;
let shortenBodyDeadline;

function loadModule(relativePath, dependencies) {
  const { outputText } = typescript.transpileModule(readFileSync(new URL(relativePath, import.meta.url), "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", "process", "fetch", "setTimeout", "clearTimeout", outputText)(
    dependency => {
      assert.ok(Object.hasOwn(dependencies, dependency), `Unexpected internal route dependency: ${dependency}`);
      return dependencies[dependency];
    },
    compiledModule, compiledModule.exports, fakeProcess,
    () => assert.fail("Live network is forbidden in isolated internal route tests"),
    (callback, milliseconds) => setTimeout(callback, shortenBodyDeadline ? 5 : milliseconds), clearTimeout
  );
  return compiledModule.exports;
}

const route = loadModule("../src/app/api/internal/social-notifications/route.ts", {
  "node:crypto": { timingSafeEqual },
  "next/server": { NextResponse },
  "@/lib/social-notifications": {
    processSocialNotifications: async (...arguments_) => {
      workerCalls.push(arguments_);
      if (workerFailure) throw new Error(`Synthetic module failure ${syntheticToken} ${privateUrl}`);
      return workerSummary;
    }
  }
});

function createRequest({ authorization = `Bearer ${syntheticToken}`, body } = {}) {
  return new Request("https://studio.example.test/api/internal/social-notifications", {
    method: "POST",
    headers: authorization === null ? {} : { authorization },
    ...(body === undefined ? {} : { body })
  });
}

function assertNoPrivateFields(payload) {
  const serialized = JSON.stringify(payload);
  for (const secret of [syntheticToken, privateUrl, privateIdentity, "encrypted_credentials", "lease_token"]) {
    assert.ok(!serialized.includes(secret), "Internal responses must not expose private worker details");
  }
}

beforeEach(() => {
  fakeProcess.env = { SOCIAL_NOTIFICATIONS_TOKEN: syntheticToken };
  workerCalls.length = 0;
  workerSummary = { ...safeSummary };
  workerFailure = false;
  shortenBodyDeadline = false;
});

test("route exports POST only and leaves unsupported methods to the Next.js adapter", () => {
  assert.equal(typeof route.POST, "function");
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    assert.equal(route[method], undefined, `${method} must not expose a worker handler`);
  }
  assert.equal(route.runtime, "nodejs");
  assert.equal(route.dynamic, "force-dynamic");
  // This isolated test does not start Next.js or claim to exercise its default HTTP 405 response.
});

test("missing and invalid configured tokens return 503 without invoking the worker", async () => {
  for (const invalidToken of [undefined, "", "short", "x".repeat(31), `${"x".repeat(32)} secret`, `${"x".repeat(32)}\n`, "\u5bc6".repeat(32)]) {
    fakeProcess.env = invalidToken === undefined ? {} : { SOCIAL_NOTIFICATIONS_TOKEN: invalidToken };
    assert.throws(() => validateWorkerToken(invalidToken), "Runner must reject exactly the same invalid token forms");
    const response = await route.POST(createRequest());
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.deepEqual(payload, { error: "Notification worker is not configured." });
    assertNoPrivateFields(payload);
  }
  assert.equal(workerCalls.length, 0);
});

test("missing, wrong and malformed bearer authentication returns 401 before reading the body", async () => {
  for (const authorization of [
    null, "", "Basic synthetic", `bearer ${syntheticToken}`, `Bearer ${"x".repeat(syntheticToken.length)}`,
    `Bearer ${syntheticToken.slice(0, -1)}`, `Bearer ${syntheticToken}x`, `Bearer  ${syntheticToken}`
  ]) {
    const request = createRequest({ authorization, body: '{"status":"PUBLISHED"}' });
    Object.defineProperty(request, "body", {
      get: () => assert.fail("Unauthenticated requests must not access the body stream")
    });
    const response = await route.POST(request);
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.deepEqual(payload, { error: "Unauthorized." });
    assertNoPrivateFields(payload);
  }
  assert.equal(workerCalls.length, 0);
});

test("arbitrary nonempty bodies are rejected and cannot inject publication state or identity", async () => {
  for (const body of [
    "{}", "null", "[]", " ", "malformed-json",
    JSON.stringify({ status: "PUBLISHED", recipient: privateUrl, applicantName: privateIdentity, auditId: "forged-audit" })
  ]) {
    const response = await route.POST(createRequest({ body }));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.deepEqual(payload, { error: "The worker accepts an empty body only." });
    assertNoPrivateFields(payload);
  }
  assert.equal(workerCalls.length, 0);
});

test("body stream failures return safe non-cacheable 400 without invoking the worker", async () => {
  const body = new ReadableStream({
    start(controller) { controller.error(new Error(`Synthetic stream error ${privateUrl} ${syntheticToken}`)); }
  });
  const response = await route.POST({ headers: new Headers({ authorization: `Bearer ${syntheticToken}` }), body });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.deepEqual(payload, { error: "The worker accepts an empty body only." });
  assertNoPrivateFields(payload);
  assert.equal(workerCalls.length, 0);
});

test("stalled body streams hit the controlled deadline, cancel and never invoke the worker", async () => {
  shortenBodyDeadline = true;
  let cancellations = 0;
  const body = new ReadableStream({ cancel() { cancellations += 1; } });
  const response = await route.POST({ headers: new Headers({ authorization: `Bearer ${syntheticToken}` }), body });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.deepEqual(payload, { error: "The worker accepts an empty body only." });
  assertNoPrivateFields(payload);
  assert.equal(cancellations, 1);
  assert.equal(workerCalls.length, 0);
});

test("valid empty-body requests invoke the worker exactly once with no caller parameters", async () => {
  workerSummary = {
    ...safeSummary, token: syntheticToken, webhookUrl: privateUrl, applicantName: privateIdentity,
    encrypted_credentials: "synthetic-encrypted-credentials", lease_token: "synthetic-private-lease"
  };
  for (const body of [undefined, ""]) {
    workerCalls.length = 0;
    const response = await route.POST(createRequest({ body }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json();
    assert.deepEqual(payload, safeSummary);
    assertNoPrivateFields(payload);
    assert.deepEqual(workerCalls, [[]], "Worker must run exactly once and receive no injected fields");
  }
});

test("the 32-character ASCII boundary agrees with runner validation", async () => {
  const boundaryToken = "x".repeat(32);
  assert.equal(validateWorkerToken(boundaryToken), boundaryToken);
  fakeProcess.env = { SOCIAL_NOTIFICATIONS_TOKEN: boundaryToken };
  const response = await route.POST(createRequest({ authorization: `Bearer ${boundaryToken}` }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), safeSummary);
  assert.deepEqual(workerCalls, [[]]);
});

test("worker warnings are sanitized and locked status/counts are preserved", async () => {
  workerSummary = {
    ...safeSummary, locked: true, warning: `Secret ${syntheticToken} ${privateUrl} ${privateIdentity}`,
    details: { token: syntheticToken, applicant: privateIdentity }
  };
  const response = await route.POST(createRequest());
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, { ...safeSummary, locked: true, warning: "Notification processing needs attention." });
  assertNoPrivateFields(payload);
  assert.deepEqual(workerCalls, [[]]);
});

test("worker module failures return safe 503 errors without revealing diagnostic secrets", async () => {
  workerFailure = true;
  const response = await route.POST(createRequest());
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.deepEqual(payload, { error: "Notification processing is unavailable." });
  assertNoPrivateFields(payload);
  assert.deepEqual(workerCalls, [[]]);
});

test("every success and rejection branch sends Cache-Control: no-store", async () => {
  const missingCacheHeaders = [];
  const cases = [
    { name: "not configured", environment: {}, expectedStatus: 503 },
    { name: "invalid configured token", environment: { SOCIAL_NOTIFICATIONS_TOKEN: "short" }, expectedStatus: 503 },
    { name: "unauthorized", request: { authorization: null }, expectedStatus: 401 },
    { name: "body rejected", request: { body: "{}" }, expectedStatus: 400 },
    { name: "worker unavailable", failure: true, expectedStatus: 503 },
    { name: "successful worker", expectedStatus: 200 }
  ];
  for (const scenario of cases) {
    fakeProcess.env = scenario.environment ?? { SOCIAL_NOTIFICATIONS_TOKEN: syntheticToken };
    workerFailure = scenario.failure ?? false;
    const response = await route.POST(createRequest(scenario.request));
    assert.equal(response.status, scenario.expectedStatus);
    const cacheControl = response.headers.get("cache-control");
    if (cacheControl !== "no-store") missingCacheHeaders.push({ branch: scenario.name, status: response.status, cacheControl });
  }
  assert.deepEqual(missingCacheHeaders, [], "All internal responses, including errors, must explicitly disable caching");
});
