// OS auto-start registration for the Wyren worker.
//
// Registers a login-time service that runs `node <pkg>/worker-launcher.mjs`
// (which reads the 0600 config and execs the bundled worker). Idempotent:
// re-running setup re-writes the same unit/plist/task in place rather than
// duplicating it. `uninstallService` tears it down.
//
//   macOS   → launchd LaunchAgent  (~/Library/LaunchAgents/ai.wyren.worker.plist)
//   Linux   → systemd --user unit  (~/.config/systemd/user/wyren-worker.service)
//   Windows → Task Scheduler task   (schtasks /TN Wyren\WyrenWorker, ONLOGON)
//
// VERIFIED ON: Linux (systemd --user path validated with `systemctl --user
// cat`). The macOS launchd and Windows schtasks generators are written and
// linted but UNVERIFIED on the build box — see README "Disabling the worker".

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { homedir, userInfo } from 'os';
import { join } from 'path';

import { LOG_PATH, ensureWyrenDir } from './config.mjs';

export const SERVICE_LABEL = 'ai.wyren.worker';

// ---------------------------------------------------------------------------
// Linux — systemd --user
// ---------------------------------------------------------------------------

const SYSTEMD_DIR = join(homedir(), '.config', 'systemd', 'user');
const SYSTEMD_UNIT_PATH = join(SYSTEMD_DIR, 'wyren-worker.service');

function linuxUnit(nodePath, launcherPath) {
  // Restart=always with a backoff keeps the worker alive across crashes/network
  // drops; the daemon itself also reconnects, so this only covers hard exits.
  return `[Unit]
Description=Wyren local render worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${launcherPath}
Restart=always
RestartSec=5
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}

[Install]
WantedBy=default.target
`;
}

function installLinux(nodePath, launcherPath) {
  mkdirSync(SYSTEMD_DIR, { recursive: true });
  writeFileSync(SYSTEMD_UNIT_PATH, linuxUnit(nodePath, launcherPath), { mode: 0o644 });
  // Enable linger FIRST: without it a `--user` service only runs while the user
  // has an active login session, so the worker dies on logout and never starts
  // at boot / on a headless box — the common "my daemon isn't connected" case.
  // Best-effort: containers / locked-down hosts may not allow it.
  try {
    execFileSync('loginctl', ['enable-linger', userInfo().username], { stdio: 'pipe' });
  } catch {
    /* no loginctl, or not permitted — service still works while logged in */
  }
  // `daemon-reload` picks up the new unit; `enable` wires it to login;
  // `--now` also starts it immediately. All best-effort.
  systemctlUser(['daemon-reload']);
  systemctlUser(['enable', '--now', 'wyren-worker.service']);
  return { type: 'systemd', path: SYSTEMD_UNIT_PATH };
}

function uninstallLinux() {
  // `disable` fails loudly when the unit was never installed — that's the
  // common "already uninstalled" case, so swallow it and just clean up.
  systemctlUserSoft(['disable', '--now', 'wyren-worker.service']);
  if (existsSync(SYSTEMD_UNIT_PATH)) rmSync(SYSTEMD_UNIT_PATH);
  systemctlUserSoft(['daemon-reload']);
}

function systemctlUser(args) {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'pipe' });
}

function systemctlUserSoft(args) {
  try {
    systemctlUser(args);
  } catch {
    /* unit not present / nothing to do */
  }
}

// ---------------------------------------------------------------------------
// macOS — launchd LaunchAgent
// ---------------------------------------------------------------------------

const LAUNCHD_DIR = join(homedir(), 'Library', 'LaunchAgents');
const LAUNCHD_PLIST_PATH = join(LAUNCHD_DIR, `${SERVICE_LABEL}.plist`);

function macPlist(nodePath, launcherPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${launcherPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`;
}

function installMac(nodePath, launcherPath) {
  mkdirSync(LAUNCHD_DIR, { recursive: true });
  writeFileSync(LAUNCHD_PLIST_PATH, macPlist(nodePath, launcherPath), { mode: 0o644 });
  // Idempotent: unload first (ignore failure when not yet loaded), then load.
  try {
    execFileSync('launchctl', ['unload', LAUNCHD_PLIST_PATH], { stdio: 'pipe' });
  } catch {
    /* not loaded yet */
  }
  execFileSync('launchctl', ['load', '-w', LAUNCHD_PLIST_PATH], { stdio: 'pipe' });
  return { type: 'launchd', path: LAUNCHD_PLIST_PATH };
}

function uninstallMac() {
  if (existsSync(LAUNCHD_PLIST_PATH)) {
    try {
      execFileSync('launchctl', ['unload', '-w', LAUNCHD_PLIST_PATH], { stdio: 'pipe' });
    } catch {
      /* already unloaded */
    }
    rmSync(LAUNCHD_PLIST_PATH);
  }
}

// ---------------------------------------------------------------------------
// Windows — Task Scheduler (ONLOGON)
// ---------------------------------------------------------------------------

const WIN_TASK_NAME = 'Wyren\\WyrenWorker';

function installWindows(nodePath, launcherPath) {
  // /F overwrites an existing task → idempotent. /SC ONLOGON runs at user login.
  // /RL LIMITED keeps it in the user's security context.
  const tr = `"${nodePath}" "${launcherPath}"`;
  execFileSync(
    'schtasks',
    ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', WIN_TASK_NAME, '/TR', tr],
    { stdio: 'pipe' },
  );
  // Start it now (best-effort; the task is also wired to next logon).
  try {
    execFileSync('schtasks', ['/Run', '/TN', WIN_TASK_NAME], { stdio: 'pipe' });
  } catch {
    /* will run at next logon */
  }
  return { type: 'schtasks', path: WIN_TASK_NAME };
}

function uninstallWindows() {
  try {
    execFileSync('schtasks', ['/End', '/TN', WIN_TASK_NAME], { stdio: 'pipe' });
  } catch {
    /* not running */
  }
  try {
    execFileSync('schtasks', ['/Delete', '/F', '/TN', WIN_TASK_NAME], { stdio: 'pipe' });
  } catch {
    /* task not present / already removed */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register + start the login-time worker service for the current platform.
 * `launcherPath` is the absolute path to `worker-launcher.mjs` in the package.
 * Returns a descriptor; throws if the platform tooling rejects the call (the
 * caller wraps this in try/catch and prints the manual fallback).
 */
export function installService(launcherPath) {
  // The service definition points its logs at LOG_PATH (~/.wyren/worker.log);
  // ensure the dir exists so systemd/launchd can open the file at start time
  // even if device-login hasn't run yet (e.g. a manual re-register).
  ensureWyrenDir();
  const nodePath = process.execPath;
  switch (process.platform) {
    case 'linux':
      return installLinux(nodePath, launcherPath);
    case 'darwin':
      return installMac(nodePath, launcherPath);
    case 'win32':
      return installWindows(nodePath, launcherPath);
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

/** Remove the login-time worker service. Best-effort across platforms. */
export function uninstallService() {
  switch (process.platform) {
    case 'linux':
      return uninstallLinux();
    case 'darwin':
      return uninstallMac();
    case 'win32':
      return uninstallWindows();
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}
