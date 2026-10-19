// Isolated manual-post regression: synthetic storage and Postiz, real media validation with sharp.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, beforeEach, test } from "node:test";
import typescript from "typescript";
import sharp from "sharp";

const nativeRequire = createRequire(import.meta.url);
const { NextResponse } = nativeRequire("next/server");

function loadModule(relativePath, dependencies = {}) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const { outputText } = typescript.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", outputText)(
    dependency => dependencies[dependency] ?? nativeRequire(dependency),
    compiledModule,
    compiledModule.exports
  );
  return compiledModule.exports;
}

/* ------------------------------------------------------------------ *
 * 1. Strict draft creation: image failures and transport failures.
 * ------------------------------------------------------------------ */

const originalFetch = globalThis.fetch;
const originalEnvironment = process.env;
process.env = { POSTIZ_API_URL: "https://postiz.example.test", POSTIZ_API_KEY: "synthetic-key" };
const calls = { requests: [] };
let respond = async () => Response.json([{ postId: "draft-one" }]);
globalThis.fetch = async (requestUrl, options) => {
  calls.requests.push({ url: String(requestUrl), options });
  return respond(requestUrl, options);
};
const platformTypes = loadModule("../src/lib/types.ts");
const postiz = loadModule("../src/lib/postiz.ts", { "./types": platformTypes });

const uploadOk = () => Response.json({ id: "media-one", path: "https://uploads.postiz.example.test/one.png" });

after(() => {
  process.env = originalEnvironment;
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  calls.requests.length = 0;
  respond = async () => Response.json([{ postId: "draft-one" }]);
});

test("an image that cannot be uploaded blocks the draft instead of sending text only", async () => {
  respond = async (url) => url.includes("/upload") ? new Response("nope", { status: 500 }) : Response.json([{ postId: "should-not-exist" }]);
  const result = await postiz.createStrictDraft({ integrationId: "channel-one", content: "With image", imageUrl: "data:image/png;base64,AAAA", platform: "instagram" });
  assert.equal(result.success, false);
  assert.equal(result.uncertain, undefined, "a refused upload is a definite failure, not an unknown result");
  assert.match(result.error, /image/i);
  assert.equal(calls.requests.filter(request => request.url.includes("/posts")).length, 0, "no create call may follow a failed upload");
});

test("a transport failure is reported as uncertain so the caller does not retry blindly", async () => {
  respond = async () => { throw new Error("socket hang up"); };
  const result = await postiz.createStrictDraft({ integrationId: "channel-one", content: "Text only", platform: "x" });
  assert.equal(result.success, false);
  assert.equal(result.uncertain, true);
});

test("every supported account receives the documented draft-only payload and authentication", async () => {
  for (const platform of ["x", "facebook", "instagram", "linkedin", "threads"]) {
    calls.requests.length = 0;
    respond = async (url) => url.endsWith("/upload") ? uploadOk() : Response.json([{ postId: `draft-${platform}` }]);
    const result = await postiz.createStrictDraft({
      integrationId: `account-${platform}`,
      platform,
      content: "Exact draft text\nwith a second line",
      imageUrl: "data:image/png;base64,AAAA"
    });
    assert.equal(result.success, true);
    assert.equal(calls.requests.length, 2, "upload must precede exactly one create request");
    const [uploadRequest, draftRequest] = calls.requests;
    assert.equal(uploadRequest.url, "https://postiz.example.test/api/public/v1/upload");
    assert.ok(uploadRequest.options.body instanceof FormData);
    assert.equal(uploadRequest.options.body.get("file").type, "image/png");
    assert.equal(draftRequest.url, "https://postiz.example.test/api/public/v1/posts");
    assert.equal(draftRequest.options.headers.Authorization, "synthetic-key");
    const payload = JSON.parse(draftRequest.options.body);
    assert.equal(payload.type, "draft");
    assert.ok(Number.isFinite(Date.parse(payload.date)), "Postiz requires a date even for a non-scheduled draft");
    assert.equal(payload.shortLink, false);
    assert.deepEqual(payload.tags, []);
    assert.equal(payload.posts.length, 1);
    assert.deepEqual(payload.posts[0].integration, { id: `account-${platform}` });
    assert.deepEqual(payload.posts[0].value, [{ content: "Exact draft text\nwith a second line", image: [{ id: "media-one", path: "https://uploads.postiz.example.test/one.png" }] }]);
    assert.equal(payload.posts[0].settings.__type, platform);
    assert.equal(payload.saveAction, undefined);
  }
});

