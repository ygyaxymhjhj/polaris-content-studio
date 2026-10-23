// Isolated only: synthetic SQL, private local files, no live database or network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { access, copyFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import vm from "node:vm";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const { NextRequest, NextResponse } = nativeRequire("next/server");
const originalEnvironment = process.env;
const originalFetch = globalThis.fetch;
const temporaryRoot = await mkdtemp("/tmp/polaris-processing-test-");
const ffmpegPath = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "/opt/homebrew/bin/ffprobe";
process.env = { TMPDIR: "/tmp", FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath };
globalThis.fetch = async () => { throw new Error("Live network access is forbidden in isolated video processing tests."); };
after(async () => { process.env = originalEnvironment; globalThis.fetch = originalFetch; await rm(temporaryRoot, { recursive: true, force: true }); });
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
const jobId = "11111111-1111-4111-8111-111111111111";
const video = { id: jobId, name: "video.mp4", bytes: 3, width: 64, height: 64, durationSeconds: 1 };

test("client job guard validates states, phases, success media and rejects media on cancelled jobs", () => {
  for (const state of ["queued", "running", "failed", "cancelled"]) {
    assert.equal(videoTypes.isVideoProcessingResponse({ job: { id: jobId, state, phase: "validating" } }), true);
  }
  assert.equal(videoTypes.isVideoProcessingResponse({ job: { id: jobId, state: "succeeded", phase: "saving", video } }), true);
  for (const job of [
    { id: "bad", state: "queued", phase: "validating" },
    { id: jobId, state: "unknown", phase: "validating" },
    { id: jobId, state: "running", phase: "unknown" },
    { id: jobId, state: "succeeded", phase: "saving" },
    { id: jobId, state: "succeeded", phase: "saving", video: { ...video, bytes: 0 } },
    { id: jobId, state: "cancelled", phase: "saving", video },
    { id: jobId, state: "failed", phase: "saving", error: { path: "/private/input" } }
  ]) assert.equal(videoTypes.isVideoProcessingResponse({ job }), false);
});

const validation = loadModule("../src/lib/video-validation.ts", { "./video-types": videoTypes });
const metadata = { width: 64, height: 64, durationSeconds: 1 };
const now = () => new Date().toISOString().slice(0, 23).replace("T", " ");

