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
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, disabled INTEGER, display_name TEXT);
    CREATE TABLE posts (id TEXT PRIMARY KEY, owner_user_id TEXT, title TEXT, content TEXT, image_data TEXT,
      image_thumb TEXT, image_name TEXT, image_width INTEGER, image_height INTEGER, version INTEGER,
      created_at TEXT, updated_at TEXT, video_media_id TEXT);
    CREATE TABLE post_targets (id TEXT, post_id TEXT, integration_id TEXT, platform TEXT, account_name TEXT,
      status TEXT, snapshot_version INTEGER, postiz_post_id TEXT, audit_id TEXT, warning TEXT, error TEXT,
      submitted_at TEXT, created_at TEXT, updated_at TEXT, attempt_id TEXT, attempt_started_at TEXT);
    CREATE TABLE social_publishes (id TEXT PRIMARY KEY, project_id TEXT, asset_id TEXT, integration_id TEXT,
      published_by TEXT, postiz_post_id TEXT);
    CREATE TABLE social_post_tracking (publish_audit_id TEXT PRIMARY KEY, postiz_post_id TEXT, review_status TEXT,
      state TEXT, save_action TEXT, postiz_publish_date TEXT, rejected_detected_at TEXT);
    CREATE TABLE draft_submissions (id TEXT PRIMARY KEY, owner_user_id TEXT, kind TEXT, source_id TEXT,
      project_id TEXT, integration_id TEXT, attempt_id TEXT, request_key TEXT UNIQUE, fingerprint TEXT,
      active_key TEXT UNIQUE, snapshot TEXT, state TEXT, lease_token TEXT, lease_expires_at TEXT,
      audit_id TEXT, postiz_post_id TEXT, warning TEXT, error TEXT, created_at TEXT, updated_at TEXT, finished_at TEXT);
    INSERT INTO users VALUES ('owner', 'member', 0, 'Owner');
    INSERT INTO posts VALUES ('${postId}', 'owner', 'Frozen title', 'Frozen content', NULL, NULL, NULL, NULL,
      NULL, 4, '${submittedAt}', '${submittedAt}', NULL);
    INSERT INTO post_targets VALUES ('target', '${postId}', 'account', 'x', 'Account', 'accepted', 4,
      'old-upstream', '${auditId}', NULL, NULL, '${submittedAt}', '${submittedAt}', '${submittedAt}', NULL, NULL);
    INSERT INTO social_publishes VALUES ('${auditId}', NULL, '${postId}', 'account', 'owner', 'old-upstream');
    INSERT INTO social_post_tracking VALUES ('${auditId}', 'old-upstream', 'rejected', 'DRAFT', 'pass',
      '2030-03-01 00:00:00.000', '${new Date().toISOString().slice(0, 23).replace("T", " ")}');
  `);
  const statements = [];
  let transactionOpen = false;
  let connectionTail = Promise.resolve();
  // SQLite executes the actual joins, CASE expressions, CTEs and conditional updates. Only MySQL
  // syntax that is not portable is translated; no canned status/count query responses are used.
  const execute = async (statement, parameters = []) => {
    statements.push(statement);
    let portableSql = statement.replace(/ FOR UPDATE(?: OF t, tracking| SKIP LOCKED)?\b/g, "")
      .replace(/ AS BINARY\)/g, " AS BLOB)")
      .replace(/<=>/g, "IS")
      .replace("IF(?='unknown',active_key,NULL)", "CASE WHEN ?='unknown' THEN active_key ELSE NULL END")
      .replace(/LEFT\(p.content, 400\)/g, "substr(p.content, 1, 400)")
      .replace(/GROUP_CONCAT\(DISTINCT t.platform ORDER BY t.platform\)/g, "GROUP_CONCAT(DISTINCT t.platform)");
    if (portableSql.startsWith("UPDATE post_targets t JOIN posts")) {
      portableSql = portableSql.replace("UPDATE post_targets t JOIN posts p ON p.id = t.post_id", "UPDATE post_targets")
        .replace("p.owner_user_id = ?", "post_id IN (SELECT id FROM posts WHERE owner_user_id = ?)")
        .replace("submission.attempt_id=t.attempt_id", "submission.attempt_id=post_targets.attempt_id")
        .replace(/\bt\./g, "");
    }
    const prepared = sql.prepare(portableSql);
    if (/^\s*(SELECT|WITH)\b/.test(portableSql)) {
      const rows = prepared.all(...parameters);
      if (statement.includes("t.attempt_started_at") && !statement.includes("FOR UPDATE")) await harness.afterTargetRead?.();
      return [rows];
    }
    return [{ affectedRows: prepared.run(...parameters).changes }];
  };
  const pool = { execute, getConnection: async () => {
    const precedingConnection = connectionTail;
    let releaseConnection;
    connectionTail = new Promise(resolve => { releaseConnection = resolve; });
    await precedingConnection;
    return {
      execute,
      beginTransaction: async () => { assert.equal(transactionOpen, false); transactionOpen = true; sql.exec("BEGIN"); },
      commit: async () => { sql.exec("COMMIT"); transactionOpen = false; },
      rollback: async () => { if (transactionOpen) sql.exec("ROLLBACK"); transactionOpen = false; },
      release: releaseConnection
    };
  } };
  const storage = loadModule("../src/lib/posts.ts", {
    "@/lib/project-db": { database: () => pool }, "./post-types": postTypes,
    "@/lib/video-uploads": { getVideoUpload: async () => { throw new Error("Legacy image posts must not query video uploads"); } }
  });
  const upstream = loadModule("../src/lib/postiz.ts", { "./types": loadModule("../src/lib/types.ts") });
  const requests = [];
  const auditHistory = [];
  const harness = {
    sql, storage, statements, requests, auditHistory,
    livePost: { id: "old-upstream", state: "DRAFT", saveAction: "pass" },
    draftResponse: () => Response.json([{ postId: "new-upstream" }]),
    afterTargetRead: null,
    afterLiveCheck: null,
    beforeDraftResponse: null,
    accountOwner: "owner",
    accountDisabled: false
  };
  const dependencies = {
    "@/lib/project-db": { database: () => pool },
    "@/lib/posts": storage,
    "@/lib/video-uploads": { getVideoUpload: async () => { throw new Error("Legacy image tasks must not query video uploads"); } },
    "@/lib/auth": { ownerHashFor: owner => `hash-${owner}` },
    "@/lib/social-accounts": { getSocialAccount: async () => ({ ownerUserId: harness.accountOwner, provider: "x", accountName: "Account" }) },
    "@/lib/postiz": {
      ...upstream,
      fetchPostizIntegrations: async () => {
        assert.equal(transactionOpen, false, "live account checks never hold a storage transaction");
        return { configured: true, accounts: [{ id: "account", identifier: "x", disabled: harness.accountDisabled }] };
      }
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
  };
  const submission = loadModule("../src/lib/post-submission.ts", dependencies);
  harness.queue = loadModule("../src/lib/draft-submissions.ts", { ...dependencies, "@/lib/post-submission": submission });
  harness.enqueue = (overrides = {}) => harness.queue.enqueueManualSubmission({
    userId: "owner", isAdmin: false, postId, integrationId: "account", expectedVersion: 4,
    expectedAuditId: auditId, ...overrides
  });
  harness.getTarget = () => sql.prepare("SELECT * FROM post_targets WHERE integration_id='account'").get();
  harness.getTask = () => sql.prepare("SELECT * FROM draft_submissions").get();
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
  assert.equal((await harness.enqueue()).kind, "queued");
  assert.equal(harness.requests.length, 0);
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.getTask().state, "failed");
  assert.match(harness.getTask().error, /no longer confirms this draft as rejected/);
  const detail = await harness.storage.getManualPost("owner", postId);
  assert.equal(detail.targets[0].status, "rejected");
  assert.equal(detail.targets[0].auditId, auditId);
  assert.equal(detail.targets[0].postizPostId, "old-upstream");
  assert.equal(detail.editable, false);
  assert.equal(harness.requests.length, 1);
}));

test("a rejected retry creates one new draft, atomically binds its audit and excludes the old rejection", () => withHarness(async harness => {
  const queued = await harness.enqueue();
  assert.equal(queued.kind, "queued");
  assert.equal(queued.task.state, "queued");
  assert.equal(queued.post.targets[0].status, "submitting");
  assert.equal(queued.post.targets[0].auditId, null);
  assert.equal(queued.post.targets[0].postizPostId, null);
  assert.equal(queued.post.editable, false);
  assert.equal(harness.requests.length, 0, "enqueue persists the frozen attempt without remote work");
  const snapshot = JSON.parse(harness.getTask().snapshot);
  assert.equal(snapshot.content, "Frozen content");
  assert.equal(snapshot.rejectedBinding.audit_id, auditId);
  assert.equal(harness.getTask().attempt_id, harness.getTarget().attempt_id);
  assert.equal(await harness.queue.processDraftSubmissions(), 1);
  assert.equal(harness.getTask().state, "succeeded");
  const detail = await harness.storage.getManualPost("owner", postId);
  assert.equal(detail.targets[0].status, "accepted");
  assert.equal(detail.targets[0].auditId, "33333333-3333-4333-8333-333333333333");
  assert.equal(detail.targets[0].postizPostId, "new-upstream");
  assert.equal(harness.getTask().audit_id, detail.targets[0].auditId);
  assert.equal(harness.getTask().postiz_post_id, detail.targets[0].postizPostId);
  const lookup = new URL(harness.requests[0].url);
  assert.ok(Date.parse(lookup.searchParams.get("startDate")) < Date.parse(submittedAt.replace(" ", "T") + "Z"));
  assert.ok(Date.parse(lookup.searchParams.get("endDate")) > Date.parse("2030-03-01T00:00:00Z"));
  assert.equal(harness.sql.prepare("SELECT COUNT(*) AS total FROM social_publishes").get().total, 2);
  assert.equal((await harness.storage.listManualPosts("owner", filters)).items[0].rejectedCount, 0);
  assert.equal((await harness.enqueue()).kind, "conflict", "stale retry audit cannot create again");
  assert.equal((await harness.enqueue({ expectedAuditId: undefined })).kind, "ok", "ordinary accepted click remains idempotent");
  assert.equal(await harness.queue.processDraftSubmissions(), 0);
  assert.equal(harness.sql.prepare("SELECT COUNT(*) AS total FROM draft_submissions").get().total, 1);
  assert.equal(harness.requests.filter(request => request.options.method === "POST").length, 1);
}));

test("definite rejected retry failure restores the original frozen binding and rejection", () => withHarness(async harness => {
  harness.draftResponse = () => new Response("refused", { status: 400 });
  assert.equal((await harness.enqueue()).kind, "queued");
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.getTask().state, "failed");
  assert.equal(harness.getTask().error, "The publishing engine refused the draft. No draft was created.");
  const detail = await harness.storage.getManualPost("owner", postId);
  assert.equal(detail.targets[0].status, "rejected");
  assert.equal(detail.targets[0].auditId, auditId);
  assert.equal(detail.targets[0].postizPostId, "old-upstream");
  assert.equal(detail.targets[0].submittedAt, submittedAt);
  assert.equal(detail.editable, false);
  assert.equal(detail.targets[0].error, harness.getTask().error);
  assert.equal((await harness.storage.updateManualPost("owner", postId, 4, { content: "Changed" })).kind, "frozen");
  assert.equal((await harness.storage.deleteManualPost("owner", postId)).kind, "frozen");
  assert.equal(harness.auditHistory[0].status, "failed");
  assert.notEqual(harness.getTask().audit_id, detail.targets[0].auditId, "failure auditing never replaces the rejected binding");
  const failedTask = harness.getTask();
  assert.equal(failedTask.active_key, null);
  const retry = await harness.enqueue();
  assert.equal(retry.kind, "queued", "a definite failure permits a fresh retry of the original rejected binding");
  assert.notEqual(retry.task.id, failedTask.id);
  assert.equal(harness.requests.filter(request => request.options.method === "POST").length, 1);
}));

test("uncertain retry clears old binding and never permits a blind retry", () => withHarness(async harness => {
  let transportFailureInjected = false;
  harness.draftResponse = () => { transportFailureInjected = true; throw new Error("transport failure"); };
  assert.equal((await harness.enqueue()).kind, "queued");
  await harness.queue.processDraftSubmissions();
  assert.equal(transportFailureInjected, true, "unknown must come from the intended transport failure, not a swallowed fetch assertion");
  assert.equal(harness.getTask().state, "unknown");
  assert.ok(harness.getTask().active_key, "unknown work keeps its duplicate-prevention key");
  const detail = await harness.storage.getManualPost("owner", postId);
  assert.equal(detail.targets[0].status, "pending_unknown");
  assert.equal(detail.targets[0].auditId, null);
  assert.equal(detail.targets[0].postizPostId, null);
  assert.equal(detail.editable, false);
  assert.match(detail.targets[0].warning, /Check the publishing engine before submitting again/);
  assert.equal((await harness.enqueue()).kind, "conflict");
  assert.equal((await harness.enqueue({ expectedAuditId: undefined })).kind, "unconfirmed");
  assert.equal(await harness.queue.processDraftSubmissions(), 0, "unknown work is never automatically retried");
  assert.equal(harness.auditHistory.length, 0);
  assert.equal(harness.requests.length, 2);
}));

test("missing/mismatched expected audit blocks retry before remote checks", () => withHarness(async harness => {
  assert.equal((await harness.enqueue({ expectedAuditId: undefined })).kind, "conflict");
  assert.equal((await harness.enqueue({ expectedAuditId: "wrong" })).kind, "conflict");
  assert.equal(harness.getTask(), undefined);
  assert.equal(harness.getTarget().audit_id, auditId);
  assert.equal(harness.requests.length, 0);
}));

for (const livePost of [null, { id: "wrong", state: "DRAFT", saveAction: "pass" },
  { id: "old-upstream", state: "QUEUE", saveAction: "pass" },
  { id: "old-upstream", state: "DRAFT", saveAction: "draft" }]) {
  test(`fresh upstream ${JSON.stringify(livePost)} refuses a retry`, () => withHarness(async harness => {
    harness.livePost = livePost;
    assert.equal((await harness.enqueue()).kind, "queued");
    assert.equal(harness.requests.length, 0);
    await harness.queue.processDraftSubmissions();
    assert.equal(harness.getTask().state, "failed");
    assert.match(harness.getTask().error, /no longer confirms this draft as rejected/);
    const detail = await harness.storage.getManualPost("owner", postId);
    assert.equal(detail.targets[0].status, "rejected");
    assert.equal(detail.targets[0].auditId, auditId);
    assert.equal(detail.targets[0].postizPostId, "old-upstream");
    assert.equal(detail.targets[0].submittedAt, submittedAt);
    assert.equal(detail.editable, false);
    assert.equal(harness.requests.length, 1);
  }));
}

for (const mutation of ["UPDATE posts SET version=5", "UPDATE post_targets SET audit_id='new-audit'",
  "UPDATE post_targets SET postiz_post_id='new-upstream'", "UPDATE social_post_tracking SET review_status='pending'"]) {
  test(`enqueue transaction recheck rejects a race: ${mutation}`, () => withHarness(async harness => {
    harness.afterTargetRead = () => harness.sql.exec(mutation);
    assert.equal((await harness.enqueue()).kind, "conflict");
    assert.equal(harness.getTask(), undefined);
    assert.equal(harness.requests.length, 0);
  }));
}

for (const mutation of ["UPDATE posts SET version=5", "UPDATE social_publishes SET id='new-audit'",
  "UPDATE social_publishes SET postiz_post_id='new-upstream'", "UPDATE social_post_tracking SET review_status='pending'"]) {
  test(`worker recheck rejects a live-check race: ${mutation}`, () => withHarness(async harness => {
    assert.equal((await harness.enqueue()).kind, "queued");
    harness.afterLiveCheck = () => harness.sql.exec(mutation);
    await harness.queue.processDraftSubmissions();
    assert.equal(harness.getTask().state, "failed");
    assert.equal(harness.getTask().error, "The frozen submission binding changed. No draft was created.");
    const detail = await harness.storage.getManualPost("owner", postId);
    assert.equal(detail.targets[0].auditId, auditId);
    assert.equal(detail.targets[0].postizPostId, "old-upstream");
    assert.equal(detail.editable, false);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.auditHistory.length, 0);
  }));
}

test("double retry cannot reuse an in-flight claim", () => withHarness(async harness => {
  let nestedOutcome;
  harness.beforeDraftResponse = async () => { nestedOutcome = await harness.enqueue(); };
  assert.equal((await harness.enqueue()).kind, "queued");
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.getTask().state, "succeeded");
  assert.equal((await harness.storage.getManualPost("owner", postId)).targets[0].status, "accepted");
  assert.equal(nestedOutcome.kind, "conflict");
  assert.equal(harness.requests.filter(request => request.options.method === "POST").length, 1);
}));

test("concurrent retries and workers still create only one draft", () => withHarness(async harness => {
  const outcomes = await Promise.all([harness.enqueue(), harness.enqueue()]);
  assert.deepEqual(outcomes.map(outcome => outcome.kind).sort(), ["conflict", "queued"]);
  assert.equal(harness.sql.prepare("SELECT COUNT(*) AS total FROM draft_submissions").get().total, 1);
  let signalFirstCheck;
  let releaseFirstCheck;
  const firstCheckStarted = new Promise(resolve => { signalFirstCheck = resolve; });
  const firstCheckReleased = new Promise(resolve => { releaseFirstCheck = resolve; });
  harness.afterLiveCheck = async () => {
    harness.afterLiveCheck = null;
    signalFirstCheck();
    await firstCheckReleased;
  };
  const firstWorker = harness.queue.processDraftSubmissions();
  await firstCheckStarted;
  try {
    assert.equal(await harness.queue.processDraftSubmissions(), 0, "another worker cannot claim running work");
    assert.equal((await harness.enqueue()).kind, "conflict");
    assert.equal((await harness.enqueue({ expectedAuditId: undefined })).kind, "in_flight");
    assert.equal(harness.requests.filter(request => request.options.method === "POST").length, 0);
  } finally { releaseFirstCheck(); await firstWorker; }
  assert.equal(harness.getTask().state, "succeeded");
  assert.equal((await harness.storage.getManualPost("owner", postId)).targets[0].status, "accepted");
  assert.equal(harness.requests.filter(request => request.options.method === "GET").length, 1);
  assert.equal(harness.requests.filter(request => request.options.method === "POST").length, 1);
}));

test("a late old worker cannot overwrite a newer pending_unknown attempt or its audit", () => withHarness(async harness => {
  harness.beforeDraftResponse = () => harness.sql.exec(`UPDATE post_targets SET status='pending_unknown',
    attempt_id='newer-attempt', audit_id='newer-audit', postiz_post_id='newer-upstream'`);
  assert.equal((await harness.enqueue()).kind, "queued");
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.getTask().state, "succeeded", "the completed old task retains its own result");
  assert.equal(harness.getTask().audit_id, "33333333-3333-4333-8333-333333333333");
  const detail = await harness.storage.getManualPost("owner", postId);
  assert.equal(detail.targets[0].status, "pending_unknown");
  assert.equal(harness.getTarget().attempt_id, "newer-attempt");
  assert.equal(detail.targets[0].auditId, "newer-audit");
  assert.equal(detail.targets[0].postizPostId, "newer-upstream");
}));

test("a recovered unknown same attempt may safely finish accepted with its audit", () => withHarness(async harness => {
  harness.beforeDraftResponse = async () => {
    harness.sql.exec("UPDATE draft_submissions SET lease_expires_at='2020-01-01 00:00:00.000'");
    await harness.queue.recoverDraftSubmissions();
    assert.equal(harness.getTask().state, "unknown");
    assert.equal(harness.getTarget().status, "pending_unknown");
    assert.equal(harness.getTarget().attempt_id, harness.getTask().attempt_id);
  };
  assert.equal((await harness.enqueue()).kind, "queued");
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.getTask().state, "succeeded");
  const detail = await harness.storage.getManualPost("owner", postId);
  assert.equal(detail.targets[0].status, "accepted");
  assert.equal(detail.targets[0].auditId, "33333333-3333-4333-8333-333333333333");
  assert.equal(detail.targets[0].postizPostId, "new-upstream");
  assert.equal(detail.targets[0].warning, null);
  assert.equal(harness.getTask().active_key, null);
  assert.equal(harness.requests.filter(request => request.options.method === "POST").length, 1);
}));

test("account and manual-post ownership gate rejected retries before enqueue", () => withHarness(async harness => {
  harness.accountOwner = "other";
  assert.equal((await harness.enqueue()).kind, "forbidden");
  harness.accountOwner = "owner";
  assert.equal((await harness.enqueue({ userId: "other", isAdmin: true })).kind, "not_found", "admins cannot submit another owner's private manual post");
  assert.equal(harness.getTask(), undefined);
  assert.equal(harness.requests.length, 0);
}));

for (const protection of ["reassigned account", "disabled account", "disabled owner"]) {
  test(`worker ${protection} protection restores the frozen rejected binding`, () => withHarness(async harness => {
    assert.equal((await harness.enqueue()).kind, "queued");
    if (protection === "reassigned account") harness.accountOwner = "other";
    else if (protection === "disabled account") harness.accountDisabled = true;
    else harness.sql.exec("UPDATE users SET disabled=1");
    await harness.queue.processDraftSubmissions();
    assert.equal(harness.getTask().state, "failed");
    assert.match(harness.getTask().error, /No draft was created/);
    const detail = await harness.storage.getManualPost("owner", postId);
    assert.equal(detail.targets[0].status, "rejected");
    assert.equal(detail.targets[0].auditId, auditId);
    assert.equal(detail.targets[0].postizPostId, "old-upstream");
    assert.equal(detail.editable, false);
    assert.equal(harness.requests.length, 0);
  }));
}

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
