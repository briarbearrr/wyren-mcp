#!/usr/bin/env node
// Worker launcher — the entry point the OS auto-start service runs at login.
//
// Why a launcher instead of pointing the service directly at the worker:
//   1. The `frm_...` key lives ONLY in `~/.wyren/config.json` (0600). Baking it
//      into a launchd plist / systemd unit would leak it into a world-readable
//      file. This launcher reads the 0600 config at start time and injects the
//      key + backend URL into the worker's env.
//   2. It resolves the shipped Remotion bundle path relative to this package,
//      so the service definition stays path-stable across npm updates.
//
// The service runs: `node <pkg>/worker-launcher.mjs`. Everything else is
// derived here.

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(homedir(), '.wyren', 'config.json');

const DEFAULT_BACKEND_URL = 'https://api.wyren.ai';

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`[wyren-worker] No config at ${CONFIG_PATH}. Run \`npx wyren-mcp\` to log in.`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`[wyren-worker] Failed to read ${CONFIG_PATH}:`, err.message);
    process.exit(1);
  }
}

const config = loadConfig();
const apiKey = config.apiKey;
if (!apiKey) {
  console.error('[wyren-worker] config.json has no apiKey. Re-run `npx wyren-mcp` to log in.');
  process.exit(1);
}

const workerEntry = join(__dirname, 'worker-standalone', 'index.mjs');
const bundleDir = join(__dirname, 'remotion-bundle');

if (!existsSync(workerEntry)) {
  console.error(`[wyren-worker] Worker artifact missing at ${workerEntry}.`);
  process.exit(1);
}

const child = spawn(process.execPath, [workerEntry], {
  stdio: 'inherit',
  env: {
    ...process.env,
    WYREN_API_KEY: apiKey,
    WYREN_BACKEND_URL: config.backendUrl || DEFAULT_BACKEND_URL,
    WYREN_REMOTION_BUNDLE_DIR: bundleDir,
  },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
