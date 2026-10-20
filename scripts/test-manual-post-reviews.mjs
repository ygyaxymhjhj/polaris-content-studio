// Run the real storage SQL and submission orchestration with an isolated SQL adapter and fake fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
function loadModule(relativePath, dependencies = {}) {
  const { outputText } = typescript.transpileModule(readFileSync(new URL(relativePath, import.meta.url), "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", outputText)(
    dependency => dependencies[dependency] ?? nativeRequire(dependency), compiledModule, compiledModule.exports
  );
  return compiledModule.exports;
}

const postId = "11111111-1111-4111-8111-111111111111";
const auditId = "22222222-2222-4222-8222-222222222222";
const submittedAt = "2020-01-15 10:00:00.000";
const postTypes = loadModule("../src/lib/post-types.ts");
const filters = { status: "all", search: "", platform: "", integrationId: "", updatedSince: 0, page: 1, perPage: 20 };

function createHarness() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`
    CREATE TABLE posts (id TEXT PRIMARY KEY, owner_user_id TEXT, title TEXT, content TEXT, image_data TEXT,
      image_thumb TEXT, image_name TEXT, image_width INTEGER, image_height INTEGER, version INTEGER,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE post_targets (id TEXT, post_id TEXT, integration_id TEXT, platform TEXT, account_name TEXT,
      status TEXT, snapshot_version INTEGER, postiz_post_id TEXT, audit_id TEXT, warning TEXT, error TEXT,
      submitted_at TEXT, created_at TEXT, updated_at TEXT, attempt_id TEXT, attempt_started_at TEXT);
    CREATE TABLE social_publishes (id TEXT PRIMARY KEY, project_id TEXT, asset_id TEXT, integration_id TEXT,
      published_by TEXT, postiz_post_id TEXT);
    CREATE TABLE social_post_tracking (publish_audit_id TEXT PRIMARY KEY, postiz_post_id TEXT, review_status TEXT,
      state TEXT, save_action TEXT, postiz_publish_date TEXT, rejected_detected_at TEXT);
    CREATE TABLE draft_submissions (attempt_id TEXT, kind TEXT, state TEXT);
    INSERT INTO posts VALUES ('${postId}', 'owner', 'Frozen title', 'Frozen content', NULL, NULL, NULL, NULL,
      NULL, 4, '${submittedAt}', '${submittedAt}');
    INSERT INTO post_targets VALUES ('target', '${postId}', 'account', 'x', 'Account', 'accepted', 4,
      'old-upstream', '${auditId}', NULL, NULL, '${submittedAt}', '${submittedAt}', '${submittedAt}', NULL, NULL);
    INSERT INTO social_publishes VALUES ('${auditId}', NULL, '${postId}', 'account', 'owner', 'old-upstream');
    INSERT INTO social_post_tracking VALUES ('${auditId}', 'old-upstream', 'rejected', 'DRAFT', 'pass',
      '2030-03-01 00:00:00.000', '${new Date().toISOString().slice(0, 23).replace("T", " ")}');
  `);
  const statements = [];
  let transactionOpen = false;
  // SQLite executes the actual joins, CASE expressions, CTEs and conditional updates. Only MySQL
  // syntax that is not portable is translated; no canned status/count query responses are used.
  const execute = async (statement, parameters = []) => {
    statements.push(statement);
    let portableSql = statement.replace(/ FOR UPDATE(?: OF t, tracking)?\b/g, "")
      .replace(/ AS BINARY\)/g, " AS BLOB)")
      .replace(/LEFT\(p.content, 400\)/g, "substr(p.content, 1, 400)")
      .replace(/GROUP_CONCAT\(DISTINCT t.platform ORDER BY t.platform\)/g, "GROUP_CONCAT(DISTINCT t.platform)");
    if (portableSql.startsWith("UPDATE post_targets t JOIN posts")) {
      portableSql = portableSql.replace("UPDATE post_targets t JOIN posts p ON p.id = t.post_id", "UPDATE post_targets")
        .replace("p.owner_user_id = ?", "post_id IN (SELECT id FROM posts WHERE owner_user_id = ?)")
        .replace(/\bt\./g, "");
    }
    const prepared = sql.prepare(portableSql);
    if (/^\s*(SELECT|WITH)\b/.test(portableSql)) return [prepared.all(...parameters)];
    return [{ affectedRows: prepared.run(...parameters).changes }];
  };
  const connection = {
    execute,
    beginTransaction: async () => { assert.equal(transactionOpen, false); transactionOpen = true; sql.exec("BEGIN"); },
    commit: async () => { sql.exec("COMMIT"); transactionOpen = false; },
    rollback: async () => { sql.exec("ROLLBACK"); transactionOpen = false; },
    release() {}
  };
  const pool = { execute, getConnection: async () => connection };
  const storage = loadModule("../src/lib/posts.ts", {
    "@/lib/project-db": { database: () => pool }, "./post-types": postTypes
  });
  const upstream = loadModule("../src/lib/postiz.ts", { "./types": loadModule("../src/lib/types.ts") });
  const requests = [];
  const auditHistory = [];
  const harness = {
    sql, storage, statements, requests, auditHistory,
    livePost: { id: "old-upstream", state: "DRAFT", saveAction: "pass" },
    draftResponse: () => Response.json([{ postId: "new-upstream" }]),
    afterLiveCheck: null,
    beforeDraftResponse: null,
    accountOwner: "owner",
    accountDisabled: false
  };
  const submission = loadModule("../src/lib/post-submission.ts", {
    "@/lib/project-db": { database: () => pool },
    "@/lib/posts": storage,
    "@/lib/social-accounts": { getSocialAccount: async () => ({ ownerUserId: harness.accountOwner }) },
    "@/lib/postiz": {
      ...upstream,
      fetchPostizIntegrations: async () => ({ configured: true, accounts: [{ id: "account", identifier: "x", disabled: harness.accountDisabled }] })
    },
    "@/lib/social-notifications": {
      recordSocialSubmission: async entry => {
        auditHistory.push(entry);
        const newAuditId = "33333333-3333-4333-8333-333333333333";
        sql.prepare("INSERT INTO social_publishes VALUES (?, NULL, ?, ?, ?, ?)")
          .run(newAuditId, entry.assetId, entry.integrationId, entry.publishedBy, entry.postizPostId ?? null);
        if (entry.status === "drafted") {
          sql.prepare("INSERT INTO social_post_tracking VALUES (?, ?, 'pending', 'DRAFT', NULL, NULL, NULL)")
            .run(newAuditId, entry.postizPostId);
        }
        return { auditId: newAuditId };
      }
    }
  });
  harness.submit = (overrides = {}) => submission.submitPostTarget({
    userId: "owner", userName: "Owner", isAdmin: false, postId, integrationId: "account", expectedVersion: 4,
    expectedAuditId: auditId, ...overrides
  });
  harness.getTarget = () => sql.prepare("SELECT * FROM post_targets WHERE integration_id='account'").get();
  harness.fetch = async (url, options) => {
    assert.equal(transactionOpen, false, "network calls never hold the storage transaction");
    requests.push({ url: String(url), options });
    if (options.method === "GET") {
      const livePost = structuredClone(harness.livePost);
      await harness.afterLiveCheck?.();
      return Response.json({ posts: livePost ? [livePost] : [] });
    }
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).type, "draft", "publication/scheduling is forbidden");
    assert.equal(harness.getTarget().audit_id, null, "claim detaches the old audit before upstream creation");
    assert.equal(harness.getTarget().postiz_post_id, null);
    await harness.beforeDraftResponse?.();
    return harness.draftResponse();
  };
  return harness;
}

