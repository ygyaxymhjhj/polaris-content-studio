// Synthetic images, in-memory registry and fake Postiz; no live services or credentials.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import sharp from "sharp";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");
function load(path, mocks = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", outputText)(id => mocks[id] ?? require(id), compiled, compiled.exports);
  return compiled.exports;
}
const types = load("../src/lib/image-types.ts");
const media = load("../src/lib/post-media.ts", { "./post-types": load("../src/lib/post-types.ts") });
const bytes = await sharp({ create: { width: 12, height: 10, channels: 3, background: "#336699" } }).png().toBuffer();
const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
const requestId = "11111111-1111-4111-8111-111111111111";
function harness() {
  const rows = new Map();
  const state = { owner: "owner", uploads: 0, sources: 0, unavailable: false, unsafe: false, expiredSource: false, beforeValidation: null, beforeUpload: null };
  const db = { async execute(sql, params) {
    if (state.unavailable) throw new Error("synthetic storage secret");
    if (sql.includes("INSERT INTO")) {
      const [id, ownerUserId, requestId, checksum, postizMediaId, postizPath, name, bytes, width, height, thumbnailDataUrl] = params;
      rows.set(id, { id, ownerUserId, requestId, checksum, postizMediaId, postizPath, name, bytes, width, height, thumbnailDataUrl });
      return [{ affectedRows: 1 }];
    }
    return [[...rows.values()].filter(row => row.ownerUserId === params[0] && (sql.includes("request_id=?") ? row.requestId === params[1] : params.slice(1).includes(row.id))).reverse()];
  } };
  const registry = load("../src/lib/image-uploads.ts", { "@/lib/project-db": { database: () => db }, "./image-types": types });
  const mocks = {
    "@/lib/auth": { currentUser: async () => state.owner ? { user: { id: state.owner, role: "admin" } } : null, unauthorized: () => NextResponse.json({}, { status: 401 }) },
    "@/lib/project-db": { databaseConfigured: () => true },
    "@/lib/same-origin": { isSameOrigin: request => request.headers.get("origin") === "https://studio.test" },
    "@/lib/request-body": load("../src/lib/request-body.ts"),
    "@/lib/post-media": { ...media, validatePostImage: async (...args) => { await state.beforeValidation?.(); return media.validatePostImage(...args); } }, "@/lib/image-types": types, "@/lib/image-uploads": registry,
    "@/lib/postiz": {
      uploadImageToPostiz: async (_url, signal) => { state.uploads++; await state.beforeUpload?.(signal); return { id: "upstream-image", path: state.unsafe ? "https://evil.test/a.png" : "https://media.test/a.png" }; },
      getTrustedPostizMediaUrl: path => { if (!path.startsWith("https://media.test/")) throw new Error("unsafe"); return path; }
    },
    "@/lib/article-collector": { requestPublicPage: async url => { state.sources++; if (state.expiredSource || url.includes("127.0.0.1")) throw new Error("blocked"); return { status: 200, body: bytes }; } }
  };
  const route = load("../src/app/api/media/images/route.ts", mocks);
  const preview = load("../src/app/api/media/images/[mediaId]/route.ts", mocks);
  const request = (body, origin = "https://studio.test", signal) => new NextRequest("https://studio.test/api/media/images", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body), signal
  });
  return { rows, state, registry, route, preview, request };
}
test("upload receipts replay safely, expose only public metadata and preserve requested order", async () => {
  const h = harness();
  const body = { requestId, dataUrl, name: "first.png" };
  const response = await h.route.POST(h.request(body));
  assert.equal(response.status, 201);
  const { image } = await response.json();
  assert.deepEqual(Object.keys(image).sort(), ["bytes", "height", "id", "name", "width"]);
  assert.equal(image.width, 12);
  assert.deepEqual(await (await h.route.POST(h.request(body))).json(), { image });
  assert.equal(h.state.uploads, 1);
  const second = await (await h.route.POST(h.request({ ...body, requestId: "22222222-2222-4222-8222-222222222222" }))).json();
  const ids = [image.id, second.image.id];
  assert.deepEqual((await h.registry.getImageUploads("owner", ids)).map(row => row.id), ids);
  assert.deepEqual((await h.registry.getImageUploads("owner", ids.slice().reverse())).map(row => row.id), ids.slice().reverse());
  for (const refs of [[ids[0], ids[0]], ["bad"], [requestId]]) await assert.rejects(h.registry.getImageUploads("owner", refs));
  await assert.rejects(h.registry.getImageUploads("other", ids));
  assert.deepEqual(await h.registry.getImageUploads("owner", []), []);
});
test("auth, origin, corrupt bytes, forged fields, body limits and changed request IDs fail closed", async () => {
  const h = harness();
  h.state.owner = null;
  assert.equal((await h.route.POST(h.request({ requestId, dataUrl }))).status, 401);
  h.state.owner = "owner";
  assert.equal((await h.route.POST(h.request({ requestId, dataUrl }, "https://evil.test"))).status, 403);
  for (const body of [{ requestId, dataUrl, postizPath: "https://evil.test" }, { requestId, dataUrl: "data:image/png;base64,AAAA" },
    { requestId, dataUrl: "https://media.test/a.png" }, { requestId, dataUrl, sourceUrl: "https://public.test/a.png" },
    { requestId: "bad", dataUrl }, { requestId, dataUrl: "a".repeat(2_100_000) }]) assert.ok((await h.route.POST(h.request(body))).status >= 400);
  assert.equal(h.state.uploads, 0);
  await h.route.POST(h.request({ requestId, dataUrl }));
  const other = await sharp({ create: { width: 10, height: 12, channels: 3, background: "#669933" } }).png().toBuffer();
  assert.equal((await h.route.POST(h.request({ requestId, dataUrl: `data:image/png;base64,${other.toString("base64")}` }))).status, 409);
  assert.equal(h.state.uploads, 1);
});
test("owner-only full and thumbnail previews ignore arbitrary URLs and never reupload", async () => {
  const h = harness();
  const { image } = await (await h.route.POST(h.request({ requestId, dataUrl }))).json();
  const context = { params: Promise.resolve({ mediaId: image.id }) };
  const full = await h.preview.GET(new NextRequest(`https://studio.test/api/media/images/${image.id}?path=https://evil.test`), context);
  assert.equal(full.status, 307);
  assert.equal(full.headers.get("location"), "https://media.test/a.png");
  const thumb = await h.preview.GET(new NextRequest(`https://studio.test/api/media/images/${image.id}?size=thumb`), context);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get("content-type"), "image/jpeg");
  assert.match(thumb.headers.get("cache-control"), /no-store/);
  h.state.owner = "other";
  assert.equal((await h.preview.GET(new NextRequest("https://studio.test/"), context)).status, 404);
  assert.equal(h.state.uploads, 1);
});
test("same-origin export validates trusted media, byte limits and owner before downloading", async () => {
  const h = harness();
  const { image } = await (await h.route.POST(h.request({ requestId, dataUrl }))).json();
  const context = { params: Promise.resolve({ mediaId: image.id }) };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, "https://media.test/a.png");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers, undefined, "No Postiz credentials or browser cookies are forwarded");
      return new Response(bytes, { headers: { "Content-Type": "image/png" } });
    };
    const request = new NextRequest(`https://studio.test/api/media/images/${image.id}?download=1`);
    const exported = await h.preview.GET(request, context);
    assert.equal(exported.status, 200);
    assert.deepEqual(Buffer.from(await exported.arrayBuffer()), bytes);
    assert.equal(exported.headers.get("content-type"), "image/png");
    h.state.owner = "other";
    assert.equal((await h.preview.GET(request, context)).status, 404);
    assert.equal(calls, 1);
    h.state.owner = "owner";
    globalThis.fetch = async () => new Response(new Uint8Array(1_500_001), { headers: { "Content-Type": "image/png" } });
    assert.equal((await h.preview.GET(request, context)).status, 503);
  } finally { globalThis.fetch = originalFetch; }
});

