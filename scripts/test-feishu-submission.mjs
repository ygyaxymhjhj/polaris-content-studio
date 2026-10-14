// Real route, synthetic identity/storage/Postiz/notification APIs; no network or real database.
// node scripts/test-feishu-submission.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const { NextResponse } = nativeRequire("next/server");
const memberUser = { id: "member-one", displayName: "Authenticated Applicant", role: "member" };
const administratorUser = { id: "admin-one", displayName: "Authenticated Administrator", role: "admin" };
const ownProjectId = "11111111-1111-4111-8111-111111111111";
const foreignProjectId = "22222222-2222-4222-8222-222222222222";
const ownAccount = { integrationId: "own-channel", ownerUserId: memberUser.id, provider: "x", accountName: "Registry Account" };
const foreignAccount = { integrationId: "foreign-channel", ownerUserId: "another-member", provider: "linkedin", accountName: "Foreign Registry Account" };
const validBody = { integrationId: ownAccount.integrationId, assetId: "synthetic-asset", content: "Review this draft" };
const pendingWarning = "Draft submitted, but notification delivery is pending. Do not submit again.";
const registrationWarning = "Draft submitted, but submission tracking could not be saved. Do not submit again.";
const calls = { accounts: [], projects: [], postiz: [], submissions: [], deliveries: [], errors: [] };
let auth;
let storageConfigured;
let projectQueryFailure;
let upstreamResult;
let registrationResult;
let deliveryResult;
let registrationFailure;
let deliveryFailure;

function loadModule(relativePath, dependencies) {
  const { outputText } = typescript.transpileModule(readFileSync(new URL(relativePath, import.meta.url), "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", "fetch", "process", "console", outputText)(
    dependency => {
      assert.ok(Object.hasOwn(dependencies, dependency), `Unexpected route dependency: ${dependency}`);
      return dependencies[dependency];
    },
    compiledModule, compiledModule.exports,
    () => assert.fail("Live network is forbidden in isolated submission tests"),
    { env: {} }, { error: (...arguments_) => calls.errors.push(arguments_) }
  );
  return compiledModule.exports;
}

const route = loadModule("../src/app/api/social/publish/route.ts", {
  "next/server": { NextResponse },
  "@/lib/auth": {
    currentUser: async () => auth,
    unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 })
  },
  "@/lib/social-accounts": {
    getSocialAccount: async integrationId => {
      calls.accounts.push(integrationId);
      return [ownAccount, foreignAccount].find(account => account.integrationId === integrationId) ?? null;
    }
  },
  "@/lib/project-db": {
    databaseConfigured: () => storageConfigured,
    database: () => ({
      execute: async (statement, parameters) => {
        calls.projects.push({ statement, parameters });
        assert.match(statement, /^SELECT id FROM projects WHERE id=\? AND owner_hash=\?$/);
        if (projectQueryFailure) throw new Error("Synthetic project storage failure");
        const [projectId, ownerHash] = parameters;
        return [[...(projectId === ownProjectId && ownerHash === auth.ownerHash ? [{ id: projectId }] : [])]];
      }
    })
  },
  "@/lib/postiz": {
    publishToPostiz: async payload => {
      calls.postiz.push(payload);
      return upstreamResult;
    }
  },
  "@/lib/social-notifications": {
    recordSocialSubmission: async entry => {
      calls.submissions.push(entry);
      if (registrationFailure) throw new Error("Synthetic registration failure");
      return registrationResult;
    },
    deliverSocialNotifications: async options => {
      calls.deliveries.push(options);
      if (deliveryFailure) throw new Error("Synthetic notification failure");
      return deliveryResult;
    }
  }
});

function createRequest(payload = validBody) {
  return new Request("https://studio.example.test/api/social/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}

function assertNoUpstreamSideEffects() {
  assert.equal(calls.postiz.length, 0, "Rejected requests must never reach Postiz");
  assert.equal(calls.submissions.length, 0, "Rejected requests must never register audit/notification entries");
  assert.equal(calls.deliveries.length, 0, "Rejected requests must never trigger delivery");
}

function assertSingleSuccessfulSubmission(response, payload) {
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.assetId, validBody.assetId);
  assert.equal(payload.postId, upstreamResult.postId, "Only the real upstream post ID is returned");
  assert.equal(calls.postiz.length, 1, "An accepted submission must never be retried by the route");
  assert.equal(calls.submissions.length, 1, "The route registers exactly one audit entry");
  assert.ok(Number.isFinite(Date.parse(payload.publishedAt)));
}

beforeEach(() => {
  for (const capturedCalls of Object.values(calls)) capturedCalls.length = 0;
  auth = { user: { ...memberUser }, ownerHash: "synthetic-member-owner-hash" };
  storageConfigured = true;
  projectQueryFailure = false;
  upstreamResult = { success: true, postId: "real-upstream-id" };
  registrationResult = { auditId: "synthetic-audit-id" };
  deliveryResult = { sent: 0, failed: 0, skipped: 0 };
  registrationFailure = false;
  deliveryFailure = false;
});

test("anonymous requests fail before parsing, registry lookup, storage or Postiz", async () => {
  auth = null;
  const request = createRequest("{");
  request.json = () => assert.fail("Unauthenticated requests must not parse the body");
  const response = await route.POST(request);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { code: "UNAUTHORIZED" });
  assert.equal(calls.accounts.length, 0);
  assert.equal(calls.projects.length, 0);
  assertNoUpstreamSideEffects();
});