test("an explicit Postiz refusal is a failure, and an accepted draft without an ID still succeeds", async () => {
  respond = async () => new Response("invalid integration", { status: 400 });
  const refused = await postiz.createStrictDraft({ integrationId: "channel-one", content: "Text", platform: "x" });
  assert.equal(refused.success, false);
  assert.equal(refused.uncertain, undefined);
  assert.match(refused.error, /400/);

  respond = async (url) => url.includes("/upload")
    ? uploadOk()
    : Response.json({ posts: [{ integration: "channel-one" }] });
  const accepted = await postiz.createStrictDraft({ integrationId: "channel-one", content: "Text", imageUrl: "data:image/png;base64,AAAA", platform: "x" });
  assert.equal(accepted.success, true);
  assert.equal(accepted.postId, undefined);
  assert.match(accepted.warning, /no post ID/i);
  const payload = JSON.parse(calls.requests.filter(request => request.url.includes("/posts")).at(-1).options.body);
  assert.equal(payload.type, "draft", "only drafts may ever be created");
  assert.equal(payload.posts[0].value[0].image[0].id, "media-one");
});

/* ------------------------------------------------------------------ *
 * 2. Media validation with the real decoder.
 * ------------------------------------------------------------------ */

const postTypes = loadModule("../src/lib/post-types.ts", { "./types": platformTypes });
const media = loadModule("../src/lib/post-media.ts", { "./post-types": postTypes });

const pngDataUrl = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;

test("a valid small image is accepted and gets a thumbnail", async () => {
  const buffer = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#3366cc" } }).png().toBuffer();
  const validated = await media.validatePostImage(pngDataUrl(buffer), "photo.png");
  assert.equal(validated.ok, true);
  assert.equal(validated.image.width, 120);
  assert.equal(validated.image.height, 80);
  assert.match(validated.image.thumbnailDataUrl, /^data:image\/jpeg;base64,/);
  assert.match(validated.image.dataUrl, /^data:image\/png;base64,/);
});

test("remote URLs, animated formats and oversized images are rejected", async () => {
  const remote = await media.validatePostImage("https://example.test/photo.png");
  assert.equal(remote.ok, false);

  const gif = await media.validatePostImage("data:image/gif;base64,R0lGODlhAQABAAAAACw=");
  assert.equal(gif.ok, false);

  const oversizedEncoding = await media.validatePostImage(`data:image/png;base64,${"A".repeat(media.MAX_POST_IMAGE_DATA_URL_LENGTH + 4)}`);
  assert.equal(oversizedEncoding.ok, false, "the encoded length is rejected before decoding");

  const wide = await sharp({ create: { width: 2600, height: 40, channels: 3, background: "#000000" } }).png().toBuffer();
  const wideResult = await media.validatePostImage(pngDataUrl(wide));
  assert.equal(wideResult.ok, false, "images wider than the accepted edge must be rejected");

  const bomb = await sharp({ create: { width: 2200, height: 2200, channels: 3, background: "#000000" } }).png().toBuffer();
  const bombResult = await media.validatePostImage(pngDataUrl(bomb));
  assert.equal(bombResult.ok, false, "the pixel guard must reject images over the limit");
});

/* ------------------------------------------------------------------ *
 * 3. Submission orchestration against a fake database.
 * ------------------------------------------------------------------ */

const postId = "11111111-1111-4111-8111-111111111111";
const integrationId = "channel-one";
const memberUser = { id: "member-one", displayName: "Manual Author", role: "member" };

const db = {
  post: { content: "Hand written draft", image_data: null, version: 4, title: "Internal title", updated_at: "2026-10-15 10:00:00.000" },
  target: { status: "not_started", attempt_started_at: null, postiz_post_id: null, warning: null, error: null, audit_id: null },
  attemptId: null,
  statements: []
};
const postizCalls = { drafts: [], integrations: 0 };
const auditCalls = [];
let strictDraftResult = { success: true, postId: "postiz-draft-one" };
let accountRecord = { integrationId, provider: "x", accountName: "Owned Account", ownerUserId: memberUser.id, ownerName: "Manual Author", origin: "connect" };
let liveAccounts = [{ id: integrationId, name: "Owned Account", identifier: "x" }];
let targetMissing = false;

