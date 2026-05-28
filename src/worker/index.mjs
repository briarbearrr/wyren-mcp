/**
 * wyren-mcp worker daemon entrypoint.
 *
 * Connects to the Wyren backend over WebSocket, declares its capabilities
 * (`caption-rendering` for the MVP), and waits for the backend dispatcher
 * to push jobs. For each job:
 *
 *   1. GET /api/jobs/:id            → fetch config
 *   2. POST /api/jobs/:id/processing → mark processing
 *   3. Resolve Remotion bundle (cached) + tempdir + concurrency
 *   4. renderCaptions(...)          → local h264 mp4
 *   5. Upload mp4 to R2 via the existing upload_media flow
 *   6. POST /api/jobs/:id/complete  → persist result, settle billing,
 *                                     write-back, mark completed
 *
 * On error, POST /api/jobs/:id/fail so the backend's in-process recovery
 * system can take over.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { ensureBrowser } from '@remotion/renderer';
import WebSocket from 'ws';
import { renderCaptions } from './captionRunner.mjs';

const CAPABILITIES = ['caption-rendering'];
const BACKEND_URL = process.env.WYREN_BACKEND_URL ?? 'https://api.wyren.ai';
const API_KEY = process.env.WYREN_API_KEY;
const HOME_DIR = path.join(homedir(), '.wyren-worker');
const BUNDLE_CACHE_PATH = path.join(HOME_DIR, 'remotion-bundle.txt');

function log(level, msg, ctx) {
  const out = ctx
    ? `[${new Date().toISOString()}] [${level}] ${msg} ${JSON.stringify(ctx)}`
    : `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (level === 'error' || level === 'warn') console.error(out);
  else console.log(out);
}

function wsUrl() {
  const u = new URL(BACKEND_URL);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/workers/connect';
  return u.toString();
}

async function probeFfmpeg() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (err) => {
      resolve(!err);
    });
  });
}

async function authedFetch(method, urlPath, body) {
  const res = await fetch(`${BACKEND_URL}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${urlPath} → ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/**
 * Upload a local mp4 to Wyren-managed R2 via the existing presign flow,
 * then return the public URL. Mirrors the MCP upload_media tool's path.
 */
async function uploadVideoFromPath(localPath, jobId) {
  const buf = readFileSync(localPath);
  const filename = `worker-${jobId}.mp4`;
  const presign = await authedFetch('POST', '/api/upload/video/presign', {
    filename,
    contentType: 'video/mp4',
    size: buf.length,
    purpose: 'caption-output',
  });
  const { uploadUrl, publicUrl } = presign;

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: buf,
    headers: {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=31536000',
    },
  });
  if (!put.ok) {
    const text = await put.text().catch(() => '');
    throw new Error(`R2 PUT failed (${put.status}): ${text.slice(0, 200)}`);
  }
  return publicUrl;
}

async function resolveRemotionBundle() {
  // The bundle path is fetched from the backend (it owns the bundle build
  // pipeline). For the MVP, we accept WYREN_REMOTION_BUNDLE_URL as an env
  // override and fall back to a cached value the user can prime once.
  const override = process.env.WYREN_REMOTION_BUNDLE_URL;
  if (override) return override;

  if (existsSync(BUNDLE_CACHE_PATH)) {
    const cached = readFileSync(BUNDLE_CACHE_PATH, 'utf8').trim();
    if (cached) return cached;
  }

  throw new Error(
    'No Remotion bundle resolved. Set WYREN_REMOTION_BUNDLE_URL or prime ' +
      `${BUNDLE_CACHE_PATH} with a bundle serveUrl/path.`,
  );
}

function pickCpuConcurrency() {
  const override = process.env.WYREN_RENDER_CONCURRENCY;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 1;
}

