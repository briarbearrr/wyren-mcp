// Cross-platform "open this URL in the default browser".
//
// No dependency on the `open` npm package — a tiny spawn of the platform's
// native opener keeps the installer dependency-free for the auth step. Best
// effort: if the spawn fails (headless box, no DISPLAY), the caller still
// prints the URL for the user to open manually.

import { spawn } from 'child_process';

export function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // `start` is a cmd builtin; the empty title arg avoids quoting pitfalls.
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
