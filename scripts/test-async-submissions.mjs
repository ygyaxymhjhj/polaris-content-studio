import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
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

const postId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const task = { id: taskId, kind: "asset", sourceId: "asset-one", projectId: null, integrationId: "account", state: "queued" };

for (const kind of ["manual", "asset"]) {
  test(`${kind}: HTTP 202 acknowledges durable work without awaiting a non-resolving Postiz promise`, async () => {
    const persisted = [];
    const wakeups = [];
    let externalCalls = 0;
    const never = new Promise(() => {});
    const enqueue = async () => {
      persisted.push({ ...task, kind });
      return { kind: "queued", task: persisted[0], post: { id: postId, targets: [{ status: "submitting" }] } };
    };
    const dependencies = {
      "next/server": { NextResponse, after: callback => wakeups.push(callback) },
      "@/lib/auth": { currentUser: async () => ({ user: { id: "owner", displayName: "Owner", role: "member" }, ownerHash: "owner-hash" }) },
      "@/lib/project-db": { databaseConfigured: () => true, database: () => ({ execute: async () => [[{ id: postId }]] }) },
      "@/lib/same-origin": { isSameOrigin: () => true },
      "@/lib/request-body": loadModule("../src/lib/request-body.ts"),
      "@/lib/image-upload": loadModule("../src/lib/image-upload.ts"),
      "@/lib/social-accounts": { getSocialAccount: async () => ({ ownerUserId: "owner", provider: "x" }) },
      "@/lib/draft-submissions": { enqueueManualSubmission: enqueue, enqueueAssetSubmission: enqueue },
      "@/lib/draft-submission-scheduler": { wakeDraftSubmissionWorker: async () => { externalCalls++; await never; } },
      "@/lib/postiz": { createStrictDraft: async () => { externalCalls++; await never; } },
      "@/lib/social-notifications": { recordSocialSubmission: async () => ({ auditId: "audit" }), deliverSocialNotifications: async () => ({ failed: 0 }) }
    };
    const path = kind === "manual" ? "../src/app/api/posts/[postId]/targets/[integrationId]/submit/route.ts" : "../src/app/api/social/publish/route.ts";
    const route = loadModule(path, dependencies);
    const request = new NextRequest("https://studio.test/api/social/publish", { method: "POST", headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify(kind === "manual" ? { expectedVersion: 4 } : { assetId: "asset-one", integrationId: "account", content: "Frozen text", requestId }) });
    const response = await route.POST(request, { params: Promise.resolve({ postId, integrationId: "account" }) });
    assert.equal(response.status, 202);
    assert.equal(persisted[0].state, "queued", "queue insertion precedes the response");
    assert.equal((await response.json()).task.state, "queued");
    assert.equal(externalCalls, 0, "HTTP handling does not touch Postiz or deliver notifications");
    assert.equal(wakeups.length, 1, "only a post-response wakeup is registered");
  });
}

export { loadModule };

