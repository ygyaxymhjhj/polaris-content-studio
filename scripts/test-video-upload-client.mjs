// Exercise the production client and runtime guards with deterministic XHR, fetch and clocks.
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const video = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'sample.mp4', bytes: 10,
  width: 64, height: 64, durationSeconds: 1 };
const firstJobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secondJobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const createJob = (state = 'queued', phase = 'validating', extra = {}) => ({ id: firstJobId, state, phase, ...extra });
const sample = new File(['sample-mp4'], 'sample.mp4', { type: 'video/mp4' });
const flushMicrotasks = async () => { for (let turn = 0; turn < 30; turn += 1) await Promise.resolve(); };

function createEnvironment() {
  let currentTime = 0;
  let timerSequence = 0;
  const timers = new Map();
  const uploads = [];
  const reads = [];
  const deletes = [];
  const responses = [];
  let deleteResponse;
  class MockRequest {
    constructor() { this.upload = {}; this.headers = {}; uploads.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(file) { this.file = file; }
    abort() { this.aborted = true; this.onabort?.(); }
    transfer() { this.upload.onload?.(); }
    respond(status, body) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
  }
  const context = vm.createContext({
    XMLHttpRequest: MockRequest, AbortController, DOMException, crypto: webcrypto,
    Date: class extends Date { static now() { return currentTime; } },
    setTimeout(callback, milliseconds) { const identifier = ++timerSequence; timers.set(identifier, { callback, at: currentTime + milliseconds }); return identifier; },
    clearTimeout(identifier) { timers.delete(identifier); },
    fetch: async (url, options) => {
      if (options.method === 'DELETE') {
        deletes.push({ url, options });
        if (deleteResponse) return deleteResponse(options);
        return new Response(JSON.stringify({ job: createJob('cancelled') }));
      }
      reads.push({ url, options, at: currentTime });
      const response = responses.shift();
      assert.ok(response, 'Every GET must have an explicitly controlled response');
      return typeof response === 'function' ? response(options) : response;
    }
  });
  const modules = new Map();
  function loadModule(modulePath) {
    if (modules.has(modulePath)) return modules.get(modulePath).exports;
    const moduleRecord = { exports: {} };
    modules.set(modulePath, moduleRecord);
    const require = dependency => {
      if (!dependency.startsWith('.')) return createRequire(modulePath)(dependency);
      const basePath = resolve(dirname(modulePath), dependency);
      return loadModule(existsSync(`${basePath}.ts`) ? `${basePath}.ts` : basePath);
    };
    const compiled = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    vm.runInContext(`(function(require, module, exports) { ${compiled}\n})`, context)(require, moduleRecord, moduleRecord.exports);
    return moduleRecord.exports;
  }
  const client = loadModule(resolve(repository, 'src/lib/video-upload-client.ts'));
  return {
    ...client, uploads, reads, deletes, responses, timers,
    holdDelete() {
      deleteResponse = options => new Promise((resolveDelete, rejectDelete) => {
        options.signal.addEventListener('abort', () => rejectDelete(new DOMException('Timeout', 'AbortError')), { once: true });
      });
    },
    async advance(milliseconds) {
      const targetTime = currentTime + milliseconds;
      await flushMicrotasks();
      while (true) {
        const nextTimer = [...timers].filter(([, timer]) => timer.at <= targetTime).sort((first, second) => first[1].at - second[1].at)[0];
        if (!nextTimer) break;
        currentTime = nextTimer[1].at;
        timers.delete(nextTimer[0]);
        nextTimer[1].callback();
        await flushMicrotasks();
      }
      currentTime = targetTime;
      await flushMicrotasks();
    }
  };
}

function startUpload(environment, controller = new AbortController()) {
  const phases = [];
  const progress = [];
  let result;
  const completion = environment.uploadVideo(sample, controller.signal, percent => progress.push(percent), phase => phases.push(phase))
    .then(value => { result = { video: value }; }, error => { result = { error }; });
  return { controller, phases, progress, completion, get result() { return result; } };
}

for (const status of [200, 201]) {
  const environment = createEnvironment();
  const upload = startUpload(environment);
  const request = environment.uploads[0];
  assert.equal(request.file, sample, 'Original raw File is the upload body');
  assert.equal(request.headers['Content-Type'], 'video/mp4');
  assert.match(request.headers['X-Upload-Request-Id'], /^[a-f0-9-]{36}$/);
  request.respond(status, { video });
  await upload.completion;
  assert.equal(upload.result.video.id, video.id);
  assert.equal(environment.reads.length, 0, 'Successful receipt replay never polls or reuploads');
}

for (const code of ['UNKNOWN_FAILURE', '__proto__', 'toString']) {
  const environment = createEnvironment();
  const upload = startUpload(environment);
  environment.uploads[0].respond(500, { code, error: '/private/server ffmpeg stderr' });
  await upload.completion;
  assert.equal(upload.result.error.message, 'Could not upload this video. Please try again.', 'Unknown error codes cannot reveal server output or inherited object members');
}

for (const state of ['succeeded', 'failed', 'cancelled']) {
  const environment = createEnvironment();
  const upload = startUpload(environment);
  environment.uploads[0].respond(202, { job: createJob(state, 'saving', state === 'succeeded' ? { video } : {}) });
  await upload.completion;
  assert.equal(environment.reads.length, 0, 'A terminal POST job is never polled');
  if (state === 'succeeded') assert.equal(upload.result.video.id, video.id);
  else assert.ok(upload.result.error);
}

{
  const environment = createEnvironment();
  const controller = new AbortController();
  controller.abort();
  const upload = startUpload(environment, controller);
  await upload.completion;
  assert.equal(upload.result.error.name, 'AbortError');
  assert.equal(environment.uploads[0].file, undefined, 'Already-aborted sessions never send a file');
  assert.equal(environment.deletes.length, 0);
}

{
  const environment = createEnvironment();
  const upload = startUpload(environment);
  environment.holdDelete();
  environment.uploads[0].respond(202, { job: createJob() });
  upload.controller.abort();
  await upload.completion;
  assert.equal(environment.deletes[0].options.signal.aborted, false, 'DELETE does not reuse the cancelled session signal');
  await environment.advance(15_000);
  assert.equal(environment.deletes[0].options.signal.aborted, true, 'DELETE has its own 15 second bound');
  assert.equal(environment.timers.size, 0);
}

{
  const environment = createEnvironment();
  const upload = startUpload(environment);
  environment.uploads[0].transfer();
  assert.deepEqual(upload.progress, [100]);
  assert.equal(upload.result, undefined, 'Transport completion is not processing completion');
  environment.responses.push(...['validating', 'converting', 'saving'].map(phase => Response.json({ job: createJob('running', phase) })),
    Response.json({ job: createJob('succeeded', 'saving', { video }) }));
  environment.uploads[0].respond(202, { job: createJob() });
  await flushMicrotasks();
  assert.equal(upload.result, undefined, 'POST 202 must not resolve with unfinished media');
  assert.deepEqual(upload.phases, ['queued']);
  await environment.advance(8000);
  await upload.completion;
  assert.equal(upload.result.video.id, video.id);
  assert.deepEqual(upload.phases, ['queued', 'validating', 'converting', 'saving']);
  assert.equal(environment.uploads.length, 1);
  for (const read of environment.reads) {
    assert.equal(read.url, `/api/media/video-jobs/${firstJobId}`);
    assert.equal(read.options.cache, 'no-store');
    assert.equal(read.options.credentials, 'same-origin');
  }
  assert.deepEqual(environment.reads.map(read => read.at), [2000, 4000, 6000, 8000]);
  assert.equal(environment.timers.size, 0, 'Successful polling releases all timers');
}

{
  const environment = createEnvironment();
  const upload = startUpload(environment);
  environment.responses.push(Response.json({ job: createJob('running', 'validating') }),
    Response.json({ job: createJob('running', 'saving') }), Response.json({ job: createJob('succeeded', 'saving', { video }) }));
  environment.uploads[0].respond(202, { job: createJob() });
  await environment.advance(6000);
  await upload.completion;
  assert.equal(upload.result.video.id, video.id);
  assert.equal(upload.phases.includes('converting'), false, 'Compatible MP4 jobs never claim that conversion is occurring');
}

{
  const environment = createEnvironment();
  const upload = startUpload(environment);
  let releaseRead;
  environment.responses.push(() => new Promise(resolveRead => { releaseRead = resolveRead; }));
  environment.uploads[0].respond(202, { job: createJob() });
  await environment.advance(2000);
  upload.controller.abort();
  await upload.completion;
  assert.equal(upload.result.error.name, 'AbortError');
  assert.equal(environment.reads[0].options.signal.aborted, true);
  assert.equal(environment.deletes.length, 1);
  assert.equal(environment.deletes[0].url, `/api/media/video-jobs/${firstJobId}`);
  assert.notEqual(environment.deletes[0].options.signal, upload.controller.signal, 'DELETE owns a fresh bounded signal');
  const replacement = startUpload(environment);
  environment.uploads[1].respond(202, { job: createJob('queued', 'validating', { id: secondJobId }) });
  releaseRead(Response.json({ job: createJob('succeeded', 'saving', { video }) }));
  await flushMicrotasks();
  assert.equal(replacement.result, undefined, 'Late old GET cannot finish the replacement upload');
  replacement.controller.abort();
  await replacement.completion;
  assert.deepEqual(environment.deletes.map(request => request.url), [firstJobId, secondJobId].map(identifier => `/api/media/video-jobs/${identifier}`));
  await environment.advance(30_000);
  assert.equal(environment.reads.length, 1, 'Cancellation stops every pending poll timer');
}

for (const state of ['failed', 'cancelled']) {
  const environment = createEnvironment();
  const upload = startUpload(environment);
  environment.responses.push(Response.json({ job: createJob(state, 'converting', { code: 'VIDEO_CONVERSION_FAILED', error: '/private/server ffmpeg stderr' }) }));
  environment.uploads[0].respond(202, { job: createJob() });
  await environment.advance(2000);
  await upload.completion;
  assert.ok(upload.result.error);
  assert.doesNotMatch(upload.result.error.message, /private|stderr/);
  if (state === 'cancelled') assert.equal(upload.result.error.name, 'AbortError');
  assert.equal(environment.deletes.length, 0, 'Server terminal state does not trigger implicit deletion');
}

for (const response of [{ job: createJob('succeeded') }, { job: createJob('running', 'rogue') },
  { job: createJob('unknown') }, { job: createJob(['running']) }, { job: createJob('running', ['converting']) },
  { job: { ...createJob(), id: '../private' } }, { job: null }]) {
  const environment = createEnvironment();
  const upload = startUpload(environment);
  environment.uploads[0].respond(202, response);
  await upload.completion;
  assert.ok(upload.result.error, 'Malformed POST jobs never become successful attachments');
  assert.equal(environment.reads.length, 0);
}

for (const status of [401, 404, 503]) {
  const environment = createEnvironment();
  const upload = startUpload(environment);
  for (let attempt = 0; attempt < 4; attempt += 1) environment.responses.push(new Response('/private/server stderr', { status }));
  environment.uploads[0].respond(202, { job: createJob() });
  await environment.advance(8000);
  await upload.completion;
  assert.ok(upload.result.error instanceof environment.VideoProcessingStatusError);
  assert.equal(upload.result.error.job.id, firstJobId, 'Unconfirmed status retains the known job receipt');
  assert.match(upload.result.error.message, /may still be running/);
  assert.doesNotMatch(upload.result.error.message, /private|stderr|convert.*failed/i);
  assert.equal(environment.reads.length, status === 503 ? 4 : 1, 'Only transient GET failures are retried, with a finite budget');
  assert.ok(environment.reads.every(read => read.options.signal.aborted), 'Failed HTTP reads do not leave response streams running after cleanup');
  assert.equal(environment.uploads.length, 1, 'Polling failure never resends raw media');
  upload.controller.abort();
  assert.equal(environment.deletes.length, 0, 'GET failure and subsequent cleanup do not secretly cancel a background job');
}

{
  const environment = createEnvironment();
  const upload = startUpload(environment);
  environment.responses.push(() => { throw new TypeError('offline'); },
    new Response('', { status: 503 }), Response.json({ job: createJob('succeeded', 'saving', { video }) }));
  environment.uploads[0].respond(202, { job: createJob() });
  await environment.advance(6000);
  await upload.completion;
  assert.equal(upload.result.video.id, video.id);
  assert.equal(environment.deletes.length, 0);
}

{
  const environment = createEnvironment();
  const upload = startUpload(environment);
  environment.responses.push(Response.json({ job: createJob('succeeded', 'saving', { video, id: secondJobId }) }));
  environment.uploads[0].respond(202, { job: createJob() });
  await environment.advance(2000);
  await upload.completion;
  assert.ok(upload.result.error, 'A GET cannot silently switch to another job id');
}

{
  const environment = createEnvironment();
  const upload = startUpload(environment);
  for (let attempt = 0; attempt < 4; attempt += 1) environment.responses.push(options => new Promise((resolveRead, rejectRead) => {
    options.signal.addEventListener('abort', () => rejectRead(new DOMException('Timeout', 'AbortError')), { once: true });
  }));
  environment.uploads[0].respond(202, { job: createJob() });
  await environment.advance(68_000);
  await upload.completion;
  assert.ok(upload.result.error instanceof environment.VideoProcessingStatusError);
  assert.equal(environment.reads.length, 4, 'Each held GET times out after 15 seconds and retries are bounded');
  assert.equal(environment.deletes.length, 0);
}

{
  const environment = createEnvironment();
  const upload = startUpload(environment);
  for (let attempt = 0; attempt < 600; attempt += 1) environment.responses.push(Response.json({ job: createJob('running', 'converting') }));
  environment.uploads[0].respond(202, { job: createJob() });
  await environment.advance(20 * 60_000);
  await upload.completion;
  assert.ok(upload.result.error instanceof environment.VideoProcessingStatusError);
  assert.match(upload.result.error.message, /longer than expected/);
  assert.equal(environment.deletes.length, 0, 'Overall deadline does not cancel an unconfirmed background job');
  assert.equal(environment.timers.size, 0);
}

{
  const environment = createEnvironment();
  const upload = startUpload(environment);
  const requestId = environment.uploads[0].headers['X-Upload-Request-Id'];
  for (let attempt = 0; attempt < 4; attempt += 1) environment.responses.push(new Response('', { status: 503 }));
  environment.uploads[0].respond(202, { job: createJob() });
  await environment.advance(8000);
  await upload.completion;
  assert.ok(upload.result.error instanceof environment.VideoProcessingStatusError);
  environment.responses.push(Response.json({ job: createJob('succeeded', 'saving', { video }) }));
  const resumed = environment.resumeVideoProcessing(upload.result.error.job, new AbortController().signal);
  await environment.advance(2000);
  assert.equal((await resumed).id, video.id);
  assert.equal(environment.uploads.length, 1, 'Retrying status never sends another raw POST');
  assert.equal(environment.uploads[0].headers['X-Upload-Request-Id'], requestId);
  assert.ok(environment.reads.every(read => read.url.endsWith(firstJobId)), 'Recovery reads exactly the original job');
}

for (const lateOutcome of ['success', 'failure']) {
  const environment = createEnvironment();
  const controller = new AbortController();
  let releaseRead;
  environment.responses.push(() => new Promise(resolveRead => { releaseRead = resolveRead; }));
  const resumed = environment.resumeVideoProcessing(createJob(), controller.signal).catch(error => error);
  await environment.advance(2000);
  controller.abort();
  assert.equal((await resumed).name, 'AbortError');
  const replacement = startUpload(environment);
  releaseRead(lateOutcome === 'success' ? Response.json({ job: createJob('succeeded', 'saving', { video }) }) : new Response('', { status: 503 }));
  await flushMicrotasks();
  assert.equal(replacement.result, undefined, 'Old recovery results cannot finish another upload');
  assert.deepEqual(environment.deletes.map(request => request.url), [`/api/media/video-jobs/${firstJobId}`]);
  environment.uploads[0].respond(201, { video });
  await replacement.completion;
  assert.equal(replacement.result.video.id, video.id);
  assert.equal(environment.timers.size, 0);
}

console.log('PASS: receipt replay, raw File/client id, phase polling, strict guards, abort isolation/DELETE, safe errors, GET retry/15s timeout/20m deadline, same-job recovery without POST and stale recovery fencing.');
