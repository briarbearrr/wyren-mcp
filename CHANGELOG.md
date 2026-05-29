# Changelog

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
