import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path, { dirname, join } from 'path';
import fs, { createWriteStream } from 'fs';
import os, { totalmem, cpus } from 'os';
import { ensureBrowser, selectComposition, makeCancelSignal, renderMedia } from '@remotion/renderer';
import WebSocket from 'ws';
import { lookup } from 'dns/promises';
import { execFile } from 'child_process';
import { writeFile, rm } from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import ffmpegStatic from 'ffmpeg-static';
import http from 'http';

createRequire(import.meta.url);
const __filename$1 = fileURLToPath(import.meta.url);
dirname(__filename$1);

// stub:@remotion/bundler
var noop = () => {
};
var handler = { get: (_, prop) => prop === "default" ? proxy : noop };
var proxy = new Proxy(noop, handler);
new Proxy({}, { get: () => "div" });
new Proxy({}, { get: () => "div" });
var bundle = noop;
var IPV4_PRIVATE_PATTERNS = [
  /^127\./,
  // Loopback
  /^10\./,
  // Class A private
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  // Class B private
  /^192\.168\./,
  // Class C private
  /^169\.254\./,
  // Link-local
  /^0\./
  // "This" network
];
var IPV6_PRIVATE_EXACT = ["::1", "0:0:0:0:0:0:0:1"];
var IPV6_PRIVATE_PREFIXES = ["fc00:", "fe80:", "fd"];
function hexMappedToIpv4(hex) {
  const parts = hex.split(":");
  if (parts.length !== 2) return null;
  const hi = parseInt(parts[0], 16);
  const lo = parseInt(parts[1], 16);
  if (isNaN(hi) || isNaN(lo)) return null;
  return `${hi >> 8 & 255}.${hi & 255}.${lo >> 8 & 255}.${lo & 255}`;
}
function isPrivateHostname(hostname) {
  const lower = hostname.toLowerCase();
  const stripped = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  if (stripped === "localhost") return true;
  if (IPV6_PRIVATE_EXACT.includes(stripped)) return true;
  if (IPV6_PRIVATE_PREFIXES.some((prefix) => stripped.startsWith(prefix))) return true;
  if (stripped.startsWith("::ffff:")) {
    const mapped = stripped.slice(7);
    if (mapped.includes(".")) {
      return IPV4_PRIVATE_PATTERNS.some((pattern) => pattern.test(mapped));
    }
    const ipv4 = hexMappedToIpv4(mapped);
    if (ipv4) {
      return IPV4_PRIVATE_PATTERNS.some((pattern) => pattern.test(ipv4));
    }
  }
  if (stripped.startsWith("::") && !stripped.startsWith("::ffff:")) {
    const remainder = stripped.slice(2);
    if (remainder.includes(".")) {
      return IPV4_PRIVATE_PATTERNS.some((pattern) => pattern.test(remainder));
    }
  }
  if (IPV4_PRIVATE_PATTERNS.some((pattern) => pattern.test(stripped))) return true;
  return false;
}
var ALLOWED_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
function validateExternalUrlSync(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `URL protocol "${parsed.protocol}" is not allowed. Only HTTP and HTTPS are permitted.`
    );
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error("URLs pointing to private/internal networks are not allowed");
  }
  return parsed;
}
async function validateExternalUrl(url) {
  const parsed = validateExternalUrlSync(url);
  try {
    const { address } = await lookup(parsed.hostname);
    if (isPrivateHostname(address)) {
      throw new Error("URL resolves to a private/internal network address");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("private/internal")) {
      throw err;
    }
  }
  return parsed;
}
var DEFAULT_TIMEOUT_MS = 5 * 60 * 1e3;
var SIGKILL_GRACE_MS = 5e3;
var WALL_CLOCK_OVERHEAD_MS = 1e4;
async function runFFmpeg(args, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, cwd } = options;
  if (!ffmpegStatic) {
    throw new Error("ffmpeg-static binary not found");
  }
  const ffmpegPath = ffmpegStatic;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action) => {
      if (settled) return;
      settled = true;
      action();
    };
    const child = execFile(
      ffmpegPath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        // 10MB stderr buffer
        cwd
      },
      (error, _stdout, stderr) => {
        if (signal?.aborted) {
          settle(() => reject(new Error("FFmpeg execution aborted")));
          return;
        }
        const execError = error;
        if (execError && "killed" in execError && execError.killed) {
          settle(() => reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`)));
          return;
        }
        const exitCode = execError?.code != null ? Number(execError.code) : 0;
        settle(() => resolve({ exitCode, stderr: stderr ?? "" }));
      }
    );
    let killTimer = null;
    const escalateKill = () => {
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, SIGKILL_GRACE_MS);
    };
    if (signal) {
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
        }
        escalateKill();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => signal.removeEventListener("abort", onAbort));
    }
    let timeoutEscalator = null;
    if (timeoutMs > 0) {
      timeoutEscalator = setTimeout(escalateKill, timeoutMs);
    }
    const wallClock = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      settle(
        () => reject(
          new Error(
            `FFmpeg wall-clock guard fired after ${timeoutMs + WALL_CLOCK_OVERHEAD_MS}ms (child unresponsive)`
          )
        )
      );
    }, timeoutMs + WALL_CLOCK_OVERHEAD_MS);
    child.on("exit", () => {
      clearTimeout(wallClock);
      if (killTimer) clearTimeout(killTimer);
      if (timeoutEscalator) clearTimeout(timeoutEscalator);
    });
  });
}
async function downloadToFile(url, destPath) {
  await validateExternalUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6e4);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error(`No response body for ${url}`);
    }
    const readable = Readable.fromWeb(response.body);
    const writable = createWriteStream(destPath);
    try {
      await pipeline(readable, writable);
    } catch (err) {
      controller.abort();
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }
}
async function probeVideo(filePath) {
  const result = await inspectVideo(filePath);
  if (!result.ok) return null;
  return {
    duration: result.duration,
    width: result.width,
    height: result.height,
    fps: result.fps
  };
}
async function inspectVideo(filePath) {
  let result;
  try {
    result = await runFFmpeg(["-i", filePath, "-f", "null", "-"], { timeoutMs: 15e3 });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const { stderr } = result;
  if (!/Input #0/i.test(stderr)) {
    const tail = stderr.split("\n").slice(-8).join("\n").trim();
    return { ok: false, reason: `ffmpeg could not open file (exit ${result.exitCode}): ${tail}` };
  }
  const videoStreamLine = stderr.match(/Stream #\d+:\d+[^\n]*?: Video: ([^\n]+)/);
  const audioStreamLine = stderr.match(/Stream #\d+:\d+[^\n]*?: Audio: ([^\n]+)/);
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  const dimMatch = videoStreamLine?.[1]?.match(/(\d{2,5})x(\d{2,5})/);
  const fpsMatch = videoStreamLine?.[1]?.match(/,\s*(\d+(?:\.\d+)?)\s*fps/);
  const audioRateMatch = audioStreamLine?.[1]?.match(/(\d+)\s*Hz/);
  const audioChMatch = audioStreamLine?.[1]?.match(/Hz,\s*([^,\s]+)/);
  const videoCodec = videoStreamLine?.[1]?.match(/^([\w]+)/)?.[1] ?? null;
  const pixFmt = videoStreamLine?.[1]?.match(/,\s*(yuv\w+|rgb\w+|gbrp\w*|nv\d+)/)?.[1] ?? null;
  const audioCodec = audioStreamLine?.[1]?.match(/^([\w]+)/)?.[1] ?? null;
  const duration = durationMatch ? parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseInt(durationMatch[3]) + parseInt(durationMatch[4]) / 100 : 0;
  let audioChannels = null;
  if (audioChMatch?.[1]) {
    const layout = audioChMatch[1];
    if (layout === "mono") audioChannels = 1;
    else if (layout === "stereo") audioChannels = 2;
    else if (/5\.1/.test(layout)) audioChannels = 6;
    else if (/7\.1/.test(layout)) audioChannels = 8;
  }
  return {
    ok: true,
    hasVideo: Boolean(videoStreamLine),
    hasAudio: Boolean(audioStreamLine),
    duration,
    width: dimMatch ? parseInt(dimMatch[1]) : 0,
    height: dimMatch ? parseInt(dimMatch[2]) : 0,
    fps: fpsMatch ? parseFloat(fpsMatch[1]) : 0,
    videoCodec,
    pixFmt,
    audioCodec,
    audioSampleRate: audioRateMatch ? parseInt(audioRateMatch[1]) : null,
    audioChannels
  };
}
async function hasKeyframeWithin(filePath, withinSec) {
  try {
    const result = await runFFmpeg(
      [
        "-ss",
        "0",
        "-t",
        String(withinSec),
        "-skip_frame",
        "nokey",
        "-i",
        filePath,
        "-an",
        "-vsync",
        "0",
        "-f",
        "null",
        "-"
      ],
      { timeoutMs: 15e3 }
    );
    const frameMatch = result.stderr.match(/frame=\s*(\d+)/);
    if (!frameMatch) return false;
    return parseInt(frameMatch[1]) > 0;
  } catch {
    return false;
  }
}

// stub:@ffmpeg/ffmpeg
var noop2 = () => {
};
var handler2 = { get: (_, prop) => prop === "default" ? proxy2 : noop2 };
var proxy2 = new Proxy(noop2, handler2);
new Proxy({}, { get: () => "div" });
new Proxy({}, { get: () => "div" });

// stub:@ffmpeg/util
var noop3 = () => {
};
var handler3 = { get: (_, prop) => prop === "default" ? proxy3 : noop3 };
var proxy3 = new Proxy(noop3, handler3);
new Proxy({}, { get: () => "div" });
new Proxy({}, { get: () => "div" });
process.env.NODE_ENV === "development";
var ENCODING_PRESETS = {
  /** Merge preset — fast + faststart for web playback */
  merge: {
    videoCodec: [
      "-c:v",
      "libx264",
      "-crf",
      "23",
      "-preset",
      "fast",
      "-profile:v",
      "main",
      "-level",
      "4.0",
      "-movflags",
      "+faststart"
    ],
    audioCodec: ["-c:a", "aac", "-b:a", "128k"]
  }
};
Promise.resolve();
function toEven(n) {
  return n % 2 === 0 ? n : n - 1;
}
function buildNormalizeCommand(inputFile, outputFile, resolution, opts = { hasAudio: true }) {
  const { width, height } = resolution;
  const fps = opts.targetFps ?? 30;
  const args = ["-threads", "2"];
  args.push("-i", inputFile);
  if (!opts.hasAudio) {
    args.push("-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`);
  }
  args.push(
    "-vf",
    `${getScaleFilter(width, height)},fps=${fps},setsar=1,setpts=PTS-STARTPTS`,
    "-af",
    `aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS`,
    "-map",
    opts.hasAudio ? "0:v:0" : "0:v:0",
    "-map",
    opts.hasAudio ? "0:a:0?" : "1:a:0",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-preset",
    "fast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(fps * 2),
    "-keyint_min",
    String(fps * 2),
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-avoid_negative_ts",
    "make_zero",
    "-fflags",
    "+genpts",
    "-video_track_timescale",
    String(fps * 1e3),
    "-shortest",
    "-y",
    outputFile
  );
  return args;
}
function buildConcatDemuxerCommand(listFile, outputFile) {
  return [
    "-threads",
    "2",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-y",
    outputFile
  ];
}
function getScaleFilter(width, height) {
  const w = toEven(width);
  const h = toEven(height);
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
}
function buildTransitionCommand(inputFiles, durations, transition, transitionDuration, audioMode, hasAudioTracks, resolution) {
  const { width, height } = resolution;
  const args = [];
  const n = inputFiles.length;
  for (const file of inputFiles) {
    args.push("-i", file);
  }
  const filterParts = [];
  for (let i = 0; i < n; i++) {
    filterParts.push(`[${i}:v]${getScaleFilter(width, height)},fps=30,setsar=1[v${i}]`);
    if (audioMode !== "mute") {
      const audioDur = durations[i] ?? 5;
      const fadeStart = Math.max(0, audioDur - transitionDuration);
      if (audioMode === "firstOnly" && i > 0) {
        filterParts.push(
          `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${audioDur}[a${i}]`
        );
      } else if (hasAudioTracks[i]) {
        filterParts.push(
          `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,atrim=0:${audioDur},afade=t=out:st=${fadeStart}:d=${transitionDuration}[a${i}]`
        );
      } else {
        filterParts.push(
          `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${audioDur}[a${i}]`
        );
      }
    }
  }
  let currentVideoLabel = "v0";
  let offsetAcc = (durations[0] ?? 5) - transitionDuration;
  for (let i = 1; i < n; i++) {
    const nextLabel = `v${i}`;
    const outputLabel = i === n - 1 ? "xfout" : `xf${i}`;
    const xfadeType = transition === "fadeBlack" ? "fadeblack" : "fade";
    filterParts.push(
      `[${currentVideoLabel}][${nextLabel}]xfade=transition=${xfadeType}:duration=${transitionDuration}:offset=${offsetAcc}[${outputLabel}]`
    );
    currentVideoLabel = outputLabel;
    if (i < n - 1) {
      offsetAcc += (durations[i] ?? 5) - transitionDuration;
    }
  }
  filterParts.push("[xfout]format=yuv420p[outv]");
  if (audioMode !== "mute") {
    const delayedAudios = [];
    let audioOffset = 0;
    for (let i = 0; i < n; i++) {
      const delayMs = Math.round(audioOffset * 1e3);
      if (delayMs > 0) {
        filterParts.push(`[a${i}]adelay=${delayMs}|${delayMs}[ad${i}]`);
        delayedAudios.push(`[ad${i}]`);
      } else {
        delayedAudios.push(`[a${i}]`);
      }
      audioOffset += (durations[i] ?? 5) - transitionDuration;
    }
    filterParts.push(
      `${delayedAudios.join("")}amix=inputs=${n}:duration=longest:normalize=0[outa]`
    );
    args.push("-filter_complex", filterParts.join(";"));
    args.push("-map", "[outv]", "-map", "[outa]");
    args.push(...ENCODING_PRESETS.merge.audioCodec);
  } else {
    args.push("-filter_complex", filterParts.join(";"));
    args.push("-map", "[outv]", "-an");
  }
  args.push(...ENCODING_PRESETS.merge.videoCodec);
  return args;
}

