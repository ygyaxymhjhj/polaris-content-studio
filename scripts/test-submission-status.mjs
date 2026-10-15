// Exercise real routes with synthetic storage and identity. Never load application DB/auth modules.
// TZ=America/Los_Angeles node scripts/test-submission-status.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const { NextResponse } = nativeRequire("next/server");
const ownProjectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const foreignProjectId = "33333333-3333-4333-8333-333333333333";
let auth;
let storageConfigured;
let storageFailure;
let storedRows;
let queries;
let capturedErrors;
let executeOverride;

function createAuditId(sequence) {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence).padStart(12, "0")}`;
}

function createRow(sequence, overrides = {}) {
  return {
    id: createAuditId(sequence), project_id: ownProjectId, owner_hash: "own-owner",
    asset_id: "shared-asset", integration_id: "channel-one", published_by: "member-one",
    postiz_post_id: `post-${sequence}`, status: "drafted", published_url: null,
    created_at: "2026-10-15 10:00:00", tracking_state: "DRAFT", review_status: "pending",
    save_action: "draft", rejected_detected_at: null, release_url: null,
    postiz_publish_date: null, confirmed_at: null, last_checked_at: null,
    content_preview: "PRIVATE CONTENT", account_name: "PRIVATE ACCOUNT", ...overrides
  };
}

function orderRows(leftRow, rightRow) {
  return rightRow.created_at.localeCompare(leftRow.created_at) || rightRow.id.localeCompare(leftRow.id);
}

async function executeSyntheticQuery(statement, parameters) {
  queries.push({ statement, parameters });
  if (storageFailure) throw new Error("Synthetic DB failure with private credentials");
  if (executeOverride) return [executeOverride(statement, parameters)];
  assert.match(statement, /LEFT JOIN social_post_tracking t ON t.publish_audit_id = p.id/);
  assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE|LIMIT)\b/i);
  assert.equal((statement.match(/\?/g) ?? []).length, parameters.length);
  let scopedRows;
  let requestedIdentifiers;
  if (/p\.project_id = \?/.test(statement)) {
    assert.match(statement, /JOIN projects pr ON pr.id = p.project_id/);
    assert.match(statement, /WHERE p.project_id = \? AND pr.owner_hash = \? AND/);
    const [projectId, ownerHash, ...identifiers] = parameters;
    scopedRows = storedRows.filter(row => row.project_id === projectId && row.owner_hash === ownerHash);
    requestedIdentifiers = identifiers;
  } else {
    assert.match(statement, /WHERE p.project_id IS NULL AND p.published_by = \? AND/);
    const [userId, ...identifiers] = parameters;
    scopedRows = storedRows.filter(row => row.project_id === null && row.published_by === userId);
    requestedIdentifiers = identifiers;
  }
  if (/p.id IN/.test(statement)) {
    assert.doesNotMatch(statement, /p.status IN/);
    return [scopedRows.filter(row => requestedIdentifiers.includes(row.id)).sort(orderRows)];
  }
  assert.match(statement, /ROW_NUMBER\(\) OVER \(PARTITION BY p.asset_id ORDER BY p.created_at DESC, p.id DESC\)/);
  assert.match(statement, /p.status IN \('drafted', 'queued', 'published'\)/);
  assert.match(statement, /WHERE ranked.submission_rank = 1/);
  const candidates = scopedRows.filter(row => requestedIdentifiers.includes(row.asset_id)
    && ["drafted", "queued", "published"].includes(row.status)).sort(orderRows);
  const latestByAsset = new Map();
  for (const row of candidates) if (!latestByAsset.has(row.asset_id)) latestByAsset.set(row.asset_id, row);
  return [[...latestByAsset.values()]];
}

function loadRoute(relativePath) {
  const dependencies = {
    "next/server": { NextResponse },
    "@/lib/auth": {
      currentUser: async () => auth,
      unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 })
    },
    "@/lib/project-db": {
      databaseConfigured: () => storageConfigured,
      database: () => ({ execute: executeSyntheticQuery })
    }
  };
  const { outputText } = typescript.transpileModule(readFileSync(new URL(relativePath, import.meta.url), "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", "fetch", "process", "console", outputText)(
    dependency => {
      assert.ok(Object.hasOwn(dependencies, dependency), `Unexpected dependency: ${dependency}`);
      return dependencies[dependency];
    }, compiledModule, compiledModule.exports,
    () => assert.fail("Live network is forbidden"), { env: {} },
    { error: (...arguments_) => capturedErrors.push(arguments_) }
  );
  return compiledModule.exports;
}

const route = loadRoute("../src/app/api/social/submission-status/route.ts");
const historyRoute = loadRoute("../src/app/api/social/publishes/route.ts");

async function getStatus(parameters = {}) {
  const request = new Request(`https://studio.example.test/api/social/submission-status?${new URLSearchParams(parameters)}`);
  const response = await route.GET(request);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return { response, payload: await response.json() };
}