function createHarness() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, disabled INTEGER, display_name TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, owner_hash TEXT, name TEXT, snapshot TEXT, version INTEGER DEFAULT 1, updated_at TEXT);
    CREATE TABLE posts (id TEXT PRIMARY KEY, owner_user_id TEXT, title TEXT, content TEXT, image_data TEXT,
      image_thumb TEXT, image_name TEXT, image_width INTEGER, image_height INTEGER, version INTEGER, created_at TEXT, updated_at TEXT, video_media_id TEXT);
    CREATE TABLE video_uploads (id TEXT PRIMARY KEY, owner_user_id TEXT, request_id TEXT, checksum TEXT,
      postiz_media_id TEXT, postiz_path TEXT, filename TEXT, byte_size INTEGER, width INTEGER, height INTEGER, duration_seconds REAL);
    CREATE TABLE post_targets (id TEXT, post_id TEXT, integration_id TEXT, platform TEXT, account_name TEXT,
      status TEXT, snapshot_version INTEGER, attempt_id TEXT, attempt_started_at TEXT, postiz_post_id TEXT,
      audit_id TEXT, warning TEXT, error TEXT, submitted_at TEXT, created_at TEXT, updated_at TEXT, UNIQUE(post_id, integration_id));
    CREATE TABLE social_publishes (id TEXT PRIMARY KEY, project_id TEXT, asset_id TEXT, integration_id TEXT,
      published_by TEXT, postiz_post_id TEXT, created_at TEXT);
    CREATE TABLE social_post_tracking (publish_audit_id TEXT PRIMARY KEY, postiz_post_id TEXT, review_status TEXT,
      state TEXT, save_action TEXT, postiz_publish_date TEXT, rejected_detected_at TEXT);
    CREATE TABLE draft_submissions (id TEXT PRIMARY KEY, owner_user_id TEXT, kind TEXT, source_id TEXT,
      project_id TEXT, integration_id TEXT, attempt_id TEXT, request_key TEXT UNIQUE, fingerprint TEXT,
      active_key TEXT UNIQUE, snapshot TEXT, state TEXT, lease_token TEXT, lease_expires_at TEXT,
      audit_id TEXT, postiz_post_id TEXT, warning TEXT, error TEXT, created_at TEXT, updated_at TEXT, finished_at TEXT);
    INSERT INTO users VALUES ('owner','member',0,'Owner');
    INSERT INTO projects (id, owner_hash) VALUES ('${postId}','hash-owner');
    INSERT INTO posts VALUES ('${postId}','owner','Title','Frozen text','data:image/png;base64,AAAA',NULL,NULL,NULL,NULL,4,'2020-01-01','2020-01-01',NULL);
    INSERT INTO post_targets VALUES ('target','${postId}','account','x','Account','not_started',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2020-01-01','2020-01-01');
  `);
  const harness = { sql, drafts: [], audits: [], accountOwner: "owner", liveDisabled: false, liveAccountMissing: false,
    draftResult: { success: true, postId: "upstream-one" }, auditFailure: false, failInsert: false,
    livePost: { id: "old-upstream", state: "DRAFT", saveAction: "pass" }, afterLive: null, draftPromise: null,
    statements: [], liveIdentifier: "x" };
  let connectionTail = Promise.resolve();
  let transactionOpen = false;
  const execute = async (statement, parameters = []) => {
    harness.statements.push({ statement, parameters, transactionOpen });
    if (harness.failInsert && statement.includes("INSERT INTO draft_submissions")) throw new Error("missing table or insert denied");
    let portable = statement.replace(/ FOR UPDATE(?: OF t, tracking| SKIP LOCKED)?\b/g, "")
      .replace(/ FOR SHARE\b/g, "").replace(/ AS BINARY\)/g, " AS BLOB)")
      .replace(/<=>/g, "IS")
      .replace("IF(?='unknown',active_key,NULL)", "CASE WHEN ?='unknown' THEN active_key ELSE NULL END")
      .replace(/LEFT\(p.content, 400\)/g, "substr(p.content, 1, 400)")
      .replace(/GROUP_CONCAT\(DISTINCT t.platform ORDER BY t.platform\)/g, "GROUP_CONCAT(DISTINCT t.platform)")
      .replace(/CURRENT_TIMESTAMP\(3\)/g, "CURRENT_TIMESTAMP")
      .replace(/ON DUPLICATE KEY UPDATE platform=VALUES\(platform\), account_name=VALUES\(account_name\), updated_at=VALUES\(updated_at\)/g,
        "ON CONFLICT(post_id, integration_id) DO UPDATE SET platform=excluded.platform, account_name=excluded.account_name, updated_at=excluded.updated_at");
    if (portable.startsWith("UPDATE post_targets t JOIN posts")) {
      portable = portable.replace("UPDATE post_targets t JOIN posts p ON p.id = t.post_id", "UPDATE post_targets")
        .replace("p.owner_user_id = ?", "post_id IN (SELECT id FROM posts WHERE owner_user_id=?)")
        .replace("submission.attempt_id=t.attempt_id", "submission.attempt_id=post_targets.attempt_id")
        .replace(/\bt\./g, "");
    }
    const prepared = sql.prepare(portable);
    return /^\s*(SELECT|WITH)\b/.test(portable) ? [prepared.all(...parameters)] : [{ affectedRows: prepared.run(...parameters).changes }];
  };
  const pool = { execute, getConnection: async () => {
    const preceding = connectionTail;
    let release;
    connectionTail = new Promise(resolve => { release = resolve; });
    await preceding;
    return { execute,
      beginTransaction: async () => { assert.equal(transactionOpen, false); transactionOpen = true; sql.exec("BEGIN"); },
      commit: async () => { sql.exec("COMMIT"); transactionOpen = false; },
      rollback: async () => { if (transactionOpen) sql.exec("ROLLBACK"); transactionOpen = false; },
      release
    };
  } };
  const postTypes = loadModule("../src/lib/post-types.ts");
  const videoUploads = loadModule("../src/lib/video-uploads.ts", {
    "@/lib/project-db": { database: () => pool }, "./video-types": loadModule("../src/lib/video-types.ts")
  });
  const storage = loadModule("../src/lib/posts.ts", {
    "@/lib/project-db": { database: () => pool }, "./post-types": postTypes, "@/lib/video-uploads": videoUploads
  });
  const dependencies = {
    "@/lib/project-db": { database: () => pool }, "@/lib/posts": storage,
    "@/lib/video-uploads": videoUploads,
    "@/lib/auth": { ownerHashFor: owner => `hash-${owner}` },
    "@/lib/social-accounts": { getSocialAccount: async () => ({ ownerUserId: harness.accountOwner, provider: "x", accountName: "Account" }) },
    "@/lib/postiz": {
      fetchPostizIntegrations: async () => { assert.equal(transactionOpen, false); return { configured: true, accounts: harness.liveAccountMissing ? [] : [{ id: "account", identifier: harness.liveIdentifier, disabled: harness.liveDisabled }] }; },
      fetchPostizPostDetails: async () => {
        assert.equal(transactionOpen, false);
        const observed = structuredClone(harness.livePost);
        await harness.afterLive?.();
        return new Map(observed ? [[observed.id, observed]] : []);
      },
      createStrictDraft: async input => {
        assert.equal(transactionOpen, false, "external work must not hold database locks");
        harness.drafts.push(input);
        return harness.createDraft ? harness.createDraft(input) : harness.draftPromise || harness.draftResult;
      }
    },
    "@/lib/social-notifications": { recordSocialSubmission: async entry => {
      harness.audits.push(entry);
      if (harness.auditFailure) throw new Error("audit unavailable");
      return { auditId: "new-audit" };
    } }
  };
  const submission = loadModule("../src/lib/post-submission.ts", dependencies);
  const queue = loadModule("../src/lib/draft-submissions.ts", { ...dependencies, "@/lib/post-submission": submission });
  return Object.assign(harness, { queue, storage, pool, videoUploads,
    enqueueAsset: (overrides = {}) => queue.enqueueAssetSubmission({ userId: "owner", isAdmin: false, assetId: "asset-one", integrationId: "account", content: "Frozen text", requestId, ...overrides }),
    enqueueManual: (overrides = {}) => queue.enqueueManualSubmission({ userId: "owner", isAdmin: false, postId, integrationId: "account", expectedVersion: 4, ...overrides }),
    tasks: () => sql.prepare("SELECT * FROM draft_submissions ORDER BY created_at, id").all(),
    target: () => sql.prepare("SELECT * FROM post_targets").get(),
    rejectOriginal: () => sql.exec(`UPDATE post_targets SET status='accepted', audit_id='old-audit', postiz_post_id='old-upstream', submitted_at='2020-01-01 00:00:00.000';
      INSERT INTO social_publishes VALUES ('old-audit',NULL,'${postId}','account','owner','old-upstream','2020-01-01 00:00:00.000');
      INSERT INTO social_post_tracking VALUES ('old-audit','old-upstream','rejected','DRAFT','pass',NULL,NULL);`)
  });
}

test("manual claim and durable insert are one transaction, including insert failure rollback", async () => {
  const harness = createHarness();
  harness.failInsert = true;
  await assert.rejects(harness.enqueueManual());
  assert.equal(harness.target().status, "not_started");
  assert.equal(harness.tasks().length, 0);
  harness.failInsert = false;
  const accepted = await harness.enqueueManual();
  assert.equal(accepted.kind, "queued");
  assert.equal(accepted.post.targets[0].status, "submitting");
  assert.equal(harness.drafts.length, 0);
  assert.equal(JSON.parse(harness.tasks()[0].snapshot).content, "Frozen text");
  assert.equal((await harness.enqueueManual()).kind, "in_flight");
  assert.equal((await harness.storage.updateManualPost("owner", postId, 4, { content: "different" })).kind, "frozen");
  harness.sql.close();
});

test("manual success uses the frozen snapshot, binds its audit and never creates a duplicate", async () => {
  const harness = createHarness();
  assert.equal((await harness.enqueueManual()).kind, "queued");
  await harness.queue.processDraftSubmissions();
  assert.deepEqual(harness.drafts, [{ integrationId: "account", content: "Frozen text", imageUrl: "data:image/png;base64,AAAA", platform: "x" }]);
  assert.equal(harness.target().status, "accepted");
  assert.equal(harness.target().postiz_post_id, "upstream-one");
  assert.equal(harness.target().audit_id, "new-audit");
  assert.equal(harness.audits[0].assetId, postId);
  assert.equal(harness.audits[0].projectId, undefined, "manual posts never borrow an AI project ID");
  assert.equal(harness.audits[0].status, "drafted");
  assert.equal((await harness.enqueueManual()).kind, "ok");
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.tasks().length, 1);
  assert.equal(harness.drafts.length, 1);
  assert.equal(harness.audits.length, 1);
  harness.sql.close();
});

for (const [mutation, expectedKind] of [
  ["UPDATE posts SET version=5", "conflict"],
  ["UPDATE posts SET content='   '", "validation"],
  ["DELETE FROM post_targets", "target_missing"],
  ["UPDATE posts SET owner_user_id='other'", "not_found"],
  ["reassign", "forbidden"]
]) {
  test(`manual enqueue refuses invalid input before persisting work: ${mutation}`, async () => {
    const harness = createHarness();
    if (mutation === "reassign") harness.accountOwner = "other";
    else harness.sql.exec(mutation);
    assert.equal((await harness.enqueueManual()).kind, expectedKind);
    assert.equal(harness.tasks().length, 0);
    assert.equal(harness.drafts.length, 0);
    harness.sql.close();
  });
}

test("a definite manual draft failure can be retried through a fresh queued attempt", async () => {
  const harness = createHarness();
  harness.draftResult = { success: false, error: "explicit refusal" };
  await harness.enqueueManual();
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.target().status, "failed");
  assert.match(harness.target().error, /No draft was created/);
  assert.equal(harness.audits[0].status, "failed");
  harness.draftResult = { success: true, postId: "retry-upstream" };
  assert.equal((await harness.enqueueManual()).kind, "queued");
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.target().status, "accepted");
  assert.equal(harness.target().postiz_post_id, "retry-upstream");
  assert.equal(harness.drafts.length, 2);
  harness.sql.close();
});

test("asset enqueue deduplicates lost responses and concurrent clicks, while later edits remain possible", async () => {
  const harness = createHarness();
  const outcomes = await Promise.all([harness.enqueueAsset(), harness.enqueueAsset({ requestId: taskId })]);
  assert.equal(outcomes[0].task.id, outcomes[1].task.id);
  assert.equal(harness.tasks().length, 1);
  assert.equal((await harness.enqueueAsset({ content: "changed", requestId: postId })).kind, "in_flight");
  let resolveDraft;
  harness.draftPromise = new Promise(resolve => { resolveDraft = resolve; });
  const firstWorker = harness.queue.processDraftSubmissions();
  while (!harness.drafts.length) await new Promise(resolve => setImmediate(resolve));
  await harness.queue.processDraftSubmissions();
  resolveDraft({ success: true, postId: "upstream-one" });
  await firstWorker;
  assert.equal(harness.drafts.length, 1, "two executors cannot claim the same queued task");
  assert.equal((await harness.enqueueAsset({ requestId: postId })).task.state, "succeeded");
  assert.equal(harness.tasks().length, 1, "a confirmed identical snapshot is never created twice");
  assert.equal((await harness.enqueueAsset({ content: "edited after success", requestId: taskId })).kind, "queued");
  assert.equal(harness.tasks().length, 2);
  harness.sql.close();
});

for (const kind of ["asset", "manual"]) {
  for (const [result, expected] of [[{ success: true, postId: "new-upstream" }, "succeeded"],
    [{ success: false, error: "explicit refusal" }, "failed"], [{ success: false, uncertain: true }, "unknown"]]) {
    test(`${kind} worker persists ${expected} without inventing publication`, async () => {
      const harness = createHarness();
      harness.draftResult = result;
      await (kind === "asset" ? harness.enqueueAsset() : harness.enqueueManual());
      await harness.queue.processDraftSubmissions();
      assert.equal(harness.tasks()[0].state, expected);
      if (kind === "manual") assert.equal(harness.target().status, expected === "succeeded" ? "accepted" : expected === "unknown" ? "pending_unknown" : "failed");
      if (expected === "unknown") {
        assert.equal(harness.audits.length, 0, "an unknown outcome is not a definite failure audit");
        assert.match(harness.tasks()[0].warning, /Check the publishing engine/);
        await harness.queue.processDraftSubmissions();
        assert.equal(harness.drafts.length, 1);
        if (kind === "asset") assert.equal((await harness.enqueueAsset({ content: "try another text", requestId: postId })).kind, "unconfirmed");
        else assert.equal((await harness.enqueueManual()).kind, "unconfirmed");
      }
      harness.sql.close();
    });
  }
}

test("successful creation with audit failure stays succeeded with a warning and blocks duplicates", async () => {
  const harness = createHarness();
  harness.auditFailure = true;
  await harness.enqueueAsset();
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.tasks()[0].state, "succeeded");
  assert.match(harness.tasks()[0].warning, /Do not submit again/);
  assert.equal((await harness.enqueueAsset({ requestId: taskId })).task.state, "succeeded");
  assert.equal(harness.drafts.length, 1);
  harness.sql.close();
});

test("queued jobs survive age and restart; expired running jobs become unknown without a create retry", async () => {
  const harness = createHarness();
  await harness.enqueueManual();
  harness.sql.exec("UPDATE post_targets SET attempt_started_at='2020-01-01'; UPDATE draft_submissions SET created_at='2020-01-01'");
  await harness.storage.sweepStaleSubmissions("owner");
  assert.equal(harness.target().status, "submitting", "queue wait is not an unknown external result");
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.drafts.length, 1);
  harness.sql.close();
  const crashed = createHarness();
  await crashed.enqueueManual();
  crashed.sql.exec("UPDATE draft_submissions SET state='running',lease_token='dead-process',lease_expires_at='2020-01-01'");
  await crashed.queue.processDraftSubmissions();
  assert.equal(crashed.tasks()[0].state, "unknown");
  assert.equal(crashed.target().status, "pending_unknown");
  assert.equal(crashed.drafts.length, 0);
  crashed.sql.close();
});

for (const mutation of ["UPDATE users SET disabled=1", "UPDATE users SET role='member'", "reassign", "disabled-account", "missing-account"]) {
  test(`worker rechecks current permissions: ${mutation}`, async () => {
    const harness = createHarness();
    harness.sql.exec("UPDATE users SET role='admin'");
    harness.accountOwner = "other";
    await harness.enqueueAsset({ isAdmin: true });
    if (mutation === "reassign") { harness.sql.exec("UPDATE users SET role='member'"); harness.accountOwner = "other"; }
    else if (mutation === "disabled-account") harness.liveDisabled = true;
    else if (mutation === "missing-account") harness.liveAccountMissing = true;
    else harness.sql.exec(mutation);
    await harness.queue.processDraftSubmissions();
    assert.equal(harness.tasks()[0].state, "failed");
    assert.equal(harness.drafts.length, 0);
    harness.sql.close();
  });
}

test("owner-only task reads omit snapshots and lease tokens", async () => {
  const harness = createHarness();
  const accepted = await harness.enqueueAsset();
  assert.deepEqual(await harness.queue.listDraftSubmissions("other", { ids: [accepted.task.id] }), []);
  const [visible] = await harness.queue.listDraftSubmissions("owner", { ids: [accepted.task.id] });
  assert.equal("snapshot" in visible, false);
  assert.equal("lease_token" in visible, false);
  assert.equal("content" in visible, false);
  harness.sql.close();
});

for (const livePost of [null, { id: "old-upstream", state: "DRAFT", saveAction: "draft" }]) {
  test(`rejected manual retry fresh check ${JSON.stringify(livePost)} restores the original frozen binding`, async () => {
    const harness = createHarness();
    harness.rejectOriginal();
    harness.livePost = livePost;
    const accepted = await harness.enqueueManual({ expectedAuditId: "old-audit" });
    assert.equal(accepted.kind, "queued");
    assert.equal(harness.drafts.length, 0);
    await harness.queue.processDraftSubmissions();
    assert.equal(harness.tasks()[0].state, "failed");
    assert.equal(harness.target().audit_id, "old-audit");
    assert.equal(harness.target().postiz_post_id, "old-upstream");
    assert.equal((await harness.storage.getManualPost("owner", postId)).editable, false);
    harness.sql.close();
  });
}

test("a late older worker cannot overwrite a newer manual attempt", async () => {
  const harness = createHarness();
  let resolveDraft;
  harness.draftPromise = new Promise(resolve => { resolveDraft = resolve; });
  await harness.enqueueManual();
  const worker = harness.queue.processDraftSubmissions();
  while (!harness.drafts.length) await new Promise(resolve => setImmediate(resolve));
  harness.sql.exec("UPDATE post_targets SET attempt_id='newer', audit_id='newer-audit', postiz_post_id='newer-upstream'");
  resolveDraft({ success: true, postId: "old-worker-result" });
  await worker;
  assert.equal(harness.target().audit_id, "newer-audit");
  assert.equal(harness.target().postiz_post_id, "newer-upstream");
  harness.sql.close();
});

for (const kind of ["manual", "asset"]) {
  test(`${kind} real route commits a queued SQL row before a held draft creation`, async () => {
    const harness = createHarness();
    const wakeups = [];
    let resolveDraft;
    harness.draftPromise = new Promise(resolve => { resolveDraft = resolve; });
    const route = loadModule(kind === "manual" ? "../src/app/api/posts/[postId]/targets/[integrationId]/submit/route.ts" : "../src/app/api/social/publish/route.ts", {
      "next/server": { NextResponse, after: callback => wakeups.push(callback) },
      "@/lib/auth": { currentUser: async () => ({ user: { id: "owner", role: "member", displayName: "Owner" } }) },
      "@/lib/project-db": { databaseConfigured: () => true },
      "@/lib/same-origin": { isSameOrigin: () => true },
      "@/lib/request-body": loadModule("../src/lib/request-body.ts"),
      "@/lib/image-upload": loadModule("../src/lib/image-upload.ts"),
      "@/lib/draft-submissions": harness.queue,
      "@/lib/draft-submission-scheduler": { wakeDraftSubmissionWorker: () => harness.queue.processDraftSubmissions() }
    });
    const request = new NextRequest("https://studio.test/api/posts", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(kind === "manual" ? { expectedVersion: 4 } : { assetId: "asset-one", integrationId: "account", content: "Frozen text", requestId }) });
    const response = await route.POST(request, { params: Promise.resolve({ postId, integrationId: "account" }) });
    assert.equal(response.status, 202);
    assert.equal(harness.tasks()[0].state, "queued");
    assert.equal(harness.drafts.length, 0);
    const worker = wakeups[0]();
    while (!harness.drafts.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.tasks()[0].state, "running");
    assert.equal((await response.json()).task.state, "queued", "response never claims external completion");
    resolveDraft({ success: true, postId: "upstream-held" });
    await worker;
    assert.equal(harness.tasks()[0].state, "succeeded");
    harness.sql.close();
  });
}

test("client task projection preserves content, unknown safety and exact review binding", () => {
  const statuses = loadModule("../src/lib/submission-status.ts");
  const client = loadModule("../src/lib/draft-submission-client.ts", {
    "./submission-status": statuses, "./draft-submission-types": loadModule("../src/lib/draft-submission-types.ts")
  });
  const queued = { ...task, auditId: null, postId: null, warning: null, error: null, createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", finishedAt: null };
  const asset = { id: "asset-one", content: "New local edits", imageUrl: "new-image", publishStatus: "unpublished" };
  const pending = client.mergeDraftTask(asset, queued);
  assert.equal(pending.publishStatus, "publishing");
  assert.equal(pending.content, "New local edits");
  const unknown = client.mergeDraftTask(pending, { ...queued, state: "unknown", warning: "Check first" });
  assert.equal(unknown.publishStatus, "pending_unknown");
  assert.equal(client.mergeDraftTask(unknown, queued), unknown, "late queued response cannot downgrade needs-review");
  const succeeded = client.mergeDraftTask(unknown, { ...queued, state: "succeeded", auditId: "audit", postId: "external", finishedAt: "2026-10-19T00:01:00.000Z" });
  assert.equal(succeeded.publishStatus, "drafted");
  assert.equal(succeeded.publishedAt, undefined);
  const rejected = { ...succeeded, reviewStatus: "rejected" };
  assert.equal(client.mergeDraftTask(rejected, { ...queued, state: "succeeded", auditId: "audit", postId: "external" }).reviewStatus, "rejected");
  const confirmedTask = { ...queued, state: "succeeded", auditId: "audit", postId: "external" };
  for (const publishStatus of ["publishing", "pending_unknown"]) {
    const restored = client.mergeDraftTask({ ...rejected, publishStatus, publishError: "Old uncertainty" }, confirmedTask);
    assert.equal(restored.publishStatus, "drafted", "a deduplicated success must release the pending card");
    assert.equal(restored.reviewStatus, "rejected", "recovery must preserve the known review result");
    assert.equal(restored.publishError, undefined);
    assert.strictEqual(client.mergeDraftTask(restored, confirmedTask), restored, "the next poll must keep the stable result");
  }
  const alreadyPublished = { ...succeeded, publishStatus: "publishing", publishedAt: "2026-10-19T01:00:00.000Z", publishedUrl: "https://example.test/post" };
  const restoredPublication = client.mergeDraftTask(alreadyPublished, confirmedTask);
  assert.equal(restoredPublication.publishStatus, "published", "deduplication cannot erase confirmed publication facts");
  assert.equal(restoredPublication.publishedAt, "2026-10-19T01:00:00.000Z");
});

// Focused video regressions: node --test --test-name-pattern=video scripts/test-async-submissions.mjs
const videoId = "44444444-4444-4444-8444-444444444444";
const otherVideoId = "55555555-5555-4555-8555-555555555555";
const image = { dataUrl: "data:image/png;base64,AAAA", thumbnailDataUrl: "data:image/jpeg;base64,AAAA", filename: "old.png", width: 20, height: 10 };

function seedVideo(harness, mediaId = videoId, ownerUserId = "owner") {
  harness.sql.prepare("INSERT INTO video_uploads VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(mediaId, ownerUserId, randomUUID(), "synthetic-checksum", `upstream-${mediaId}`, `https://media.test/${mediaId}.mp4`, "clip.mp4", 1024, 1280, 720, 3);
  return { id: `upstream-${mediaId}`, path: `https://media.test/${mediaId}.mp4` };
}

