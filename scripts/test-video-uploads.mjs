// Isolated only: synthetic environment, in-memory SQL, mocked fetch, local ffmpeg/ffprobe fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import typescript from "typescript";
import sharp from "sharp";

const nativeRequire = createRequire(import.meta.url);
const { NextRequest, NextResponse } = nativeRequire("next/server");
const originalEnvironment = process.env;
const originalFetch = globalThis.fetch;
const ffprobePath = process.env.FFPROBE_PATH || "/opt/homebrew/bin/ffprobe";
const ffmpegPath = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
process.env = {
  TMPDIR: "/tmp", FFPROBE_PATH: ffprobePath,
  POSTIZ_API_URL: "https://postiz.example.test/api/public/v1",
  POSTIZ_UI_URL: "https://studio-postiz.example.test",
  POSTIZ_API_KEY: "synthetic-video-secret"
};
globalThis.fetch = async () => { throw new Error("Unexpected network request: live access is forbidden in this test."); };
after(() => { process.env = originalEnvironment; globalThis.fetch = originalFetch; });

function loadModule(relativePath, dependencies = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", outputText)(
    dependency => dependencies[dependency] ?? nativeRequire(dependency), compiled, compiled.exports
  );
  return compiled.exports;
}

const videoTypes = loadModule("../src/lib/video-types.ts");
const validation = loadModule("../src/lib/video-validation.ts", { "./video-types": videoTypes });
const postiz = loadModule("../src/lib/postiz.ts", { "./types": { DEFAULT_PLATFORMS: ["x", "instagram", "facebook", "threads", "linkedin"] }, "./post-types": loadModule("../src/lib/post-types.ts") });
const requestId = "11111111-1111-4111-8111-111111111111";
const metadata = { width: 64, height: 64, durationSeconds: 1 };
const upstreamMedia = { id: "postiz-media-one", path: "https://uploads.postiz.com/video.mp4" };
const tinyPng = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#3366cc" } }).png().toBuffer();
const tinyPngDataUrl = `data:image/png;base64,${tinyPng.toString("base64")}`;

function createStorageHarness() {
  const harness = { rows: [], jobs: [], queries: [], failSelect: false, failInsert: false, acquired: 0, released: 0, destroyed: 0 };
  harness.connection = {
    release: () => { harness.released++; },
    destroy: () => { harness.destroyed++; },
    execute: async (query, parameters = []) => {
      const statement = typeof query === "string" ? query : query.sql;
      if (typeof query !== "string") assert.equal(query.timeout, 5_000);
      harness.queries.push({ statement, parameters });
      if (/^\s*INSERT/.test(statement)) {
        if (harness.failInsert) throw new Error("synthetic-video-secret /private/tmp/storage-unavailable");
        if (statement.includes("video_processing_jobs")) {
          const [id, ownerUserId, requestId, checksum, name, bytes] = parameters;
          harness.jobs.push({ id, ownerUserId, requestId, checksum, name, bytes, state: "queued", phase: "validating" });
          return [{ affectedRows: 1 }];
        }
        const [id, ownerUserId, requestId, checksum, postizMediaId, postizPath, name, bytes, width, height, durationSeconds] = parameters;
        if (harness.rows.some(row => row.ownerUserId === ownerUserId && row.requestId === requestId)) {
          throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
        }
        harness.rows.push({ id, ownerUserId, requestId, checksum, postizMediaId, postizPath, name, bytes, width, height, durationSeconds });
        return [{ affectedRows: 1 }];
      }
      assert.match(statement, /^\s*SELECT/);
      assert.match(statement, /WHERE owner_user_id = \?/);
      if (harness.failSelect) throw Object.assign(new Error("synthetic-video-secret /private/tmp/missing-table"), { code: "ER_NO_SUCH_TABLE" });
      const [ownerUserId, ...identifiers] = parameters;
      const selected = harness.rows.filter(row => row.ownerUserId === ownerUserId && (
        statement.includes("request_id = ?") ? row.requestId === identifiers[0] : identifiers.includes(row.id)
      ));
      return [selected];
    }
  };
  harness.acquire = async () => { harness.acquired++; return harness.connection; };
  harness.storage = loadModule("../src/lib/video-uploads.ts", {
    "@/lib/project-db": { database: () => ({
      execute: (...arguments_) => harness.connection.execute(...arguments_),
      getConnection: () => harness.acquire()
    }) }, "./video-types": videoTypes
  });
  return harness;
}