function createHarness() {
  delete globalThis.polarisVideoProcessing;
  process.env.VIDEO_PROCESSING_DIRECTORY = join(temporaryRoot, randomUUID());
  const harness = { jobs: [], receipts: [], queries: [], activeConnections: 0, normalizations: [], uploads: [], disabled: false,
    unknownCommit: false, failSuccessUpdate: false, expireBeforeSuccess: false, lockHeld: false, afterCallbacks: [], user: { id: "owner", role: "member" } };
  const pool = { getConnection: async () => {
    harness.activeConnections++;
    let snapshot = null;
    let released = false;
    const release = () => { if (!released) { released = true; harness.activeConnections--; } };
    const connection = {
      release,
      destroy() { if (snapshot) { harness.jobs = snapshot.jobs; harness.receipts = snapshot.receipts; snapshot = null; } harness.lockHeld = false; release(); },
      async execute(query, parameters = []) {
        assert.equal(released, false, "destroyed connections cannot execute late SQL");
        const statement = typeof query === "string" ? query : query.sql;
        if (typeof query !== "string") assert.equal(query.timeout, 5_000);
        const normalized = statement.replace(/\s+/g, " ").trim();
        harness.queries.push({ statement: normalized, parameters, transaction: Boolean(snapshot) });
        if (normalized === "START TRANSACTION") { assert.equal(snapshot, null); snapshot = structuredClone({ jobs: harness.jobs, receipts: harness.receipts }); return [{}]; }
        if (normalized === "COMMIT") {
          snapshot = null;
          if (harness.unknownCommit) { harness.unknownCommit = false; throw new Error("synthetic secret /private/unknown-commit"); }
          return [{}];
        }
        if (normalized === "ROLLBACK") { if (snapshot) { harness.jobs = snapshot.jobs; harness.receipts = snapshot.receipts; snapshot = null; } return [{}]; }
        if (normalized.includes("GET_LOCK")) { assert.equal(harness.lockHeld, false); harness.lockHeld = true; return [[{ acquired: 1 }]]; }
        if (normalized.includes("RELEASE_LOCK")) { harness.lockHeld = false; return [[{ released: 1 }]]; }
        if (normalized.startsWith("SELECT id FROM users")) return [harness.disabled ? [] : [{ id: parameters[0] }]];
        if (normalized.startsWith("SELECT COUNT")) {
          assert.equal(harness.lockHeld, true, "capacity count must hold the MySQL admission lock");
          const active = harness.jobs.filter(job => ["queued", "running"].includes(job.state));
          return [[{ total: active.length, ownerTotal: active.filter(job => job.owner_user_id === parameters[0]).length }]];
        }
        if (normalized.includes("FROM video_uploads")) return [structuredClone(harness.receipts.filter(receipt => receipt.ownerUserId === parameters[0]
          && (normalized.includes("request_id = ?") ? receipt.requestId === parameters[1] : receipt.id === parameters[1])))];
        if (normalized.startsWith("INSERT INTO video_uploads")) {
          assert.ok(snapshot, "ready receipt and job success must share a transaction");
          const [id, ownerUserId, requestId, checksum, postizMediaId, postizPath, name, bytes, width, height, durationSeconds] = parameters;
          const job = harness.jobs.find(job => job.owner_user_id === ownerUserId && job.request_id === requestId);
          assert.equal(job.state, "running");
          assert.ok(job.lease_token && job.lease_expires_at > now());
          const locks = harness.queries.filter(query => query.statement.includes("FOR UPDATE"));
          assert.equal(locks.at(-1).parameters[1], job.id);
          harness.receipts.push({ id, ownerUserId, requestId, checksum, postizMediaId, postizPath, name, bytes, width, height, durationSeconds });
          return [{ affectedRows: 1 }];
        }
        if (normalized.startsWith("INSERT INTO video_processing_jobs")) {
          const [id, owner_user_id, request_id, checksum, input_bytes, filename, created_at, updated_at] = parameters;
          assert.ok(snapshot && harness.lockHeld);
          harness.jobs.push({ id, owner_user_id, request_id, checksum, input_bytes, filename, state: "queued", phase: "validating",
            created_at, updated_at, video_media_id: null, error_code: null, error: null, lease_token: null, lease_expires_at: null, files_cleaned_at: null });
          return [{ affectedRows: 1 }];
        }
        if (normalized.startsWith("SELECT") && normalized.includes("FROM video_processing_jobs")) {
          let jobs = harness.jobs;
          if (normalized.includes("owner_user_id = ?")) jobs = jobs.filter(job => job.owner_user_id === parameters[0]
            && (normalized.includes("request_id = ?") ? job.request_id === parameters[1] : job.id === parameters[1]));
          else if (normalized.includes("WHERE id=?")) jobs = jobs.filter(job => job.id === parameters[0]);
          else if (normalized.includes("state='queued'")) jobs = jobs.filter(job => job.state === "queued").slice(0, 1);
          else if (normalized.includes("state='running'")) jobs = jobs.filter(job => job.state === "running" && job.lease_expires_at <= parameters[0]);
          else if (normalized.includes("files_cleaned_at IS NULL")) jobs = jobs.filter(job => ["succeeded", "failed", "cancelled"].includes(job.state)
            && !job.files_cleaned_at && job.updated_at < parameters[0] && (!job.lease_expires_at || job.lease_expires_at < parameters[1]));
          else assert.fail(`Unhandled job SELECT: ${normalized}`);
          return [structuredClone(jobs)];
        }
        if (normalized.startsWith("UPDATE video_processing_jobs")) {
          let identifier;
          let changes;
          let token;
          let deadline;
          if (normalized.includes("SET state='running'")) {
            const [lease_token, lease_expires_at, updated_at, id] = parameters;
            identifier = id; changes = { state: "running", lease_token, lease_expires_at, updated_at };
          } else if (normalized.includes("SET phase=?")) {
            const [phase, updated_at, id, lease, expiry] = parameters;
            identifier = id; token = lease; deadline = expiry; changes = { phase, updated_at };
          } else if (normalized.includes("SET state='cancelled'")) {
            identifier = parameters[1]; changes = { state: "cancelled", error_code: "PROCESSING_CANCELLED", error: "Video processing was cancelled.", updated_at: parameters[0] };
          } else if (normalized.includes("SET state='succeeded'")) {
            const [video_media_id, updated_at, id, lease, expiry] = parameters;
            identifier = id; token = lease; deadline = expiry;
            changes = { state: "succeeded", phase: "saving", video_media_id, updated_at, error_code: null, error: null };
            if (harness.failSuccessUpdate) throw new Error("synthetic secret /private/failed-success-update");
            if (harness.expireBeforeSuccess && lease) harness.jobs.find(job => job.id === id).lease_expires_at = "2000-01-01 00:00:00.000";
          } else if (normalized.includes("error_code='PROCESSING_INTERRUPTED'")) {
            identifier = parameters[1]; changes = { state: "failed", error_code: "PROCESSING_INTERRUPTED", updated_at: parameters[0] };
          } else if (normalized.includes("SET state='failed'")) {
            const [error_code, error, updated_at, id, lease, expiry] = parameters;
            identifier = id; token = lease; deadline = expiry; changes = { state: "failed", error_code, error, updated_at };
          } else if (normalized.includes("SET files_cleaned_at")) {
            identifier = parameters[1]; changes = { files_cleaned_at: parameters[0] };
          } else assert.fail(`Unhandled job UPDATE: ${normalized}`);
          const job = harness.jobs.find(job => job.id === identifier);
          if (!job || (token !== undefined && (job.state !== "running" || job.lease_token !== token || job.lease_expires_at <= deadline))) return [{ affectedRows: 0 }];
          Object.assign(job, changes);
          return [{ affectedRows: 1 }];
        }
        assert.fail(`Unexpected SQL: ${normalized}`);
      }
    };
    return connection;
  } };
  harness.storage = loadModule("../src/lib/video-uploads.ts", { "@/lib/project-db": { database: () => pool }, "./video-types": videoTypes });
  harness.normalize = async (inputPath, outputPath, signal, onConverting) => {
    assert.equal(harness.activeConnections, 0, "normalization holds no SQL connection");
    harness.normalizations.push({ inputPath, outputPath, signal });
    await onConverting();
    await copyFile(inputPath, outputPath);
    return { filePath: outputPath, metadata, bytes: (await stat(outputPath)).size, converted: true };
  };
  harness.upload = async (filePath, signal) => {
    assert.equal(harness.activeConnections, 0, "upstream upload holds no SQL connection");
    assert.equal(signal.aborted, false);
    harness.uploads.push({ filePath, bytes: await readFile(filePath) });
    return { id: "upstream-id", path: "https://media.example.test/video.mp4" };
  };
  const processingDependencies = {
    "./video-types": videoTypes, "./video-validation": validation, "./video-uploads": harness.storage,
    "./video-transcoding": { prepareCompatibleVideo: (...parameters) => harness.normalize(...parameters) },
    "./postiz": { uploadVideoFileToPostiz: (...parameters) => harness.upload(...parameters) }
  };
  harness.reload = () => { delete globalThis.polarisVideoProcessing; harness.processing = loadModule("../src/lib/video-processing.ts", processingDependencies); };
  harness.reload();
  harness.dependencies = {
    "next/server": { NextRequest, NextResponse, after: callback => { harness.afterCallbacks.push(callback); } },
    "@/lib/auth": { currentUser: async () => harness.user ? { user: harness.user } : null,
      unauthorized: () => NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
    "@/lib/project-db": { databaseConfigured: () => true }, "@/lib/same-origin": loadModule("../src/lib/same-origin.ts"),
    "@/lib/postiz": { getPostizConfig: () => ({}) }, "@/lib/video-types": videoTypes, "@/lib/video-validation": validation,
    "@/lib/video-uploads": harness.storage, "@/lib/video-processing": harness.processing,
    "@/lib/video-processing-scheduler": { wakeVideoProcessingWorker: () => harness.processing.processVideoProcessingJobs() }
  };
  harness.route = loadModule("../src/app/api/media/uploads/route.ts", harness.dependencies);
  harness.jobRoute = loadModule("../src/app/api/media/video-jobs/[jobId]/route.ts", harness.dependencies);
  harness.receive = async (bytes = Buffer.from([1, 2, 3]), requestId = randomUUID()) => {
    const input = await harness.processing.createVideoProcessingInput();
    await writeFile(input.partPath, bytes, { mode: 0o600 });
    await harness.processing.completeVideoProcessingInput(input.id);
    return { ...input, requestId, checksum: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, name: "video.mp4", ownerUserId: "owner" };
  };
  harness.enqueue = async (...parameters) => {
    const input = await harness.receive(...parameters);
    const result = await harness.processing.registerVideoProcessingJob(input, new AbortController().signal);
    return { input, result };
  };
  return harness;
}

const uploadRequest = (requestId = randomUUID(), body = Buffer.from([1, 2, 3])) => new NextRequest("https://polaris.test/api/media/uploads", {
  method: "POST", duplex: "half", body,
  headers: { origin: "https://polaris.test", "content-type": "video/mp4", "x-file-name": "video.mp4", "x-upload-request-id": requestId }
});
const context = id => ({ params: Promise.resolve({ jobId: id }) });

test("POST returns 202 after durable input/queue commit and never waits for permanently pending normalization", async () => {
  const harness = createHarness();
  harness.normalize = () => new Promise(() => {});
  const response = await harness.route.POST(uploadRequest());
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.ok(videoTypes.isVideoProcessingResponse(result));
  assert.equal(harness.jobs[0].id, result.job.id);
  const directory = join(process.env.VIDEO_PROCESSING_DIRECTORY, result.job.id);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, "input.mp4"))).mode & 0o777, 0o600);
  await assert.rejects(access(join(directory, "input.part")), { code: "ENOENT" });
  assert.equal(harness.afterCallbacks.length, 1);
  assert.equal(harness.normalizations.length, 0);
  assert.equal(harness.uploads.length, 0);
});

