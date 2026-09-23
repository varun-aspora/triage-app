#!/usr/bin/env node
// triage HTTP server shim (T07.10). `bun run serve` runs it.
//
// Order matters: load config from TRIAGE_HOME, run prepareServer (refuses a
// blank TRIAGE_HTTP_AUTH_TOKEN, builds the run store, starts the retention
// timer), set PORT from TRIAGE_HTTP_PORT, and only then import the Flue-built
// dist/server.mjs, which reads PORT once when it starts listening. The timer
// runs in this same process as the routes. Flue's server handles SIGINT and
// SIGTERM itself; the timer is unref-ed, so it never holds the process open.
//
// src/ is loaded through Node's type stripping, as bin/triage.mjs does.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER_URL = new URL('../dist/server.mjs', import.meta.url);

/**
 * Boots the server. Every step can be replaced for tests.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   loadConfig?: () => unknown,
 *   prepareServer?: (config: any) => Promise<{ port: number, stop(): void }>,
 *   importServer?: () => Promise<unknown>,
 * }} [deps]
 * @returns {Promise<{ port: number, stop(): void }>}
 */
export async function runServer(deps = {}) {
  const env = deps.env ?? process.env;
  const loadConfig = deps.loadConfig ?? (await import('../src/config/env.ts')).loadConfig;
  const prepareServer = deps.prepareServer ?? (await import('../src/server/boot.ts')).prepareServer;
  const importServer = deps.importServer ?? (() => import(SERVER_URL.href));

  const config = loadConfig();
  const prepared = await prepareServer(config);
  env.PORT = String(prepared.port);
  try {
    await importServer();
  } catch (err) {
    prepared.stop();
    throw err;
  }
  return prepared;
}

/**
 * One stderr line for a boot failure. ConfigError messages carry key names
 * only. Other messages can carry connection details, so only the error name
 * is printed.
 *
 * @param {unknown} err
 * @returns {{ line: string, exitCode: number }}
 */
export function describeBootError(err) {
  const e = /** @type {{ name?: unknown, message?: unknown, code?: unknown, url?: unknown }} */ (err ?? {});
  if (e.name === 'ConfigError' && typeof e.message === 'string') {
    return { line: `triage-server: ${e.message}`, exitCode: 3 };
  }
  if (e.code === 'ERR_MODULE_NOT_FOUND' && typeof e.message === 'string' && e.message.includes('dist/server.mjs')) {
    return { line: 'triage-server: dist/server.mjs not found; run `bun run build` first', exitCode: 1 };
  }
  const name = typeof e.name === 'string' && e.name !== '' ? e.name : 'unknown error';
  return { line: `triage-server: boot failed (${name})`, exitCode: 1 };
}

function isMain() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    process.stderr.write(`triage-server: needs Node >= 22.19, found ${process.versions.node}\n`);
    process.exit(1);
  }
  try {
    await runServer();
  } catch (err) {
    const { line, exitCode } = describeBootError(err);
    process.stderr.write(`${line}\n`);
    process.exit(exitCode);
  }
}