function videoHarness(context) {
  const harness = createHarness();
  context.after(() => harness.sql.close());
  seedVideo(harness);
  return harness;
}

test("video manual persistence restores the reference, lists it and copies without targets or another upload", async context => {
  const harness = videoHarness(context);
  const created = await harness.storage.createManualPost("owner", {
    title: "", content: "", image: null, videoMediaId: videoId,
    targets: [{ integrationId: "account", platform: "x", accountName: "Account" }]
  });
  assert.equal(created.videoMediaId, videoId);
  assert.equal(created.imageUrl, null);
  assert.equal((await harness.storage.getManualPost("owner", created.id)).videoMediaId, videoId);
  assert.equal(await harness.storage.getManualPost("other", created.id), null);
  const listed = await harness.storage.listManualPosts("owner", { status: "all", search: "", platform: "", integrationId: "", updatedSince: 0, page: 1, perPage: 20 });
  assert.equal(listed.items.find(post => post.id === created.id).hasVideo, true);
  const copy = await harness.storage.duplicateManualPost("owner", created.id);
  assert.equal(copy.videoMediaId, videoId);
  assert.deepEqual(copy.targets, []);
  assert.notEqual(copy.id, created.id);
  assert.equal(harness.sql.prepare("SELECT COUNT(*) AS count FROM video_uploads").get().count, 1);
  assert.equal(await harness.storage.duplicateManualPost("other", created.id), null);
});