beforeEach(() => {
  auth = { user: { id: "member-one", role: "member" }, ownerHash: "own-owner" };
  storageConfigured = true;
  storageFailure = false;
  storedRows = [];
  queries = [];
  capturedErrors = [];
  executeOverride = null;
});

test("anonymous callers receive 401 before querying storage", async () => {
  auth = null;
  const { response, payload } = await getStatus({ assetIds: "shared-asset" });
  assert.equal(response.status, 401);
  assert.deepEqual(payload, { code: "UNAUTHORIZED" });
  assert.equal(queries.length, 0);
});

test("invalid, ambiguous, oversized and arbitrary post ID queries fail before storage", async () => {
  for (const parameters of [
    {}, { projectId: ownProjectId }, { projectId: "", assetIds: "asset" },
    { projectId: "-".repeat(36), assetIds: "asset" }, { auditIds: "not-uuid" },
    { auditIds: "-".repeat(36) }, { auditIds: `${createAuditId(1)},` }, { assetIds: "" },
    { assetIds: "../foreign" }, { assetIds: "a b" }, { assetIds: "\u6c49\u5b57" },
    { assetIds: "a".repeat(65) }, { assetIds: "asset,,other" },
    { assetIds: Array.from({ length: 201 }, (_, index) => `asset-${index}`).join(",") },
    { auditIds: Array.from({ length: 200 }, (_, index) => createAuditId(index)).join(","), assetIds: "asset" },
    { assetIds: Array.from({ length: 200 }, (_, index) => `${index}_${"a".repeat(60)}`).join(",") },
    { postId: "arbitrary-upstream-id" }, { assetIds: "a".repeat(16001) },
    [["assetIds", "one"], ["assetIds", "two"]]
  ]) {
    const { response } = await getStatus(parameters);
    assert.equal(response.status, 400, JSON.stringify(parameters).slice(0, 120));
  }
  assert.equal(queries.length, 0);
});

test("project-scoped audit lookup never exposes foreign projects even to administrators", async () => {
  storedRows = [createRow(1), createRow(2, { project_id: otherProjectId }),
    createRow(3, { project_id: foreignProjectId, owner_hash: "foreign-owner" })];
  for (const role of ["member", "admin"]) {
    auth.user.role = role;
    const result = await getStatus({ projectId: ownProjectId, auditIds: storedRows.map(row => row.id).join(",") });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.submissions.map(row => row.auditId), [createAuditId(1)]);
    for (const projectId of [foreignProjectId, createAuditId(999)]) {
      const hidden = await getStatus({ projectId, auditIds: createAuditId(3), assetIds: "shared-asset" });
      assert.deepEqual(hidden.payload, { submissions: [] });
    }
  }
});

test("omitted project queries only the current user's unprojected rows", async () => {
  storedRows = [createRow(1), createRow(2, { project_id: null }),
    createRow(3, { project_id: null, published_by: "another-user" })];
  const { payload } = await getStatus({ auditIds: storedRows.map(row => row.id).join(","), assetIds: "shared-asset" });
  assert.deepEqual(payload.submissions.map(row => row.auditId), [createAuditId(2)]);
  for (const query of queries) assert.deepEqual(query.parameters.slice(0, 1), [auth.user.id]);
});

