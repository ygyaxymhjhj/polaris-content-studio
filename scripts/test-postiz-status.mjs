// Isolated Postiz contract regression: synthetic configuration, mocked fetch, no live requests.
// node scripts/test-postiz-status.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, beforeEach, test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
function loadModule(relativePath, dependencies = {}) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const { outputText } = typescript.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", outputText)(
    dependency => dependencies[dependency] ?? nativeRequire(dependency),
    compiledModule,
    compiledModule.exports
  );
  return compiledModule.exports;
}

// Keep only the environment object reference; never inspect inherited credentials.
const originalEnvironment = process.env;
const originalFetch = globalThis.fetch;
process.env = {
  POSTIZ_API_URL: "https://postiz.example.test",
  POSTIZ_API_KEY: "synthetic-postiz-test-key"
};
const capturedRequests = [];
let createResponse = () => Response.json({ posts: [] });
globalThis.fetch = async (requestUrl, requestOptions) => {
  capturedRequests.push({ url: new URL(requestUrl), options: requestOptions });
  return createResponse();
};
const platformTypes = loadModule("../src/lib/types.ts");
const postiz = loadModule("../src/lib/postiz.ts", { "./types": platformTypes });
const customRange = {
  startDate: new Date("2026-01-01T00:00:00.000Z"),
  endDate: new Date("2026-10-14T12:05:00.000Z")
};
const oversizedResponseBytes = 10 * 1024 * 1024 + 1;

beforeEach(() => {
  capturedRequests.length = 0;
  process.env.POSTIZ_API_URL = "https://postiz.example.test";
  process.env.POSTIZ_API_KEY = "synthetic-postiz-test-key";
  createResponse = () => Response.json({ posts: [] });
});
after(() => {
  process.env = originalEnvironment;
  globalThis.fetch = originalFetch;
});

function assertSanitizedConnectionError(error) {
  assert.ok(error instanceof postiz.PostizConnectionError);
  assert.ok(!error.message.includes("synthetic-postiz-test-key"));
  assert.ok(!error.message.includes("private-provider-detail"));
  return true;
}

test("draft hand-off succeeds without inventing an ID when upstream omits it", async () => {
  for (const upstreamBody of [{}, [], [{ integration: "channel-one" }], { postId: "" }, { postId: {} }]) {
    createResponse = () => Response.json(upstreamBody);
    const result = await postiz.publishToPostiz({ integrationId: "channel-one", content: "Review this draft", platform: "x" });
    assert.equal(result.success, true);
    assert.equal(result.postId, undefined);
    assert.match(result.warning, /tracking/i);
    assert.equal(result.error, undefined);
    const payload = JSON.parse(capturedRequests.at(-1).options.body);
    assert.equal(payload.type, "draft");
    assert.equal(payload.posts[0].settings.__type, "x");
  }
});

test("Facebook drafts include the normal post type required for later publication", async () => {
  createResponse = () => Response.json([{ postId: "facebook-draft-one" }]);
  const result = await postiz.publishToPostiz({
    integrationId: "facebook-page-one", content: "Facebook draft", platform: "facebook"
  });
  assert.equal(result.success, true);
  const payload = JSON.parse(capturedRequests.at(-1).options.body);
  assert.equal(payload.type, "draft", "Adding Facebook settings must not publish immediately");
  assert.deepEqual(payload.posts[0].settings, { __type: "facebook", post_type: "post" });
});

test("draft hand-off retains only IDs actually returned upstream", async () => {
  for (const upstreamBody of [
    [{ postId: "real-post-one", integration: "channel-one" }],
    { id: "real-post-one" },
    { postId: " ", id: "real-post-one" },
    { postId: {}, id: "real-post-one" },
    { postId: 123, id: "real-post-one" }
  ]) {
    createResponse = () => Response.json(upstreamBody);
    assert.deepEqual(await postiz.publishToPostiz({ integrationId: "channel-one", content: "Draft" }), {
      success: true, postId: "real-post-one"
    });
  }
  createResponse = () => new Response("not-json", { status: 200 });
  const result = await postiz.publishToPostiz({ integrationId: "channel-one", content: "Draft" });
  assert.equal(result.success, true, "An accepted request without tracking metadata must not imply submission failure");
  assert.equal(result.postId, undefined);
  assert.match(result.warning, /tracking/i);
});

test("details expose all documented states and published metadata, not inferred publication", async () => {
  createResponse = () => Response.json({ posts: [
    { id: "published", state: "PUBLISHED", releaseURL: "https://social.example.test/posts/123", publishDate: "2026-10-14T10:00:00.000Z" },
    { id: "draft", state: "DRAFT", releaseURL: "https://social.example.test/posts/draft" },
    { id: "queued", state: "QUEUE" },
    { id: "failed", state: "ERROR" },
    { id: "not-requested", state: "PUBLISHED" }
  ] });
  const details = await postiz.fetchPostizPostDetails(["published", "draft", "queued", "failed", "missing"], customRange);
  assert.deepEqual(details.get("published"), {
    id: "published", state: "PUBLISHED", releaseUrl: "https://social.example.test/posts/123", publishDate: "2026-10-14T10:00:00.000Z"
  });
  assert.equal(details.get("draft").state, "DRAFT");
  assert.equal(details.get("queued").state, "QUEUE");
  assert.equal(details.get("failed").state, "ERROR");
  assert.equal(details.has("missing"), false);
  assert.equal(details.has("not-requested"), false);
});