test("video manual updates preserve omission, remove only explicit media and clear every old image column on replacement", async context => {
  const harness = videoHarness(context);
  let result = await harness.storage.updateManualPost("owner", postId, 4, { videoMediaId: videoId });
  assert.equal(result.kind, "ok");
  const stored = harness.sql.prepare("SELECT * FROM posts WHERE id=?").get(postId);
  for (const column of ["image_data", "image_thumb", "image_name", "image_width", "image_height"]) assert.equal(stored[column], null);
  for (const patch of [{ content: "Changed" }, { image: { kind: "remove" } }, { image: { kind: "keep" } }]) {
    result = await harness.storage.updateManualPost("owner", postId, result.post.version, patch);
    assert.equal(result.post.videoMediaId, videoId);
  }
  result = await harness.storage.updateManualPost("owner", postId, result.post.version, { videoMediaId: null });
  assert.equal(result.post.videoMediaId, null);
  result = await harness.storage.updateManualPost("owner", postId, result.post.version, { videoMediaId: videoId });
  result = await harness.storage.updateManualPost("owner", postId, result.post.version, { image: { kind: "set", image } });
  assert.equal(result.post.videoMediaId, null);
  assert.ok(result.post.imageUrl);
  result = await harness.storage.updateManualPost("owner", postId, result.post.version, { videoMediaId: null });
  assert.ok(result.post.imageUrl, "removing a video must not delete the current image");
  assert.ok(harness.statements.filter(entry => entry.statement.includes("FROM video_uploads")).every(entry => entry.transactionOpen));
});