function createRouteHarness() {
  const harness = Object.assign(createStorageHarness(), {
    user: { id: "owner-one", role: "member" }, configured: true, postizConfigured: true,
    temporaryFiles: [], uploads: [], probeCalls: 0, afterCallbacks: []
  });
  harness.probe = async () => { harness.probeCalls++; return metadata; };
  harness.upload = async (filePath, signal) => {
    assert.equal(harness.acquired, harness.released + harness.destroyed, "no SQL connection is held across upstream upload");
    assert.equal(signal.aborted, false);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(filePath, ".."))).mode & 0o777, 0o700);
    harness.uploads.push(filePath);
    return upstreamMedia;
  };
  const dependencies = {
    "next/server": { NextRequest, NextResponse, after: callback => { harness.afterCallbacks.push(callback); } },
    "@/lib/auth": {
      currentUser: async () => harness.user ? { user: harness.user } : null,
      unauthorized: () => NextResponse.json({ error: "Sign in to continue.", code: "UNAUTHORIZED" }, { status: 401 })
    },
    "@/lib/project-db": { databaseConfigured: () => harness.configured },
    "@/lib/same-origin": loadModule("../src/lib/same-origin.ts"),
    "@/lib/video-types": videoTypes,
    "@/lib/video-uploads": harness.storage,
    "@/lib/video-processing-scheduler": { wakeVideoProcessingWorker: () => harness.finishJobs() },
    "@/lib/video-processing": {
      getVideoProcessingRequest: async (ownerUserId, requestId, signal) => ({
        receipt: await harness.storage.withVideoUploadConnection(connection => harness.storage.getVideoUploadByRequest(ownerUserId, requestId, connection), signal),
        job: null
      }),
      createVideoProcessingInput: async () => {
        const temporary = { ...await validation.createVideoUploadTempFile(), id: randomUUID() };
        harness.temporaryFiles.push(temporary);
        return { id: temporary.id, partPath: temporary.filePath };
      },
      completeVideoProcessingInput: async () => {},
      removeVideoProcessingInput: async id => {
        await validation.removeVideoUploadTempFile(harness.temporaryFiles.find(temporary => temporary.id === id).directory);
      },
      registerVideoProcessingJob: async (input, signal) => {
        const temporary = harness.temporaryFiles.find(temporary => temporary.id === input.id);
        try {
          const existing = harness.jobs.find(job => job.ownerUserId === input.ownerUserId && job.requestId === input.requestId);
          if (existing) {
            if (existing.checksum !== input.checksum) throw new harness.storage.VideoUploadRequestConflictError();
            await validation.removeVideoUploadTempFile(temporary.directory);
            return { job: { id: existing.id, state: existing.state, phase: existing.phase } };
          }
          await harness.storage.withVideoUploadConnection(connection => connection.execute({
            sql: "INSERT INTO video_processing_jobs (id,owner_user_id,request_id,checksum,filename,input_bytes) VALUES (?,?,?,?,?,?)", timeout: 5_000
          }, [input.id, input.ownerUserId, input.requestId, input.checksum, input.name, input.bytes]), signal);
          return { job: { id: input.id, state: "queued", phase: "validating" } };
        } catch (error) {
          await validation.removeVideoUploadTempFile(temporary.directory);
          throw error;
        }
      }
    },
    "@/lib/postiz": {
      ...postiz, getPostizConfig: () => harness.postizConfigured ? {} : null,
      uploadVideoFileToPostiz: (...arguments_) => harness.upload(...arguments_)
    },
    "@/lib/video-validation": {
      ...validation,
      createVideoUploadTempFile: async () => {
        const temporary = await validation.createVideoUploadTempFile();
        harness.temporaryFiles.push(temporary);
        return temporary;
      },
      validateVideoFile: (...arguments_) => harness.probe(...arguments_)
    }
  };
  harness.route = loadModule("../src/app/api/media/uploads/route.ts", dependencies);
  harness.preview = loadModule("../src/app/api/media/uploads/[mediaId]/route.ts", dependencies);
  harness.finishJobs = async (signal = new AbortController().signal) => {
    for (const job of harness.jobs.filter(job => job.state === "queued")) {
      const temporary = harness.temporaryFiles.find(temporary => temporary.id === job.id);
      job.state = "running";
      try {
        const metadata = await harness.probe(temporary.filePath, signal);
        const uploaded = await harness.upload(temporary.filePath, signal);
        signal.throwIfAborted();
        const recorded = await harness.storage.withVideoUploadConnection(connection => harness.storage.recordVideoUpload({
          ownerUserId: job.ownerUserId, requestId: job.requestId, checksum: job.checksum, name: job.name, bytes: job.bytes,
          ...metadata, postizMediaId: uploaded.id, postizPath: uploaded.path
        }, connection), signal);
        job.state = "succeeded";
        job.phase = "saving";
        job.video = recorded.video;
      } finally { await validation.removeVideoUploadTempFile(temporary.directory); }
    }
  };
  harness.assertClean = async () => {
    for (const temporary of harness.temporaryFiles) await assert.rejects(access(temporary.directory), { code: "ENOENT" });
  };
  return harness;
}

function makeRequest(body = new Uint8Array([1, 2, 3]), options = {}) {
  return new NextRequest("https://polaris.test/api/media/uploads", {
    method: "POST", duplex: "half", ...options,
    headers: {
      origin: "https://polaris.test", "content-type": "video/mp4",
      "x-upload-request-id": requestId, "x-file-name": encodeURIComponent("my video.mp4"), ...options.headers
    }, body
  });
}

function sizedStream(size) {
  let remaining = size;
  const chunk = new Uint8Array(256 * 1024);
  return new ReadableStream({ pull(controller) {
    if (remaining === 0) { controller.close(); return; }
    const bytes = Math.min(remaining, chunk.byteLength);
    controller.enqueue(chunk.subarray(0, bytes));
    remaining -= bytes;
  } });
}

function assertSafe(text) {
  assert.doesNotMatch(text, /synthetic-video-secret|\/private\/tmp|polaris-video-|postiz-media-one/);
}