/** Statements the real code issues, answered from the in-memory row. Shared by the pool and a connection. */
async function executeStatement(rawStatement, parameters = []) {
  const statement = String(rawStatement).replace(/\s+/g, " ").trim();
  db.statements.push(statement);
  if (statement.startsWith("SELECT content, image_data, version FROM posts")) {
    return [[{ content: db.post.content, image_data: db.post.image_data, version: db.post.version }]];
  }
  if (statement.startsWith("SELECT CASE") && statement.includes("t.attempt_started_at")) {
    return [targetMissing ? [] : [{ ...db.target }]];
  }
  if (statement.startsWith("UPDATE post_targets SET status='submitting'")) {
    db.attemptId = parameters[0];
    db.target = { ...db.target, status: "submitting", attempt_started_at: parameters[1], audit_id: null, postiz_post_id: null, submitted_at: null };
    return [{ affectedRows: 1 }];
  }
  if (statement.startsWith("UPDATE post_targets SET status='pending_unknown'")) {
    db.target = { ...db.target, status: "pending_unknown" };
    return [{ affectedRows: 1 }];
  }
  if (statement.startsWith("UPDATE post_targets SET status=?, postiz_post_id=?")) {
    const [status, upstreamId, auditId, warning, error, submittedAt, , , , attemptId] = parameters;
    if (db.target.status !== "submitting" || db.attemptId !== attemptId) return [{ affectedRows: 0 }];
    db.target = { ...db.target, status, postiz_post_id: upstreamId, audit_id: auditId, warning, error, submitted_at: submittedAt };
    return [{ affectedRows: 1 }];
  }
  if (statement.startsWith("UPDATE post_targets SET status='accepted', postiz_post_id=?")) {
    const [upstreamId, auditId, warning, error, submittedAt, , , , attemptId] = parameters;
    if (db.target.status !== "pending_unknown" || db.attemptId !== attemptId) return [{ affectedRows: 0 }];
    db.target = { ...db.target, status: "accepted", postiz_post_id: upstreamId, audit_id: auditId, warning, error, submitted_at: submittedAt };
    return [{ affectedRows: 1 }];
  }
  throw new Error(`Unexpected statement in the fake database: ${statement}`);
}

function fakeConnection() {
  return {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
    execute: executeStatement
  };
}

function fakeDatabase() {
  return { getConnection: async () => fakeConnection(), execute: executeStatement };
}

function detail() {
  return {
    id: postId,
    title: db.post.title,
    content: db.post.content,
    imageUrl: null,
    imageName: null,
    imageWidth: null,
    imageHeight: null,
    version: db.post.version,
    editable: db.target.status !== "accepted" && db.target.status !== "submitting" && db.target.status !== "pending_unknown",
    frozenReason: db.target.status === "accepted" ? "accepted" : db.target.status === "pending_unknown" ? "pending_unknown" : null,
    createdAt: "2026-10-15 09:00:00.000",
    updatedAt: db.post.updated_at,
    targets: [{
      integrationId,
      platform: "x",
      accountName: "Owned Account",
      status: db.target.status,
      snapshotVersion: db.target.status === "not_started" ? 0 : db.post.version,
      postizPostId: db.target.postiz_post_id,
      auditId: db.target.audit_id,
      warning: db.target.warning,
      error: db.target.error,
      submittedAt: null
    }]
  };
}

