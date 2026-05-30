#!/usr/bin/env node
// Sync the standalone worker artifact + Remotion bundle from the frames monorepo
// into this package.
//
// CO-EVOLUTION: `worker-standalone/` and `remotion-bundle/` are GENERATED, not
// authored here. They are built in the frames monorepo and copied in:
//
//   # in the monorepo checkout:
//   npm run build:worker      # → backend/dist/worker-standalone/index.mjs (+ .map)
//   npm run bundle:remotion    # → backend/dist/remotion-bundle/  (~24MB)
//
//   # then sync into this package (point at the monorepo root):
//   node scripts/sync-worker.mjs /path/to/frames
//
// Provenance of the artifacts currently vendored in this package:
//   monorepo branch: main
//   monorepo commit: 910ad36
//   tsup config:     backend/tsup.worker.config.ts
//   externals (must stay in this package's dependencies, in sync with that
//     config's EXTERNAL_RUNTIME_DEPS):
//       @remotion/renderer (pinned 4.0.421), ffmpeg-static, ws, zod,
//       file-type, @aws-sdk/client-s3, @aws-sdk/lib-storage
//
// Re-run this script + bump the provenance commit above whenever the monorepo
// worker daemon or Remotion compositions change.

import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const monorepo = process.argv[2];
if (!monorepo) {
  console.error('Usage: node scripts/sync-worker.mjs /path/to/frames');
  process.exit(1);
}

const srcWorker = resolve(monorepo, 'backend/dist/worker-standalone');
const srcBundle = resolve(monorepo, 'backend/dist/remotion-bundle');

for (const [label, src] of [
  ['worker-standalone', srcWorker],
  ['remotion-bundle', srcBundle],
]) {
  if (!existsSync(src)) {
    console.error(
      `Missing ${label} at ${src}. Run \`npm run build:worker && npm run bundle:remotion\` in the monorepo first.`,
    );
    process.exit(1);
  }
}

for (const [label, src] of [
  ['worker-standalone', srcWorker],
  ['remotion-bundle', srcBundle],
]) {
  const dest = join(PKG_ROOT, label);
  if (existsSync(dest)) rmSync(dest, { recursive: true });
  mkdirSync(dest, { recursive: true });
  // worker-standalone: drop its `index.mjs.map` — debug-only (~5MB), unused at
  //   runtime. remotion-bundle: KEEP `.map` files — Remotion's `prepareServer`
  //   reads `bundle.js.map` at render time, so stripping it makes
  //   `selectComposition` throw `ENOENT … bundle.js.map` and breaks EVERY
  //   caption / slideshow render in the daemon.
  const keepMaps = label === 'remotion-bundle';
  cpSync(src, dest, {
    recursive: true,
    ...(keepMaps ? {} : { filter: (s) => !s.endsWith('.map') }),
  });
  console.log(`Synced ${label} → ${dest} (sourcemaps ${keepMaps ? 'kept — Remotion needs bundle.js.map' : 'excluded'})`);
}

console.log('\nDone. Remember to bump the provenance commit in this script.');