test("storage outage, unsafe media and legacy imports use safe errors and validated bytes", async () => {
  const h = harness();
  h.state.unavailable = true;
  const failure = await h.route.POST(h.request({ requestId, dataUrl }));
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /secret|synthetic/);
  assert.equal(h.state.uploads, 0);
  h.state.unavailable = false;
  assert.equal((await h.route.POST(h.request({ requestId, sourceUrl: "http://127.0.0.1/private" }))).status, 503);
  assert.equal(h.state.uploads, 0);
  h.state.unsafe = true;
  assert.equal((await h.route.POST(h.request({ requestId, dataUrl }))).status, 503);
  assert.equal(h.rows.size, 0);
  h.state.unsafe = false;
  const imported = await h.route.POST(h.request({ requestId, sourceUrl: "https://public.test/cover" }));
  assert.equal(imported.status, 201);
  assert.equal((await imported.json()).image.width, 12);
});
test("completed legacy imports replay without refetching an expired source", async () => {
  const h = harness();
  const body = { requestId, sourceUrl: "https://public.test/cover", name: "cover" };
  const original = await (await h.route.POST(h.request(body))).json();
  h.state.expiredSource = true;
  const replay = await h.route.POST(h.request(body));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), original);
  assert.equal(h.state.sources, 1);
  assert.equal(h.state.uploads, 1);
  assert.equal((await h.route.POST(h.request({ ...body, sourceUrl: "https://public.test/other" }))).status, 409);
});

test("cancellation during validation prevents starting an upload; committed media still keeps its receipt", async () => {
  const h = harness();
  const controller = new AbortController();
  h.state.beforeValidation = () => { controller.abort(); };
  assert.equal((await h.route.POST(h.request({ requestId, dataUrl }, "https://studio.test", controller.signal))).status, 400);
  assert.equal(h.state.uploads, 0);
  assert.equal(h.rows.size, 0);
  h.state.beforeValidation = null;
  const committed = new AbortController();
  h.state.beforeUpload = signal => { assert.ok(signal); committed.abort(); };
  const saved = await h.route.POST(h.request({ requestId, dataUrl }, "https://studio.test", committed.signal));
  assert.equal(saved.status, 201, "Preserve the receipt when the upstream operation has already succeeded");
  assert.equal(h.rows.size, 1);
});

test("migration and init share append-only image registry and nullable legacy column", () => {
  const init = readFileSync(new URL("../deploy/mysql/init.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../deploy/mysql/migrations/2026-10-29-image-uploads.sql", import.meta.url), "utf8");
  const table = source => source.match(/CREATE TABLE IF NOT EXISTS image_uploads \([\s\S]+?\) ENGINE=InnoDB;/)[0];
  assert.equal(table(init), table(migration));
  assert.match(migration, /information_schema.columns[\s\S]+image_media_ids/);
  assert.match(migration, /GRANT SELECT, INSERT ON .*image_uploads/);
  assert.doesNotMatch(migration, /GRANT[^;]*(?:UPDATE|DELETE)/);
});