test("queued input survives module restart; normalization, upload, fenced receipt and success then clean both files", async () => {
  const harness = createHarness();
  const { input } = await harness.enqueue();
  harness.reload();
  assert.equal(await harness.processing.processVideoProcessingJobs(), 1);
  const job = await harness.processing.getVideoProcessingJob("owner", input.id, new AbortController().signal);
  assert.equal(job.state, "succeeded");
  assert.ok(videoTypes.isVideoProcessingResponse({ job }));
  assert.equal(harness.receipts.length, 1);
  assert.equal(harness.normalizations.length, 1);
  assert.equal(harness.uploads.length, 1);
  assert.equal(basename(harness.uploads[0].filePath), "output.mp4");
  await assert.rejects(access(input.directory), { code: "ENOENT" });
  assert.ok(harness.queries.some(query => query.statement.includes("SKIP LOCKED")));
});

test("same owner/request/hash replays queued job, changed hash conflicts; failed jobs release owner capacity", async () => {
  const harness = createHarness();
  const { input, result } = await harness.enqueue();
  const replay = await harness.enqueue(undefined, input.requestId);
  assert.deepEqual(replay.result, result);
  await assert.rejects(access(replay.input.directory), { code: "ENOENT" });
  await assert.rejects(harness.enqueue(Buffer.from([4]), input.requestId), harness.storage.VideoUploadRequestConflictError);
  await assert.rejects(harness.enqueue(), error => error.code === "UPLOAD_BUSY");
  harness.jobs[0].state = "failed";
  assert.equal((await harness.enqueue()).result.job.state, "queued");
  assert.equal(harness.jobs.length, 2);
});