test("route streams exactly 100 MiB without Content-Length, queues before processing, then exposes a ready receipt", async () => {
  const harness = createRouteHarness();
  const response = await harness.route.POST(makeRequest(sizedStream(videoTypes.MAX_VIDEO_UPLOAD_BYTES)));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.ok(videoTypes.isVideoProcessingResponse(body));
  assert.equal(body.job.state, "queued");
  assert.equal(harness.rows.length, 0);
  assert.equal(harness.uploads.length, 0);
  assert.equal(harness.jobs[0].bytes, 100 * 1024 * 1024);
  await access(harness.temporaryFiles[0].filePath);
  await harness.finishJobs();
  const video = harness.jobs.find(job => job.id === body.job.id).video;
  assert.equal(video.bytes, 100 * 1024 * 1024);
  assert.equal(harness.rows.length, 1);
  assert.equal(harness.uploads.length, 1);
  const ready = await (await harness.route.POST(makeRequest(sizedStream(videoTypes.MAX_VIDEO_UPLOAD_BYTES)))).json();
  assert.deepEqual(Object.keys(ready.video).sort(), ["bytes", "durationSeconds", "height", "id", "name", "width"]);
  assert.ok(videoTypes.isVideoUploadResponse(ready));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assertSafe(JSON.stringify(body));
  await harness.assertClean();
});

test("actual stream bytes enforce 100 MiB + 1, regardless of missing or dishonest Content-Length", async () => {
  for (const headers of [{}, { "content-length": "1" }]) {
    const harness = createRouteHarness();
    const response = await harness.route.POST(makeRequest(sizedStream(videoTypes.MAX_VIDEO_UPLOAD_BYTES + 1), { headers }));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "VIDEO_TOO_LARGE");
    assert.equal(harness.uploads.length, 0);
    assert.equal(harness.rows.length, 0);
    await harness.assertClean();
  }
});

test("empty, truncated and errored bodies are refused without an upstream call and always cleaned", async () => {
  const cases = [
    [new Uint8Array(), {}, "EMPTY_VIDEO"],
    [new Uint8Array([1]), { "content-length": "2" }, "INCOMPLETE_UPLOAD"],
    [new ReadableStream({ start(controller) { controller.error(new Error("synthetic-video-secret /private/tmp/client")); } }), {}, "UPLOAD_READ_FAILED"]
  ];
  for (const [body, headers, code] of cases) {
    const harness = createRouteHarness();
    const response = await harness.route.POST(makeRequest(body, { headers }));
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.code, code);
    assertSafe(JSON.stringify(result));
    assert.equal(harness.uploads.length, 0);
    await harness.assertClean();
  }
});

test("auth, cross-origin, content type, request ID, filename and early size checks fail before storage/temp work", async () => {
  const cases = [
    [{}, harness => { harness.user = null; }, 401],
    [{ origin: "https://attacker.test" }, () => {}, 403],
    [{ "content-type": "multipart/form-data" }, () => {}, 415],
    [{ "x-upload-request-id": "invalid" }, () => {}, 400],
    [{ "x-file-name": "%zz.mp4" }, () => {}, 400],
    [{ "x-file-name": "..%2Fbad.mp4" }, () => {}, 400],
    [{ "x-file-name": "image.png" }, () => {}, 400],
    [{ "content-length": String(videoTypes.MAX_VIDEO_UPLOAD_BYTES + 1) }, () => {}, 413],
    [{ "content-length": "garbage" }, () => {}, 400],
    [{}, harness => { harness.configured = false; }, 503],
    [{}, harness => { harness.postizConfigured = false; }, 503],
    [{}, harness => { harness.user = null; harness.postizConfigured = false; harness.configured = false; }, 401]
  ];
  for (const [headers, configure, status] of cases) {
    const harness = createRouteHarness();
    configure(harness);
    assert.equal((await harness.route.POST(makeRequest(undefined, { headers }))).status, status);
    assert.equal(harness.temporaryFiles.length, 0);
    assert.equal(harness.queries.length, 0);
  }
});

test("same owner successful request ID replays only identical SHA-256, never uploads again or creates drafts", async () => {
  const harness = createRouteHarness();
  assert.equal((await harness.route.POST(makeRequest())).status, 202);
  await harness.finishJobs();
  const original = await (await harness.route.POST(makeRequest())).json();
  const replay = await harness.route.POST(makeRequest(undefined, { headers: { "x-file-name": "renamed.mp4" } }));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), original);
  const conflict = await harness.route.POST(makeRequest(new Uint8Array([4, 5, 6])));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "REQUEST_ID_CONFLICT");
  assert.equal(harness.uploads.length, 1);
  assert.equal(harness.probeCalls, 1);
  assert.equal(harness.rows.length, 1);
  assert.ok(harness.queries.every(query => !/draft_submissions|social_publishes|post_targets/.test(query.statement)));
  harness.user = { id: "owner-two", role: "member" };
  assert.equal((await harness.route.POST(makeRequest())).status, 202, "request IDs are owner-scoped");
  await harness.finishJobs();
  assert.equal(harness.rows.length, 2);
  await harness.assertClean();
});

test("missing table fails before upload; INSERT failure is sanitized and leaves no ready receipt", async () => {
  for (const stage of ["failSelect", "failInsert"]) {
    const harness = createRouteHarness();
    harness[stage] = true;
    const response = await harness.route.POST(makeRequest());
    assert.equal(response.status, 503);
    assertSafe(await response.text());
    assert.equal(harness.rows.length, 0);
    assert.equal(harness.uploads.length, 0);
    assert.equal(harness.temporaryFiles.length, stage === "failSelect" ? 0 : 1);
    await harness.assertClean();
  }
});