async function withHarness(callback) {
  const harness = createHarness();
  const originalFetch = globalThis.fetch;
  const originalEnvironment = process.env;
  globalThis.fetch = harness.fetch;
  process.env = { ...originalEnvironment, POSTIZ_API_URL: "https://postiz.test", POSTIZ_API_KEY: "synthetic-key" };
  try { await callback(harness); }
  finally { globalThis.fetch = originalFetch; process.env = originalEnvironment; harness.sql.close(); }
}

test("strict current binding projects rejection consistently in details, list, counts and overview", () => withHarness(async harness => {
  harness.sql.exec(`INSERT INTO post_targets VALUES ('second', '${postId}', 'second', 'x', 'Second', 'accepted', 4,
    NULL, NULL, NULL, NULL, '${submittedAt}', '${submittedAt}', '${submittedAt}', NULL, NULL)`);
  const detail = await harness.storage.getManualPost("owner", postId);
  assert.deepEqual(detail.targets.map(target => target.status), ["rejected", "accepted"]);
  assert.equal(detail.editable, false);
  const list = await harness.storage.listManualPosts("owner", filters);
  assert.equal(list.items[0].acceptedCount, 1);
  assert.equal(list.items[0].rejectedCount, 1);
  assert.equal(list.items[0].status, "attention");
  assert.equal(list.items[0].deletable, false);
  assert.equal(list.counts.attention, 1);
  const overview = await harness.storage.overviewSnapshot("owner", 86_400_000);
  assert.equal(overview.counts.attention, 1);
  assert.equal(overview.activity[0].kind, "rejected");
  assert.equal(harness.requests.length, 0, "storage must not perform network I/O");
}));