test("members cannot submit through foreign or unknown channels", async () => {
  for (const integrationId of [foreignAccount.integrationId, "unknown-channel"]) {
    const response = await route.POST(createRequest({ ...validBody, integrationId, publishedBy: "admin-one" }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "FORBIDDEN");
  }
  assertNoUpstreamSideEffects();
});

test("successful submissions use authenticated identity and registry metadata, not forged body values", async () => {
  const content = `  ${"Synthetic summary ".repeat(20)}  `;
  const response = await route.POST(createRequest({
    ...validBody, content, projectId: ownProjectId, imageUrl: " https://assets.example.test/image.png ",
    publishAt: "2026-10-14T15:00:00Z", platform: "forged-platform", accountName: "Forged Account",
    publishedBy: "forged-user", publishedByName: "Forged Applicant", displayName: "Forged Name",
    ownerHash: "forged-owner-hash"
  }));
  const payload = await response.json();
  assertSingleSuccessfulSubmission(response, payload);
  assert.equal(payload.warning, undefined);
  assert.deepEqual(calls.projects[0].parameters, [ownProjectId, auth.ownerHash]);
  assert.deepEqual(calls.postiz[0], {
    integrationId: ownAccount.integrationId, content: content.trim(),
    imageUrl: "https://assets.example.test/image.png", platform: ownAccount.provider
  });
  assert.deepEqual(calls.submissions[0], {
    projectId: ownProjectId, assetId: validBody.assetId, platform: ownAccount.provider,
    integrationId: ownAccount.integrationId, accountName: ownAccount.accountName,
    publishedBy: memberUser.id, publishedByName: memberUser.displayName,
    contentPreview: content.trim().slice(0, 200), postizPostId: upstreamResult.postId,
    status: "drafted", error: undefined
  });
  assert.deepEqual(calls.deliveries, [{ auditId: registrationResult.auditId, limit: 1 }]);
});

test("administrator channel bypass never bypasses project ownership", async () => {
  auth = { user: { ...administratorUser }, ownerHash: "synthetic-admin-owner-hash" };
  const blocked = await route.POST(createRequest({ ...validBody, projectId: foreignProjectId, ownerHash: auth.ownerHash }));
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, "FORBIDDEN");
  assert.deepEqual(calls.projects[0].parameters, [foreignProjectId, auth.ownerHash]);
  assertNoUpstreamSideEffects();
  const response = await route.POST(createRequest({ ...validBody, projectId: ownProjectId, integrationId: foreignAccount.integrationId }));
  assertSingleSuccessfulSubmission(response, await response.json());
  assert.equal(calls.submissions[0].publishedByName, administratorUser.displayName);
  assert.equal(calls.postiz[0].platform, foreignAccount.provider);
});

test("member forged project and unavailable storage are rejected before Postiz", async () => {
  const foreignResponse = await route.POST(createRequest({ ...validBody, projectId: foreignProjectId, ownerHash: auth.ownerHash }));
  assert.equal(foreignResponse.status, 403);
  assertNoUpstreamSideEffects();
  storageConfigured = false;
  const unavailableResponse = await route.POST(createRequest({ ...validBody, projectId: ownProjectId }));
  assert.equal(unavailableResponse.status, 503);
  assert.equal(calls.projects.length, 1, "Unconfigured storage must not be queried");
  assertNoUpstreamSideEffects();
  storageConfigured = true;
  projectQueryFailure = true;
  assert.equal((await route.POST(createRequest({ ...validBody, projectId: ownProjectId }))).status, 500);
  assertNoUpstreamSideEffects();
});

test("malformed bodies and non-string submission fields fail before side effects", async () => {
  for (const payload of ["{", "null", "[]", "123", '"text"']) {
    assert.equal((await route.POST(createRequest(payload))).status, 400);
  }
  const stringFields = ["assetId", "integrationId", "content", "imageUrl", "publishAt", "projectId", "platform", "accountName"];
  for (const field of stringFields) {
    for (const invalidValue of [null, 42, true, {}, []]) {
      assert.equal((await route.POST(createRequest({ ...validBody, [field]: invalidValue }))).status, 400, `${field} rejects ${JSON.stringify(invalidValue)}`);
    }
  }
  assert.equal(calls.accounts.length, 0);
  assert.equal(calls.projects.length, 0);
  assertNoUpstreamSideEffects();
});

