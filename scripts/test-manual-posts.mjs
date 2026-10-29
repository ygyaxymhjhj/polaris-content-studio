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
    dependency => dependencies[dependency] ?? (["./image-types", "@/lib/image-types"].includes(dependency) ? loadModule("../src/lib/image-types.ts") : nativeRequire(dependency)),
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
const postiz = loadModule("../src/lib/postiz.ts", { "./types": platformTypes, "./post-types": loadModule("../src/lib/post-types.ts") });
const tinyPng = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#3366cc" } }).png().toBuffer();
const tinyPngDataUrl = `data:image/png;base64,${tinyPng.toString("base64")}`;

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
  const result = await postiz.createStrictDraft({ integrationId: "channel-one", content: "With image", imageUrl: tinyPngDataUrl, platform: "instagram" });
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
      imageUrl: tinyPngDataUrl
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
  const accepted = await postiz.createStrictDraft({ integrationId: "channel-one", content: "Text", imageUrl: tinyPngDataUrl, platform: "x" });
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
 * 3. Route-level validation for creating a post.
 * ------------------------------------------------------------------ */

const postId = "11111111-1111-4111-8111-111111111111";
const integrationId = "channel-one";
const memberUser = { id: "member-one", displayName: "Manual Author", role: "member" };

const createdPosts = [];
const route = loadModule("../src/app/api/posts/route.ts", {
  "next/server": { NextResponse },
  "@/lib/auth": {
    currentUser: async () => ({ user: { ...memberUser }, ownerHash: "synthetic-owner" }),
    unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 })
  },
  "@/lib/project-db": { databaseConfigured: () => true },
  "@/lib/same-origin": { isSameOrigin: () => true },
  "@/lib/posts": {
    sweepStaleSubmissions: async () => 0,
    listManualPosts: async () => ({ items: [], total: 0, counts: { all: 0, draft: 0, pushing: 0, pushed: 0, attention: 0 } }),
    createManualPost: async (ownerUserId, input) => { createdPosts.push({ ownerUserId, input }); return { id: postId }; }
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


test("registered image arrays preserve order without downloading or uploading again", async () => {
  const uploadedImages = [
    { id: "second", path: "https://uploads.postiz.com/second.png" },
    { id: "first", path: "https://uploads.postiz.com/first.png" }
  ];
  const result = await postiz.createStrictDraft({ integrationId: "channel-one", content: "Album", platform: "instagram", uploadedImages });
  assert.equal(result.success, true);
  assert.equal(calls.requests.length, 1);
  assert.ok(calls.requests[0].url.endsWith("/posts"));
  assert.deepEqual(JSON.parse(calls.requests[0].options.body).posts[0].value[0].image, uploadedImages);
  calls.requests.length = 0;
  assert.equal((await postiz.publishToPostiz({ integrationId: "channel-one", content: "Album", platform: "facebook", uploadedImages })).success, true);
  assert.equal(calls.requests.length, 1);
});

test("strict image arrays refuse limits, mixed sources and untrusted media before creating a draft", async () => {
  const uploadedImages = Array.from({ length: 11 }, (_, index) => ({ id: `image-${index}`, path: `https://uploads.postiz.com/${index}.png` }));
  for (const input of [
    { platform: "x", uploadedImages: uploadedImages.slice(0, 5) },
    { platform: "facebook", uploadedImages },
    { platform: "youtube", uploadedImages: uploadedImages.slice(0, 1) },
    { uploadedImages: [], imageUrl: tinyPngDataUrl },
    { uploadedImages: [], imageUrl: "" },
    { uploadedImages: uploadedImages.slice(0, 1), uploadedMedia: { id: "video", path: "https://uploads.postiz.com/video.mp4" } },
    { uploadedImages: [{ id: "unsafe", path: "https://foreign.test/image.png" }] },
    { uploadedImages: [{ id: "", path: "https://uploads.postiz.com/image.png" }] }
  ]) {
    const result = await postiz.createStrictDraft({ integrationId: "channel-one", content: "Album", ...input });
    assert.equal(result.success, false);
    assert.equal(result.uncertain, undefined);
    assert.equal(calls.requests.length, 0);
  }
  assert.equal((await postiz.createStrictDraft({ integrationId: "channel-one", content: "Album", platform: "facebook", uploadedImages: uploadedImages.slice(0, 10) })).success, true);
  assert.equal(JSON.parse(calls.requests[0].options.body).posts[0].value[0].image.length, 10);
});

test("manual create accepts image-only references and rejects invalid arrays or mixed media", async () => {
  const imageId = "22222222-2222-4222-8222-222222222222";
  assert.equal((await route.POST(createRequest({ imageMediaIds: [imageId] }))).status, 201);
  assert.deepEqual(createdPosts[0].input.imageMediaIds, [imageId]);
  createdPosts.length = 0;
  for (const imageMediaIds of [null, "invalid", ["bad"], [imageId, imageId], Array.from({ length: 11 }, (_, index) => `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`)]) {
    assert.equal((await route.POST(createRequest({ title: "Title", imageMediaIds }))).status, 400);
  }
  for (const body of [{ imageMediaIds: [imageId], imageDataUrl: tinyPngDataUrl }, { imageMediaIds: [imageId], videoMediaId: postId }]) {
    assert.equal((await route.POST(createRequest(body))).status, 400);
  }
  assert.equal(createdPosts.length, 0);
  assert.equal((await route.POST(createRequest({ imageMediaIds: [], imageDataUrl: tinyPngDataUrl }))).status, 400, "an explicitly empty image selection cannot make an empty draft nonempty");
  assert.equal((await route.POST(createRequest({ title: "Title", imageMediaIds: [], imageDataUrl: tinyPngDataUrl }))).status, 201);
  assert.equal(createdPosts[0].input.image, null);
  assert.deepEqual(createdPosts[0].input.imageMediaIds, []);
});
