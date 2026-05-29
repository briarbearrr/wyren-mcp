#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { CONFIG_PATH, LOG_PATH, readConfig, writeConfig } from './lib/config.mjs';
import { deviceLogin } from './lib/device-auth.mjs';
import { installService, uninstallService } from './lib/service.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_URL = 'https://api.wyren.ai/mcp';
const BACKEND_URL = 'https://api.wyren.ai';

const args = process.argv.slice(2);
const isUninstall = args.includes('--uninstall') || args.includes('--teardown');
const isGlobal = args.includes('-g') || args.includes('--global');
const skipWorker = args.includes('--no-worker');
const scope = isGlobal ? 'user' : 'local';

const LAUNCHER_PATH = join(__dirname, 'worker-launcher.mjs');
const WORKER_ENTRY = join(__dirname, 'worker-standalone', 'index.mjs');
const BUNDLE_DIR = join(__dirname, 'remotion-bundle');

const manualWorkerCmd = `WYREN_API_KEY=<your frm_ key> WYREN_BACKEND_URL=${BACKEND_URL} WYREN_REMOTION_BUNDLE_DIR=${BUNDLE_DIR} node ${WORKER_ENTRY}`;

if (isUninstall) {
  runUninstall();
} else {
  runSetup();
}

// ---------------------------------------------------------------------------

function runUninstall() {
  console.log('\n  Wyren MCP — uninstall worker\n');
  try {
    uninstallService();
    console.log('  Removed the auto-start worker service.');
  } catch (err) {
    console.log(`  Could not remove the service automatically: ${err.message}`);
  }
  console.log(`  Your login key remains at ${CONFIG_PATH} — delete it manually to fully reset.`);
  console.log(
    '  (The MCP server + skill stay installed; remove with `claude mcp remove wyren`.)\n',
  );
}

function runSetup() {
  console.log('\n  Wyren MCP Setup\n');
  console.log(`  Scope: ${isGlobal ? 'global (all projects)' : 'local (this project)'}\n`);

  // Step 1: Add MCP server to Claude Code
  console.log('  [1/4] Adding Wyren MCP server...');
  try {
    execFileSync(
      'claude',
      ['mcp', 'add', '--transport', 'http', '--scope', scope, 'wyren', MCP_URL],
      {
        stdio: 'pipe',
      },
    );
    console.log('         MCP server added.');
  } catch {
    console.log('         MCP server already configured or claude CLI not found.');
    console.log(
      `         Manual: claude mcp add --transport http --scope ${scope} wyren ${MCP_URL}`,
    );
  }

  // Step 2: Copy skill files
  console.log('  [2/4] Installing Wyren skill...');
  const skillSrc = join(__dirname, 'skills', 'wyren');
  const skillDest = isGlobal
    ? join(homedir(), '.claude', 'skills', 'wyren')
    : join(process.cwd(), '.claude', 'skills', 'wyren');
  if (!existsSync(skillSrc)) {
    console.error('         Skill files not found. Skipping skill install.');
  } else {
    mkdirSync(skillDest, { recursive: true });
    cpSync(skillSrc, skillDest, { recursive: true });
    console.log(`         Skill installed to ${skillDest}`);
  }

  if (skipWorker) {
    console.log('\n  --no-worker: skipping local render worker setup.');
    printDone();
    return;
  }

  // Step 3: Device login (browser approval → ~/.wyren/config.json)
  console.log('  [3/4] Setting up the local render worker...');
  setupWorker()
    .then((started) => {
      printDone(started);
    })
    .catch((err) => {
      console.log(`         Worker setup skipped: ${err.message}`);
      console.log('         You can run the worker manually any time:');
      console.log(`           ${manualWorkerCmd}`);
      printDone(false);
    });
}

async function setupWorker() {
  if (!existsSync(WORKER_ENTRY)) {
    throw new Error('worker artifact not found in this package install');
  }

  // Reuse an existing key if the user already logged in; otherwise device-login.
  const existing = readConfig();
  if (existing?.apiKey) {
    console.log('         Found an existing Wyren login; reusing it.');
  } else {
    console.log('         Logging you in (one-time browser approval)...');
    const apiKey = await deviceLogin(BACKEND_URL, { log: (m) => console.log(`         ${m}`) });
    writeConfig({ apiKey, backendUrl: BACKEND_URL });
    console.log(`         Logged in. Key saved to ${CONFIG_PATH} (0600).`);
  }

  // Step 4: register + start the auto-start service.
  console.log('  [4/4] Registering the worker to start at login...');
  try {
    const svc = installService(LAUNCHER_PATH);
    console.log(`         Service registered (${svc.type}: ${svc.path}) and started.`);
    console.log(`         Worker logs: ${LOG_PATH}`);
    return true;
  } catch (err) {
    console.log(`         Could not register auto-start (${err.message}). Run manually:`);
    console.log(`           ${manualWorkerCmd}`);
    return false;
  }
}

function printDone(workerStarted) {
  console.log('\n  Done! Start Claude Code and the Wyren tools will be available.');
  if (workerStarted) {
    console.log('  The local render worker is running and will auto-start at login.');
    console.log('  To stop it: npx wyren-mcp --uninstall');
  }
  console.log(
    `  Tip: run with ${isGlobal ? '' : '--global (-g) for all projects, or without flag for '}project-only.\n`,
  );
}
