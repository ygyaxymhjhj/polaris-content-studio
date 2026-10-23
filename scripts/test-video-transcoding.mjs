// Local-only fixtures and process doubles. No environment files, network, database or live uploads.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { access, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const ffmpegPath = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "/opt/homebrew/bin/ffprobe";
const previousEnvironment = process.env;
const originalFetch = globalThis.fetch;
process.env = { TMPDIR: "/tmp", FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath };
globalThis.fetch = async () => { throw new Error("Network access is forbidden in this test."); };
after(() => { process.env = previousEnvironment; globalThis.fetch = originalFetch; });

function loadModule(relativePath, dependencies = {}, bindings = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(bindings), outputText)(
    dependency => dependencies[dependency] ?? nativeRequire(dependency), compiled, compiled.exports, ...Object.values(bindings)
  );
  return compiled.exports;
}

const videoTypes = loadModule("../src/lib/video-types.ts");
const validation = loadModule("../src/lib/video-validation.ts", { "./video-types": videoTypes });
const conversions = [];
const transcoding = loadModule("../src/lib/video-transcoding.ts", {
  "./video-types": videoTypes, "./video-validation": validation,
  "node:child_process": { execFile: (binary, arguments_, options, callback) => {
    conversions.push(arguments_);
    return execFile(binary, arguments_, options, callback);
  } }
});

function generate(outputPath, { codec = "libx264", audio = "aac", size = "64x48", rate = "24", pixels = "yuv420p", extra = [] } = {}) {
  const arguments_ = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-threads", "2",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}`];
  if (audio) arguments_.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100");
  arguments_.push("-t", "0.6", "-c:v", codec, "-threads", "2", "-pix_fmt", pixels);
  if (codec === "libsvtav1") arguments_.push("-preset", "12", "-svtav1-params", "lp=2");
  if (codec === "libx265") arguments_.push("-x265-params", "pools=none:frame-threads=1:log-level=error");
  if (audio) arguments_.push("-c:a", audio);
  arguments_.push(...extra, outputPath);
  execFileSync(ffmpegPath, arguments_, { timeout: 20_000, stdio: "pipe" });
}

function probe(filePath) {
  return JSON.parse(execFileSync(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
    { timeout: 15_000, encoding: "utf8" }));
}

function packetHashes(filePath, selector) {
  return JSON.parse(execFileSync(ffprobePath, ["-v", "error", "-select_streams", selector, "-show_packets", "-show_data_hash", "sha256",
    "-show_entries", "packet=data_hash", "-of", "json", filePath], { timeout: 15_000, encoding: "utf8" })).packets.map(packet => packet.data_hash);
}

function assertSafe(error) {
  assert.doesNotMatch(error.message, /\/private\/|\/tmp\/|synthetic-secret|decoder private detail|missing-polaris/);
  return true;
}

function assertBoundedArguments(arguments_) {
  const option = name => arguments_[arguments_.indexOf(name) + 1];
  for (const flag of ["-nostdin", "-n", "-xerror"]) assert.ok(arguments_.includes(flag));
  assert.equal(option("-protocol_whitelist"), "file");
  assert.equal(option("-enable_drefs"), "0");
  assert.equal(option("-use_absolute_path"), "0");
  assert.equal(option("-f"), "mov");
  assert.equal(option("-fs"), String(videoTypes.MAX_VIDEO_UPLOAD_BYTES));
  assert.equal(option("-filter_threads"), "2");
  assert.equal(option("-filter_complex_threads"), "2");
  assert.equal(option("-threads"), "2");
  assert.ok(!arguments_.includes("-autorotate") && !arguments_.includes("-noautorotate"),
    "use enabled-by-default autorotation without version-dependent boolean syntax");
  assert.equal(option("-movflags"), "+faststart");
  assert.equal(option("-map_metadata"), "-1");
  assert.equal(option("-map_metadata:s"), "-1");
  assert.equal(option("-map_chapters"), "-1");
  assert.ok(!arguments_.includes("-shortest"), "the pipeline must not silently truncate to a shorter stream");
}