test("video helpers reject foreign, malformed and mixed media atomically without relying on route schemas", async context => {
  const harness = videoHarness(context);
  seedVideo(harness, otherVideoId, "other");
  for (const mediaId of [otherVideoId, "not-a-uuid", ""]) {
    await assert.rejects(harness.storage.createManualPost("owner", { title: "Title", content: "", image: null, videoMediaId: mediaId, targets: [] }), harness.storage.PostMediaValidationError);
    await assert.rejects(harness.storage.updateManualPost("owner", postId, 4, { videoMediaId: mediaId }), harness.storage.PostMediaValidationError);
  }
  await assert.rejects(harness.storage.createManualPost("owner", { title: "Title", content: "", image, videoMediaId: videoId, targets: [] }), harness.storage.PostMediaValidationError);
  await assert.rejects(harness.storage.updateManualPost("owner", postId, 4, { image: { kind: "set", image }, videoMediaId: videoId }), harness.storage.PostMediaValidationError);
  assert.equal(harness.sql.prepare("SELECT COUNT(*) AS count FROM posts").get().count, 1);
  assert.equal(harness.sql.prepare("SELECT version FROM posts WHERE id=?").get(postId).version, 4);
  assert.equal((await harness.storage.updateManualPost("owner", postId, 3, { videoMediaId: videoId })).kind, "conflict");
  harness.sql.prepare("UPDATE posts SET image_data=NULL, video_media_id=?").run(otherVideoId);
  await assert.rejects(harness.storage.duplicateManualPost("owner", postId), harness.storage.PostMediaValidationError);
});