test("asset fallback ranks successful submissions stably without failed or cross-project replacements", async () => {
  storedRows = [createRow(1), createRow(2), createRow(3, { status: "failed", created_at: "2026-10-15 12:00:00" }),
    createRow(4, { project_id: otherProjectId, created_at: "2026-10-15 13:00:00" }),
    createRow(5, { asset_id: "failed-only", status: "failed" })];
  const { payload } = await getStatus({ projectId: ownProjectId, assetIds: "shared-asset,failed-only" });
  assert.deepEqual(payload.submissions.map(row => row.auditId), [createAuditId(2)]);
  const exactFailed = await getStatus({ projectId: ownProjectId, auditIds: createAuditId(3) });
  assert.equal(exactFailed.payload.submissions[0].publishStatus, "failed");
});

test("all 200 exact audits are returned rather than the historical latest 50", async () => {
  storedRows = Array.from({ length: 200 }, (_, index) => createRow(index));
  const { response, payload } = await getStatus({ projectId: ownProjectId, auditIds: storedRows.map(row => row.id).join(",") });
  assert.equal(response.status, 200);
  assert.equal(payload.submissions.length, 200);
  assert.ok(payload.submissions.some(row => row.auditId === createAuditId(0)));
});

test("200 asset groups survive many newer rows for one asset without global truncation", async () => {
  storedRows = Array.from({ length: 200 }, (_, index) => createRow(index, { asset_id: `asset-${index}` }));
  storedRows.push(...Array.from({ length: 250 }, (_, index) => createRow(index + 1000,
    { asset_id: "asset-0", created_at: "2026-10-15 12:00:00" })));
  const { payload } = await getStatus({ projectId: ownProjectId,
    assetIds: Array.from({ length: 200 }, (_, index) => `asset-${index}`).join(",") });
  assert.equal(payload.submissions.length, 200);
  assert.ok(payload.submissions.some(row => row.auditId === createAuditId(199)));
  assert.ok(payload.submissions.some(row => row.auditId === createAuditId(1249)));
});

test("mixed lookup deduplicates audits while retaining different exact and latest submissions", async () => {
  storedRows = [createRow(1), createRow(2)];
  const { payload } = await getStatus({ projectId: ownProjectId, auditIds: `${createAuditId(1)},${createAuditId(2)}`,
    assetIds: "shared-asset" });
  assert.deepEqual(payload.submissions.map(row => row.auditId).sort(), [createAuditId(1), createAuditId(2)]);
});

test("normalized snapshots expose only the fixed contract, UTC dates and persisted review facts", async () => {
  storedRows = [createRow(1, { review_status: "rejected", save_action: "pass",
    rejected_detected_at: "2026-10-15 11:00:00" })];
  const { payload } = await getStatus({ projectId: ownProjectId, auditIds: createAuditId(1) });
  assert.deepEqual(payload.submissions[0], {
    auditId: createAuditId(1), postId: "post-1", assetId: "shared-asset", integrationId: "channel-one",
    publishStatus: "drafted", reviewStatus: "rejected", rejectedDetectedAt: "2026-10-15T11:00:00.000Z",
    submittedAt: "2026-10-15T10:00:00.000Z", postizState: "DRAFT", saveAction: "pass",
    publishedUrl: null, publishedAt: null
  });
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE|content_preview|account_name|owner_hash|published_by/);
});

test("missing and unknown tracking values normalize safely and pass alone never implies rejection", async () => {
  for (const overrides of [
    { tracking_state: null, review_status: null, save_action: null },
    { tracking_state: "UNRECOGNIZED", review_status: "INVALID", save_action: "INVALID" },
    { tracking_state: "DRAFT", review_status: "unknown", save_action: "pass" },
    { tracking_state: "QUEUE", review_status: "unknown", save_action: "pass" }
  ]) {
    storedRows = [createRow(1, { ...overrides, rejected_detected_at: "invalid", postiz_post_id: null })];
    const { payload } = await getStatus({ projectId: ownProjectId, assetIds: "shared-asset" });
    const snapshot = payload.submissions[0];
    assert.equal(snapshot.reviewStatus, "unknown");
    assert.equal(snapshot.rejectedDetectedAt, null);
    assert.equal(snapshot.postId, null);
    assert.equal(snapshot.postizState, ["DRAFT", "QUEUE"].includes(overrides.tracking_state) ? overrides.tracking_state : null);
    assert.equal(snapshot.saveAction, overrides.save_action === "pass" ? "pass" : null);
  }
});