test("admission is bounded globally at eight active jobs and serializes count/insert using GET_LOCK", async () => {
  const harness = createHarness();
  for (let index = 0; index < 8; index++) {
    const input = await harness.receive();
    input.ownerUserId = `owner-${index}`;
    await harness.processing.registerVideoProcessingJob(input, new AbortController().signal);
  }
  await assert.rejects(harness.enqueue(), error => error.code === "UPLOAD_BUSY");
  assert.equal(harness.jobs.length, 8);
  assert.equal(harness.lockHeld, false);
});

test("GET/DELETE require exact owner including admin, validate UUID, ignore path and never run upstream work", async () => {
  const harness = createHarness();
  const { input } = await harness.enqueue();
  const request = new NextRequest(`https://polaris.test/api/media/video-jobs/${input.id}?path=/etc/passwd`);
  const found = await harness.jobRoute.GET(request, context(input.id));
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("cache-control"), "no-store");
  harness.user = { id: "another-admin", role: "admin" };
  assert.equal((await harness.jobRoute.GET(request, context(input.id))).status, 404);
  assert.equal((await harness.jobRoute.DELETE(new NextRequest(request.url, { method: "DELETE", headers: { origin: "https://polaris.test" } }), context(input.id))).status, 404);
  assert.equal((await harness.jobRoute.GET(request, context("invalid"))).status, 404);
  harness.user = { id: "owner", role: "member" };
  assert.equal((await harness.jobRoute.DELETE(new NextRequest(request.url, { method: "DELETE", headers: { origin: "https://attacker.test" } }), context(input.id))).status, 403);
  const cancelled = await harness.jobRoute.DELETE(new NextRequest(request.url, { method: "DELETE", headers: { origin: "https://polaris.test" } }), context(input.id));
  assert.equal((await cancelled.json()).job.state, "cancelled");
  await assert.rejects(access(input.directory), { code: "ENOENT" }, "queued cancellation cannot accumulate large unused inputs");
  harness.user = null;
  assert.equal((await harness.jobRoute.GET(request, context(input.id))).status, 401);
  assert.equal(harness.uploads.length, 0);
  assert.equal(harness.normalizations.length, 0);
});