for (const phase of ["preflight", "record"]) {
  for (const waitingFor of ["acquire", "query"]) {
    for (const interruption of ["cancel", "timeout"]) {
      test(`${phase} pending ${waitingFor}: ${interruption} frees the upload slot and cleans SQL resources`, async () => {
        const harness = createRouteHarness();
        const abort = new AbortController();
        const originalAcquire = harness.acquire;
        const originalExecute = harness.connection.execute;
        const originalDestroy = harness.connection.destroy;
        let acquireCalls = 0;
        let unblockAcquire;
        let rejectQuery;
        let querySettled = false;
        let started;
        const blocked = new Promise(resolve => { started = resolve; });
        harness.acquire = async () => {
          acquireCalls++;
          if (waitingFor === "acquire" && acquireCalls === (phase === "preflight" ? 1 : 2)) {
            return new Promise(resolve => {
              unblockAcquire = () => { harness.acquired++; resolve(harness.connection); };
              started();
            });
          }
          return originalAcquire();
        };
        harness.connection.execute = async (query, parameters) => {
          const statement = typeof query === "string" ? query : query.sql;
          if (waitingFor === "query" && (phase === "preflight" ? statement.includes("SELECT") : statement.includes("INSERT"))) {
            assert.equal(query.timeout, 5_000);
            try {
              return await new Promise((_resolve, reject) => { rejectQuery = reject; started(); });
            } finally { querySettled = true; }
          }
          return originalExecute(query, parameters);
        };
        harness.connection.destroy = () => {
          originalDestroy();
          rejectQuery?.(new Error("synthetic-video-secret /private/tmp/destroyed-query"));
        };
        const pending = harness.route.POST(makeRequest(undefined, { signal: abort.signal }));
        await blocked;
        if (interruption === "cancel") abort.abort();
        const response = await pending;
        assert.equal(response.status, interruption === "cancel" ? 499 : 503);
        assertSafe(await response.text());
        assert.equal(harness.rows.length, 0);
        assert.equal(harness.uploads.length, 0, "receiving and enqueueing never run an upstream upload");
        await harness.assertClean();
        const releaseSlot = validation.acquireVideoUploadSlot("owner-one");
        releaseSlot();
        if (waitingFor === "acquire") {
          const queriesBeforeLateAcquire = harness.queries.length;
          const releasesBeforeLateAcquire = harness.released;
          unblockAcquire();
          await delay(0);
          assert.equal(harness.released, releasesBeforeLateAcquire + 1, "late acquired connection is released");
          assert.equal(harness.queries.length, queriesBeforeLateAcquire, "late acquire never starts SQL");
          assert.equal(harness.destroyed, 0);
        } else {
          assert.equal(harness.destroyed, 1, "in-flight query connection is destroyed, not returned to pool");
          assert.equal(querySettled, true);
        }
        assert.equal(harness.acquired, harness.released + harness.destroyed);
      });
    }
  }
}

test("stream cancellation wakes a pending read, cleans its file and releases the owner slot", async () => {
  const harness = createRouteHarness();
  const abort = new AbortController();
  let cancelled = false;
  const pending = harness.route.POST(makeRequest(new ReadableStream({ cancel() { cancelled = true; } }), { signal: abort.signal }));
  while (harness.temporaryFiles.length === 0) await delay(1);
  abort.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal(cancelled, true);
  assert.equal(harness.uploads.length, 0);
  await harness.assertClean();
  assert.equal((await harness.route.POST(makeRequest())).status, 202);
  await harness.finishJobs();
  await harness.assertClean();
});

test("stream timeout wakes a stalled body rather than hanging on reader.read", async () => {
  const temporary = await validation.createVideoUploadTempFile();
  try {
    const timeout = AbortSignal.timeout(10);
    const keepAlive = delay(25);
    await assert.rejects(validation.streamVideoUpload(makeRequest(new ReadableStream()), temporary.filePath, null, timeout),
      error => error.code === "UPLOAD_TIMEOUT" && error.status === 408);
    await keepAlive;
  } finally { await validation.removeVideoUploadTempFile(temporary.directory); }
});

test("accepted job upstream abort must settle before file removal; request receive slot is already released", async () => {
  const harness = createRouteHarness();
  const abort = new AbortController();
  let completeUpstream;
  let upstreamStarted;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  harness.upload = (filePath, signal) => new Promise((_resolve, reject) => {
    completeUpstream = () => reject(new Error("synthetic-video-secret /private/tmp/upstream"));
    signal.addEventListener("abort", () => upstreamStarted(filePath), { once: true });
    upstreamStarted(filePath);
  });
  assert.equal((await harness.route.POST(makeRequest())).status, 202);
  const pending = harness.finishJobs(abort.signal);
  const filePath = await started;
  abort.abort();
  await delay(5);
  await access(filePath);
  const receiveRelease = validation.acquireVideoUploadSlot("owner-one");
  receiveRelease();
  completeUpstream();
  await assert.rejects(pending);
  assert.equal(harness.rows.length, 0);
  await harness.assertClean();
  const release = validation.acquireVideoUploadSlot("owner-one");
  release();
});

test("receiving allows two owners and one stream per owner, independently from durable processing", () => {
  const releaseFirst = validation.acquireVideoUploadSlot("first");
  try {
    assert.throws(() => validation.acquireVideoUploadSlot("first"), error => error.status === 429);
    const releaseSecond = validation.acquireVideoUploadSlot("second");
    try { assert.throws(() => validation.acquireVideoUploadSlot("third"), error => error.status === 429); }
    finally { releaseSecond(); }
  } finally { releaseFirst(); }
});

