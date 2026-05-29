# wyren-mcp

Install the [Wyren](https://wyren.yibby.ai) MCP server, agent skills, and an auto-starting local render worker for Claude Code.

## Install

```bash
# Project-only (current directory)
npx wyren-mcp

# Global (all projects)
npx wyren-mcp --global
```

This:

1. Adds the Wyren MCP server to your Claude Code config.
2. Installs the Wyren agent skill for guided AI pipeline building.
3. Logs you in once via your browser and starts a **local render worker** that auto-starts at login.

## What you get

- **MCP Server** — tools for creating, building, executing, and publishing AI workflows.
- **Agent Skill** — teaches Claude how to use Wyren tools effectively, with workflow patterns and domain knowledge.
- **Local render worker** — a background daemon that runs heavy renders (captions, slideshows, video merge/trim, audio overlay, brainrot compose) on your machine instead of Wyren's servers. Faster for you, cheaper to run.

## The local render worker

### One-time browser approval

During setup, your browser opens to a Wyren `/device` page showing a short code. Approve it while logged in to your Wyren account. The installer then mints an API key scoped to your account and writes it to:

```
~/.wyren/config.json   (permissions 0600 — readable only by you)
```

You never copy-paste a key. After this one approval, the worker authenticates automatically on every start.

### Auto-start at login

The installer registers a per-user login service that runs the worker whenever you log in:

| Platform | Mechanism | Location |
| --- | --- | --- |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/ai.wyren.worker.plist` |
| Linux | systemd `--user` unit | `~/.config/systemd/user/wyren-worker.service` |
| Windows | Task Scheduler (ONLOGON) | task `Wyren\WyrenWorker` |

The service runs `worker-launcher.mjs`, which reads your key from `~/.wyren/config.json` and starts the bundled worker. The key is never written into the service definition itself.

### Where things live

- **Key / config**: `~/.wyren/config.json`
- **Logs**: `~/.wyren/worker.log`
- **Worker binary + Remotion bundle**: shipped inside this package (`worker-standalone/`, `remotion-bundle/`).

On the first render the worker downloads a headless Chromium (~200MB) via Remotion's `ensureBrowser()`. This is a one-time download.

### Disabling / uninstalling the worker

```bash
npx wyren-mcp --uninstall
```

This removes the auto-start service. Your `~/.wyren/config.json` is left in place — delete it manually to fully reset. To skip the worker at install time:

```bash
npx wyren-mcp --no-worker
```

### Running the worker manually

If auto-start is unsupported on your system, or you prefer to run it yourself:

```bash
WYREN_API_KEY=<your frm_ key> \
WYREN_BACKEND_URL=https://api.wyren.ai \
WYREN_REMOTION_BUNDLE_DIR=<package>/remotion-bundle \
node <package>/worker-standalone/index.mjs
```

(`<package>` is wherever npm installed `wyren-mcp`.)

## Manual MCP setup

If the installer doesn't work, set up the MCP server manually:

```bash
# Add MCP server (local)
claude mcp add --transport http wyren https://api.wyren.ai/mcp

# Add MCP server (global)
claude mcp add --transport http --scope user wyren https://api.wyren.ai/mcp

# Install skill (via skills CLI)
npx skills add briarbearrr/wyren-mcp
```

## Maintainers

The `worker-standalone/` and `remotion-bundle/` directories are **generated** from the Wyren monorepo, not authored here. To update them, see `scripts/sync-worker.mjs`:

```bash
# in the monorepo:
npm run build:worker && npm run bundle:remotion
# then, in this repo:
node scripts/sync-worker.mjs /path/to/frames
```