test("all save actions are allowed independently from review and publication state", async () => {
  for (const saveAction of ["pass", "update", "draft", "schedule", "now"]) {
    storedRows = [createRow(1, { save_action: saveAction, tracking_state: "ERROR", review_status: "pending" })];
    const { payload } = await getStatus({ projectId: ownProjectId, assetIds: "shared-asset" });
    assert.equal(payload.submissions[0].saveAction, saveAction);
    assert.equal(payload.submissions[0].reviewStatus, "pending");
    assert.equal(payload.submissions[0].postizState, "ERROR");
  }
});

test("published tracking takes precedence without mixing review status into publish status", async () => {
  storedRows = [createRow(1, { tracking_state: "PUBLISHED", review_status: "rejected", save_action: "pass",
    postiz_publish_date: "2026-10-15T20:00:00+08:00", confirmed_at: "2026-10-15 13:00:00",
    release_url: "https://social.example.test/released", published_url: "https://social.example.test/old" })];
  let result = await getStatus({ projectId: ownProjectId, assetIds: "shared-asset" });
  assert.equal(result.payload.submissions[0].publishStatus, "published");
  assert.equal(result.payload.submissions[0].publishedAt, "2026-10-15T12:00:00.000Z");
  assert.equal(result.payload.submissions[0].publishedUrl, storedRows[0].release_url);
  assert.equal(result.payload.submissions[0].reviewStatus, "rejected");
  storedRows[0].postiz_publish_date = null;
  storedRows[0].confirmed_at = new Date("2026-10-15T13:00:00Z");
  result = await getStatus({ projectId: ownProjectId, assetIds: "shared-asset" });
  assert.equal(result.payload.submissions[0].publishedAt, "2026-10-15T13:00:00.000Z");
});

test("unconfigured and failing storage return safe 503 without leaking database details", async () => {
  storageConfigured = false;
  let result = await getStatus({ assetIds: "asset" });
  assert.equal(result.response.status, 503);
  assert.equal(queries.length, 0);
  storageConfigured = true;
  storageFailure = true;
  result = await getStatus({ assetIds: "asset" });
  assert.equal(result.response.status, 503);
  assert.deepEqual(result.payload, { error: "Could not load submission status." });
  assert.doesNotMatch(JSON.stringify(capturedErrors), /credentials/);
});

test("history remains capped at 50 and adds independent normalized tracking facts", async () => {
  executeOverride = statement => {
    assert.match(statement, /LIMIT 50/);
    assert.match(statement, /t.review_status, t.save_action, t.rejected_detected_at, t.last_checked_at/);
    assert.match(statement, /p.project_id = \? AND pr.owner_hash = \?/);
    return [createRow(1, { tracking_state: "PUBLISHED", review_status: "rejected", save_action: "pass",
      rejected_detected_at: "2026-10-15 09:00:00", last_checked_at: "2026-10-15 11:00:00",
      postiz_publish_date: "2026-10-15 12:00:00" }),
    createRow(2, { tracking_state: null, review_status: "INVALID", save_action: "INVALID" })];
  };
  const response = await historyRoute.GET(new Request(`https://studio.example.test/api/social/publishes?projectId=${ownProjectId}`));
  const { publishes } = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(queries[0].parameters, [ownProjectId, auth.ownerHash]);
  assert.equal(publishes[0].status, "published");
  assert.equal(publishes[0].reviewStatus, "rejected");
  assert.equal(publishes[0].saveAction, "pass");
  assert.equal(publishes[0].postizState, "PUBLISHED");
  assert.equal(publishes[0].publishedAt, "2026-10-15T12:00:00.000Z");
  assert.equal(publishes[0].rejectedDetectedAt, "2026-10-15T09:00:00.000Z");
  assert.equal(publishes[0].lastCheckedAt, "2026-10-15T11:00:00.000Z");
  assert.equal(publishes[1].reviewStatus, "unknown");
  assert.equal(publishes[1].saveAction, null);
  assert.equal(publishes[1].postizState, null);
});
