// The publish route now acknowledges durable work; delivery belongs exclusively to the outbox worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const { NextRequest, NextResponse } = nativeRequire("next/server");
function loadModule(path, dependencies = {}) {
  const { outputText } = typescript.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", outputText)(name => dependencies[name] ?? nativeRequire(name), compiled, compiled.exports);
  return compiled.exports;
}
const validBody = { assetId: "synthetic-asset", integrationId: "owned-account", content: "Review this draft",
  requestId: "11111111-1111-4111-8111-111111111111" };
const calls = { enqueues: [], wakeups: [] };
let auth;
let storageConfigured;
let sameOrigin;
let enqueueOutcome;
let enqueueFailure;
const route = loadModule("../src/app/api/social/publish/route.ts", {
  "next/server": { NextResponse, after: callback => calls.wakeups.push(callback) },
  "@/lib/auth": { currentUser: async () => auth, unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 }) },
  "@/lib/project-db": { databaseConfigured: () => storageConfigured },
  "@/lib/same-origin": { isSameOrigin: () => sameOrigin },
  "@/lib/request-body": loadModule("../src/lib/request-body.ts"),
  "@/lib/image-upload": loadModule("../src/lib/image-upload.ts"),
  "@/lib/draft-submissions": { enqueueAssetSubmission: async options => {
    calls.enqueues.push(options);
    if (enqueueFailure) throw new Error("Synthetic schema failure with private details");
    return enqueueOutcome;
  } },
  "@/lib/draft-submission-scheduler": { wakeDraftSubmissionWorker: async () => {} }
});
function createRequest(body = validBody) {
  return new NextRequest("https://studio.test/api/social/publish", { method: "POST", headers: { "content-type": "application/json", origin: "https://studio.test" },
    body: typeof body === "string" ? body : JSON.stringify(body) });
}
beforeEach(() => {
  calls.enqueues.length = 0;
  calls.wakeups.length = 0;
  auth = { user: { id: "owner", displayName: "Owner", role: "member" } };
  storageConfigured = true;
  sameOrigin = true;
  enqueueFailure = false;
  enqueueOutcome = { kind: "queued", task: { id: "task", state: "queued" } };
});

test("anonymous and cross-origin submissions have no queue side effects", async () => {
  sameOrigin = false;
  assert.equal((await route.POST(createRequest())).status, 403);
  sameOrigin = true;
  auth = null;
  assert.equal((await route.POST(createRequest("{"))).status, 401);
  assert.equal(calls.enqueues.length, 0);
});

test("accepted response is 202 and registers only a post-response worker wakeup", async () => {
  const response = await route.POST(createRequest());
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.deepEqual(result, { accepted: true, task: enqueueOutcome.task });
  assert.equal(result.success, undefined);
  assert.equal(result.publishedAt, undefined);
  assert.equal(calls.wakeups.length, 1);
  assert.equal(calls.enqueues[0].userId, "owner");
  assert.equal(calls.enqueues[0].isAdmin, false);
});

test("role is sourced from the session and forged identity fields are rejected", async () => {
  for (const field of ["userId", "isAdmin", "publishedBy", "publishedByName", "ownerHash"]) {
    assert.equal((await route.POST(createRequest({ ...validBody, [field]: "forged" }))).status, 400);
  }
  assert.equal(calls.enqueues.length, 0);
  auth.user.role = "admin";
  assert.equal((await route.POST(createRequest())).status, 202);
  assert.equal(calls.enqueues[0].isAdmin, true);
});

test("bounded malformed/non-string payloads are refused before queueing", async () => {
  for (const body of ["{", "null", "[]", "123", '"text"']) assert.equal((await route.POST(createRequest(body))).status, 400);
  for (const field of ["assetId", "integrationId", "content", "imageUrl", "publishAt", "projectId", "platform", "accountName", "requestId", "expectedAuditId"]) {
    for (const invalid of [null, 42, true, {}, []]) assert.equal((await route.POST(createRequest({ ...validBody, [field]: invalid }))).status, 400);
  }
  assert.equal((await route.POST(createRequest({ ...validBody, content: "x".repeat(2_000_000) }))).status, 400);
  assert.equal(calls.enqueues.length, 0);
});

test("request identity, source identity and legacy scheduling inputs remain validated", async () => {
  for (const patch of [{ assetId: "" }, { assetId: undefined }, { integrationId: " " }, { content: " " },
    { requestId: undefined }, { requestId: "invalid" }, { expectedAuditId: "invalid" }, { projectId: "" },
    { projectId: "invalid" }, { publishAt: "not-a-date" }, { imageUrl: "file:///private" }]) {
    assert.equal((await route.POST(createRequest({ ...validBody, ...patch }))).status, 400);
  }
  assert.equal(calls.enqueues.length, 0);
  assert.equal((await route.POST(createRequest({ ...validBody, publishAt: "2026-10-19T12:00:00Z" }))).status, 202);
});

test("local ownership and active/unknown conflicts do not trigger worker wakeups", async () => {
  for (const [kind, status] of [["forbidden", 403], ["conflict", 409], ["in_flight", 409], ["unconfirmed", 409]]) {
    enqueueOutcome = { kind, message: "Refused by local ownership checks" };
    assert.equal((await route.POST(createRequest())).status, status);
  }
  assert.equal(calls.wakeups.length, 0);
});

test("missing queue schema and storage permissions return a safe 503", async () => {
  storageConfigured = false;
  assert.equal((await route.POST(createRequest())).status, 503);
  assert.equal(calls.enqueues.length, 0);
  storageConfigured = true;
  enqueueFailure = true;
  const response = await route.POST(createRequest());
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private details|schema failure/);
  assert.equal(calls.wakeups.length, 0);
});

test("existing succeeded/unknown jobs remain task facts rather than a new draft response", async () => {
  for (const state of ["succeeded", "unknown"]) {
    enqueueOutcome = { kind: "queued", task: { id: "existing", state } };
    const response = await route.POST(createRequest());
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.task.state, state);
    assert.equal(result.success, undefined);
  }
});