test("empty project IDs are invalid, but frontend-style omitted project IDs are accepted", async () => {
  for (const projectId of ["", " ", "not-a-project-id"]) {
    assert.equal((await route.POST(createRequest({ ...validBody, projectId }))).status, 400);
  }
  assert.equal(calls.projects.length, 0);
  assertNoUpstreamSideEffects();
  const currentProjectId = "";
  const request = createRequest({ ...validBody, projectId: currentProjectId || undefined });
  assert.ok(!Object.hasOwn(await request.clone().json(), "projectId"));
  const response = await route.POST(request);
  assertSingleSuccessfulSubmission(response, await response.json());
  assert.equal(calls.projects.length, 0);
  assert.equal(calls.submissions[0].projectId, undefined);
});

test("required fields and invalid legacy scheduling input are rejected", async () => {
  for (const invalidBody of [
    { ...validBody, integrationId: " " }, { ...validBody, integrationId: undefined },
    { ...validBody, content: " " }, { ...validBody, content: undefined },
    { ...validBody, publishAt: "not-a-date" }
  ]) assert.equal((await route.POST(createRequest(invalidBody))).status, 400);
  assertNoUpstreamSideEffects();
});

test("upstream failures register a failed audit but never deliver notifications", async () => {
  upstreamResult = { success: false, error: "Synthetic Postiz rejection" };
  const response = await route.POST(createRequest());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: upstreamResult.error });
  assert.equal(calls.postiz.length, 1);
  assert.equal(calls.submissions.length, 1);
  assert.equal(calls.submissions[0].status, "failed");
  assert.equal(calls.submissions[0].error, upstreamResult.error);
  assert.equal(calls.deliveries.length, 0);
});

test("notification failures keep accepted submission successful and warn without retries", async () => {
  deliveryResult = { sent: 0, failed: 1, skipped: 0 };
  const response = await route.POST(createRequest());
  const payload = await response.json();
  assertSingleSuccessfulSubmission(response, payload);
  assert.equal(payload.warning, pendingWarning, "A failed delivery generates its own warning without upstream/core warnings");
  assert.equal(calls.deliveries.length, 1);
});

test("matching upstream, registration and delivery warnings appear only once", async () => {
  deliveryResult = { sent: 0, failed: 1, skipped: 0 };
  upstreamResult.warning = pendingWarning;
  registrationResult.warning = pendingWarning;
  const response = await route.POST(createRequest());
  const payload = await response.json();
  assertSingleSuccessfulSubmission(response, payload);
  assert.equal(payload.warning, pendingWarning, "Repeated warning sources must be deduplicated");
  assert.equal(calls.deliveries.length, 1);
});

test("delivery exceptions preserve successful hand-off and do not retry upstream", async () => {
  deliveryFailure = true;
  const response = await route.POST(createRequest());
  const payload = await response.json();
  assertSingleSuccessfulSubmission(response, payload);
  assert.equal(payload.warning, pendingWarning);
  assert.equal(calls.deliveries.length, 1);
});

test("missing upstream ID remains success with a warning and never invents an ID", async () => {
  upstreamResult = { success: true };
  const response = await route.POST(createRequest());
  const payload = await response.json();
  assertSingleSuccessfulSubmission(response, payload);
  assert.equal(Object.hasOwn(payload, "postId"), false);
  assert.equal(calls.submissions[0].postizPostId, undefined);
  assert.equal(calls.submissions[0].status, "drafted");
  assert.match(payload.warning, /no post ID.*Do not submit again/);
  assert.deepEqual(calls.deliveries, [{ auditId: registrationResult.auditId, limit: 1 }]);
});

test("registration exceptions preserve success with no delivery", async () => {
  registrationFailure = true;
  const response = await route.POST(createRequest());
  const payload = await response.json();
  assertSingleSuccessfulSubmission(response, payload);
  assert.equal(payload.warning, registrationWarning);
  assert.equal(calls.deliveries.length, 0);
  assert.equal(calls.errors.length, 1);
});

test("registration warning without an audit ID is propagated without a second generic warning", async () => {
  registrationResult = { warning: "Synthetic audit persistence warning. Do not submit again." };
  const response = await route.POST(createRequest());
  const payload = await response.json();
  assertSingleSuccessfulSubmission(response, payload);
  assert.equal(payload.warning, registrationResult.warning);
  assert.equal(calls.deliveries.length, 0);
});

test("missing audit ID without a core warning generates the safe registration warning", async () => {
  registrationResult = {};
  const response = await route.POST(createRequest());
  const payload = await response.json();
  assertSingleSuccessfulSubmission(response, payload);
  assert.equal(payload.warning, registrationWarning);
  assert.equal(calls.deliveries.length, 0);
});

test("Postiz warning is propagated verbatim, including missing-ID hand-offs", async () => {
  upstreamResult = { success: true, warning: "Accepted upstream, but publication tracking is unavailable. Do not submit again." };
  const response = await route.POST(createRequest());
  const payload = await response.json();
  assertSingleSuccessfulSubmission(response, payload);
  assert.equal(payload.warning, upstreamResult.warning);
  assert.equal(Object.hasOwn(payload, "postId"), false);
  assert.equal(calls.submissions[0].postizPostId, undefined);
});