test("all rejected targets are frozen and cannot be edited or deleted", () => withHarness(async harness => {
  const detail = await harness.storage.getManualPost("owner", postId);
  assert.equal(detail.frozenReason, "rejected");
  assert.equal(postTypes.isTargetSetEditable(detail.targets), false);
  assert.equal(postTypes.postStatusFromTargets(detail.targets), "attention");
  assert.equal((await harness.storage.listManualPosts("owner", filters)).items[0].deletable, false);
  assert.equal((await harness.storage.updateManualPost("owner", postId, 4, { content: "Changed" })).kind, "frozen");
  assert.equal((await harness.storage.deleteManualPost("owner", postId)).kind, "frozen");
}));

for (const [label, mutation] of [
  ["old target audit", "UPDATE post_targets SET audit_id='old-audit'"],
  ["wrong audit asset", "UPDATE social_publishes SET asset_id='another-post'"],
  ["wrong integration", "UPDATE social_publishes SET integration_id='other'"],
  ["AI project audit", "UPDATE social_publishes SET project_id='project'"],
  ["wrong owner", "UPDATE social_publishes SET published_by='other'"],
  ["wrong audit upstream", "UPDATE social_publishes SET postiz_post_id='other'"],
  ["differently cased audit upstream", "UPDATE social_publishes SET postiz_post_id='OLD-UPSTREAM'"],
  ["wrong tracking upstream", "UPDATE social_post_tracking SET postiz_post_id='other'"],
  ["wrong tracking audit", "UPDATE social_post_tracking SET publish_audit_id='other'"],
  ["no tracking", "DELETE FROM social_post_tracking"],
  ["unknown review with no action", "UPDATE social_post_tracking SET save_action=NULL, review_status='unknown'"],
  ["not a draft", "UPDATE social_post_tracking SET state='QUEUE'"],
  ["raw nonaccepted", "UPDATE post_targets SET status='pending_unknown'"]
]) {
  test(`${label} cannot project rejection`, () => withHarness(async harness => {
    harness.sql.exec(mutation);
    const detail = await harness.storage.getManualPost("owner", postId);
    assert.notEqual(detail.targets[0].status, "rejected");
    assert.equal((await harness.storage.listManualPosts("owner", filters)).items[0].rejectedCount, 0);
  }));
}

test("missing action preserves the worker's known rejected marker but cannot authorize a fresh retry", () => withHarness(async harness => {
  harness.sql.exec("UPDATE social_post_tracking SET save_action=NULL");
  assert.equal((await harness.storage.getManualPost("owner", postId)).targets[0].status, "rejected");
  harness.livePost = { id: "old-upstream", state: "DRAFT" };
  assert.equal((await harness.submit()).kind, "validation");
  assert.equal(harness.requests.length, 1);
}));