test("video manual claim verifies the locked reference before freezing or queue insertion", async context => {
  const harness = videoHarness(context);
  seedVideo(harness, otherVideoId, "other");
  harness.sql.prepare("UPDATE posts SET image_data=NULL, video_media_id=?").run(otherVideoId);
  assert.equal((await harness.enqueueManual()).kind, "validation");
  harness.sql.prepare("UPDATE posts SET image_data=?, video_media_id=?").run(image.dataUrl, videoId);
  assert.equal((await harness.enqueueManual()).kind, "validation");
  assert.equal(harness.target().status, "not_started");
  assert.equal(harness.tasks().length, 0);
  assert.ok(harness.statements.filter(entry => entry.statement.includes("FROM video_uploads")).every(entry => entry.transactionOpen));
});

test("video worker reuses the frozen reference in a real draft-only payload without any download or upload", async context => {
  const harness = videoHarness(context);
  seedVideo(harness, otherVideoId);
  harness.sql.prepare("UPDATE posts SET image_data=NULL, video_media_id=?").run(videoId);
  assert.equal((await harness.enqueueManual()).kind, "queued");
  const frozen = JSON.parse(harness.tasks()[0].snapshot);
  assert.equal(frozen.videoMediaId, videoId);
  assert.equal(frozen.imageUrl, null);
  assert.doesNotMatch(harness.tasks()[0].snapshot, /\.mp4|postizPath|postizMediaId|blob:|data:video/);
  assert.equal((await harness.storage.updateManualPost("owner", postId, 4, { videoMediaId: otherVideoId })).kind, "frozen");
  // Simulate a bypassed mutable row: execution must still use the committed queue reference.
  harness.sql.prepare("UPDATE posts SET video_media_id=?").run(otherVideoId);
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.POSTIZ_API_URL;
  const originalKey = process.env.POSTIZ_API_KEY;
  const originalMediaOrigins = process.env.POSTIZ_MEDIA_ORIGINS;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.POSTIZ_API_URL; else process.env.POSTIZ_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.POSTIZ_API_KEY; else process.env.POSTIZ_API_KEY = originalKey;
    if (originalMediaOrigins === undefined) delete process.env.POSTIZ_MEDIA_ORIGINS; else process.env.POSTIZ_MEDIA_ORIGINS = originalMediaOrigins;
  });
  process.env.POSTIZ_API_URL = "https://postiz.test";
  process.env.POSTIZ_API_KEY = "synthetic";
  process.env.POSTIZ_MEDIA_ORIGINS = "https://media.test";
  const requests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://postiz.test/api/public/v1/posts", "no media GET or upload endpoint may be called");
    requests.push(JSON.parse(options.body));
    return Response.json([{ postId: "new-video-draft" }]);
  };
  harness.liveIdentifier = "instagram-standalone";
  harness.createDraft = loadModule("../src/lib/postiz.ts", { "./types": loadModule("../src/lib/types.ts") }).createStrictDraft;
  await harness.queue.processDraftSubmissions();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "draft");
  assert.equal(requests[0].posts[0].settings.__type, "instagram-standalone");
  assert.deepEqual(requests[0].posts[0].value[0].image, [{ id: `upstream-${videoId}`, path: `https://media.test/${videoId}.mp4` }]);
  assert.equal(harness.tasks()[0].state, "succeeded");
});