test("restart sweep is bounded, skips symlinks/unrelated entries, and only removes old dedicated directories", async () => {
  const previousSweep = globalThis.polarisVideoTempSweep;
  delete globalThis.polarisVideoTempSweep;
  const removed = [];
  let inspected = 0;
  const mocked = loadModule("../src/lib/video-validation.ts", {
    "./video-types": videoTypes,
    "node:os": { tmpdir: () => "/tmp" },
    "node:fs/promises": {
      ...nativeRequire("node:fs/promises"),
      opendir: async () => ({ async *[Symbol.asyncIterator]() {
        yield { name: "unrelated", isDirectory: () => true };
        yield { name: "polaris-video-symlink", isDirectory: () => false };
        for (let index = 0; index < 250; index++) {
          inspected++;
          yield { name: `polaris-video-${String(index).padStart(6, "0")}`, isDirectory: () => true };
        }
      } }),
      stat: async () => ({ mtimeMs: 0 }),
      rm: async directory => { removed.push(directory); },
      mkdtemp: async () => "/tmp/polaris-video-new123"
    }
  });
  try {
    await mocked.createVideoUploadTempFile();
    await mocked.createVideoUploadTempFile();
    assert.equal(removed.length, 20, "one sweep per process, at most twenty old directories");
    assert.ok(inspected <= 200);
    assert.ok(removed.every(directory => /^\/tmp\/polaris-video-\d{6}$/.test(directory)));
  } finally { globalThis.polarisVideoTempSweep = previousSweep; }
});

test("owner lookup and bulk validation never bypass ownership; injected transaction connection is used", async () => {
  const harness = createStorageHarness();
  const recorded = await harness.storage.recordVideoUpload({
    ownerUserId: "owner-one", requestId, checksum: "a".repeat(64), ...metadata,
    name: "video.mp4", bytes: 3, postizMediaId: upstreamMedia.id, postizPath: upstreamMedia.path
  });
  const mediaId = recorded.video.id;
  assert.equal(await harness.storage.getVideoUpload("owner-two", mediaId), null);
  assert.equal(await harness.storage.ownsVideoUploads("owner-two", [mediaId]), false);
  const queryCount = harness.queries.length;
  assert.equal(await harness.storage.ownsVideoUploads("owner-one", [mediaId, mediaId], harness.connection), true);
  assert.equal(harness.queries.length, queryCount + 1);
  assert.deepEqual(harness.queries.at(-1).parameters, ["owner-one", mediaId]);
  assert.equal(await harness.storage.ownsVideoUploads("owner-one", [mediaId, randomUUID()]), false);
  assert.equal(await harness.storage.ownsVideoUploads("owner-one", ["bad"]), false);
  assert.equal(await harness.storage.ownsVideoUploads("owner-one", []), true);
  assert.equal((await harness.storage.getVideoUpload("owner-one", mediaId, harness.connection)).postizMediaId, upstreamMedia.id);
});

test("concurrent INSERT dedup returns the immutable receipt, different hash conflicts", async () => {
  const harness = createStorageHarness();
  const input = { ownerUserId: "owner-one", requestId, checksum: "a".repeat(64), ...metadata,
    name: "video.mp4", bytes: 3, postizMediaId: upstreamMedia.id, postizPath: upstreamMedia.path };
  const original = await harness.storage.recordVideoUpload(input);
  const replay = await harness.storage.recordVideoUpload({ ...input, postizMediaId: "orphan-media" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.video.id, original.video.id);
  assert.equal(replay.video.postizMediaId, upstreamMedia.id);
  await assert.rejects(harness.storage.recordVideoUpload({ ...input, checksum: "b".repeat(64) }), harness.storage.VideoUploadRequestConflictError);
  assert.equal(harness.rows.length, 1);
  assert.ok(harness.queries.every(query => /^\s*(SELECT|INSERT)/.test(query.statement)));
});

test("preview is an owner-only no-store 307, ignores arbitrary path and never fetches media", async () => {
  const harness = createRouteHarness();
  assert.equal((await harness.route.POST(makeRequest())).status, 202);
  await harness.finishJobs();
  const { video } = await (await harness.route.POST(makeRequest())).json();
  const request = new NextRequest(`https://polaris.test/api/media/uploads/${video.id}?path=https://attacker.test`);
  const context = { params: Promise.resolve({ mediaId: video.id }) };
  const response = await harness.preview.GET(request, context);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), upstreamMedia.path);
  assert.equal(response.headers.get("cache-control"), "no-store");
  harness.user = { id: "another-admin", role: "admin" };
  assert.equal((await harness.preview.GET(request, context)).status, 404);
  assert.equal((await harness.preview.GET(request, { params: Promise.resolve({ mediaId: "bad" }) })).status, 404);
  harness.user = null;
  assert.equal((await harness.preview.GET(request, context)).status, 401);
  await harness.assertClean();
});

