/**
 * Native FFmpeg wrapper for the local-worker daemon.
 *
 * The daemon expects a system `ffmpeg` binary on PATH (probed at startup).
 * We deliberately don't bundle `ffmpeg-static` here — keeps install size
 * down, and a system ffmpeg is more reliable on macOS/Linux dev boxes.
 */

import { execFile } from 'node:child_process';

export function runFFmpeg(args, { signal, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('ffmpeg', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr?.toString?.()?.slice(-2_000) ?? '';
        reject(new Error(`ffmpeg failed: ${err.message}\n${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (signal) {
      const onAbort = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