test("unknown states and malformed post entries are ignored", async () => {
  const unknownStates = ["SCHEDULED", "published", "UNKNOWN", "", null, 1, { state: "PUBLISHED" }];
  createResponse = () => Response.json({ posts: [
    ...unknownStates.map((state, index) => ({ id: `unknown-${index}`, state, releaseURL: "https://social.example.test/123" })),
    null, "PUBLISHED", [], { id: 12, state: "PUBLISHED" }, { state: "PUBLISHED" }, { id: " ", state: "PUBLISHED" }
  ] });
  const requestedIds = unknownStates.map((_, index) => `unknown-${index}`);
  const details = await postiz.fetchPostizPostDetails([...requestedIds, "12", " "], customRange);
  assert.equal(details.size, 0);
});

test("release URLs accept HTTP(S) without credentials and discard invalid metadata", async () => {
  const invalidUrls = ["javascript:alert(1)", "ftp://social.example.test/123", "https://user:password@social.example.test/123", "https://user@social.example.test/123", "/posts/123", "invalid", "", 123];
  createResponse = () => Response.json({ posts: [
    ...invalidUrls.map((releaseURL, index) => ({ id: `invalid-${index}`, state: "PUBLISHED", releaseURL })),
    { id: "http", state: "PUBLISHED", releaseURL: "http://social.example.test/posts/123" }
  ] });
  const details = await postiz.fetchPostizPostDetails([...invalidUrls.map((_, index) => `invalid-${index}`), "http"], customRange);
  for (const index of invalidUrls.keys()) {
    assert.equal(details.get(`invalid-${index}`).releaseUrl, undefined);
  }
  assert.equal(details.get("http").releaseUrl, "http://social.example.test/posts/123");
});

test("publish dates must be valid ISO date-times, including valid calendar days", async () => {
  const invalidDates = ["2026-02-30T10:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-10-14", "October 14, 2026", "2026-10-14T10:00:00", "invalid", 123];
  const validDates = ["2026-10-14T10:00:00Z", "2026-10-14T10:00:00.123Z", "2024-02-29T10:00:00+08:00"];
  createResponse = () => Response.json({ posts: [...invalidDates, ...validDates].map((publishDate, index) => ({ id: `date-${index}`, state: "PUBLISHED", publishDate })) });
  const details = await postiz.fetchPostizPostDetails([...invalidDates, ...validDates].map((_, index) => `date-${index}`), customRange);
  for (const index of invalidDates.keys()) assert.equal(details.get(`date-${index}`).publishDate, undefined);
  for (const [index, publishDate] of validDates.entries()) assert.equal(details.get(`date-${invalidDates.length + index}`).publishDate, publishDate);
});

test("caller range is preserved beyond 30 days; only documented unpaginated query fields are sent", async () => {
  // Evidence: docs.postiz.com/public-api/posts/list documents startDate/endDate/customer only.
  // Upstream GetPostsDto + PostsRepository.getPosts uses findMany without take/skip/cursors.
  createResponse = () => Response.json({ posts: [{ id: "old-draft", state: "DRAFT", publishDate: "2026-01-01T00:00:00.000Z" }] });
  const details = await postiz.fetchPostizPostDetails(["old-draft", "missing"], customRange);
  assert.equal(details.get("old-draft").state, "DRAFT");
  assert.equal(capturedRequests.length, 1);
  const { url, options } = capturedRequests[0];
  assert.equal(url.pathname, "/api/public/v1/posts");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["endDate", "startDate"]);
  assert.equal(url.searchParams.get("startDate"), customRange.startDate.toISOString());
  assert.equal(url.searchParams.get("endDate"), customRange.endDate.toISOString());
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.equal(options.headers.Authorization, "synthetic-postiz-test-key");
});

test("a valid empty posts array differs from invalid response envelopes", async () => {
  assert.equal((await postiz.fetchPostizPostDetails(["missing"], customRange)).size, 0);
  for (const invalidBody of [{}, [], { data: { posts: [] } }, { posts: null }, { posts: {} }, null]) {
    createResponse = () => Response.json(invalidBody);
    await assert.rejects(postiz.fetchPostizPostDetails(["missing"], customRange), assertSanitizedConnectionError);
  }
  createResponse = () => new Response("not-json");
  await assert.rejects(postiz.fetchPostizPostDetails(["missing"], customRange), assertSanitizedConnectionError);
});