test("cancelled running job waits for late upstream settlement, creates no receipt and cannot replay media", async () => {
  const harness = createHarness();
  const { input } = await harness.enqueue();
  let finishUpload;
  let startedUpload;
  const started = new Promise(resolve => { startedUpload = resolve; });
  harness.upload = async filePath => {
    startedUpload(filePath);
    return new Promise(resolve => { finishUpload = () => resolve({ id: "late-media", path: "https://media.example.test/late.mp4" }); });
  };
  const processing = harness.processing.processVideoProcessingJobs();
  const filePath = await started;
  await harness.processing.cancelVideoProcessingJob("owner", input.id, new AbortController().signal);
  await delay(10);
  await access(filePath);
  await access(input.inputPath);
  assert.equal(harness.receipts.length, 0);
  finishUpload();
  await processing;
  assert.equal(harness.jobs[0].state, "cancelled");
  assert.equal(harness.receipts.length, 0);
  await assert.rejects(access(input.directory), { code: "ENOENT" });
  assert.equal((await harness.enqueue(undefined, input.requestId)).result.job.state, "cancelled");
});

test("expired running work without a receipt becomes interrupted, never auto-reuploads; receipt recovery skips normalization", async () => {
  for (const hasReceipt of [false, true]) {
    const harness = createHarness();
    const { input } = await harness.enqueue();
    Object.assign(harness.jobs[0], { state: "running", lease_token: randomUUID(), lease_expires_at: "2000-01-01 00:00:00.000" });
    if (hasReceipt) harness.receipts.push({ ...video, id: randomUUID(), ownerUserId: "owner", requestId: input.requestId,
      checksum: input.checksum, postizMediaId: "existing-upstream", postizPath: "https://media.example.test/existing.mp4" });
    await harness.processing.processVideoProcessingJobs();
    assert.equal(harness.jobs[0].state, hasReceipt ? "succeeded" : "failed");
    if (!hasReceipt) assert.equal(harness.jobs[0].error_code, "PROCESSING_INTERRUPTED");
    assert.equal(harness.normalizations.length, 0);
    assert.equal(harness.uploads.length, 0);
  }
});

test("ready receipt INSERT rolls back with failed job success UPDATE", async () => {
  const harness = createHarness();
  await harness.enqueue();
  harness.failSuccessUpdate = true;
  await harness.processing.processVideoProcessingJobs();
  assert.equal(harness.jobs[0].state, "failed");
  assert.equal(harness.receipts.length, 0);
});

test("late worker with changed token or expired deadline cannot insert ready receipt", async () => {
  for (const loss of ["token", "deadline", "deadline-after-insert"]) {
    const harness = createHarness();
    await harness.enqueue();
    const originalUpload = harness.upload;
    harness.upload = async (...parameters) => {
      const result = await originalUpload(...parameters);
      if (loss === "token") harness.jobs[0].lease_token = randomUUID();
      if (loss === "deadline") harness.jobs[0].lease_expires_at = "2000-01-01 00:00:00.000";
      if (loss === "deadline-after-insert") harness.expireBeforeSuccess = true;
      return result;
    };
    await harness.processing.processVideoProcessingJobs();
    assert.equal(harness.receipts.length, 0, `receipt must be fenced after ${loss}`);
    assert.notEqual(harness.jobs[0].state, "succeeded");
  }
});

test("uncertain job commit keeps the source and committed queue, then restart safely resumes it", async () => {
  const harness = createHarness();
  const input = await harness.receive();
  harness.unknownCommit = true;
  await assert.rejects(harness.processing.registerVideoProcessingJob(input, new AbortController().signal));
  await access(input.inputPath);
  assert.equal(harness.jobs.length, 1);
  harness.reload();
  await harness.processing.processVideoProcessingJobs();
  assert.equal(harness.jobs[0].state, "succeeded");
});