test("trusted URL requires exact HTTP(S) origin without credentials; explicit whitelist replaces defaults", () => {
  for (const path of ["javascript:alert(1)", "file:///tmp/video.mp4", "https://attacker.test/video.mp4",
    "https://uploads.postiz.com.attacker.test/video.mp4", "https://user:password@uploads.postiz.com/video.mp4",
    "https://uploads.postiz.com/video.mp4?key=synthetic-video-secret"]) {
    assert.throws(() => postiz.getTrustedPostizMediaUrl(path), error => { assertSafe(error.message); return true; });
  }
  assert.equal(postiz.getTrustedPostizMediaUrl("https://studio-postiz.example.test/file.mp4"), "https://studio-postiz.example.test/file.mp4");
  process.env.POSTIZ_MEDIA_ORIGINS = "https://cdn.example.test";
  try {
    assert.equal(postiz.getTrustedPostizMediaUrl("https://cdn.example.test/video.mp4"), "https://cdn.example.test/video.mp4");
    assert.throws(() => postiz.getTrustedPostizMediaUrl(upstreamMedia.path));
    process.env.POSTIZ_MEDIA_ORIGINS = "https://cdn.example.test/not-an-origin";
    assert.throws(() => postiz.getTrustedPostizMediaUrl("https://cdn.example.test/video.mp4"));
  } finally { delete process.env.POSTIZ_MEDIA_ORIGINS; }
});

test("native file-backed Blob multipart has adjust=false, bounded response and no draft creation", async () => {
  const temporary = await validation.createVideoUploadTempFile();
  await writeFile(temporary.filePath, new Uint8Array([1, 2, 3]));
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.match(url, /\/upload$/);
    assert.equal(options.body.get("adjust"), "false");
    const file = options.body.get("file");
    assert.equal(file.name, "video.mp4");
    assert.equal(file.type, "video/mp4");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "synthetic-video-secret");
    return Response.json({ ...upstreamMedia, status: "ready" });
  };
  try {
    assert.deepEqual(await postiz.uploadVideoFileToPostiz(temporary.filePath), upstreamMedia);
    assert.equal(calls, 1);
    for (const response of [new Response("synthetic-video-secret /private/tmp/provider", { status: 500 }),
      Response.json({ ...upstreamMedia, status: "processing" }), new Response("x".repeat(64 * 1024 + 1)),
      Response.json({ ...upstreamMedia, path: "https://attacker.test/video.mp4" })]) {
      globalThis.fetch = async () => response;
      await assert.rejects(postiz.uploadVideoFileToPostiz(temporary.filePath), error => { assertSafe(error.message); return true; });
    }
  } finally {
    globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
    await validation.removeVideoUploadTempFile(temporary.directory);
  }
});

test("strict drafts reuse media directly, keep provider aliases, reject mixed media, preserve uncertain", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, "error", "credential-bearing draft requests never follow redirects");
    calls.push({ url, options });
    return Response.json([{ postId: "draft-one" }]);
  };
  try {
    for (const platform of ["instagram-standalone", "linkedin-page", "x"]) {
      const result = await postiz.createStrictDraft({ integrationId: "account-one", content: "Review", platform, uploadedMedia: upstreamMedia });
      assert.equal(result.success, true);
      assert.match(calls.at(-1).url, /\/posts$/);
      const payload = JSON.parse(calls.at(-1).options.body);
      assert.equal(payload.type, "draft");
      assert.deepEqual(payload.posts[0].value[0].image, [upstreamMedia]);
      assert.equal(payload.posts[0].settings.__type, platform);
      if (platform === "instagram-standalone") assert.equal(payload.posts[0].settings.post_type, "post");
      assert.doesNotMatch(JSON.stringify(payload), /reel/);
    }
    assert.equal(calls.length, 3, "there is no media upload or download fetch");
    const mixed = await postiz.createStrictDraft({ integrationId: "account-one", content: "Review", uploadedMedia: upstreamMedia, imageUrl: "data:image/png;base64,AAAA" });
    assert.equal(mixed.success, false);
    assert.equal(calls.length, 3);
    globalThis.fetch = async () => { throw new Error("synthetic-video-secret /private/tmp/provider"); };
    const uncertain = await postiz.createStrictDraft({ integrationId: "account-one", content: "Review", uploadedMedia: upstreamMedia });
    assert.equal(uncertain.uncertain, true);
    assertSafe(uncertain.error);
    globalThis.fetch = async () => new Response("synthetic-video-secret /private/tmp/provider", { status: 400 });
    const refused = await postiz.createStrictDraft({ integrationId: "account-one", content: "Review", uploadedMedia: upstreamMedia });
    assert.equal(refused.uncertain, undefined);
    assertSafe(refused.error);
  } finally { globalThis.fetch = async () => { throw new Error("Unexpected network request"); }; }
});

test("YouTube drafts require a video and valid title and reuse the media with private visibility", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json([{ postId: "youtube-draft" }]);
  };
  try {
    for (const input of [
      { title: "Video title" }, { title: "Video title", imageUrl: tinyPngDataUrl },
      { uploadedMedia: upstreamMedia }, { title: "x", uploadedMedia: upstreamMedia },
      { title: "Invalid <title>", uploadedMedia: upstreamMedia },
      { title: "x".repeat(101), uploadedMedia: upstreamMedia },
      { title: "Title", content: "x".repeat(5001), uploadedMedia: upstreamMedia }
    ]) {
      const result = await postiz.createStrictDraft({ integrationId: "youtube-channel", platform: "youtube", content: "", ...input });
      assert.equal(result.success, false);
      assert.equal(result.uncertain, undefined);
      assert.equal(calls.length, 0, "Invalid YouTube requests cannot upload images or create drafts");
    }
    assert.equal((await postiz.publishToPostiz({ integrationId: "youtube-channel", platform: "youtube", content: "No video" })).success, false);
    assert.equal(calls.length, 0);
    const title = "😀".repeat(100);
    const result = await postiz.createStrictDraft({ integrationId: "youtube-channel", platform: "youtube", title, content: "", uploadedMedia: upstreamMedia });
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.type, "draft");
    assert.deepEqual(payload.posts[0].settings, { __type: "youtube", title, type: "private" });
    assert.deepEqual(payload.posts[0].value[0].image, [upstreamMedia]);
  } finally { globalThis.fetch = async () => { throw new Error("Unexpected network request"); }; }
});