test("HTTP, transport, parse and configuration failures throw sanitized connection errors", async () => {
  for (const status of [401, 403, 429, 500, 502]) {
    createResponse = () => new Response("synthetic-postiz-test-key private-provider-detail", { status });
    await assert.rejects(postiz.fetchPostizPostDetails(["post-one"], customRange), assertSanitizedConnectionError);
  }
  createResponse = () => { throw new Error("synthetic-postiz-test-key private-provider-detail"); };
  await assert.rejects(postiz.fetchPostizPostDetails(["post-one"], customRange), assertSanitizedConnectionError);
  createResponse = () => { throw new DOMException("private-provider-detail", "TimeoutError"); };
  await assert.rejects(postiz.fetchPostizPostDetails(["post-one"], customRange), assertSanitizedConnectionError);
  delete process.env.POSTIZ_API_KEY;
  await assert.rejects(postiz.fetchPostizPostDetails(["post-one"], customRange), error => {
    assertSanitizedConnectionError(error);
    assert.equal(error.status, 503);
    return true;
  });
});

test("invalid ranges fail before contacting upstream", async () => {
  for (const range of [
    { startDate: new Date("invalid"), endDate: customRange.endDate },
    { startDate: customRange.startDate, endDate: new Date("invalid") },
    { startDate: customRange.endDate, endDate: customRange.startDate }
  ]) {
    await assert.rejects(postiz.fetchPostizPostDetails(["post-one"], range), assertSanitizedConnectionError);
  }
  assert.equal(capturedRequests.length, 0);
});

test("oversized content-length rejects and cancels without reading the response", async () => {
  let canceled = false;
  createResponse = () => new Response(new ReadableStream({ cancel() { canceled = true; } }), {
    headers: { "Content-Length": String(oversizedResponseBytes) }
  });
  await assert.rejects(postiz.fetchPostizPostDetails(["post-one"], customRange), assertSanitizedConnectionError);
  assert.equal(canceled, true);
});

test("streaming body bound applies without trusting content-length", async () => {
  for (const contentLength of [undefined, "1"]) {
    let canceled = false;
    let chunkCount = 0;
    createResponse = () => new Response(new ReadableStream({
      pull(controller) {
        chunkCount += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() { canceled = true; }
    }), { headers: contentLength ? { "Content-Length": contentLength } : {} });
    await assert.rejects(postiz.fetchPostizPostDetails(["post-one"], customRange), assertSanitizedConnectionError);
    assert.equal(canceled, true);
    assert.ok(chunkCount <= 13, "An unbounded stream must be stopped just beyond the 10MB limit");
  }
});

test("stream read failures remain sanitized", async () => {
  createResponse = () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("synthetic-postiz-test-key private-provider-detail")); }
  }));
  await assert.rejects(postiz.fetchPostizPostDetails(["post-one"], customRange), assertSanitizedConnectionError);
});

test("legacy status client preserves Map null compatibility and its default 30-day range", async () => {
  createResponse = () => Response.json({ posts: [{ id: "queued", state: "QUEUE" }, { id: "published", state: "PUBLISHED" }, { id: "unknown", state: "SCHEDULED" }] });
  const beforeRequest = Date.now();
  const statuses = await postiz.fetchPostizPostStatus(["queued", "published", "missing", "unknown"]);
  const afterRequest = Date.now();
  assert.deepEqual([...statuses], [["queued", "QUEUE"], ["published", "PUBLISHED"], ["missing", null], ["unknown", null]]);
  const listUrl = capturedRequests[0].url;
  const endMilliseconds = Date.parse(listUrl.searchParams.get("endDate"));
  const startMilliseconds = Date.parse(listUrl.searchParams.get("startDate"));
  assert.ok(endMilliseconds >= beforeRequest && endMilliseconds <= afterRequest);
  assert.equal(endMilliseconds - startMilliseconds, 30 * 24 * 60 * 60 * 1000);
  createResponse = () => new Response("private-provider-detail", { status: 500 });
  assert.deepEqual([...await postiz.fetchPostizPostStatus(["queued", "missing"])], [["queued", null], ["missing", null]]);
  createResponse = () => { throw new Error("private-provider-detail"); };
  assert.deepEqual([...await postiz.fetchPostizPostStatus(["queued"])], [["queued", null]]);
  delete process.env.POSTIZ_API_KEY;
  assert.deepEqual([...await postiz.fetchPostizPostStatus(["queued"])], [["queued", null]]);
});

test("empty requested IDs never trigger an upstream query", async () => {
  assert.equal((await postiz.fetchPostizPostDetails([], customRange)).size, 0);
  assert.equal((await postiz.fetchPostizPostStatus([])).size, 0);
  assert.equal(capturedRequests.length, 0);
});

test("integration platform comes from real identifier, not integration ID", async () => {
  createResponse = () => Response.json([{ id: "channel-one", identifier: "linkedin", name: "Editorial Team" }]);
  const integrations = await postiz.fetchPostizIntegrations();
  assert.equal(integrations.accounts[0].id, "channel-one");
  assert.equal(integrations.accounts[0].identifier, "linkedin");
});