test("video AI enqueue checks owner even for admins, keeps project ownership and fingerprints the frozen ID", async context => {
  const harness = videoHarness(context);
  seedVideo(harness, otherVideoId, "other");
  assert.equal((await harness.enqueueAsset({ videoMediaId: otherVideoId, isAdmin: true })).kind, "validation");
  assert.equal((await harness.enqueueAsset({ videoMediaId: videoId, imageUrl: image.dataUrl })).kind, "validation");
  assert.equal((await harness.enqueueAsset({ videoMediaId: "invalid" })).kind, "validation");
  assert.equal((await harness.enqueueAsset({ videoMediaId: videoId, projectId: taskId, isAdmin: true })).kind, "forbidden");
  assert.equal(harness.tasks().length, 0);
  const first = await harness.enqueueAsset({ videoMediaId: videoId, projectId: postId });
  assert.equal(first.kind, "queued");
  const firstFingerprint = harness.tasks()[0].fingerprint;
  assert.equal(JSON.parse(harness.tasks()[0].snapshot).videoMediaId, videoId);
  assert.ok(harness.statements.filter(entry => entry.statement.includes("FROM video_uploads")).every(entry => entry.transactionOpen));
  await harness.queue.processDraftSubmissions();
  const replay = await harness.enqueueAsset({ videoMediaId: videoId, projectId: postId, requestId: randomUUID() });
  assert.equal(replay.task.id, first.task.id);
  seedVideo(harness, taskId);
  const changed = await harness.enqueueAsset({ videoMediaId: taskId, projectId: postId, requestId: randomUUID() });
  assert.notEqual(changed.task.id, first.task.id);
  assert.notEqual(harness.tasks().find(task => task.id === changed.task.id).fingerprint, firstFingerprint);
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.drafts[0].uploadedMedia.id, `upstream-${videoId}`);
  assert.equal(harness.drafts[1].uploadedMedia.id, `upstream-${taskId}`);
});

test("video extension preserves pre-existing image fingerprints and avoids video-table queries for legacy jobs", async context => {
  const harness = videoHarness(context);
  const accepted = await harness.enqueueAsset({ imageUrl: image.dataUrl });
  const legacyDigest = createHash("sha256").update(JSON.stringify(["asset", "owner", null, "asset-one", "account", "Frozen text", image.dataUrl, null])).digest("hex");
  assert.equal(harness.tasks()[0].fingerprint, legacyDigest);
  await harness.queue.processDraftSubmissions();
  assert.equal((await harness.enqueueAsset({ imageUrl: image.dataUrl, requestId: randomUUID() })).task.id, accepted.task.id);
  assert.equal(harness.statements.filter(entry => entry.statement.includes("video_uploads")).length, 0);
});

for (const mutation of ["UPDATE video_uploads SET owner_user_id='other'", "DELETE FROM video_uploads"]) {
  test(`video worker fails closed before creating a draft when its frozen reference disappears: ${mutation}`, async context => {
    const harness = videoHarness(context);
    await harness.enqueueAsset({ videoMediaId: videoId });
    harness.sql.exec(mutation);
    await harness.queue.processDraftSubmissions();
    assert.equal(harness.tasks()[0].state, "failed");
    assert.match(harness.tasks()[0].error, /video attachment/i);
    assert.equal(harness.drafts.length, 0);
  });
}

test("video create uncertainty retains the original unknown barrier and never automatically retries", async context => {
  const harness = videoHarness(context);
  harness.draftResult = { success: false, uncertain: true };
  await harness.enqueueAsset({ videoMediaId: videoId });
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.tasks()[0].state, "unknown");
  assert.ok(harness.tasks()[0].active_key);
  assert.equal((await harness.enqueueAsset({ videoMediaId: videoId, content: "Different", requestId: randomUUID() })).kind, "unconfirmed");
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.drafts.length, 1);
});

function projectSnapshot(assets) {
  return {
    schemaVersion: 1,
    config: { name: "Video project", title: "Title", category: "", language: "en", audience: "", cta: "", websiteUrl: "", sourceUrl: "", tone: "", publishDate: "", imageUrl: "https://media.test/article-cover.png" },
    sourceText: "Source", sourceName: "", sourcePending: false, importedSource: null, editedConfig: [], analysis: null,
    assets, selectedPlatforms: ["instagram"], threads: {}, usedFallback: false, generationRun: "first"
  };
}

