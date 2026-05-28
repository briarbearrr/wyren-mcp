#!/usr/bin/env node
/**
 * wyren-mcp CLI entrypoint.
 *
 *   npx wyren-mcp                 → install MCP server + Wyren skill (default)
 *   npx wyren-mcp install         → same as default
 *   npx wyren-mcp worker start    → run the local render daemon
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

async function run() {
  const sub = args[0];

  if (sub === 'worker') {
    const action = args[1];
    if (action !== 'start' && action !== undefined) {
      console.error(`Unknown worker subcommand: ${action}`);
      console.error('Usage: npx wyren-mcp worker start');
      process.exit(2);
    }
    const { startWorker } = await import('../src/worker/index.mjs');
    await startWorker();
    return;
  }

  if (sub === undefined || sub === 'install') {
    await import(join(__dirname, '..', 'setup.mjs'));
    return;
  }

  if (sub === '--help' || sub === '-h') {
    console.log('wyren-mcp commands:');
    console.log('  install        Install MCP server + Wyren skill (default)');
    console.log('  worker start   Run the local render daemon');
    return;
  }

  console.error(`Unknown command: ${sub}`);
  console.error('Run `npx wyren-mcp --help` for options.');
  process.exit(2);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