// shared/lib/workers/runners/captionRendering.ts
var CAPTION_FPS = 30;
var SEGMENT_THRESHOLD_SECONDS = 12;
var SEGMENT_SECONDS = 8;
function resolveSegmentConcurrency(segmentCount, totalMemMb = totalmem() / (1024 * 1024), cpuCount = cpus().length) {
  const override = process.env.CAPTION_SEGMENT_CONCURRENCY;
  if (override !== void 0 && override !== "") {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.max(1, Math.min(parsed, segmentCount));
  }
  const PER_RENDER_MB = 1024;
  const RESERVE_MB = 768;
  const byMem = Math.floor((totalMemMb - RESERVE_MB) / PER_RENDER_MB);
  const byCpu = Math.max(1, cpuCount - 1);
  return Math.max(1, Math.min(segmentCount, byMem, byCpu));
}
var NOOP_LOGGER = {
  info: () => {
  },
  warn: () => {
  }
};
function resolveRenderConcurrency(requested, segmentParallel = 1) {
  const MAX_TABS_PER_RENDER = 4;
  const perRender = Math.floor(requested / Math.max(1, segmentParallel));
  return Math.max(1, Math.min(perRender, MAX_TABS_PER_RENDER));
}
async function renderSinglePass(opts, progressBase = 0, progressSpan = 0.95) {
  const {
    bundlePath,
    jobId,
    signal,
    tmpDir,
    sourceServedUrl,
    captionConfig,
    concurrency,
    onProgress,
    logger
  } = opts;
  const inputProps = { ...captionConfig, videoUrl: sourceServedUrl };
  const selectStart = Date.now();
  const composition = await selectComposition({
    serveUrl: bundlePath,
    id: "VideoCaptions",
    inputProps,
    timeoutInMilliseconds: 12e4
  });
  logger.info("Single-pass composition selected", { jobId, selectMs: Date.now() - selectStart });
  const outputLocation = path.join(tmpDir, "output.mp4");
  const { cancelSignal, cancel } = makeCancelSignal();
  signal.addEventListener("abort", () => cancel(), { once: true });
  const renderStart = Date.now();
  await renderMedia({
    composition,
    serveUrl: bundlePath,
    codec: "h264",
    outputLocation,
    inputProps,
    concurrency: resolveRenderConcurrency(concurrency),
    timeoutInMilliseconds: 12e4,
    onProgress: ({ progress }) => {
      const overall = progressBase + progress * progressSpan;
      if (onProgress) {
        void Promise.resolve(onProgress(Math.min(overall, 0.95))).catch((err) => {
          logger.warn("Progress callback failed (non-fatal)", {
            jobId,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    },
    cancelSignal
  });
  const finalBytes = fs.existsSync(outputLocation) ? fs.statSync(outputLocation).size : 0;
  logger.info("Single-pass render complete", {
    jobId,
    renderMs: Date.now() - renderStart,
    finalBytes
  });
  return outputLocation;
}
function contentTypeFor(name) {
  switch (path.extname(name).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".aac":
      return "audio/aac";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}
function startLocalFileServer(dir) {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const name = path.basename(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"));
    const filePath = path.join(dir, name);
    if (!name || !fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const { size } = fs.statSync(filePath);
    res.setHeader("Content-Type", contentTypeFor(name));
    res.setHeader("Accept-Ranges", "bytes");
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m?.[1] ? parseInt(m[1], 10) : 0;
      const end = m?.[2] ? parseInt(m[2], 10) : size - 1;
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", String(size));
      fs.createReadStream(filePath).pipe(res);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}
async function renderChunked(opts, totalSeconds) {
  const {
    bundlePath,
    jobId,
    signal,
    tmpDir,
    sourceLocalPath,
    fileServerOrigin,
    captionConfig,
    concurrency,
    onProgress,
    logger
  } = opts;
  const allWords = captionConfig.words ?? [];
  const segmentCount = Math.ceil(totalSeconds / SEGMENT_SECONDS);
  const segmentPaths = new Array(segmentCount);
  const parallel = resolveSegmentConcurrency(segmentCount);
  const segmentRenderConcurrency = resolveRenderConcurrency(concurrency, parallel);
  logger.info("Rendering captions in chunks", {
    jobId,
    totalSeconds,
    segmentCount,
    wordCount: allWords.length,
    parallel
  });
  const renderSegment = async (i) => {
    if (signal.aborted) throw new Error("Caption render aborted");
    const startSec = i * SEGMENT_SECONDS;
    const endSec = Math.min(startSec + SEGMENT_SECONDS, totalSeconds);
    const segDurationSec = endSec - startSec;
    const trimmedSrc = path.join(tmpDir, `src-seg-${i}.mp4`);
    const trim = await runFFmpeg(
      [
        "-y",
        "-loglevel",
        "error",
        "-ss",
        startSec.toFixed(3),
        "-i",
        sourceLocalPath,
        "-t",
        segDurationSec.toFixed(3),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-avoid_negative_ts",
        "make_zero",
        trimmedSrc
      ],
      { signal, timeoutMs: 6e4 }
    );
    if (trim.exitCode !== 0 || !fs.existsSync(trimmedSrc)) {
      const tail = trim.stderr.split("\n").slice(-10).join("\n");
      throw new Error(
        `Caption segment ${i} trim failed (exit ${trim.exitCode}, file ${fs.existsSync(trimmedSrc) ? "present" : "MISSING"}):
${tail}`
      );
    }
    const windowStartMs = startSec * 1e3;
    const windowEndMs = endSec * 1e3;
    const segmentWords = allWords.filter((w) => w.endMs > windowStartMs && w.startMs < windowEndMs).map((w) => ({
      text: w.text,
      startMs: Math.max(0, w.startMs - windowStartMs),
      endMs: Math.min(segDurationSec * 1e3, w.endMs - windowStartMs)
    }));
    const segmentInputProps = {
      ...captionConfig,
      // Served over loopback HTTP (not file://) — Chromium/OffthreadVideo can't
      // load file:// segments (fails on WSL2 and in the compositor).
      videoUrl: `${fileServerOrigin}/${path.basename(trimmedSrc)}`,
      words: segmentWords,
      durationInFrames: Math.max(1, Math.ceil(segDurationSec * CAPTION_FPS))
    };
    const segmentComposition = await selectComposition({
      serveUrl: bundlePath,
      id: "VideoCaptions",
      inputProps: segmentInputProps,
      timeoutInMilliseconds: 6e4
    });
    const segOut = path.join(tmpDir, `cap-seg-${i}.mp4`);
    const { cancelSignal, cancel } = makeCancelSignal();
    const onAbort = () => cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await renderMedia({
        composition: segmentComposition,
        serveUrl: bundlePath,
        codec: "h264",
        outputLocation: segOut,
        inputProps: segmentInputProps,
        concurrency: segmentRenderConcurrency,
        timeoutInMilliseconds: 18e4,
        cancelSignal
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    segmentPaths[i] = segOut;
  };
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= segmentCount) return;
      await renderSegment(i);
      completed++;
      if (onProgress) {
        void Promise.resolve(onProgress(Math.min(completed / segmentCount * 0.95, 0.95))).catch(
          (err) => {
            logger.warn("Progress callback failed (non-fatal)", {
              jobId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        );
      }
      logger.info("Caption chunk render done", { jobId, chunkIdx: i, completed, segmentCount });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, segmentCount) }, () => worker()));
  const concatListPath = path.join(tmpDir, "concat.txt");
  fs.writeFileSync(
    concatListPath,
    segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );
  const finalOutput = path.join(tmpDir, "output.mp4");
  await runFFmpeg(buildConcatDemuxerCommand(concatListPath, finalOutput), {
    signal,
    timeoutMs: 6e4
  });
  logger.info("Caption chunked render complete", { jobId, segmentCount });
  return finalOutput;
}
async function renderCaptions(input) {
  const logger = input.logger ?? NOOP_LOGGER;
  const rawFrames = input.captionConfig.durationInFrames ?? 0;
  if (!rawFrames) {
    throw new Error(
      `Caption render for job ${input.jobId} has invalid or missing durationInFrames`
    );
  }
  const totalSeconds = rawFrames / CAPTION_FPS;
  const chunked = totalSeconds > SEGMENT_THRESHOLD_SECONDS;
  logger.info("Caption render dispatch", {
    jobId: input.jobId,
    totalSeconds,
    chunked,
    videoUrl: input.videoUrl
  });
  const fileServer = await startLocalFileServer(input.workDir);
  try {
    const sourceLocalPath = path.join(input.workDir, "source.mp4");
    if (/^https?:\/\//i.test(input.videoUrl)) {
      await downloadToFile(input.videoUrl, sourceLocalPath);
    } else {
      fs.copyFileSync(input.videoUrl, sourceLocalPath);
    }
    const sourceServedUrl = `${fileServer.origin}/${path.basename(sourceLocalPath)}`;
    const captionConfig = { ...input.captionConfig };
    const audioUrl = captionConfig.audioUrl;
    if (typeof audioUrl === "string" && /^https?:\/\//i.test(audioUrl)) {
      const audioExt = path.extname(new URL(audioUrl).pathname) || ".mp3";
      const audioLocalName = `source-audio${audioExt}`;
      await downloadToFile(audioUrl, path.join(input.workDir, audioLocalName));
      captionConfig.audioUrl = `${fileServer.origin}/${audioLocalName}`;
    }
    const chunkInputs = {
      bundlePath: input.bundlePath,
      jobId: input.jobId,
      signal: input.cancelSignal,
      tmpDir: input.workDir,
      sourceLocalPath,
      sourceServedUrl,
      fileServerOrigin: fileServer.origin,
      captionConfig,
      concurrency: input.concurrency,
      logger,
      ...input.onProgress ? { onProgress: input.onProgress } : {}
    };
    const outputFilePath = chunked ? await renderChunked(chunkInputs, totalSeconds) : await renderSinglePass(chunkInputs);
    const durationSec = Math.round(rawFrames / CAPTION_FPS * 10) / 10;
    return { outputFilePath, durationSec };
  } finally {
    await fileServer.close();
  }
}
var SLIDESHOW_FPS = 30;
var NOOP_LOGGER2 = {
  info: () => {
  },
  warn: () => {
  }
};
async function renderSlideshow(input) {
  const logger = input.logger ?? NOOP_LOGGER2;
  const { config, jobId } = input;
  const { slideshowConfig } = config;
  if (!slideshowConfig.durationInFrames) {
    throw new Error(`Slideshow job ${jobId} has invalid durationInFrames`);
  }
  const inputProps = {
    imageUrls: config.imageUrls,
    audioUrl: config.audioUrl,
    includeAudio: slideshowConfig.includeAudio,
    animationPreset: slideshowConfig.animationPreset,
    durationInFrames: slideshowConfig.durationInFrames,
    aspectRatio: slideshowConfig.aspectRatio,
    resolution: slideshowConfig.resolution,
    includeCaptions: slideshowConfig.includeCaptions,
    captionConfig: config.captionConfig,
    // Beat-sync: per-image durations override uniform calculation in the composition.
    perImageDurationsSec: slideshowConfig.perImageDurationsSec,
    playbackSpeed: slideshowConfig.playbackSpeed
  };
  await Promise.all(config.imageUrls.map((u) => input.validateUrl(u)));
  if (config.audioUrl) await input.validateUrl(config.audioUrl);
  const composition = await selectComposition({
    serveUrl: input.bundlePath,
    id: "ImageSlideshow",
    inputProps,
    timeoutInMilliseconds: 12e4
  });
  const outputLocation = path.join(input.workDir, "output.mp4");
  const { cancelSignal, cancel } = makeCancelSignal();
  input.cancelSignal.addEventListener("abort", () => cancel(), { once: true });
  const renderStart = Date.now();
  await renderMedia({
    composition,
    serveUrl: input.bundlePath,
    codec: "h264",
    outputLocation,
    inputProps,
    concurrency: input.concurrency,
    timeoutInMilliseconds: 12e4,
    onProgress: ({ progress }) => {
      if (input.onProgress) {
        void Promise.resolve(input.onProgress(Math.min(progress, 0.95))).catch((err) => {
          logger.warn("Slideshow progress callback failed (non-fatal)", {
            jobId,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    },
    cancelSignal
  });
  const finalBytes = fs.existsSync(outputLocation) ? fs.statSync(outputLocation).size : 0;
  logger.info("Slideshow render complete", {
    jobId,
    renderMs: Date.now() - renderStart,
    finalBytes
  });
  const durationSec = Math.round(slideshowConfig.durationInFrames / SLIDESHOW_FPS * 10) / 10;
  return {
    outputFilePath: outputLocation,
    durationSec,
    result: {
      imageCount: config.imageUrls.length,
      aspectRatio: slideshowConfig.aspectRatio,
      resolution: slideshowConfig.resolution,
      hasAudio: slideshowConfig.includeAudio && !!config.audioUrl,
      hasCaptions: slideshowConfig.includeCaptions ?? false
    }
  };
}
var TRIM_TIMEOUT_MS = 2 * 60 * 1e3;
var NOOP_LOGGER3 = { info: () => {
}, warn: () => {
} };
function buildAtempoChainNative(speed) {
  if (speed >= 0.5 && speed <= 2) return `atempo=${speed.toFixed(6)}`;
  const chain = [];
  let remaining = speed;
  while (remaining < 0.5) {
    chain.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2) {
    chain.push(2);
    remaining /= 2;
  }
  chain.push(remaining);
  return chain.map((s) => `atempo=${s.toFixed(6)}`).join(",");
}
async function runVideoTrim(input) {
  const logger = input.logger ?? NOOP_LOGGER3;
  const { config, jobId, workDir, cancelSignal } = input;
  const inputPath = join(workDir, "input.mp4");
  await input.validateUrl(config.videoUrl);
  await downloadToFile(config.videoUrl, inputPath);
  const expectedDuration = config.endTime - config.startTime;
  const outputPath = join(workDir, "output.mp4");
  const playbackSpeed = config.playbackSpeed ?? 1;
  const preservePitch = config.preservePitch ?? true;
  const sourceProbe = await probeVideo(inputPath);
  const sourceFps = sourceProbe?.fps && sourceProbe.fps > 0 && sourceProbe.fps <= 120 ? sourceProbe.fps : 30;
  const inputArgs = [
    "-ss",
    config.startTime.toString(),
    "-i",
    inputPath,
    "-t",
    expectedDuration.toString()
  ];
  const useStreamCopy = config.quality === "fast" && playbackSpeed === 1;
  const outputArgs = useStreamCopy ? ["-c", "copy", "-avoid_negative_ts", "make_zero"] : [
    "-r",
    sourceFps.toString(),
    "-vsync",
    "cfr",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "fast",
    "-c:a",
    "aac",
    "-b:a",
    "192k"
  ];
  if (playbackSpeed !== 1) {
    const videoFilter = `setpts=${(1 / playbackSpeed).toFixed(6)}*PTS`;
    const audioBase = preservePitch ? buildAtempoChainNative(playbackSpeed) : `asetrate=44100*${playbackSpeed.toFixed(6)},aresample=44100`;
    const audioFilter = `${audioBase},aresample=async=1:first_pts=0`;
    outputArgs.push("-filter:v", videoFilter, "-filter:a", audioFilter);
  }
  const args = [...inputArgs, ...outputArgs, "-y", outputPath];
  logger.info("Running FFmpeg trim", {
    jobId,
    startTime: config.startTime,
    endTime: config.endTime,
    quality: config.quality
  });
  const result = await runFFmpeg(args, { timeoutMs: TRIM_TIMEOUT_MS, signal: cancelSignal });
  if (result.exitCode !== 0) {
    const tail = result.stderr.split("\n").slice(-20).join("\n");
    throw new Error(`FFmpeg trim failed (exit ${result.exitCode}):
${tail}`);
  }
  const outputInfo = await probeVideo(outputPath);
  const durationSec = outputInfo?.duration ?? expectedDuration / playbackSpeed;
  return {
    outputFilePath: outputPath,
    durationSec,
    result: {
      startTime: config.startTime,
      endTime: config.endTime,
      quality: config.quality
    }
  };
}
var OVERLAY_TIMEOUT_MS = 3 * 60 * 1e3;
var NOOP_LOGGER4 = { info: () => {
}, warn: () => {
} };
async function runAudioOverlay(input) {
  const logger = input.logger ?? NOOP_LOGGER4;
  const { config, jobId, workDir, cancelSignal } = input;
  const videoPath = join(workDir, "input-video.mp4");
  const audioPath = join(workDir, "input-audio.mp3");
  await input.validateUrl(config.videoUrl);
  await input.validateUrl(config.audioUrl);
  await downloadToFile(config.videoUrl, videoPath);
  await downloadToFile(config.audioUrl, audioPath);
  const outputPath = join(workDir, "output.mp4");
  const startOffset = config.startOffset ?? 0;
  const loop = config.loop ?? false;
  const fadeInSec = config.fadeInSec ?? 0;
  const fadeOutSec = config.fadeOutSec ?? 0;
  const volume = config.volume ?? 1;
  const videoProbe = await probeVideo(videoPath);
  const videoDuration = videoProbe?.duration && videoProbe.duration > 0 ? videoProbe.duration : 0;
  const polishFilters = [];
  if (loop) polishFilters.push("aloop=loop=-1:size=2147483647");
  if (startOffset > 0) {
    polishFilters.push(`atrim=start=${startOffset}`, "asetpts=PTS-STARTPTS");
  }
  if (fadeInSec > 0) polishFilters.push(`afade=t=in:st=0:d=${fadeInSec}`);
  if (volume !== 1) polishFilters.push(`volume=${volume}`);
  if (fadeOutSec > 0 && !loop) {
    polishFilters.push("areverse", `afade=t=in:st=0:d=${fadeOutSec}`, "areverse");
  }
  if (!loop && videoDuration > 0) {
    polishFilters.push(
      `apad=whole_dur=${videoDuration.toFixed(6)}`,
      `atrim=end=${videoDuration.toFixed(6)}`,
      "asetpts=PTS-STARTPTS"
    );
  }
  const polishStage = polishFilters.length > 0 ? `[1:a]${polishFilters.join(",")}[aprep]` : "[1:a]anull[aprep]";
  const filterGraph = config.audioMode === "mix" ? `${polishStage};[0:a][aprep]amix=inputs=2:duration=longest:dropout_transition=2[aout]` : `${polishStage};[aprep]anull[aout]`;
  const args = [
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-c:v",
    "copy",
    "-filter_complex",
    filterGraph,
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-y",
    outputPath
  ];
  logger.info("Running FFmpeg audio overlay", { jobId, audioMode: config.audioMode });
  const result = await runFFmpeg(args, { timeoutMs: OVERLAY_TIMEOUT_MS, signal: cancelSignal });
  if (result.exitCode !== 0) {
    const tail = result.stderr.split("\n").slice(-20).join("\n");
    throw new Error(`FFmpeg audio overlay failed (exit ${result.exitCode}):
${tail}`);
  }
  const outputInfo = await probeVideo(outputPath);
  return {
    outputFilePath: outputPath,
    durationSec: outputInfo?.duration ?? 0,
    result: {
      audioMode: config.audioMode
    }
  };
}

// shared/lib/audio/beatSync.ts
var DRIFT_TOLERANCE_SEC = 0.02;
function resolveBeatSync(input) {
  const { clipDurations, beatTimes, firstBeatOffset, beatsPerItem, speedTolerance } = input;
  const beatsArr = expandBeatsPerItem(beatsPerItem, clipDurations.length);
  const alignedFirstBeatOffset = Math.max(0, firstBeatOffset);
  const clips = [];
  let cursor = alignedFirstBeatOffset;
  for (let i = 0; i < clipDurations.length; i++) {
    const naturalDuration = clipDurations[i] ?? 0;
    const beatsForClip = beatsArr[i] ?? 1;
    const segmentEnd = advanceBeats(beatTimes, cursor, beatsForClip);
    const targetDurationSec = Math.max(1e-3, segmentEnd - cursor);
    const candidateSpeed = naturalDuration / targetDurationSec;
    const drift = Math.abs(1 - candidateSpeed);
    let plan;
    if (Number.isFinite(candidateSpeed) && drift <= speedTolerance) {
      plan = {
        targetDurationSec,
        playbackSpeed: candidateSpeed,
        hardTrim: null
      };
    } else {
      const trimEnd = nearestBeatAtMost(beatTimes, cursor, segmentEnd);
      const adjustedDuration = Math.max(1e-3, trimEnd - cursor);
      plan = {
        targetDurationSec: adjustedDuration,
        playbackSpeed: 1,
        hardTrim: { startSec: 0, endSec: adjustedDuration }
      };
    }
    const cutPoint = cursor + plan.targetDurationSec;
    const snappedBeat = nearestBeat(beatTimes, cutPoint);
    if (Math.abs(cutPoint - snappedBeat) > DRIFT_TOLERANCE_SEC) {
      const snapped = Math.max(1e-3, snappedBeat - cursor);
      plan.targetDurationSec = snapped;
      if (plan.hardTrim) {
        plan.hardTrim = { startSec: 0, endSec: snapped };
      }
    }
    clips.push(plan);
    cursor += plan.targetDurationSec;
  }
  return { clips, alignedFirstBeatOffset };
}
function expandBeatsPerItem(beatsPerItem, itemCount) {
  if (Array.isArray(beatsPerItem)) {
    if (beatsPerItem.length !== itemCount) {
      throw new Error(
        `beatsPerItem length ${beatsPerItem.length} does not match clipCount ${itemCount}`
      );
    }
    return beatsPerItem.map((n) => Math.max(1, Math.round(n)));
  }
  const uniform = Math.max(1, Math.round(beatsPerItem));
  return new Array(itemCount).fill(uniform);
}
function advanceBeats(beatTimes, startTime, count) {
  if (beatTimes.length === 0) {
    return startTime + count * 0.5;
  }
  let idx = beatTimes.findIndex((t) => t >= startTime);
  if (idx < 0) idx = beatTimes.length - 1;
  const targetIdx = idx + count;
  if (targetIdx < beatTimes.length) {
    return beatTimes[targetIdx];
  }
  const span = beatTimes[beatTimes.length - 1] - beatTimes[0];
  const avgInterval = beatTimes.length > 1 ? span / (beatTimes.length - 1) : 0.5;
  return beatTimes[beatTimes.length - 1] + (targetIdx - (beatTimes.length - 1)) * avgInterval;
}
function nearestBeatAtMost(beatTimes, floor, cap) {
  let best = floor;
  for (const t of beatTimes) {
    if (t <= cap && t >= floor && t > best) best = t;
    if (t > cap) break;
  }
  return best;
}
function nearestBeat(beatTimes, t) {
  if (beatTimes.length === 0) return t;
  let best = beatTimes[0];
  let bestDist = Math.abs(t - best);
  for (const candidate of beatTimes) {
    const d = Math.abs(t - candidate);
    if (d < bestDist) {
      best = candidate;
      bestDist = d;
    }
  }
  return best;
}

// shared/lib/workers/runners/videoMerge.ts
var MERGE_TIMEOUT_MS = 5 * 60 * 1e3;
var NORMALIZE_TIMEOUT_MS = 90 * 1e3;
var VALIDATE_KEYFRAME_WINDOW_SEC = 5;
var NOOP_LOGGER5 = { info: () => {
}, warn: () => {
} };
function shouldUseSinglePassXfade(inputCount, resolution, totalMemMb = totalmem() / (1024 * 1024)) {
  const override = process.env.VIDEO_MERGE_SINGLE_PASS;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  const pixelRatio = resolution.width * resolution.height / (1920 * 1080);
  const perInputMb = Math.max(120, Math.round(pixelRatio * 200));
  const estPeakMb = 400 + inputCount * perInputMb;
  return totalMemMb >= estPeakMb * 2 + 1536;
}
async function runPairwiseXfadeMerge(opts) {
  const {
    jobId,
    tempDir,
    inputs,
    durations,
    hasAudioTracks,
    transition,
    transitionDuration,
    audioMode,
    resolution,
    signal,
    logger
  } = opts;
  const N = inputs.length;
  const { width, height } = resolution;
  const scaleFilter = getScaleFilter(width, height);
  const xfadeType = transition === "fadeBlack" ? "fadeblack" : "fade";
  let currentVideo = inputs[0];
  let accumulatedDuration = durations[0] ?? 5;
  for (let i = 1; i < N; i++) {
    const nextInput = inputs[i];
    const isFinal = i === N - 1 && audioMode === "mute";
    const stepOutput = isFinal ? join(tempDir, "output.mp4") : join(tempDir, `pairwise-${i}.mp4`);
    const xfadeOffset = Math.max(0, accumulatedDuration - transitionDuration);
    const filter = `[0:v]${scaleFilter},fps=30,setsar=1[v0];[1:v]${scaleFilter},fps=30,setsar=1[v1];[v0][v1]xfade=transition=${xfadeType}:duration=${transitionDuration}:offset=${xfadeOffset}[xfout];[xfout]format=yuv420p[outv]`;
    const args = [
      "-threads",
      "2",
      "-i",
      currentVideo,
      "-i",
      nextInput,
      "-filter_complex",
      filter,
      "-map",
      "[outv]",
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "23",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-y",
      stepOutput
    ];
    logger.info("Pairwise xfade step", { jobId, step: i, total: N - 1, offset: xfadeOffset });
    const r2 = await runFFmpeg(args, { timeoutMs: MERGE_TIMEOUT_MS, signal });
    if (r2.exitCode !== 0) {
      const tail = r2.stderr.split("\n").slice(-20).join("\n");
      throw new Error(
        `FFmpeg pairwise xfade step ${i}/${N - 1} failed (exit ${r2.exitCode}):
${tail}`
      );
    }
    if (i >= 2) {
      const prevPairwise = join(tempDir, `pairwise-${i - 1}.mp4`);
      await rm(prevPairwise, { force: true }).catch(() => void 0);
    }
    currentVideo = stepOutput;
    accumulatedDuration += (durations[i] ?? 5) - transitionDuration;
  }
  if (audioMode === "mute") {
    return currentVideo;
  }
  const audioFilters = [];
  const delayedAudios = [];
  let audioOffset = 0;
  for (let i = 0; i < N; i++) {
    const inputIdx = i + 1;
    const audioDur = durations[i] ?? 5;
    const fadeStart = Math.max(0, audioDur - transitionDuration);
    if (audioMode === "firstOnly" && i > 0) {
      audioFilters.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${audioDur}[a${i}]`
      );
    } else if (hasAudioTracks[i]) {
      audioFilters.push(
        `[${inputIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,atrim=0:${audioDur},afade=t=out:st=${fadeStart}:d=${transitionDuration}[a${i}]`
      );
    } else {
      audioFilters.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${audioDur}[a${i}]`
      );
    }
    const delayMs = Math.round(audioOffset * 1e3);
    if (delayMs > 0) {
      audioFilters.push(`[a${i}]adelay=${delayMs}|${delayMs}[ad${i}]`);
      delayedAudios.push(`[ad${i}]`);
    } else {
      delayedAudios.push(`[a${i}]`);
    }
    audioOffset += audioDur - transitionDuration;
  }
  audioFilters.push(`${delayedAudios.join("")}amix=inputs=${N}:duration=longest:normalize=0[outa]`);
  const finalPath = join(tempDir, "output.mp4");
  const muxArgs = ["-threads", "2", "-i", currentVideo];
  for (const p of inputs) muxArgs.push("-i", p);
  muxArgs.push(
    "-filter_complex",
    audioFilters.join(";"),
    "-map",
    "0:v",
    "-map",
    "[outa]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-y",
    finalPath
  );
  logger.info("Pairwise xfade audio mux", { jobId });
  const r = await runFFmpeg(muxArgs, { timeoutMs: MERGE_TIMEOUT_MS, signal });
  if (r.exitCode !== 0) {
    const tail = r.stderr.split("\n").slice(-20).join("\n");
    throw new Error(`FFmpeg pairwise xfade audio mux failed (exit ${r.exitCode}):
${tail}`);
  }
  return finalPath;
}
function buildAtempoChainNative2(speed) {
  if (speed >= 0.5 && speed <= 2) return `atempo=${speed.toFixed(6)}`;
  const chain = [];
  let remaining = speed;
  while (remaining < 0.5) {
    chain.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2) {
    chain.push(2);
    remaining /= 2;
  }
  chain.push(remaining);
  return chain.map((s) => `atempo=${s.toFixed(6)}`).join(",");
}
async function generatePoster(jobId, workDir, sourcePath, durationSec, signal, logger) {
  const posterPath = join(workDir, "poster.jpg");
  const posterTimestamp = Math.min(1, Math.max(0, durationSec - 0.1));
  const r = await runFFmpeg(
    [
      "-y",
      "-ss",
      String(posterTimestamp),
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      posterPath
    ],
    { timeoutMs: 3e4, signal }
  );
  if (r.exitCode !== 0) {
    logger.warn("Poster generation failed (non-fatal)", {
      jobId,
      tail: r.stderr.split("\n").slice(-5).join("\n")
    });
    return null;
  }
  return posterPath;
}
async function runVideoMerge(input) {
  const logger = input.logger ?? NOOP_LOGGER5;
  const { config, jobId, workDir, inputPaths, cancelSignal: signal } = input;
  let workingPaths = inputPaths;
  if (config.beatSyncEnabled && config.beats) {
    const probedDurations = [];
    for (const p of inputPaths) {
      const info = await probeVideo(p);
      probedDurations.push(info?.duration ?? 5);
    }
    const beatsPer = config.beatsPerClip === "custom" && config.beatsPerClipCustom?.length ? config.beatsPerClipCustom : config.beatsPerClip ?? 2;
    const plan = resolveBeatSync({
      clipDurations: probedDurations,
      beatTimes: config.beats.beatTimes,
      barTimes: config.beats.barTimes,
      firstBeatOffset: config.firstBeatOffset ?? config.beats.firstBeat,
      beatsPerItem: beatsPer,
      speedTolerance: config.speedTolerance ?? 0.15
    });
    const out = [];
    for (let i = 0; i < inputPaths.length; i++) {
      const cp = plan.clips[i];
      if (!cp || cp.playbackSpeed === 1 && !cp.hardTrim) {
        out.push(inputPaths[i]);
        continue;
      }
      const retimed = join(workDir, `retimed-${i}.mp4`);
      const args = ["-i", inputPaths[i]];
      if (cp.hardTrim) {
        args.unshift("-ss", String(cp.hardTrim.startSec));
        args.push("-t", String(cp.hardTrim.endSec - cp.hardTrim.startSec));
      }
      if (cp.playbackSpeed !== 1) {
        const videoFilter = `setpts=${(1 / cp.playbackSpeed).toFixed(6)}*PTS`;
        const audioFilter = config.preservePitch ?? true ? buildAtempoChainNative2(cp.playbackSpeed) : `asetrate=44100*${cp.playbackSpeed.toFixed(6)},aresample=44100`;
        args.push("-filter:v", videoFilter, "-filter:a", audioFilter);
      }
      args.push(
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-preset",
        "fast",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-y",
        retimed
      );
      const r = await runFFmpeg(args, { timeoutMs: MERGE_TIMEOUT_MS, signal });
      if (r.exitCode !== 0) {
        throw new Error(
          `Beat-sync retime failed for clip ${i} (exit ${r.exitCode}):
${r.stderr.split("\n").slice(-10).join("\n")}`
        );
      }
      out.push(retimed);
    }
    workingPaths = out;
  }
  const inspections = [];
  for (let i = 0; i < workingPaths.length; i++) {
    const result = await inspectVideo(workingPaths[i]);
    if (!result.ok) throw new Error(`Input ${i + 1} unreadable: ${result.reason}`);
    if (!result.hasVideo) throw new Error(`Input ${i + 1} has no video stream`);
    if (!result.duration || result.duration <= 0) {
      throw new Error(
        `Input ${i + 1} has no parseable duration (codec=${result.videoCodec ?? "unknown"})`
      );
    }
    const hasKey = await hasKeyframeWithin(workingPaths[i], VALIDATE_KEYFRAME_WINDOW_SEC);
    if (!hasKey) {
      throw new Error(
        `Input ${i + 1} has no keyframe in first ${VALIDATE_KEYFRAME_WINDOW_SEC}s (open-GOP source; transcode and retry)`
      );
    }
    inspections.push({
      hasAudio: result.hasAudio,
      duration: result.duration,
      width: result.width,
      height: result.height,
      fps: result.fps,
      videoCodec: result.videoCodec,
      pixFmt: result.pixFmt
    });
  }
  const MAX_HEIGHT = 1080;
  let resolution = inspections[0]?.width ? { width: inspections[0].width, height: inspections[0].height } : { width: 1920, height: 1080 };
  if (resolution.height > MAX_HEIGHT) {
    const scale = MAX_HEIGHT / resolution.height;
    resolution = {
      width: Math.round(resolution.width * scale / 2) * 2,
      height: MAX_HEIGHT
    };
  }
  const durations = inspections.map((it) => it.duration);
  const hasAudioTracks = inspections.map((it) => it.hasAudio);
  const outputPath = join(workDir, "output.mp4");
  const transition = config.transition;
  const audioMode = config.audioMode;
  const usesXfade = transition === "crossfade" || transition === "fadeBlack";
  const N = workingPaths.length;
  let finalOutputPath;
  let computedDuration;
  if (usesXfade && N > 2 && !shouldUseSinglePassXfade(N, resolution)) {
    logger.info("Running FFmpeg merge (pairwise xfade, memory-bounded)", {
      jobId,
      inputCount: N,
      transition
    });
    finalOutputPath = await runPairwiseXfadeMerge({
      jobId,
      tempDir: workDir,
      inputs: workingPaths,
      durations,
      hasAudioTracks,
      transition,
      transitionDuration: config.transitionDuration,
      audioMode,
      resolution,
      signal,
      logger
    });
    computedDuration = durations.reduce((a, b) => a + b, 0) - (N - 1) * config.transitionDuration;
  } else if (transition === "none") {
    const normalizedPaths = [];
    for (let i = 0; i < workingPaths.length; i++) {
      const dest = join(workDir, `normalized-${i}.mp4`);
      const args2 = buildNormalizeCommand(workingPaths[i], dest, resolution, {
        hasAudio: inspections[i].hasAudio
      });
      logger.info("Normalizing input", {
        jobId,
        index: i,
        codec: inspections[i].videoCodec,
        pixFmt: inspections[i].pixFmt,
        fps: inspections[i].fps,
        hasAudio: inspections[i].hasAudio
      });
      const result2 = await runFFmpeg(args2, { timeoutMs: NORMALIZE_TIMEOUT_MS, signal });
      if (result2.exitCode !== 0) {
        const tail = result2.stderr.split("\n").slice(-20).join("\n");
        throw new Error(`Failed to normalize input ${i + 1} (exit ${result2.exitCode}):
${tail}`);
      }
      normalizedPaths.push(dest);
    }
    const listFile = join(workDir, "concat-list.txt");
    const listBody = normalizedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(listFile, `${listBody}
`, "utf8");
    const args = buildConcatDemuxerCommand(listFile, outputPath);
    logger.info("Running FFmpeg merge (concat demuxer)", { jobId, inputCount: N });
    const result = await runFFmpeg(args, { timeoutMs: MERGE_TIMEOUT_MS, signal });
    if (result.exitCode !== 0) {
      const tail = result.stderr.split("\n").slice(-20).join("\n");
      throw new Error(`FFmpeg concat-demuxer merge failed (exit ${result.exitCode}):
${tail}`);
    }
    finalOutputPath = outputPath;
    computedDuration = durations.reduce((a, b) => a + b, 0);
  } else {
    const args = buildTransitionCommand(
      workingPaths,
      durations,
      transition,
      config.transitionDuration,
      audioMode,
      hasAudioTracks,
      resolution
    );
    args.unshift("-threads", "0");
    args.push("-y", outputPath);
    logger.info("Running FFmpeg merge (single-pass xfade, no pre-normalize)", {
      jobId,
      inputCount: N,
      transition
    });
    const result = await runFFmpeg(args, { timeoutMs: MERGE_TIMEOUT_MS, signal });
    if (result.exitCode !== 0) {
      const tail = result.stderr.split("\n").slice(-20).join("\n");
      throw new Error(`FFmpeg merge failed (exit ${result.exitCode}):
${tail}`);
    }
    finalOutputPath = outputPath;
    computedDuration = durations.reduce((a, b) => a + b, 0) - (N - 1) * config.transitionDuration;
  }
  const posterFilePath = await generatePoster(
    jobId,
    workDir,
    finalOutputPath,
    computedDuration,
    signal,
    logger
  );
  return {
    outputFilePath: finalOutputPath,
    posterFilePath,
    durationSec: computedDuration,
    result: {
      clipCount: N,
      outputResolution: resolution
    }
  };
}
var NORMALIZE_TIMEOUT_MS2 = 90 * 1e3;
var CONCAT_TIMEOUT_MS = 5 * 60 * 1e3;
var VALIDATE_KEYFRAME_WINDOW_SEC2 = 5;
var MIN_SEGMENT_SEC = 1 / 30;
var NOOP_LOGGER6 = { info: () => {
}, warn: () => {
} };
function buildTrimPlan(clipDurations, audioDurationSec) {
  if (clipDurations.length === 0) {
    throw new Error("No video clips available to compose");
  }
  const plan = [];
  let remaining = audioDurationSec;
  for (let i = 0; i < clipDurations.length && remaining > MIN_SEGMENT_SEC; i++) {
    const clipDur = clipDurations[i];
    if (clipDur <= 0) continue;
    const take = Math.min(clipDur, remaining);
    plan.push({ inputIndex: i, durationSec: take });
    remaining -= take;
  }
  if (remaining > MIN_SEGMENT_SEC) {
    const lastIdx = (() => {
      for (let i = clipDurations.length - 1; i >= 0; i--) {
        if ((clipDurations[i] ?? 0) > 0) return i;
      }
      return -1;
    })();
    if (lastIdx < 0) {
      throw new Error("All input clips have zero duration; cannot loop to fill audio budget");
    }
    const loopClipDur = clipDurations[lastIdx];
    while (remaining > MIN_SEGMENT_SEC) {
      const take = Math.min(loopClipDur, remaining);
      plan.push({ inputIndex: lastIdx, durationSec: take });
      remaining -= take;
    }
  }
  return plan;
}
async function generatePoster2(jobId, workDir, sourcePath, durationSec, signal, logger) {
  const posterPath = join(workDir, "poster.jpg");
  const posterTimestamp = Math.min(1, Math.max(0, durationSec - 0.1));
  const r = await runFFmpeg(
    [
      "-y",
      "-ss",
      String(posterTimestamp),
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      posterPath
    ],
    { timeoutMs: 3e4, signal }
  );
  if (r.exitCode !== 0) {
    logger.warn("Poster generation failed (non-fatal)", {
      jobId,
      tail: r.stderr.split("\n").slice(-5).join("\n")
    });
    return null;
  }
  return posterPath;
}
async function runBrainrotCompose(input) {
  const logger = input.logger ?? NOOP_LOGGER6;
  const { jobId, workDir, audioPath, inputPaths, cancelSignal: signal } = input;
  const audioProbe = await inspectVideo(audioPath);
  if (!audioProbe.ok) throw new Error(`Voiceover unreadable: ${audioProbe.reason}`);
  if (!audioProbe.duration || audioProbe.duration <= 0) {
    throw new Error("Voiceover has no parseable duration");
  }
  const audioDuration = audioProbe.duration;
  const inspections = [];
  for (let i = 0; i < inputPaths.length; i++) {
    const result = await inspectVideo(inputPaths[i]);
    if (!result.ok) throw new Error(`Clip ${i + 1} unreadable: ${result.reason}`);
    if (!result.hasVideo) throw new Error(`Clip ${i + 1} has no video stream`);
    if (!result.duration || result.duration <= 0) {
      throw new Error(`Clip ${i + 1} has no parseable duration`);
    }
    const hasKey = await hasKeyframeWithin(inputPaths[i], VALIDATE_KEYFRAME_WINDOW_SEC2);
    if (!hasKey) {
      throw new Error(
        `Clip ${i + 1} has no keyframe in first ${VALIDATE_KEYFRAME_WINDOW_SEC2}s (open-GOP)`
      );
    }
    inspections.push({
      duration: result.duration,
      width: result.width,
      height: result.height,
      hasAudio: result.hasAudio
    });
  }
  const MAX_HEIGHT = 1080;
  let resolution = inspections[0]?.width ? { width: inspections[0].width, height: inspections[0].height } : { width: 1920, height: 1080 };
  if (resolution.height > MAX_HEIGHT) {
    const scale = MAX_HEIGHT / resolution.height;
    resolution = {
      width: Math.round(resolution.width * scale / 2) * 2,
      height: MAX_HEIGHT
    };
  }
  const plan = buildTrimPlan(
    inspections.map((i) => i.duration),
    audioDuration
  );
  logger.info("Composed trim plan", {
    jobId,
    audioDurationSec: audioDuration,
    entries: plan.length,
    totalSec: plan.reduce((a, b) => a + b.durationSec, 0)
  });
  const normalizedPaths = [];
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    const inspection = inspections[entry.inputIndex];
    const clipInput = inputPaths[entry.inputIndex];
    const dest = join(workDir, `seg-${i}.mp4`);
    const args = buildNormalizeCommand(clipInput, dest, resolution, {
      hasAudio: inspection.hasAudio
    });
    const yIdx = args.lastIndexOf("-y");
    if (yIdx < 0) {
      throw new Error("Internal: buildNormalizeCommand output shape changed");
    }
    args.splice(yIdx, 0, "-t", entry.durationSec.toFixed(6));
    logger.info("Normalizing segment", {
      jobId,
      segment: i,
      inputIndex: entry.inputIndex,
      durationSec: entry.durationSec
    });
    const result = await runFFmpeg(args, { timeoutMs: NORMALIZE_TIMEOUT_MS2, signal });
    if (result.exitCode !== 0) {
      const tail = result.stderr.split("\n").slice(-20).join("\n");
      throw new Error(`Normalize segment ${i} failed (exit ${result.exitCode}):
${tail}`);
    }
    normalizedPaths.push(dest);
  }
  const listFile = join(workDir, "concat-list.txt");
  const listBody = normalizedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listFile, `${listBody}
`, "utf8");
  const outputPath = join(workDir, "output.mp4");
  const concatArgs = buildConcatDemuxerCommand(listFile, outputPath);
  logger.info("Running concat demuxer", { jobId, segments: normalizedPaths.length });
  const r = await runFFmpeg(concatArgs, { timeoutMs: CONCAT_TIMEOUT_MS, signal });
  if (r.exitCode !== 0) {
    const tail = r.stderr.split("\n").slice(-20).join("\n");
    throw new Error(`Concat failed (exit ${r.exitCode}):
${tail}`);
  }
  const durationSec = plan.reduce((a, b) => a + b.durationSec, 0);
  const posterFilePath = await generatePoster2(
    jobId,
    workDir,
    outputPath,
    durationSec,
    signal,
    logger
  );
  return {
    outputFilePath: outputPath,
    posterFilePath,
    durationSec,
    result: {
      clipCount: plan.length
    }
  };
}

// backend/src/worker-daemon/index.ts
var CAPABILITIES = [
  "caption-rendering",
  "slideshow-rendering",
  "video-merge",
  "video-trim",
  "audio-overlay",
  "brainrot-compose"
];
var HEARTBEAT_INTERVAL_MS = 15e3;
var RECONNECT_BASE_MS = 1e3;
var RECONNECT_MAX_MS = 3e4;
var ENTRY_POINT = path.resolve(process.cwd(), "remotion/Root.tsx");
function resolvePrebuiltBundleDir() {
  const override = process.env.WYREN_REMOTION_BUNDLE_DIR?.trim();
  if (override) return path.resolve(override);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const installRelative = path.join(moduleDir, "remotion-bundle");
  if (fs.existsSync(path.join(installRelative, "index.html"))) {
    return installRelative;
  }
  return path.resolve(process.cwd(), "backend/dist/remotion-bundle");
}
var PREBUILT_BUNDLE_DIR = resolvePrebuiltBundleDir();
function log(msg, ctx) {
  const suffix = ctx && Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[daemon] ${msg}${suffix}`);
}
function logError(msg, err) {
  console.error(`[daemon] ${msg}`, err instanceof Error ? err.stack ?? err.message : err);
}
function resolveConfig() {
  const token = process.env.WYREN_API_KEY?.trim();
  if (!token) {
    throw new Error("WYREN_API_KEY is required (a frm_... MCP API key or a backend-issued JWT).");
  }
  const backendUrl = (process.env.WYREN_BACKEND_URL ?? "http://localhost:4000").replace(/\/$/, "");
  const concurrency = Math.max(1, os.cpus().length - 1);
  return { token, backendUrl, concurrency };
}
function wsUrlFor(backendUrl) {
  const ws = backendUrl.replace(/^http/, "ws");
  return `${ws}/api/workers/connect`;
}
var cachedBundlePath = null;
async function resolveBundle() {
  if (cachedBundlePath) return cachedBundlePath;
  const prebuiltIndex = path.join(PREBUILT_BUNDLE_DIR, "index.html");
  if (fs.existsSync(prebuiltIndex)) {
    log("Using pre-built Remotion bundle", { dir: PREBUILT_BUNDLE_DIR });
    cachedBundlePath = PREBUILT_BUNDLE_DIR;
    return cachedBundlePath;
  }
  if (!fs.existsSync(ENTRY_POINT)) {
    throw new Error(
      `Prebuilt Remotion bundle not found at ${PREBUILT_BUNDLE_DIR} and no Remotion source tree is available to live-bundle. Set WYREN_REMOTION_BUNDLE_DIR to the directory containing the prebuilt bundle's index.html.`
    );
  }
  log("No pre-built bundle found; bundling live (this is slow)", { entry: ENTRY_POINT });
  cachedBundlePath = await bundle();
  log("Live bundle ready", { path: cachedBundlePath });
  return cachedBundlePath;
}
var BackendClient = class {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }
  baseUrl;
  token;
  authHeaders() {
    return { Authorization: `Bearer ${this.token}` };
  }
  async getJob(jobId) {
    const res = await fetch(`${this.baseUrl}/api/jobs/${jobId}`, {
      headers: this.authHeaders()
    });
    if (!res.ok) {
      throw new Error(`GET /api/jobs/${jobId} \u2192 ${res.status} ${await res.text()}`);
    }
    return await res.json();
  }
  async markProcessing(jobId) {
    await this.post(`/api/jobs/${jobId}/processing`, {});
  }
  async complete(jobId, body) {
    await this.post(`/api/jobs/${jobId}/complete`, body);
  }
  async fail(jobId, reason, retryable) {
    await this.post(`/api/jobs/${jobId}/fail`, { reason, retryable });
  }
  /** Upload a rendered video output via a backend-issued presigned URL. */
  async uploadVideo(localPath) {
    return this.uploadViaPresign(localPath, "/api/upload/video/presign", "video/mp4", "merged");
  }
  /** Upload a poster frame via a backend-issued presigned URL. */
  async uploadPoster(localPath) {
    return this.uploadViaPresign(localPath, "/api/upload/image/presign", "image/jpeg");
  }
  /**
   * Upload a local file to R2 WITHOUT R2 credentials: ask the backend (which
   * holds the keys) for a short-lived presigned PUT URL scoped to this user,
   * PUT the bytes to it, and return the public URL. This is what lets the
   * daemon run on arbitrary end-user machines — no R2 secrets are ever shipped
   * to or stored on the worker. Mirrors `shared/lib/storage/clientUpload.ts`
   * (only `Content-Type` is sent on the PUT; R2 signs no other required header).
   */
  async uploadViaPresign(localPath, endpoint, contentType, purpose) {
    const size = fs.statSync(localPath).size;
    const body = {
      filename: path.basename(localPath),
      contentType,
      size
    };
    if (purpose) body.purpose = purpose;
    const presignRes = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!presignRes.ok) {
      throw new Error(`presign ${endpoint} \u2192 ${presignRes.status} ${await presignRes.text()}`);
    }
    const { uploadUrl, publicUrl } = await presignRes.json();
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: fs.readFileSync(localPath)
    });
    if (!putRes.ok) {
      throw new Error(`presigned PUT \u2192 ${putRes.status} ${await putRes.text()}`);
    }
    return publicUrl;
  }
  async post(pathname, body) {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`POST ${pathname} \u2192 ${res.status} ${await res.text()}`);
    }
  }
};
function daemonLogger(jobId) {
  return {
    info: (msg, ctx) => log(msg, { jobId, ...ctx ?? {} }),
    warn: (msg, ctx) => log(`WARN ${msg}`, { jobId, ...ctx ?? {} })
  };
}
function progressSender(ctx) {
  return (pct) => {
    if (ctx.socket.readyState === WebSocket.OPEN) {
      ctx.socket.send(JSON.stringify({ type: "progress", jobId: ctx.jobId, pct }));
    }
  };
}
async function uploadOutputBuffer(ctx, outputFilePath) {
  log("Render complete; uploading", {
    jobId: ctx.jobId,
    bytes: fs.statSync(outputFilePath).size
  });
  return ctx.client.uploadVideo(outputFilePath);
}
var captionHandler = async (ctx) => {
  const config = ctx.job.config ?? {};
  if (!config.videoUrl) throw new Error(`Job ${ctx.jobId} config missing videoUrl`);
  if (!config.captionConfig) throw new Error(`Job ${ctx.jobId} config missing captionConfig`);
  await validateExternalUrl(config.videoUrl);
  const bundlePath = await resolveBundle();
  const { outputFilePath, durationSec } = await renderCaptions({
    bundlePath,
    jobId: ctx.jobId,
    videoUrl: config.videoUrl,
    captionConfig: config.captionConfig,
    workDir: ctx.workDir,
    concurrency: ctx.concurrency,
    cancelSignal: ctx.cancelSignal,
    onProgress: progressSender(ctx),
    logger: daemonLogger(ctx.jobId)
  });
  const outputUrl = await uploadOutputBuffer(ctx, outputFilePath);
  await ctx.client.complete(ctx.jobId, {
    outputUrl,
    durationSec,
    sourceVideoUrl: config.videoUrl
  });
};
var slideshowHandler = async (ctx) => {
  const config = ctx.job.config ?? {};
  const bundlePath = await resolveBundle();
  const { outputFilePath, durationSec, result } = await renderSlideshow({
    bundlePath,
    jobId: ctx.jobId,
    config,
    workDir: ctx.workDir,
    concurrency: ctx.concurrency,
    cancelSignal: ctx.cancelSignal,
    validateUrl: validateExternalUrl,
    onProgress: progressSender(ctx),
    logger: daemonLogger(ctx.jobId)
  });
  const outputUrl = await uploadOutputBuffer(ctx, outputFilePath);
  await ctx.client.complete(ctx.jobId, { outputUrl, durationSec, result });
};
var videoTrimHandler = async (ctx) => {
  const config = ctx.job.config ?? {};
  const { outputFilePath, durationSec, result } = await runVideoTrim({
    jobId: ctx.jobId,
    config,
    workDir: ctx.workDir,
    cancelSignal: ctx.cancelSignal,
    validateUrl: validateExternalUrl,
    logger: daemonLogger(ctx.jobId)
  });
  const outputUrl = await uploadOutputBuffer(ctx, outputFilePath);
  await ctx.client.complete(ctx.jobId, { outputUrl, durationSec, result });
};
var audioOverlayHandler = async (ctx) => {
  const config = ctx.job.config ?? {};
  const { outputFilePath, durationSec, result } = await runAudioOverlay({
    jobId: ctx.jobId,
    config,
    workDir: ctx.workDir,
    cancelSignal: ctx.cancelSignal,
    validateUrl: validateExternalUrl,
    logger: daemonLogger(ctx.jobId)
  });
  const outputUrl = await uploadOutputBuffer(ctx, outputFilePath);
  await ctx.client.complete(ctx.jobId, { outputUrl, durationSec, result });
};
var videoMergeHandler = async (ctx) => {
  const config = ctx.job.config ?? {};
  let videoUrls = config.videoUrls;
  if (config.videoOrder?.length) {
    videoUrls = config.videoOrder.map((idx) => config.videoUrls[idx]);
  }
  const inputPaths = [];
  for (let i = 0; i < videoUrls.length; i++) {
    const url = videoUrls[i];
    await validateExternalUrl(url);
    const filePath = path.join(ctx.workDir, `input${i}.mp4`);
    await downloadToFile(url, filePath);
    inputPaths.push(filePath);
  }
  const { outputFilePath, posterFilePath, durationSec, result } = await runVideoMerge({
    jobId: ctx.jobId,
    config,
    workDir: ctx.workDir,
    inputPaths,
    cancelSignal: ctx.cancelSignal,
    logger: daemonLogger(ctx.jobId)
  });
  const outputUrl = await ctx.client.uploadVideo(outputFilePath);
  let posterUrl;
  if (posterFilePath) {
    try {
      posterUrl = await ctx.client.uploadPoster(posterFilePath);
    } catch (err) {
      log(`WARN poster upload failed (non-fatal)`, {
        jobId: ctx.jobId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  await ctx.client.complete(ctx.jobId, { outputUrl, durationSec, posterUrl, result });
};
var brainrotComposeHandler = async (ctx) => {
  const config = ctx.job.config ?? {};
  if (!config.videoUrls || config.videoUrls.length === 0) {
    throw new Error("brainrot-compose requires at least one video URL");
  }
  await validateExternalUrl(config.audioUrl);
  const audioPath = path.join(ctx.workDir, "voiceover.audio");
  await downloadToFile(config.audioUrl, audioPath);
  const inputPaths = [];
  for (let i = 0; i < config.videoUrls.length; i++) {
    const url = config.videoUrls[i];
    await validateExternalUrl(url);
    const filePath = path.join(ctx.workDir, `clip-${i}.mp4`);
    await downloadToFile(url, filePath);
    inputPaths.push(filePath);
  }
  const { outputFilePath, posterFilePath, durationSec, result } = await runBrainrotCompose({
    jobId: ctx.jobId,
    workDir: ctx.workDir,
    audioPath,
    inputPaths,
    cancelSignal: ctx.cancelSignal,
    logger: daemonLogger(ctx.jobId)
  });
  const outputUrl = await ctx.client.uploadVideo(outputFilePath);
  let posterUrl;
  if (posterFilePath) {
    try {
      posterUrl = await ctx.client.uploadPoster(posterFilePath);
    } catch (err) {
      log(`WARN poster upload failed (non-fatal)`, {
        jobId: ctx.jobId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  await ctx.client.complete(ctx.jobId, { outputUrl, durationSec, posterUrl, result });
};
var JOB_HANDLERS = {
  "caption-rendering": captionHandler,
  "slideshow-rendering": slideshowHandler,
  "video-trim": videoTrimHandler,
  "audio-overlay": audioOverlayHandler,
  "video-merge": videoMergeHandler,
  "brainrot-compose": brainrotComposeHandler
};
async function runJob(socket, client, jobType, jobId, concurrency, cancelSignal) {
  const handler4 = JOB_HANDLERS[jobType];
  if (!handler4) throw new Error(`Daemon has no runner for jobType '${jobType}'`);
  log("Picking up job", { jobType, jobId });
  const job = await client.getJob(jobId);
  const userId = job.user_id;
  if (!userId) throw new Error(`Job ${jobId} has no user_id`);
  await client.markProcessing(jobId);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `wyren-daemon-${jobId}-`));
  try {
    await handler4({ socket, client, jobId, userId, job, concurrency, cancelSignal, workDir });
    log("Job completed", { jobType, jobId });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
function parseServerMsg(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type === "dispatch") return parsed;
    return null;
  } catch {
    return null;
  }
}
var Daemon = class {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new BackendClient(cfg.backendUrl, cfg.token);
  }
  cfg;
  client;
  socket = null;
  heartbeat = null;
  reconnectTimer = null;
  reconnectAttempts = 0;
  inFlight = /* @__PURE__ */ new Map();
  stopped = false;
  start() {
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    const url = wsUrlFor(this.cfg.backendUrl);
    log("Connecting to backend WebSocket", { url });
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.cfg.token}` }
    });
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      log("WebSocket open; registering", { capabilities: [...CAPABILITIES] });
      this.sendRegisterBurst();
      this.startHeartbeat();
    });
    socket.on("message", (data) => {
      const msg = parseServerMsg(data.toString());
      if (!msg) return;
      void this.handleDispatch(socket, msg);
    });
    socket.on("close", (code, reason) => {
      log("WebSocket closed", {
        code,
        reason: reason.toString(),
        inFlight: this.inFlight.size
      });
      this.cleanupSocket();
      this.scheduleReconnect();
    });
    socket.on("error", (err) => {
      logError("WebSocket error", err);
    });
  }
  async handleDispatch(socket, msg) {
    const { jobType, jobId } = msg;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ack", jobId }));
    }
    log("Dispatch received", { jobType, jobId });
    if (!CAPABILITIES.includes(jobType)) {
      logError(`Unsupported jobType '${jobType}'`, new Error("no runner"));
      await this.safeFail(jobId, `Daemon has no runner for jobType '${jobType}'`, true);
      return;
    }
    const controller = new AbortController();
    this.inFlight.set(jobId, controller);
    try {
      await runJob(socket, this.client, jobType, jobId, this.cfg.concurrency, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        log("Job aborted (will be retried by backend fallback)", { jobId });
        return;
      }
      logError(`Job ${jobId} (${jobType}) failed`, err);
      await this.safeFail(jobId, err instanceof Error ? err.message : String(err), true);
    } finally {
      this.inFlight.delete(jobId);
    }
  }
  async safeFail(jobId, reason, retryable) {
    try {
      await this.client.fail(jobId, reason, retryable);
    } catch (err) {
      logError(`Failed to report failure for job ${jobId}`, err);
    }
  }
  sendRegisterBurst() {
    const payload = JSON.stringify({ type: "register", capabilities: [...CAPABILITIES] });
    let attempts = 0;
    const send = () => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this.socket.send(payload);
      attempts += 1;
      if (attempts < 4) {
        const timer = setTimeout(send, 400);
        timer.unref?.();
      }
    };
    send();
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }
  stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
  cleanupSocket() {
    this.stopHeartbeat();
    this.socket = null;
  }
  abortAllInFlight(reason) {
    for (const [jobId, controller] of this.inFlight.entries()) {
      log("Aborting in-flight job", { jobId, reason });
      controller.abort();
    }
    this.inFlight.clear();
  }
  scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
    log("Scheduling reconnect", { attempt: this.reconnectAttempts, delayMs: delay });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
  stop() {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abortAllInFlight("daemon shutdown");
    try {
      this.socket?.close(1e3, "shutdown");
    } catch {
    }
  }
};
async function preflight() {
  log("Preflight: ensuring headless browser (downloads ~500MB on first run)");
  try {
    await ensureBrowser({
      onBrowserDownload: () => ({
        version: null,
        onProgress: ({ percent }) => {
          log("Browser download progress", { percent: Math.round(percent * 100) });
        }
      })
    });
    log("Headless browser ready");
  } catch (err) {
    logError("ensureBrowser failed \u2014 caption renders will fail until resolved", err);
    throw err;
  }
  await resolveBundle();
}
async function main() {
  const cfg = resolveConfig();
  log("Local worker daemon starting", {
    backendUrl: cfg.backendUrl,
    concurrency: cfg.concurrency,
    capabilities: [...CAPABILITIES]
  });
  await preflight();
  const daemon = new Daemon(cfg);
  daemon.start();
  const shutdown = (sig) => {
    log(`Received ${sig}; shutting down`);
    daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
main().catch((err) => {
  logError("Daemon fatal error", err);
  process.exit(1);
});
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map