async function withFixtures(run) {
  const directory = await mkdtemp("/tmp/polaris-transcoding-");
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("H264/AAC and silent compatible MP4s return the original bytes without ffmpeg or an output file", async () => {
  await withFixtures(async directory => {
    for (const audio of ["aac", null]) {
      const source = join(directory, `${audio || "silent"}.mp4`);
      const output = join(directory, `${audio || "silent"}-output.mp4`);
      generate(source, { audio });
      const bytes = await readFile(source);
      const previousConversions = conversions.length;
      let notices = 0;
      const result = await transcoding.prepareCompatibleVideo(source, output, new AbortController().signal, async () => { notices++; });
      assert.equal(result.converted, false);
      assert.equal(result.filePath, source);
      assert.equal(result.bytes, bytes.length);
      assert.equal(notices, 0);
      assert.equal(conversions.length, previousConversions);
      assert.deepEqual(await readFile(source), bytes);
      await assert.rejects(access(output), { code: "ENOENT" });
    }
  });
});

test("AV1, HEVC and VP9 become H264 main/yuv420p while AAC packets are copied exactly and faststart is present", async () => {
  await withFixtures(async directory => {
    for (const codec of ["libsvtav1", "libx265", "libvpx-vp9"]) {
      const source = join(directory, `${codec}.mp4`);
      const output = join(directory, `${codec}-output.mp4`);
      generate(source, { codec, size: "64x64" });
      await assert.rejects(validation.validateVideoFile(source), error => error.code === "UNSUPPORTED_VIDEO");
      let notices = 0;
      const result = await transcoding.prepareCompatibleVideo(source, output, new AbortController().signal, async () => {
        await delay(1);
        notices++;
      });
      assert.equal(notices, 1);
      assert.equal(result.converted, true);
      assert.equal(result.filePath, output);
      const inspection = probe(output);
      assert.equal(inspection.streams[0].codec_name, "h264");
      assert.equal(inspection.streams[0].profile, "Main");
      assert.equal(inspection.streams[0].pix_fmt, "yuv420p");
      assert.equal(inspection.streams[1].codec_name, "aac");
      assert.deepEqual(packetHashes(output, "a:0"), packetHashes(source, "a:0"));
      assert.equal(result.bytes, (await stat(output)).size);
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      assert.ok(Math.abs(result.metadata.durationSeconds - Number(probe(source).format.duration)) < 0.1);
      const outputBytes = await readFile(output);
      assert.ok(outputBytes.indexOf(Buffer.from("moov")) < outputBytes.indexOf(Buffer.from("mdat")));
      assertBoundedArguments(conversions.at(-1));
      assert.equal(conversions.at(-1)[conversions.at(-1).indexOf("-c:a") + 1], "copy");
      await validation.validateVideoFile(output);
    }
  });
});

test("H264 plus MP3 converts audio only; encoded video packets remain identical", async () => {
  await withFixtures(async directory => {
    const source = join(directory, "mp3.mp4");
    const output = join(directory, "aac.mp4");
    generate(source, { audio: "libmp3lame" });
    const result = await transcoding.prepareCompatibleVideo(source, output, new AbortController().signal);
    assert.equal(result.converted, true);
    assert.deepEqual(packetHashes(output, "v:0"), packetHashes(source, "v:0"));
    assert.equal(probe(output).streams[1].codec_name, "aac");
    const arguments_ = conversions.at(-1);
    assert.equal(arguments_[arguments_.indexOf("-c:v") + 1], "copy");
    assert.equal(arguments_[arguments_.indexOf("-c:a") + 1], "aac");
  });
});

test("incompatible secondary audio is dropped by a stream-copy remux, without reencoding compatible tracks or preserving private tags", async () => {
  await withFixtures(async directory => {
    const source = join(directory, "multi-audio.mp4");
    const output = join(directory, "selected-audio.mp4");
    generate(source, { extra: ["-map", "0:v", "-map", "1:a", "-map", "1:a", "-c:a:1", "libmp3lame",
      "-metadata", "title=synthetic-secret", "-metadata:s:v:0", "handler_name=synthetic-secret"] });
    const result = await transcoding.prepareCompatibleVideo(source, output, new AbortController().signal);
    assert.equal(result.converted, true);
    assert.equal(probe(output).streams.length, 2);
    assert.deepEqual(packetHashes(output, "v:0"), packetHashes(source, "v:0"));
    assert.deepEqual(packetHashes(output, "a:0"), packetHashes(source, "a:0"));
    assert.doesNotMatch(JSON.stringify(probe(output)), /synthetic-secret/);
    const arguments_ = conversions.at(-1);
    assert.equal(arguments_[arguments_.indexOf("-c:v") + 1], "copy");
    assert.equal(arguments_[arguments_.indexOf("-c:a") + 1], "copy");
  });
});

test("onConverting is awaited before any ffmpeg work and its typed error leaves no output", async () => {
  await withFixtures(async directory => {
    const source = join(directory, "callback.mp4");
    const output = join(directory, "not-started.mp4");
    generate(source, { audio: "libmp3lame" });
    const previousConversions = conversions.length;
    let notices = 0;
    const callbackError = new validation.VideoUploadError("The status update is unavailable.", "STATUS_UNAVAILABLE", 503);
    await assert.rejects(transcoding.prepareCompatibleVideo(source, output, new AbortController().signal, async () => {
      await delay(1);
      notices++;
      throw callbackError;
    }), error => error === callbackError);
    assert.equal(notices, 1);
    assert.equal(conversions.length, previousConversions);
    await assert.rejects(access(output), { code: "ENOENT" });
  });
});

test("odd dimensions, 10-bit/chroma, 60fps and large frames are normalized rather than mislabeled compatible", async () => {
  await withFixtures(async directory => {
    const cases = [
      { size: "65x49", codec: "libx264", pixels: "yuv444p", extra: ["-vf", "scale=65:49"] },
      { pixels: "yuv420p10le" },
      { rate: "60" },
      { size: "2048x1152", audio: null }
    ];
    for (const [index, options] of cases.entries()) {
      const source = join(directory, `normalize-${index}.mp4`);
      const output = join(directory, `normalized-${index}.mp4`);
      generate(source, options);
      const result = await transcoding.prepareCompatibleVideo(source, output, new AbortController().signal);
      assert.equal(result.converted, true);
      const video = probe(output).streams[0];
      assert.equal(video.codec_name, "h264");
      assert.equal(video.pix_fmt, "yuv420p");
      assert.equal(video.width % 2, 0);
      assert.equal(video.height % 2, 0);
      assert.ok(Math.max(video.width, video.height) <= 1920);
      assert.ok(Math.min(video.width, video.height) <= 1080);
      const [numerator, denominator] = video.avg_frame_rate.split("/").map(Number);
      assert.ok(numerator / denominator <= 30);
    }
  });
});

test("rotation and SAR are baked into displayed dimensions by autorotate then square-pixel scaling", async () => {
  await withFixtures(async directory => {
    const base = join(directory, "base.mp4");
    const rotated = join(directory, "rotated.mp4");
    const output = join(directory, "upright.mp4");
    generate(base, { size: "96x64", extra: ["-vf", "setsar=2/1"] });
    execFileSync(ffmpegPath, ["-v", "error", "-nostdin", "-n", "-display_rotation:v:0", "90", "-i", base, "-c", "copy", rotated], { timeout: 15_000 });
    const sourceProbe = probe(rotated).streams[0];
    assert.equal(sourceProbe.width, 96);
    assert.equal(sourceProbe.height, 64);
    assert.equal(sourceProbe.sample_aspect_ratio, "2:1");
    assert.equal(Math.abs(sourceProbe.side_data_list[0].rotation), 90);
    const result = await transcoding.prepareCompatibleVideo(rotated, output, new AbortController().signal);
    assert.equal(result.converted, true);
    assert.equal(result.metadata.width, 64);
    assert.equal(result.metadata.height, 192);
    const outputProbe = probe(output).streams[0];
    assert.equal(outputProbe.sample_aspect_ratio, "1:1");
    assert.ok(!outputProbe.side_data_list?.some(sideData => sideData.rotation));
  });
});

test("empty, corrupt, renamed MOV/MKV, cover-art-only and multiple video streams are rejected without conversion", async () => {
  await withFixtures(async directory => {
    const cases = ["empty", "corrupt", "mov", "mkv", "cover", "multiple"];
    for (const fixture of cases) {
      const source = join(directory, `${fixture}.mp4`);
      const output = join(directory, `${fixture}-output.mp4`);
      if (fixture === "empty" || fixture === "corrupt") await writeFile(source, fixture === "empty" ? "" : "not an MP4");
      else if (fixture === "cover") generate(source, { codec: "mjpeg", extra: ["-frames:v", "1", "-disposition:v:0", "attached_pic"] });
      else generate(source, { extra: fixture === "multiple" ? ["-map", "0:v", "-map", "0:v"] : ["-f", fixture === "mkv" ? "matroska" : "mov"] });
      const previousConversions = conversions.length;
      await assert.rejects(transcoding.prepareCompatibleVideo(source, output, new AbortController().signal), error => {
        assertSafe(error);
        return error.status === 400;
      });
      assert.equal(conversions.length, previousConversions);
      await assert.rejects(access(output), { code: "ENOENT" });
    }
  });
});

test("missing ffmpeg is a safe 503, and existing outputs and the source are never overwritten", async () => {
  await withFixtures(async directory => {
    const source = join(directory, "source.mp4");
    const output = join(directory, "converted.mp4");
    generate(source, { audio: "libmp3lame" });
    const sourceBytes = await readFile(source);
    process.env.FFPROBE_PATH = "/missing-polaris-test-ffprobe";
    try {
      await assert.rejects(transcoding.prepareCompatibleVideo(source, output, new AbortController().signal), error => {
        assertSafe(error);
        return error.code === "FFPROBE_UNAVAILABLE" && error.status === 503;
      });
    } finally { process.env.FFPROBE_PATH = ffprobePath; }
    process.env.FFMPEG_PATH = "/missing-polaris-test-ffmpeg";
    try {
      await assert.rejects(transcoding.prepareCompatibleVideo(source, output, new AbortController().signal), error => {
        assertSafe(error);
        return error.code === "FFMPEG_UNAVAILABLE" && error.status === 503;
      });
    } finally { process.env.FFMPEG_PATH = ffmpegPath; }
    await assert.rejects(access(output), { code: "ENOENT" });
    for (const unsafePath of [source, output, join(directory, "..", "escaped-output.mp4")]) {
      await writeFile(output, "keep-existing-file");
      await assert.rejects(transcoding.prepareCompatibleVideo(source, unsafePath, new AbortController().signal), assertSafe);
      assert.equal(await readFile(output, "utf8"), "keep-existing-file");
    }
    assert.deepEqual(await readFile(source), sourceBytes);
  });
});

function createProcessHarness({ sourceOverrides = {}, outputOverrides = {}, outputSize = 1000, liveSize = 1000, failure = null } = {}) {
  const source = {
    width: 64, height: 48, durationSeconds: 10,
    video: { index: 0, codec_type: "video", codec_name: "av1", width: 64, height: 48, duration: "10",
      avg_frame_rate: "24/1", r_frame_rate: "24/1", pix_fmt: "yuv420p", sample_aspect_ratio: "1:1" },
    streams: [], ...sourceOverrides
  };
  source.streams = [source.video];
  const output = { ...source, video: { index: 0, codec_name: "h264", duration: "10", pix_fmt: "yuv420p", avg_frame_rate: "24/1" }, ...outputOverrides };
  output.streams = [output.video];
  const harness = { signals: [], removed: false, created: false, closed: false, callback: null, timeout: null };
  const child = new EventEmitter();
  child.kill = signal => { harness.signals.push(signal); return true; };
  harness.started = new Promise(resolve => { harness.start = resolve; });
  harness.finishCallback = () => harness.callback(failure);
  harness.close = () => { harness.closed = true; child.emit("close", 0, null); };
  harness.module = loadModule("../src/lib/video-transcoding.ts", {
    "./video-types": videoTypes,
    "./video-validation": { ...validation, inspectVideoFile: async filePath => filePath.endsWith("input.mp4") ? source : output },
    "node:child_process": { execFile: (_binary, arguments_, options, callback) => {
      assertBoundedArguments(arguments_);
      assert.equal(options.maxBuffer, 64 * 1024);
      assert.equal(options.killSignal, "SIGKILL");
      assert.ok(!options.shell);
      harness.arguments = arguments_;
      harness.created = true;
      harness.callback = callback;
      harness.start();
      return child;
    } },
    "node:fs/promises": {
      lstat: async filePath => {
        if (filePath.endsWith("input.mp4")) return { isFile: () => true, isSymbolicLink: () => false, size: 1000 };
        if (filePath === "/private/work") return { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700 };
        if (!harness.created) throw Object.assign(new Error("private path"), { code: "ENOENT" });
        return { isFile: () => true, isSymbolicLink: () => false, size: outputSize };
      },
      stat: async () => ({ size: liveSize }),
      chmod: async () => {},
      rm: async () => { assert.equal(harness.closed, true, "partial file cannot be removed before child close"); harness.removed = true; }
    }
  }, { setTimeout: (callback, milliseconds) => { assert.equal(milliseconds, 300_000); harness.timeout = callback; return 1; }, clearTimeout: () => {} });
  harness.prepare = signal => harness.module.prepareCompatibleVideo("/private/work/input.mp4", "/private/work/output.mp4", signal || new AbortController().signal);
  return harness;
}

test("abort and five-minute deadline explicitly SIGKILL and wait for close before cleanup/rejection", async () => {
  for (const reason of ["abort", "timeout"]) {
    const harness = createProcessHarness();
    const controller = new AbortController();
    let settled = false;
    const checked = assert.rejects(harness.prepare(controller.signal), error => {
      assertSafe(error);
      return error.code === (reason === "abort" ? "UPLOAD_CANCELLED" : "VIDEO_CONVERSION_TIMEOUT");
    }).then(() => { settled = true; });
    await harness.started;
    if (reason === "abort") controller.abort(); else harness.timeout();
    harness.finishCallback();
    await delay(5);
    assert.ok(harness.signals.length >= 1);
    assert.ok(harness.signals.every(signal => signal === "SIGKILL"));
    assert.equal(harness.removed, false);
    assert.equal(settled, false);
    harness.close();
    await checked;
    assert.equal(harness.removed, true);
  }
});

test("successful ffmpeg exit cannot hide truncation, oversized output, or a failed decoder", async () => {
  const cases = [
    [{ outputOverrides: { durationSeconds: 5, video: { index: 0, codec_name: "h264", duration: "5", pix_fmt: "yuv420p", avg_frame_rate: "24/1" } } }, "VIDEO_CONVERSION_INCOMPLETE"],
    [{ outputOverrides: { video: { index: 0, codec_name: "h264", duration: "5", pix_fmt: "yuv420p", avg_frame_rate: "24/1" } } }, "VIDEO_CONVERSION_INCOMPLETE"],
    [{ outputSize: videoTypes.MAX_VIDEO_UPLOAD_BYTES + 1 }, "VIDEO_TOO_LARGE"],
    [{ failure: Object.assign(new Error("decoder private detail /private/work synthetic-secret"), { code: 1 }) }, "VIDEO_CONVERSION_FAILED"]
  ];
  for (const [options, code] of cases) {
    const harness = createProcessHarness(options);
    const pending = assert.rejects(harness.prepare(), error => { assertSafe(error); return error.code === code; });
    await harness.started;
    harness.finishCallback();
    harness.close();
    await pending;
    assert.equal(harness.removed, true);
  }
});

test("live output watchdog stops a writer above 100 MiB and still waits for close", async () => {
  const harness = createProcessHarness({ liveSize: videoTypes.MAX_VIDEO_UPLOAD_BYTES + 1 });
  const pending = assert.rejects(harness.prepare(), error => error.code === "VIDEO_TOO_LARGE");
  await harness.started;
  while (!harness.signals.length) await delay(10);
  assert.equal(harness.removed, false);
  harness.finishCallback();
  harness.close();
  await pending;
  assert.equal(harness.removed, true);
});

test("source resource budgets reject before ffmpeg; unknown frame rate is normalized", async () => {
  for (const sourceOverrides of [
    { width: 8193 }, { width: 8192, height: 8192 }, { durationSeconds: 3600.1 },
    { video: { index: 0, codec_name: "av1", avg_frame_rate: "241/1" } }
  ]) {
    const harness = createProcessHarness({ sourceOverrides });
    await assert.rejects(harness.prepare(), error => error.code === "VIDEO_RESOURCE_LIMIT" && assertSafe(error));
    assert.equal(harness.created, false);
  }
  const harness = createProcessHarness({ sourceOverrides: { video: { index: 0, codec_name: "av1", avg_frame_rate: "0/0" } } });
  const pending = harness.prepare();
  await harness.started;
  harness.finishCallback();
  harness.close();
  await pending;
});

test("VFR nominal timestamp rates above 240 are normalized, not rejected when average fps is valid or unknown", async () => {
  for (const averageRate of ["24/1", "0/0"]) {
    const harness = createProcessHarness({ sourceOverrides: {
      video: { index: 0, codec_name: "h264", pix_fmt: "yuv420p", avg_frame_rate: averageRate, r_frame_rate: "1000/1" }
    } });
    const pending = harness.prepare();
    await harness.started;
    assert.equal(harness.created, true);
    const arguments_ = harness.arguments;
    assert.equal(arguments_[arguments_.indexOf("-c:v") + 1], "libx264");
    assert.match(arguments_[arguments_.indexOf("-vf") + 1], /(?:^|,)fps=30(?:,|$)/);
    harness.finishCallback();
    harness.close();
    assert.equal((await pending).converted, true);
  }
  const excessiveAverage = createProcessHarness({ sourceOverrides: {
    video: { index: 0, codec_name: "h264", pix_fmt: "yuv420p", avg_frame_rate: "241/1", r_frame_rate: "24/1" }
  } });
  await assert.rejects(excessiveAverage.prepare(), error => error.code === "VIDEO_RESOURCE_LIMIT");
  assert.equal(excessiveAverage.created, false);
});

if (process.argv.includes("--sample")) {
  test("authorized AV1/AAC sample converts completely in a private temp directory without changing original", async () => {
    const original = "/Users/junqing/Downloads/3vUvjzct7KeaBZEe.mp4";
    const before = await stat(original);
    await withFixtures(async directory => {
      const source = join(directory, "sample-source.mp4");
      const output = join(directory, "sample-compatible.mp4");
      await copyFile(original, source);
      const checksum = createHash("sha256").update(await readFile(source)).digest("hex");
      const sourceInspection = probe(source);
      assert.equal(sourceInspection.streams[0].codec_name, "av1");
      const result = await transcoding.prepareCompatibleVideo(source, output, new AbortController().signal);
      const outputInspection = probe(output);
      assert.equal(outputInspection.streams[0].codec_name, "h264");
      assert.equal(outputInspection.streams[1].codec_name, "aac");
      assert.deepEqual(packetHashes(output, "a:0"), packetHashes(source, "a:0"));
      assert.ok(Math.abs(result.metadata.durationSeconds - Number(sourceInspection.format.duration)) < 0.1);
      assert.ok(result.bytes <= videoTypes.MAX_VIDEO_UPLOAD_BYTES);
      assert.equal(createHash("sha256").update(await readFile(original)).digest("hex"), checksum);
      console.log(`Sample verified: AV1 -> H264, AAC packets copied, ${result.metadata.width}x${result.metadata.height}, ${result.metadata.durationSeconds.toFixed(6)}s, ${result.bytes} bytes.`);
    });
    const after = await stat(original);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });
}
