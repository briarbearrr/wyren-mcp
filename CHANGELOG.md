# Changelog

## 1.2.0

- **Fixed** Caption (and slideshow) renders failed in the daemon: the vendored `remotion-bundle` was missing `bundle.js.map`, which Remotion's `prepareServer` reads — `sync-worker.mjs` was stripping ALL `.map` files. It now keeps the Remotion bundle maps (still drops the worker's debug map).
- **Fixed** Chunked captions served trimmed segments over `file://`, which Chromium refuses (fails on WSL2; OffthreadVideo is http-only). Segments are now served over a loopback HTTP server (Range + CORS).
- **Fixed** Daemon exited on any WebSocket drop (every backend redeploy) instead of reconnecting — the reconnect timer was `unref`'d. It is now ref'd, so the daemon rides through deploys via exponential backoff.
- **Changed** Remotion pinned to exactly 4.0.421 across renderer + bundler (was drifting to 4.0.452); the worker bundle is rebuilt from monorepo main (a3edc51).
- **Fixed** The daemon no longer needs R2 credentials. It uploads results via backend-issued **presigned URLs** ( → PUT) using only its  API key — so it runs on any end-user machine without distributing R2 secrets. Verified end-to-end against prod.


## 1.1.0

- **Added** Auto-starting local render worker. `npx wyren-mcp` now logs you in
  via a one-time browser approval (device-code flow), writes the minted key to
  `~/.wyren/config.json` (0600), and registers a login-time service (launchd /
  systemd `--user` / Task Scheduler) that runs the bundled worker.
- **Added** `worker-standalone/` (self-contained worker binary) and
  `remotion-bundle/` (prebuilt Remotion compositions) shipped as package assets,
  generated from the monorepo via `scripts/sync-worker.mjs`.
- **Added** Runtime dependencies for the worker: `@remotion/renderer` (pinned
  `4.0.421`), `ffmpeg-static`, `ws`, `zod`, `file-type`, `@aws-sdk/client-s3`,
  `@aws-sdk/lib-storage`.
- **Added** `npx wyren-mcp --uninstall` to remove the auto-start service, and
  `--no-worker` to skip worker setup at install time.
- **Changed** `setup.mjs` is now a 4-step installer (MCP add → skill → device
  login → service registration). All worker steps are wrapped so install never
  hard-fails; the exact manual run command is printed if any step is
  unsupported or declined.

## 1.0.0

- Initial installer: adds the Wyren MCP server and copies the agent skill.