test("old inline image upload still precedes strict draft creation", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/upload")) {
      const file = options.body.get("file");
      assert.equal(file.type, "image/png");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), tinyPng, "validated image bytes are uploaded unchanged");
    }
    return Response.json(url.endsWith("/upload") ? { id: "image-one", path: "https://uploads.postiz.com/image.png" } : [{ postId: "image-draft" }]);
  };
  try {
    const result = await postiz.createStrictDraft({ integrationId: "account-one", content: "Image", imageUrl: tinyPngDataUrl });
    assert.equal(result.postId, "image-draft");
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/upload$/);
    assert.deepEqual(JSON.parse(calls[1].options.body).posts[0].value[0].image, [{ id: "image-one", path: "https://uploads.postiz.com/image.png" }]);
  } finally { globalThis.fetch = async () => { throw new Error("Unexpected network request"); }; }
});

test("remote article JPEG/PNG/WebP originals remain unchanged despite misleading URL or MIME", async () => {
  const widePng = await sharp({ create: { width: 2600, height: 10, channels: 3, background: "#3366cc" } }).png().toBuffer();
  const originals = [
    [widePng, "png"],
    [await sharp(tinyPng).jpeg().toBuffer(), "jpeg"],
    [await sharp(tinyPng).webp().toBuffer(), "webp"]
  ];
  // Valid originals can exceed the editor's stored-image 1.5MB limit.
  originals.push([Buffer.concat([tinyPng, Buffer.alloc(1_600_000)]), "png"]);
  try {
    for (const [original, format] of originals) {
      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (!options?.method) return new Response(original, { headers: { "content-type": "video/mp4" } });
        if (url.endsWith("/upload")) {
          const file = options.body.get("file");
          assert.equal(file.type, `image/${format}`);
          assert.deepEqual(Buffer.from(await file.arrayBuffer()), original);
          return Response.json({ id: "image-one", path: "https://uploads.postiz.com/image.png" });
        }
        return Response.json([{ postId: "article-image-draft" }]);
      };
      const result = await postiz.createStrictDraft({ integrationId: "account-one", content: "Article", imageUrl: "https://article.example.test/no-image-suffix.mp4" });
      assert.equal(result.postId, "article-image-draft");
      assert.equal(calls.length, 3);
    }
  } finally { globalThis.fetch = async () => { throw new Error("Unexpected network request"); }; }
});

