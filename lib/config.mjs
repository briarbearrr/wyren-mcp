// Wyren config persistence — `~/.wyren/config.json`, 0600.
//
// The device-login flow writes the minted `frm_...` key + backend URL here so
// the worker daemon (and every subsequent login-time start) can authenticate
// without the user ever copy-pasting a key. The service definition we register
// reads the key from this file at start time.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const WYREN_DIR = join(homedir(), '.wyren');
export const CONFIG_PATH = join(WYREN_DIR, 'config.json');
export const LOG_PATH = join(WYREN_DIR, 'worker.log');

/** Ensure `~/.wyren` exists with restrictive perms; return its path. */
export function ensureWyrenDir() {
  if (!existsSync(WYREN_DIR)) {
    mkdirSync(WYREN_DIR, { recursive: true, mode: 0o700 });
  }
  return WYREN_DIR;
}

/** Read `~/.wyren/config.json`, or `null` if it doesn't exist / is unreadable. */
export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write `{ apiKey, backendUrl, ... }` to `~/.wyren/config.json` with 0600 perms.
 * Merges over any existing config so re-running setup doesn't drop fields.
 */
export function writeConfig(patch) {
  ensureWyrenDir();
  const current = readConfig() ?? {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  // writeFileSync's mode only applies on create; enforce on overwrite too.
  chmodSync(CONFIG_PATH, 0o600);
  return next;
}