test("video project PUT rejects upstream fields, validates owned references, restores IDs and skips old image snapshots", async context => {
  const harness = videoHarness(context);
  seedVideo(harness, otherVideoId, "other");
  const imageUpload = loadModule("../src/lib/image-upload.ts");
  const schemas = loadModule("../src/lib/project-schema.ts", { "./image-upload": imageUpload });
  const asset = { id: "asset-one", platform: "instagram", assetType: "post", title: "Title", content: "Text", factIds: [], riskFlags: [], updatedAt: "2026-10-22", videoMediaId: videoId };
  const route = loadModule("../src/app/api/projects/route.ts", {
    "next/server": { NextResponse },
    "@/lib/auth": { currentUser: async () => ({ user: { id: "owner", role: "admin" }, ownerHash: "hash-owner" }) },
    "@/lib/project-db": { database: () => harness.pool }, "@/lib/project-schema": schemas,
    "@/lib/same-origin": { isSameOrigin: () => true }, "@/lib/video-uploads": harness.videoUploads
  });
  const put = (snapshot, version = 0) => route.PUT(new NextRequest("https://studio.test/api/projects", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: taskId, version, snapshot })
  }));
  for (const field of ["uploadedMedia", "postizMediaId", "postizPath"]) {
    for (const value of ["forged-upstream-reference", { id: "forged", path: "https://media.test/forged.mp4" }, null]) {
      const snapshot = projectSnapshot([{ ...asset, [field]: value }]);
      assert.equal(schemas.projectSchema.safeParse(snapshot).success, true, "historical reads remain permissive");
      harness.statements.length = 0;
      assert.equal((await put(snapshot)).status, 400, `${field} must not be silently stripped on save`);
      assert.equal(harness.statements.length, 0, "invalid upstream fields must fail before any storage query or write");
      assert.equal(harness.sql.prepare("SELECT id FROM projects WHERE id=?").get(taskId), undefined);
    }
  }
  for (const invalid of [{ ...asset, videoMediaId: otherVideoId }, { ...asset, videoMediaId: "invalid" }, { ...asset, imageUrl: image.dataUrl }]) {
    assert.equal((await put(projectSnapshot([invalid]))).status, 400);
  }
  assert.equal(harness.sql.prepare("SELECT id FROM projects WHERE id=?").get(taskId), undefined);
  harness.statements.length = 0;
  assert.equal((await put(projectSnapshot([asset, { ...asset, id: "asset-two" }]))).status, 200);
  const checks = harness.statements.filter(entry => entry.statement.includes("FROM video_uploads"));
  assert.equal(checks.length, 1, "all video IDs are checked in a single bulk query");
  assert.equal(checks[0].transactionOpen, true);
  assert.deepEqual(checks[0].parameters, ["owner", videoId], "duplicate asset references share the same receipt");
  const restored = await route.GET(new NextRequest(`https://studio.test/api/projects?id=${taskId}`));
  assert.equal((await restored.json()).snapshot.assets[0].videoMediaId, videoId);
  harness.statements.length = 0;
  assert.equal((await put(projectSnapshot([{ ...asset, videoMediaId: undefined, imageUrl: image.dataUrl }]), 1)).status, 200);
  assert.equal(harness.statements.filter(entry => entry.statement.includes("video_uploads")).length, 0);
});

test("video manual POST and PATCH accept nullable UUID references and reject mixed or forged media fields", async context => {
  const harness = videoHarness(context);
  seedVideo(harness, otherVideoId, "other");
  const dependencies = {
    "next/server": { NextResponse },
    "@/lib/auth": { currentUser: async () => ({ user: { id: "owner", role: "admin" } }) },
    "@/lib/project-db": { databaseConfigured: () => true }, "@/lib/same-origin": { isSameOrigin: () => true },
    "@/lib/posts": harness.storage, "@/lib/post-types": loadModule("../src/lib/post-types.ts"),
    "@/lib/post-media": { validatePostImage: async () => ({ ok: true, image }) },
    "@/lib/social-accounts": {}, "@/lib/request-body": loadModule("../src/lib/request-body.ts")
  };
  const createRoute = loadModule("../src/app/api/posts/route.ts", dependencies);
  const updateRoute = loadModule("../src/app/api/posts/[postId]/route.ts", dependencies);
  const request = (method, body) => new NextRequest("https://studio.test/api/posts", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const payload of [{ videoMediaId: "invalid" }, { videoMediaId: videoId, imageDataUrl: image.dataUrl }, { videoMediaId: videoId, uploadedMedia: { id: "forged", path: "https://forged.test" } }]) {
    assert.equal((await createRoute.POST(request("POST", payload))).status, 400);
    assert.equal((await updateRoute.PATCH(request("PATCH", { version: 4, ...payload }), { params: Promise.resolve({ postId }) })).status, 400);
  }
  assert.equal((await createRoute.POST(request("POST", { videoMediaId: otherVideoId }))).status, 400);
  const createdResponse = await createRoute.POST(request("POST", { videoMediaId: videoId, imageDataUrl: null }));
  assert.equal(createdResponse.status, 201, "a video-only local draft is not empty");
  const created = (await createdResponse.json()).post;
  const contextParameters = { params: Promise.resolve({ postId: created.id }) };
  const kept = await updateRoute.PATCH(request("PATCH", { version: 1, content: "Caption" }), contextParameters);
  assert.equal((await kept.json()).post.videoMediaId, videoId);
  const removed = await updateRoute.PATCH(request("PATCH", { version: 2, videoMediaId: null }), contextParameters);
  assert.equal((await removed.json()).post.videoMediaId, null);
});