test("image actual byte limits, encoded limits, corrupt files and pixel bombs block upload and create", async () => {
  const limit = 30 * 1024 * 1024;
  try {
    for (const headers of [{}, { "content-length": "1" }]) {
      let cancelled = false;
      let postizCalls = 0;
      let bytesSent = 0;
      globalThis.fetch = async (_url, options) => {
        if (options?.method === "POST") { postizCalls++; return Response.json({}); }
        return new Response(new ReadableStream({
          pull(controller) {
            if (bytesSent >= limit + 1) return;
            const chunk = new Uint8Array(Math.min(256 * 1024, limit + 1 - bytesSent));
            bytesSent += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() { cancelled = true; }
        }), { headers });
      };
      const result = await postiz.createStrictDraft({ integrationId: "account-one", content: "Oversize", imageUrl: "https://article.example.test/image.png" });
      assert.equal(result.success, false);
      assert.equal(postizCalls, 0);
      assert.equal(cancelled, true);
    }
    const bomb = await sharp({ create: { width: 6500, height: 6500, channels: 3, background: "#000000" } }).png().toBuffer();
    for (const imageUrl of [
      `data:image/png;base64,${"A".repeat(4 * Math.ceil(limit / 3) + 100)}`,
      `data:image/png;base64,${tinyPng.subarray(0, tinyPng.length - 30).toString("base64")}`,
      `data:image/png;base64,${bomb.toString("base64")}`,
      "data:image/png;base64,AAAA"
    ]) {
      let postizCalls = 0;
      globalThis.fetch = async () => { postizCalls++; return Response.json({}); };
      const result = await postiz.createStrictDraft({ integrationId: "account-one", content: "Invalid", imageUrl });
      assert.equal(result.success, false);
      assert.equal(postizCalls, 0, "invalid image must not call Postiz upload or create");
    }
  } finally { globalThis.fetch = async () => { throw new Error("Unexpected network request"); }; }
});

test("real ffprobe accepts a local H264/AAC MP4, rejects fake, truncated, wrong container and wrong codec", async () => {
  const fixtureDirectory = await mkdtemp("/tmp/polaris-video-fixture-");
  const videoPath = join(fixtureDirectory, "valid.mp4");
  const generate = (output, codec = "libx264", extra = []) => execFileSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.3", "-c:v", codec,
    "-pix_fmt", "yuv420p", "-c:a", "aac", ...extra, output
  ], { timeout: 15_000, stdio: "pipe" });
  try {
    generate(videoPath);
    const result = await validation.validateVideoFile(videoPath);
    assert.equal(result.width, 64);
    assert.equal(result.height, 64);
    assert.ok(result.durationSeconds > 0);
    const validBytes = await readFile(videoPath);
    assert.ok(validBytes.length < 100 * 1024, "only a tiny real fixture is read whole in tests");
    assert.equal(createHash("sha256").update(validBytes).digest("hex").length, 64);
    for (const createDraft of [postiz.createStrictDraft, postiz.publishToPostiz]) {
      for (const imageUrl of ["https://uploads.postiz.com/someone.mp4", "https://article.example.test/forged.png",
        `data:video/mp4;base64,${validBytes.toString("base64")}`, `data:image/png;base64,${validBytes.toString("base64")}`]) {
        const calls = [];
        globalThis.fetch = async (url, options) => {
          calls.push({ url, options });
          return new Response(validBytes, { headers: { "content-type": "image/png" } });
        };
        const result = await createDraft({ integrationId: "account-one", content: "Bypass", imageUrl });
        assert.equal(result.success, false);
        assert.equal(result.uncertain, undefined);
        assert.ok(calls.every(call => call.options?.method !== "POST"), "MP4 cannot reach either Postiz upload or create endpoint");
      }
    }
    globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
    const harness = createRouteHarness();
    harness.probe = validation.validateVideoFile;
    assert.equal((await harness.route.POST(makeRequest(validBytes))).status, 202);
    await harness.finishJobs();
    assert.equal(harness.jobs[0].state, "succeeded");
    await harness.assertClean();
    const forgedPath = join(fixtureDirectory, "fake.mp4");
    const truncatedPath = join(fixtureDirectory, "truncated.mp4");
    const wrongContainer = join(fixtureDirectory, "quicktime.mp4");
    const wrongCodec = join(fixtureDirectory, "mpeg4.mp4");
    await writeFile(forgedPath, "not video/mp4");
    await writeFile(truncatedPath, validBytes.subarray(0, 50));
    generate(wrongContainer, "libx264", ["-f", "mov"]);
    generate(wrongCodec, "mpeg4");
    for (const path of [forgedPath, truncatedPath, wrongContainer, wrongCodec]) {
      await assert.rejects(validation.validateVideoFile(path), error => { assertSafe(error.message); return error.status === 400; });
    }
  } finally {
    globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("ffprobe execution is bounded, blocks external resources, and waits for child close on abort", async () => {
  const abort = new AbortController();
  const child = new EventEmitter();
  const killSignals = [];
  child.kill = signal => { killSignals.push(signal); return true; };
  let callback;
  const mocked = loadModule("../src/lib/video-validation.ts", {
    "./video-types": videoTypes,
    "node:child_process": { execFile: (_binary, arguments_, options, complete) => {
      callback = complete;
      assert.equal(options.timeout, 15_000);
      assert.equal(options.maxBuffer, 64 * 1024);
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(arguments_[arguments_.indexOf("-protocol_whitelist") + 1], "file");
      assert.equal(arguments_[arguments_.indexOf("-enable_drefs") + 1], "0");
      assert.equal(arguments_[arguments_.indexOf("-use_absolute_path") + 1], "0");
      return child;
    } }
  });
  let settled = false;
  const pending = mocked.validateVideoFile("/private/tmp/test.mp4", abort.signal);
  const checked = assert.rejects(pending, error => error.code === "UPLOAD_CANCELLED").then(() => { settled = true; });
  abort.abort();
  callback(Object.assign(new Error("private probe detail"), { code: "ABORT_ERR" }), "");
  await delay(5);
  assert.deepEqual(killSignals, ["SIGKILL"], "explicit escalation survives Node20 execFile clearing its internal timeout");
  assert.equal(settled, false);
  child.emit("close", null, "SIGKILL");
  await checked;
});

test("missing ffprobe fails the accepted background job safely and cleans its file", async () => {
  const previousPath = process.env.FFPROBE_PATH;
  process.env.FFPROBE_PATH = "/missing-polaris-test-ffprobe";
  const harness = createRouteHarness();
  harness.probe = validation.validateVideoFile;
  try {
    const response = await harness.route.POST(makeRequest());
    assert.equal(response.status, 202);
    await assert.rejects(harness.finishJobs(), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "FFPROBE_UNAVAILABLE");
      assert.match(error.message, /install ffprobe|FFPROBE_PATH/);
      assert.doesNotMatch(error.message, /missing-polaris-test|polaris-video-/);
      return true;
    });
    await harness.assertClean();
    assert.equal(harness.uploads.length, 0);
  } finally { process.env.FFPROBE_PATH = previousPath; }
});

test("migration and init agree on append-only registry, unique request key and idempotent column addition", () => {
  const migration = readFileSync(new URL("../deploy/mysql/migrations/2026-10-22-video-uploads.sql", import.meta.url), "utf8");
  const initialization = readFileSync(new URL("../deploy/mysql/init.sql", import.meta.url), "utf8");
  const tablePattern = /CREATE TABLE IF NOT EXISTS video_uploads \([\s\S]+?\) ENGINE=InnoDB;/;
  assert.equal(migration.match(tablePattern)[0], initialization.match(tablePattern)[0]);
  assert.match(migration, /UNIQUE KEY video_uploads_owner_request \(owner_user_id, request_id\)/);
  assert.match(migration, /information_schema\.columns[\s\S]+PREPARE migration_statement/);
  assert.match(migration, /GRANT SELECT, INSERT ON polaris_content_studio\.video_uploads/);
  assert.doesNotMatch(migration, /GRANT[^;]*(UPDATE|DELETE|ALTER)/);
});