const storageSql = loadModule("../src/lib/posts.ts", { "@/lib/project-db": {}, "./post-types": postTypes });
const submission = loadModule("../src/lib/post-submission.ts", {
  "@/lib/project-db": { database: fakeDatabase, databaseConfigured: () => true },
  "@/lib/social-accounts": { getSocialAccount: async () => accountRecord },
  "@/lib/social-notifications": {
    recordSocialSubmission: async (entry) => { auditCalls.push(entry); return { auditId: "audit-one" }; }
  },
  "@/lib/postiz": {
    createStrictDraft: async (request) => { postizCalls.drafts.push(request); return strictDraftResult; },
    fetchPostizIntegrations: async () => { postizCalls.integrations += 1; return { configured: true, accounts: liveAccounts }; }
  },
  "@/lib/posts": {
    POST_TARGET_REVIEW_JOINS: storageSql.POST_TARGET_REVIEW_JOINS,
    POST_TARGET_STATUS_SQL: storageSql.POST_TARGET_STATUS_SQL,
    SUBMISSION_STALE_MS: 120_000,
    databaseEpoch: (value) => {
      if (typeof value !== "string" || !value) return 0;
      const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
      return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
    },
    getManualPost: async () => detail(),
    sweepStaleSubmissions: async () => 0
  }
});

function submit(overrides = {}) {
  return submission.submitPostTarget({
    userId: memberUser.id,
    userName: memberUser.displayName,
    isAdmin: false,
    postId,
    integrationId,
    expectedVersion: db.post.version,
    ...overrides
  });
}

beforeEach(() => {
  db.target = { status: "not_started", attempt_started_at: null, postiz_post_id: null, warning: null, error: null, audit_id: null };
  db.attemptId = null;
  db.statements.length = 0;
  postizCalls.drafts.length = 0;
  postizCalls.integrations = 0;
  auditCalls.length = 0;
  strictDraftResult = { success: true, postId: "postiz-draft-one" };
  accountRecord = { integrationId, provider: "x", accountName: "Owned Account", ownerUserId: memberUser.id, ownerName: "Manual Author", origin: "connect" };
  liveAccounts = [{ id: integrationId, name: "Owned Account", identifier: "x" }];
  targetMissing = false;
});

test("an accepted hand-off is recorded once and never repeated", async () => {
  const first = await submit();
  assert.equal(first.kind, "ok");
  assert.equal(postizCalls.drafts.length, 1);
  assert.equal(postizCalls.drafts[0].content, db.post.content, "the saved row is the source of truth");
  assert.equal(postizCalls.drafts[0].platform, "x");
  assert.equal(db.target.status, "accepted");
  assert.equal(db.target.postiz_post_id, "postiz-draft-one");
  assert.equal(db.target.audit_id, "audit-one");
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].assetId, postId);
  assert.equal(auditCalls[0].projectId, undefined, "manual posts never borrow an AI project id");
  assert.equal(auditCalls[0].status, "drafted");

  const second = await submit();
  assert.equal(second.kind, "ok");
  assert.equal(postizCalls.drafts.length, 1, "an accepted target must not create a second draft");
});

test("a second click while the first attempt is in flight is refused without a create call", async () => {
  db.target = { ...db.target, status: "submitting", attempt_started_at: new Date().toISOString().slice(0, 23).replace("T", " ") };
  const result = await submit();
  assert.equal(result.kind, "in_flight");
  assert.equal(postizCalls.drafts.length, 0);
});

test("an unconfirmed result blocks resubmission", async () => {
  db.target = { ...db.target, status: "pending_unknown" };
  const result = await submit();
  assert.equal(result.kind, "unconfirmed");
  assert.equal(postizCalls.drafts.length, 0);
});

test("a transport failure leaves the target needing review and records no audit", async () => {
  strictDraftResult = { success: false, error: "socket hang up", uncertain: true };
  const result = await submit();
  assert.equal(result.kind, "ok");
  assert.equal(db.target.status, "pending_unknown");
  assert.match(db.target.warning, /check Postiz/i);
  assert.equal(auditCalls.length, 0, "an unknown result must not be recorded as a definite failure");
});

test("a refused draft is a failure that can be retried", async () => {
  strictDraftResult = { success: false, error: "Postiz API error (400): bad request" };
  const first = await submit();
  assert.equal(first.kind, "ok");
  assert.equal(db.target.status, "failed");
  assert.match(db.target.error, /400/);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].status, "failed");

  strictDraftResult = { success: true, postId: "postiz-draft-two" };
  const retry = await submit();
  assert.equal(retry.kind, "ok");
  assert.equal(db.target.status, "accepted");
  assert.equal(postizCalls.drafts.length, 2);
});