test("a rejected retry creates one new draft, atomically binds its audit and excludes the old rejection", () => withHarness(async harness => {
  const result = await harness.submit();
  assert.equal(result.kind, "ok");
  assert.equal(result.post.targets[0].status, "accepted");
  assert.equal(result.post.targets[0].auditId, "33333333-3333-4333-8333-333333333333");
  assert.equal(result.post.targets[0].postizPostId, "new-upstream");
  const lookup = new URL(harness.requests[0].url);
  assert.ok(Date.parse(lookup.searchParams.get("startDate")) < Date.parse(submittedAt.replace(" ", "T") + "Z"));
  assert.ok(Date.parse(lookup.searchParams.get("endDate")) > Date.parse("2030-03-01T00:00:00Z"));
  assert.equal(harness.sql.prepare("SELECT COUNT(*) AS total FROM social_publishes").get().total, 2);
  assert.equal((await harness.storage.listManualPosts("owner", filters)).items[0].rejectedCount, 0);
  assert.equal((await harness.submit()).kind, "conflict", "stale retry audit cannot create again");
  assert.equal((await harness.submit({ expectedAuditId: undefined })).kind, "ok", "ordinary accepted click remains idempotent");
  assert.equal(harness.requests.filter(request => request.options.method === "POST").length, 1);
}));

test("definite rejected retry failure restores the original frozen binding and rejection", () => withHarness(async harness => {
  harness.draftResponse = () => new Response("refused", { status: 400 });
  const result = await harness.submit();
  assert.equal(result.kind, "ok");
  assert.equal(result.post.targets[0].status, "rejected");
  assert.equal(result.post.targets[0].auditId, auditId);
  assert.equal(result.post.targets[0].postizPostId, "old-upstream");
  assert.equal(result.post.targets[0].submittedAt, submittedAt);
  assert.equal(result.post.editable, false);
  assert.match(result.post.targets[0].warning, /original rejected draft remains frozen/);
  assert.match(result.post.targets[0].error, /400/);
  assert.equal(harness.auditHistory[0].status, "failed");
}));

test("uncertain retry clears old binding and never permits a blind retry", () => withHarness(async harness => {
  harness.draftResponse = () => { throw new Error("transport failure"); };
  const first = await harness.submit();
  assert.equal(first.post.targets[0].status, "pending_unknown");
  assert.equal(first.post.targets[0].auditId, null);
  assert.equal(first.post.targets[0].postizPostId, null);
  assert.equal(first.post.editable, false);
  assert.equal((await harness.submit()).kind, "conflict");
  assert.equal((await harness.submit({ expectedAuditId: undefined })).kind, "unconfirmed");
  assert.equal(harness.requests.length, 2);
}));

test("missing/mismatched expected audit blocks retry before remote checks", () => withHarness(async harness => {
  assert.equal((await harness.submit({ expectedAuditId: undefined })).kind, "validation");
  assert.equal((await harness.submit({ expectedAuditId: "wrong" })).kind, "conflict");
  assert.equal(harness.requests.length, 0);
}));

for (const livePost of [null, { id: "wrong", state: "DRAFT", saveAction: "pass" },
  { id: "old-upstream", state: "QUEUE", saveAction: "pass" },
  { id: "old-upstream", state: "DRAFT", saveAction: "draft" }]) {
  test(`fresh upstream ${JSON.stringify(livePost)} refuses a retry`, () => withHarness(async harness => {
    harness.livePost = livePost;
    assert.equal((await harness.submit()).kind, "validation");
    assert.equal(harness.requests.length, 1);
  }));
}

for (const mutation of ["UPDATE posts SET version=5", "UPDATE post_targets SET audit_id='new-audit'",
  "UPDATE post_targets SET postiz_post_id='new-upstream'", "UPDATE social_post_tracking SET review_status='pending'"]) {
  test(`transaction recheck rejects a race: ${mutation}`, () => withHarness(async harness => {
    harness.afterLiveCheck = () => harness.sql.exec(mutation);
    assert.equal((await harness.submit()).kind, "conflict");
    assert.equal(harness.requests.length, 1);
  }));
}