test("uncertain ready commit recovers the joint receipt/success without another upstream upload", async () => {
  const harness = createHarness();
  await harness.enqueue();
  const upload = harness.upload;
  harness.upload = async (...parameters) => {
    const result = await upload(...parameters);
    harness.unknownCommit = true;
    return result;
  };
  await harness.processing.processVideoProcessingJobs();
  assert.equal(harness.jobs[0].state, "succeeded");
  assert.equal(harness.receipts.length, 1);
  harness.reload();
  assert.equal(await harness.processing.processVideoProcessingJobs(), 0);
  assert.equal(harness.uploads.length, 1);
});

test("changed source checksum and a disabled queued owner fail safely before normalize/upload", async () => {
  for (const failure of ["checksum", "disabled"]) {
    const harness = createHarness();
    const { input } = await harness.enqueue();
    if (failure === "checksum") await writeFile(input.inputPath, Buffer.from([4, 5, 6]));
    else harness.disabled = true;
    await harness.processing.processVideoProcessingJobs();
    assert.equal(harness.jobs[0].state, "failed");
    assert.equal(harness.uploads.length, 0);
    assert.equal(harness.normalizations.length, 0);
    assert.doesNotMatch(JSON.stringify(await harness.processing.getVideoProcessingJob("owner", input.id, new AbortController().signal)), /secret|\/private\//);
    await assert.rejects(access(input.directory), { code: "ENOENT" });
  }
});

test("a normalization failure cleans partial output; an unexpected output path never reaches Postiz", async () => {
  for (const failure of ["partial", "path"]) {
    const harness = createHarness();
    const { input } = await harness.enqueue();
    harness.normalize = async (_inputPath, outputPath) => {
      await writeFile(outputPath, "partial", { mode: 0o600 });
      if (failure === "partial") throw new Error("secret decoder stderr /private/path");
      return { filePath: "/etc/passwd", metadata, bytes: 7, converted: true };
    };
    await harness.processing.processVideoProcessingJobs();
    assert.equal(harness.jobs[0].state, "failed");
    assert.equal(harness.uploads.length, 0);
    assert.equal(harness.receipts.length, 0);
    await assert.rejects(access(input.directory), { code: "ENOENT" });
    assert.doesNotMatch(harness.jobs[0].error, /secret|stderr|\/private/);
  }
});

test("orphan reconciliation removes only old UUID directories without a database reference", async () => {
  const harness = createHarness();
  const orphan = await harness.receive();
  const referenced = await harness.enqueue();
  const recent = await harness.receive();
  const old = new Date(Date.now() - 48 * 60 * 60_000);
  await utimes(orphan.directory, old, old);
  await utimes(referenced.input.directory, old, old);
  harness.jobs[0].state = "cancelled";
  await harness.processing.processVideoProcessingJobs();
  await assert.rejects(access(orphan.directory), { code: "ENOENT" });
  await access(referenced.input.inputPath);
  await access(recent.inputPath);
});

test("real tiny AV1 MP4 normalizes to H264 and flows through durable worker with only mocked Postiz", async () => {
  const harness = createHarness();
  const fixture = join(temporaryRoot, "tiny-av1.mp4");
  execFileSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.2:r=5", "-c:v", "libsvtav1", "-preset", "12", "-svtav1-params", "lp=1", "-threads", "1", "-y", fixture], { stdio: "pipe" });
  const transcoding = loadModule("../src/lib/video-transcoding.ts", { "./video-types": videoTypes, "./video-validation": validation });
  harness.normalize = transcoding.prepareCompatibleVideo;
  await harness.enqueue(await readFile(fixture));
  await harness.processing.processVideoProcessingJobs();
  assert.equal(harness.jobs[0].state, "succeeded");
  assert.equal(harness.receipts.length, 1);
  assert.equal(harness.uploads.length, 1);
  const uploadedFixture = join(temporaryRoot, "uploaded-h264.mp4");
  await writeFile(uploadedFixture, harness.uploads[0].bytes);
  assert.equal((await validation.validateVideoFile(uploadedFixture)).width, 64);
});

test("processing schema is identical in init/migration and retains append-only ready permissions", () => {
  const migration = readFileSync(new URL("../deploy/mysql/migrations/2026-10-22-video-processing.sql", import.meta.url), "utf8");
  const initialization = readFileSync(new URL("../deploy/mysql/init.sql", import.meta.url), "utf8");
  const tablePattern = /CREATE TABLE IF NOT EXISTS video_processing_jobs \([\s\S]+?\) ENGINE=InnoDB;/;
  assert.equal(migration.match(tablePattern)[0], initialization.match(tablePattern)[0]);
  assert.match(migration, /UNIQUE KEY video_processing_owner_request \(owner_user_id, request_id\)/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.video_processing_jobs/);
  assert.doesNotMatch(migration, /GRANT[^;]*(DELETE|ALTER)/);
  assert.ok(initialization.indexOf("GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.video_processing_jobs") > initialization.indexOf("REVOKE ALL PRIVILEGES"));
  const service = readFileSync(new URL("../deploy/polaris-studio.service", import.meta.url), "utf8");
  assert.match(service, /StateDirectory=polaris-content-studio\/video-processing/);
  assert.match(service, /VIDEO_PROCESSING_DIRECTORY=\/var\/lib\/polaris-content-studio\/video-processing/);
  assert.match(service, /StateDirectoryMode=0700/);
});

function createSchedulerFixture(environment = {}) {
  const timers = new Map();
  const processMock = new EventEmitter();
  processMock.env = { NODE_ENV: "production", NEXT_RUNTIME: "nodejs", SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED: "false", ...environment };
  let implementation = async () => 0;
  let calls = 0;
  const context = vm.createContext({
    process: processMock, console: { warn() {} },
    setTimeout(callback, milliseconds) { const timer = { unref() {} }; timers.set(timer, { callback, milliseconds }); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  function load(relativePath, dependencies) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const { outputText } = typescript.transpileModule(source, {
      compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
    });
    const exports = {};
    vm.runInContext(`(function(require, exports) { ${outputText}\n })`, context)(specifier => {
      assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected dependency ${specifier}`);
      return dependencies[specifier];
    }, exports);
    return exports;
  }
  const scheduler = load("../src/lib/video-processing-scheduler.ts", {
    "./project-db": { databaseConfigured: () => true },
    "./video-processing": { processVideoProcessingJobs: () => { calls++; return implementation(); } }
  });
  const instrumentation = load("../src/instrumentation.ts", {
    "./lib/video-processing-scheduler": scheduler,
    "./lib/draft-submission-scheduler": { startDraftSubmissionScheduler() {} },
    "./lib/social-notification-scheduler": { startSocialNotificationScheduler() { throw new Error("Notifications must remain independent"); } }
  });
  return { scheduler, instrumentation, timers, processMock, setImplementation(callback) { implementation = callback; }, get calls() { return calls; } };
}

test("production video scheduler starts independently from notifications; dev opt-in, build and Vercel gates are explicit", async () => {
  for (const [environment, expected] of [
    [{}, 1], [{ NODE_ENV: "development" }, 0], [{ NODE_ENV: "development", VIDEO_PROCESSING_SCHEDULER_ENABLED: "true" }, 1],
    [{ VIDEO_PROCESSING_SCHEDULER_ENABLED: "false" }, 0], [{ NEXT_PHASE: "phase-production-build" }, 0],
    [{ VERCEL: "1" }, 0], [{ NEXT_RUNTIME: "edge" }, 0]
  ]) {
    const fixture = createSchedulerFixture(environment);
    await fixture.instrumentation.register();
    fixture.scheduler.startVideoProcessingScheduler();
    assert.equal(fixture.timers.size, expected);
    fixture.scheduler.stopVideoProcessingScheduler();
  }
});

test("after wake drains sequentially in dev without opt-in and coalesces overlapping wakeups", async () => {
  const fixture = createSchedulerFixture({ NODE_ENV: "development" });
  let finishFirst;
  fixture.setImplementation(() => fixture.calls === 1 ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve(fixture.calls < 4 ? 1 : 0));
  const pending = fixture.scheduler.wakeVideoProcessingWorker();
  assert.equal(fixture.scheduler.wakeVideoProcessingWorker(), pending);
  assert.equal(fixture.calls, 1);
  finishFirst(1);
  await pending;
  assert.equal(fixture.calls, 4);
  assert.equal(fixture.timers.size, 0);
});
