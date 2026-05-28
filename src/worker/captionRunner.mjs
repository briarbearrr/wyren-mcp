/**
 * Caption render runner (vendored from monorepo).
 *
 * CO-EVOLUTION: keep in sync with
 *   briarbearrr/frames →
 *     shared/lib/workers/runners/captionRendering.ts
 *
 * That file is the source of truth; this is a hand-ported ESM copy used
 * by `wyren-mcp worker start` so the daemon ships as a single tiny npm
 * install. When the monorepo file changes, update this file in the same
 * PR or in the very next one.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeCancelSignal, renderMedia, selectComposition } from '@remotion/renderer';
import { runFFmpeg } from './ffmpegNative.mjs';

export const CAPTION_FPS = 30;
export const SEGMENT_THRESHOLD_SECONDS = 12;
export const SEGMENT_SECONDS = 8;

function buildConcatDemuxerCommand(listFile, outputFile) {
  return [
    '-threads',
    '2',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-y',
    outputFile,
  ];
}

async function renderSinglePass(opts, progressBase = 0, progressSpan = 0.95) {
  const { bundlePath, jobId, signal, tmpDir, videoUrl, captionConfig, concurrency, onProgress, logger } =
    opts;
  const inputProps = { ...captionConfig, videoUrl };

  const composition = await selectComposition({
    serveUrl: bundlePath,
    id: 'VideoCaptions',
    inputProps,
    timeoutInMilliseconds: 120_000,
  });
  logger.info('single-pass composition selected', { jobId });

  const outputLocation = path.join(tmpDir, 'output.mp4');
  const { cancelSignal, cancel } = makeCancelSignal();
  signal.addEventListener('abort', () => cancel(), { once: true });

  await renderMedia({
    composition,
    serveUrl: bundlePath,
    codec: 'h264',
    outputLocation,
    inputProps,
    concurrency,
    timeoutInMilliseconds: 120_000,
    onProgress: ({ progress }) => {
      const overall = progressBase + progress * progressSpan;
      if (onProgress) {
        Promise.resolve(onProgress(Math.min(overall, 0.95))).catch(() => {});
      }
    },
    cancelSignal,
  });

  const finalBytes = existsSync(outputLocation) ? statSync(outputLocation).size : 0;
  logger.info('single-pass render complete', { jobId, finalBytes });
  return outputLocation;
}

async function renderChunked(opts, totalSeconds) {
  const { bundlePath, jobId, signal, tmpDir, videoUrl, captionConfig, concurrency, onProgress, logger } =
    opts;

  const allWords = Array.isArray(captionConfig.words) ? captionConfig.words : [];
  const segmentCount = Math.ceil(totalSeconds / SEGMENT_SECONDS);
  const segmentPaths = [];

  logger.info('rendering captions in chunks', { jobId, totalSeconds, segmentCount });

  for (let i = 0; i < segmentCount; i++) {
    if (signal.aborted) throw new Error('Caption render aborted');

    const startSec = i * SEGMENT_SECONDS;
    const endSec = Math.min(startSec + SEGMENT_SECONDS, totalSeconds);
    const segDurationSec = endSec - startSec;

    const trimmedSrc = path.join(tmpDir, `src-seg-${i}.mp4`);
    await runFFmpeg(
      [
        '-y',
        '-loglevel',
        'error',
        '-ss',
        startSec.toFixed(3),
        '-i',
        videoUrl,
        '-t',
        segDurationSec.toFixed(3),
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-avoid_negative_ts',
        'make_zero',
        trimmedSrc,
      ],
      { signal, timeoutMs: 60_000 },
    );

    const windowStartMs = startSec * 1000;
    const windowEndMs = endSec * 1000;
    const segmentWords = allWords
      .filter((w) => w.endMs > windowStartMs && w.startMs < windowEndMs)
      .map((w) => ({
        text: w.text,
        startMs: Math.max(0, w.startMs - windowStartMs),
        endMs: Math.min(segDurationSec * 1000, w.endMs - windowStartMs),
      }));

    const segmentInputProps = {
      ...captionConfig,
      videoUrl: `file://${trimmedSrc}`,
      words: segmentWords,
      durationInFrames: Math.max(1, Math.ceil(segDurationSec * CAPTION_FPS)),
    };

    const segmentComposition = await selectComposition({
      serveUrl: bundlePath,
      id: 'VideoCaptions',
      inputProps: segmentInputProps,
      timeoutInMilliseconds: 60_000,
    });

    const segOut = path.join(tmpDir, `cap-seg-${i}.mp4`);
    const { cancelSignal, cancel } = makeCancelSignal();
    const onAbort = () => cancel();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await renderMedia({
        composition: segmentComposition,
        serveUrl: bundlePath,
        codec: 'h264',
        outputLocation: segOut,
        inputProps: segmentInputProps,
        concurrency,
        timeoutInMilliseconds: 180_000,
        onProgress: ({ progress }) => {
          const overall = (i + progress) / segmentCount;
          if (onProgress) {
            Promise.resolve(onProgress(Math.min(overall * 0.95, 0.95))).catch(() => {});
          }
        },
        cancelSignal,
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    segmentPaths.push(segOut);
    logger.info('chunk render done', { jobId, chunkIdx: i });
  }

  const concatListPath = path.join(tmpDir, 'concat.txt');
  writeFileSync(
    concatListPath,
    segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
  );

  const finalOutput = path.join(tmpDir, 'output.mp4');
  await runFFmpeg(buildConcatDemuxerCommand(concatListPath, finalOutput), {
    signal,
    timeoutMs: 60_000,
  });

  logger.info('chunked render complete', { jobId, segmentCount });
  return finalOutput;
}

export async function renderCaptions(input) {
  const logger = input.logger ?? { info: () => {}, warn: () => {} };
  const rawFrames = input.captionConfig?.durationInFrames ?? 0;
  if (!rawFrames) {
    throw new Error(`Caption render for job ${input.jobId} has invalid durationInFrames`);
  }
  const totalSeconds = rawFrames / CAPTION_FPS;
  const chunked = totalSeconds > SEGMENT_THRESHOLD_SECONDS;

  mkdirSync(input.workDir, { recursive: true });

  const chunkInputs = {
    bundlePath: input.bundlePath,
    jobId: input.jobId,
    signal: input.cancelSignal,
    tmpDir: input.workDir,
    videoUrl: input.videoUrl,
    captionConfig: input.captionConfig,
    concurrency: input.concurrency,
    onProgress: input.onProgress,
    logger,
  };

  const outputFilePath = chunked
    ? await renderChunked(chunkInputs, totalSeconds)
    : await renderSinglePass(chunkInputs);

  const durationSec = Math.round((rawFrames / CAPTION_FPS) * 10) / 10;
  return { outputFilePath, durationSec };
}