test("double retry cannot reuse an in-flight claim", () => withHarness(async harness => {
  let nestedOutcome;
  harness.beforeDraftResponse = async () => { nestedOutcome = await harness.submit(); };
  assert.equal((await harness.submit()).kind, "ok");
  assert.equal(nestedOutcome.kind, "conflict");
  assert.equal(harness.requests.filter(request => request.options.method === "POST").length, 1);
}));

test("two retries that both pass the live check still create only one draft", () => withHarness(async harness => {
  let signalFirstCheck;
  let releaseFirstCheck;
  const firstCheckStarted = new Promise(resolve => { signalFirstCheck = resolve; });
  const firstCheckReleased = new Promise(resolve => { releaseFirstCheck = resolve; });
  harness.afterLiveCheck = async () => {
    harness.afterLiveCheck = null;
    signalFirstCheck();
    await firstCheckReleased;
  };
  const first = harness.submit();
  await firstCheckStarted;
  const second = await harness.submit();
  releaseFirstCheck();
  assert.equal(second.kind, "ok");
  assert.equal((await first).kind, "conflict");
  assert.equal(harness.requests.filter(request => request.options.method === "GET").length, 2);
  assert.equal(harness.requests.filter(request => request.options.method === "POST").length, 1);
}));

test("a late old finalizer cannot overwrite a newer pending_unknown attempt or its audit", () => withHarness(async harness => {
  harness.beforeDraftResponse = () => harness.sql.exec(`UPDATE post_targets SET status='pending_unknown',
    attempt_id='newer-attempt', audit_id='newer-audit', postiz_post_id='newer-upstream'`);
  await harness.submit();
  assert.equal(harness.getTarget().status, "pending_unknown");
  assert.equal(harness.getTarget().audit_id, "newer-audit");
  assert.equal(harness.getTarget().postiz_post_id, "newer-upstream");
}));

test("a swept same attempt may safely finalize accepted with its audit", () => withHarness(async harness => {
  harness.beforeDraftResponse = () => harness.sql.exec("UPDATE post_targets SET status='pending_unknown'");
  assert.equal((await harness.submit()).post.targets[0].status, "accepted");
  assert.equal(harness.getTarget().audit_id, "33333333-3333-4333-8333-333333333333");
}));

test("ownership and enabled-channel checks still gate rejected retries", () => withHarness(async harness => {
  harness.accountOwner = "other";
  assert.equal((await harness.submit()).kind, "forbidden");
  harness.accountOwner = "owner";
  harness.accountDisabled = true;
  assert.equal((await harness.submit()).kind, "forbidden");
  assert.equal(harness.requests.length, 0);
}));

test("submit route accepts only optional UUID expectedAuditId and forwards it", async () => {
  const { NextResponse } = nativeRequire("next/server");
  const received = [];
  const route = loadModule("../src/app/api/posts/[postId]/targets/[integrationId]/submit/route.ts", {
    "next/server": { NextResponse },
    "@/lib/auth": { currentUser: async () => ({ user: { id: "owner", displayName: "Owner", role: "member" } }) },
    "@/lib/project-db": { databaseConfigured: () => true },
    "@/lib/same-origin": { isSameOrigin: () => true },
    "@/lib/request-body": loadModule("../src/lib/request-body.ts"),
    "@/lib/draft-submissions": { enqueueManualSubmission: async options => { received.push(options); return { kind: "ok", post: {} }; } },
    "@/lib/draft-submission-scheduler": { wakeDraftSubmissionWorker: async () => {} }
  });
  for (const [expectedAuditId, expectedStatus] of [[null, 400], ["invalid", 400], [auditId, 200], [undefined, 200]]) {
    const request = new Request("https://studio.test/api/posts", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 4, expectedAuditId }) });
    assert.equal((await route.POST(request, { params: Promise.resolve({ postId, integrationId: "account" }) })).status, expectedStatus);
  }
  assert.deepEqual(received.map(options => options.expectedAuditId), [auditId, undefined]);
});