async function handleCaptionJob(jobId, sendProgress) {
  const job = await authedFetch('GET', `/api/jobs/${jobId}`);
  const config = job?.config ?? job;
  if (!config?.videoUrl || !config?.captionConfig) {
    throw new Error(`Job ${jobId} missing videoUrl or captionConfig`);
  }

  await authedFetch('POST', `/api/jobs/${jobId}/processing`);

  const bundlePath = await resolveRemotionBundle();
  const concurrency = pickCpuConcurrency();
  const workDir = path.join(tmpdir(), `wyren-caption-${jobId}`);
  mkdirSync(workDir, { recursive: true });

  const cancelController = new AbortController();
  try {
    const { outputFilePath, durationSec } = await renderCaptions({
      bundlePath,
      jobId,
      videoUrl: config.videoUrl,
      captionConfig: config.captionConfig,
      workDir,
      concurrency,
      cancelSignal: cancelController.signal,
      onProgress: (pct) => sendProgress(jobId, pct),
      logger: { info: (m, c) => log('info', m, c), warn: (m, c) => log('warn', m, c) },
    });

    const outputUrl = await uploadVideoFromPath(outputFilePath, jobId);

    await authedFetch('POST', `/api/jobs/${jobId}/complete`, {
      outputUrl,
      durationSec,
      sourceVideoUrl: config.videoUrl,
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function startWorker() {
  if (!API_KEY) {
    console.error('WYREN_API_KEY is required.');
    process.exit(1);
  }

  mkdirSync(HOME_DIR, { recursive: true });

  log('info', 'probing ffmpeg…');
  if (!(await probeFfmpeg())) {
    console.error('System `ffmpeg` not found on PATH.');
    console.error('Install: macOS `brew install ffmpeg` · Ubuntu `sudo apt install ffmpeg`.');
    process.exit(1);
  }

  log('info', 'ensuring chrome-headless-shell…');
  try {
    await ensureBrowser();
  } catch (err) {
    log('warn', 'ensureBrowser failed (non-fatal — will retry per render)', {
      error: err?.message,
    });
  }

  let backoffMs = 1_000;
  // Reconnect loop: connect, run until close, sleep, repeat. Backoff caps at 30s.
  while (true) {
    try {
      await runConnection();
      backoffMs = 1_000; // healthy close resets backoff
    } catch (err) {
      log('warn', 'connection lost — reconnecting', { error: err?.message, backoffMs });
    }
    await wait(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}

function runConnection() {
  return new Promise((resolve, reject) => {
    const url = wsUrl();
    log('info', 'connecting', { url });

    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    let heartbeat = null;
    const sendProgress = (jobId, pct) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'progress', jobId, pct }));
      }
    };

    socket.on('open', () => {
      log('info', 'WS open — sending register', { capabilities: CAPABILITIES });
      socket.send(JSON.stringify({ type: 'register', capabilities: CAPABILITIES, bridgeUrl: null }));
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'heartbeat' }));
        }
      }, 15_000);
      heartbeat.unref?.();
    });

    socket.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== 'dispatch') return;
      const { jobType, jobId } = msg;
      log('info', 'dispatch received', { jobType, jobId });
      socket.send(JSON.stringify({ type: 'ack', jobId }));

      try {
        if (jobType === 'caption-rendering') {
          await handleCaptionJob(jobId, sendProgress);
          log('info', 'job completed', { jobId });
        } else {
          throw new Error(`Unsupported jobType: ${jobType}`);
        }
      } catch (err) {
        log('error', 'job failed', { jobId, error: err?.message });
        try {
          await authedFetch('POST', `/api/jobs/${jobId}/fail`, {
            reason: err?.message ?? 'unknown error',
            retryable: true,
          });
        } catch (failErr) {
          log('error', 'failed to report failure', { jobId, error: failErr?.message });
        }
      }
    });

    socket.on('close', (code, reason) => {
      if (heartbeat) clearInterval(heartbeat);
      log('info', 'WS closed', { code, reason: reason?.toString() });
      resolve();
    });

    socket.on('error', (err) => {
      if (heartbeat) clearInterval(heartbeat);
      reject(err);
    });
  });
}

// Allow `node src/worker/index.mjs` invocation for dev.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  startWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
