# Changelog

## 1.2.3

- **Fixed** Caption renders failed on the daemon. Three compounding bugs: (1) the worker bundle **inlined `ffmpeg-static`** (a build misconfig overrode the external list), so it resolved the ffmpeg binary relative to the bundle dir — every ffmpeg call silently failed and captions died with a misleading Remotion "404 fetching segment"; now forced external + the trim fails loud on a bad exit. (2) The caption overlay eagerly loaded **all 10 Google Font families** every render (hundreds of requests), and the chunked path opened ~30 headless Chromium tabs (`cpus-1` × parallel segments) — together they starved the worker's loopback file server until it refused connections; now only the selected font loads and per-render concurrency is bounded. Rebuilt from monorepo main `910ad36`. Verified end-to-end on a real daemon.
- **Fixed** The Linux installer now enables **systemd linger** (`loginctl enable-linger`) in addition to `systemctl --user enable --now`, so the worker auto-starts at boot and keeps running without an active login session (previously it stopped when the session ended → "daemon not connected").

## 1.2.2

- **Fixed** Caption renders failed on hosts that can't reach the media CDN directly — broken-IPv6 networks (WSL2, and some end-user machines), where the bundled ffmpeg core-dumps and Chromium `net::ERR_FAIL`s fetching the CDN even though Node's `fetch` reaches it fine. The worker now prefetches the source video — and any remote audio track — via Node `fetch` and serves them (with the trimmed segments) over one loopback HTTP server, so ffmpeg and Chromium/OffthreadVideo only read from `127.0.0.1`. The render then completes on any network. Rebuilt from monorepo main `df78a6b`. Verified end-to-end on a broken-IPv6 box (14 s chunked ~32 s; 8 s single-pass with muxed audio ~24 s).

## 1.2.1

- **Fixed** The daemon survives WebSocket drops (e.g. every backend redeploy) without losing in-flight work: it no longer aborts running jobs when the socket closes. Render, presigned upload, and completion run over the HTTP lifecycle independent of the socket, so jobs finish and report while the socket reconnects in the background. Only a real shutdown aborts in-flight work.

## 1.2.0

- **Fixed** Caption (and slideshow) renders failed in the daemon: the vendored `remotion-bundle` was missing `bundle.js.map`, which Remotion's `prepareServer` reads — `sync-worker.mjs` was stripping ALL `.map` files. It now keeps the Remotion bundle maps (still drops the worker's debug map).
- **Fixed** Chunked captions served trimmed segments over `file://`, which Chromium refuses (fails on WSL2; OffthreadVideo is http-only). Segments are now served over a loopback HTTP server (Range + CORS).
- **Fixed** Daemon exited on any WebSocket drop (every backend redeploy) instead of reconnecting — the reconnect timer was `unref`'d. It is now ref'd, so the daemon rides through deploys via exponential backoff.
- **Changed** Remotion pinned to exactly 4.0.421 across renderer + bundler (was drifting to 4.0.452); the worker bundle is rebuilt from monorepo main (0600ac2).
- **Fixed** The daemon no longer needs R2 credentials. It uploads results via backend-issued **presigned URLs** (`/api/upload/{video,image}/presign` → PUT) using only its `frm_` API key — so it runs on any end-user machine without distributing R2 secrets. Verified end-to-end against prod.


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