test("only the owner's account may be used, and a stale version is refused", async () => {
  accountRecord = { integrationId, provider: "x", accountName: "Other Account", ownerUserId: "another-member", ownerName: "Someone Else", origin: "admin" };
  const forbidden = await submit();
  assert.equal(forbidden.kind, "forbidden");
  assert.equal(postizCalls.drafts.length, 0);

  accountRecord = { integrationId, provider: "x", accountName: "Owned Account", ownerUserId: memberUser.id, ownerName: "Manual Author", origin: "connect" };
  const conflict = await submit({ expectedVersion: db.post.version + 1 });
  assert.equal(conflict.kind, "conflict");
  assert.equal(postizCalls.drafts.length, 0);

  liveAccounts = [];
  const missing = await submit();
  assert.equal(missing.kind, "forbidden");
  assert.equal(postizCalls.drafts.length, 0);
});

test("empty content and a missing target are refused before any upstream call", async () => {
  const originalContent = db.post.content;
  db.post.content = "   ";
  const empty = await submit();
  assert.equal(empty.kind, "validation");
  assert.equal(postizCalls.drafts.length, 0);
  db.post.content = originalContent;

  targetMissing = true;
  const missingTarget = await submit();
  assert.equal(missingTarget.kind, "target_missing");
  assert.equal(postizCalls.drafts.length, 0);
});

/* ------------------------------------------------------------------ *
 * 4. Route-level validation for creating a post.
 * ------------------------------------------------------------------ */

const createdPosts = [];
const route = loadModule("../src/app/api/posts/route.ts", {
  "next/server": { NextResponse },
  "@/lib/auth": {
    currentUser: async () => ({ user: { ...memberUser }, ownerHash: "synthetic-owner" }),
    unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 })
  },
  "@/lib/project-db": { databaseConfigured: () => true, database: fakeDatabase },
  "@/lib/same-origin": { isSameOrigin: () => true },
  "@/lib/posts": {
    sweepStaleSubmissions: async () => 0,
    listManualPosts: async () => ({ items: [], total: 0, counts: { all: 0, draft: 0, pushing: 0, pushed: 0, attention: 0 } }),
    createManualPost: async (ownerUserId, input) => { createdPosts.push({ ownerUserId, input }); return detail(); }
  },
  "@/lib/post-media": { validatePostImage: media.validatePostImage },
  "@/lib/request-body": loadModule("../src/lib/request-body.ts"),
  "@/lib/post-types": postTypes,
  "@/lib/social-accounts": {
    listAccountOwners: async () => new Map([[integrationId, { integrationId, provider: "x", accountName: "Owned Account", ownerUserId: memberUser.id, ownerName: "Manual Author", origin: "connect" }]])
  }
});

function createRequest(body) {
  return new Request("https://studio.example.test/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://studio.example.test" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  createdPosts.length = 0;
});

test("an empty composer never creates a record", async () => {
  const response = await route.POST(createRequest({ title: "", content: "   " }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "EMPTY_POST");
  assert.equal(createdPosts.length, 0);
});

test("an image the server cannot validate is rejected before anything is stored", async () => {
  const response = await route.POST(createRequest({ title: "Hello", imageDataUrl: "https://example.test/photo.png" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_IMAGE");
  assert.equal(createdPosts.length, 0);
});

test("boards outside the caller's accounts are refused, and a valid post stores the registry snapshot", async () => {
  const foreign = await route.POST(createRequest({ title: "Hello", integrationIds: ["someone-elses-channel"] }));
  assert.equal(foreign.status, 400);
  assert.equal((await foreign.json()).code, "INVALID_TARGET");
  assert.equal(createdPosts.length, 0);

  const accepted = await route.POST(createRequest({ title: "Hello", content: "Hand written", integrationIds: [integrationId] }));
  assert.equal(accepted.status, 201);
  assert.equal(createdPosts.length, 1);
  assert.equal(createdPosts[0].ownerUserId, memberUser.id);
  assert.deepEqual(createdPosts[0].input.targets, [{ integrationId, platform: "x", accountName: "Owned Account" }]);
  assert.equal(createdPosts[0].input.image, null);
});
