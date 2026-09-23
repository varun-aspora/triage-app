// The one no-io guard for every test run (bun test preload and Vitest setup).
// Once installed, outbound network calls and host binaries that reach real
// systems throw NoIoGuardError. Loopback is allowed only for ports a test
// opts into with allowLoopback(). There is no env switch and no uninstall.
//
// Covered: fetch, WebSocket, net.connect/createConnection, net.Socket
// connect (which tls, http and https use underneath), tls.connect,
// http/https request and get, child_process spawn/exec/execFile (sync and
// async, shell:true included), and in Bun also Bun.connect, Bun.spawn,
// Bun.spawnSync and Bun.$.

import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { promisify } from 'node:util';

export const DENIED_BINARIES: readonly string[] = Object.freeze([
  'ssh', 'qw', 'kubectl', 'psql', 'curl', 'aws', 'codegraph', 'git', 'gh',
]);

// Commands that run other commands from their arguments. When one of these
// is spawned, its arguments are scanned for denied binaries too.
const COMMAND_RUNNERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'env', 'xargs', 'nohup',
  'sudo', 'doas', 'timeout', 'nice', 'time', 'exec', 'command', 'stdbuf', 'script', 'watch',
]);

const INSTALLED = Symbol.for('triage-app.no-io-guard');

export class NoIoGuardError extends Error {
  override name = 'NoIoGuardError';
  constructor(what: string) {
    super(`no-io guard: ${what} is blocked in tests. Use fixtures, mocks or the fake model provider.`);
  }
}

// ---------------------------------------------------------------- loopback

const loopbackPorts = new Map<number, number>();

/**
 * Lets connections to 127.0.0.1, ::1 and localhost on these ports through
 * until the returned function is called. Other ports stay blocked. Call the
 * returned function in afterEach or finally, since bun test shares one
 * process across files.
 */
export function allowLoopback(ports: readonly number[]): () => void {
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError(`allowLoopback: invalid port ${String(port)}`);
    }
  }
  for (const port of ports) loopbackPorts.set(port, (loopbackPorts.get(port) ?? 0) + 1);
  let revoked = false;
  return () => {
    if (revoked) return;
    revoked = true;
    for (const port of ports) {
      const n = (loopbackPorts.get(port) ?? 0) - 1;
      if (n > 0) loopbackPorts.set(port, n);
      else loopbackPorts.delete(port);
    }
  };
}

function normaliseHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  const h = normaliseHost(host);
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h === '::' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

export type Target = { host?: string; port?: number | string; path?: string };

/** Throws unless the target is a loopback host on an opted-in port. */
export function checkTarget(what: string, target: Target): void {
  if (target.path !== undefined) throw new NoIoGuardError(`${what} to socket path ${target.path}`);
  const host = normaliseHost(target.host || 'localhost');
  const port = Number(target.port);
  const loopback = isLoopbackHost(host);
  if (loopback && Number.isInteger(port) && loopbackPorts.has(port)) return;
  const where = `${host}:${target.port ?? '?'}`;
  throw new NoIoGuardError(
    loopback ? `${what} to ${where} (loopback port not opted in with allowLoopback)` : `${what} to ${where}`,
  );
}

// ------------------------------------------------------ argument parsing

type AnyRecord = Record<string, unknown>;
const isRecord = (x: unknown): x is AnyRecord => typeof x === 'object' && x !== null;
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
const portOf = (x: unknown): number | string | undefined =>
  typeof x === 'number' || typeof x === 'string' ? x : undefined;

/** net.connect / net.Socket#connect / tls.connect arguments. */
function socketTarget(args: readonly unknown[]): Target | 'already-connected' {
  // Node passes its own normalised [options, callback] array to Socket#connect.
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (isRecord(first)) {
    if (first.socket !== undefined) return 'already-connected';
    const path = str(first.path);
    if (path !== undefined) return { path };
    return { host: str(first.host) ?? str(first.hostname), port: portOf(first.port) };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const second = args[1];
    const host = str(second) ?? (isRecord(second) ? str(second.host) : undefined);
    return { host, port: first };
  }
  if (typeof first === 'string') return { path: first };
  return {};
}

/** http(s).request / get arguments. */
function requestTarget(args: readonly unknown[], defaultPort: number): Target {
  let url: URL | undefined;
  let opts: AnyRecord = {};
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    url = new URL(String(args[0]));
    if (isRecord(args[1])) opts = args[1];
  } else if (isRecord(args[0])) {
    opts = args[0];
  }
  const socketPath = str(opts.socketPath);
  if (socketPath !== undefined) return { path: socketPath };
  const host = str(opts.hostname) ?? str(opts.host) ?? url?.hostname;
  const port = portOf(opts.port) ?? (url?.port || undefined) ?? portOf(opts.defaultPort) ?? defaultPort;
  return { host, port };
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443 };

function checkUrl(what: string, raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NoIoGuardError(`${what} to ${raw}`);
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return;
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (defaultPort === undefined) throw new NoIoGuardError(`${what} to ${url.protocol} URL`);
  checkTarget(`${what} ${url.origin}`, { host: url.hostname, port: url.port || defaultPort });
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (isRecord(input) && typeof input.url === 'string') return input.url;
  return String(input);
}

// ------------------------------------------------------------ binaries

function baseName(word: string): string {
  const last = word.split(/[\\/]/).pop() ?? word;
  return last.replace(/\.exe$/i, '').toLowerCase();
}

function shellWords(text: string): string[] {
  return text.split(/[\s;&|()<>`$'"{}=]+/).filter(Boolean);
}

/**
 * Returns the denied binary a command would run, if any. With shell=true,
 * or when the command is itself a shell or wrapper such as env or sudo,
 * every word of the command line is checked.
 */
export function deniedBinaryIn(file: string, args: readonly string[], shell: boolean): string | undefined {
  const words = shell ? shellWords([file, ...args].join(' ')) : [file];
  if (!shell && COMMAND_RUNNERS.has(baseName(file))) words.push(...args.flatMap(shellWords));
  return words.map(baseName).find((w) => DENIED_BINARIES.includes(w));
}

function checkCommand(api: string, file: unknown, args: readonly unknown[], shell: boolean): void {
  const denied = deniedBinaryIn(String(file), args.map(String), shell);
  if (denied !== undefined) throw new NoIoGuardError(`${api} of '${denied}'`);
}

/** spawn / spawnSync / execFile / execFileSync arguments. */
function checkSpawnLike(api: string, args: readonly unknown[]): void {
  const argv = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
  const opts = Array.isArray(args[1]) ? args[2] : args[1];
  const shell = isRecord(opts) && Boolean(opts.shell);
  checkCommand(api, args[0], argv, shell);
}

/** exec / execSync always run through a shell. */
function checkExecLike(api: string, args: readonly unknown[]): void {
  checkCommand(api, args[0], [], true);
}

function checkFork(args: readonly unknown[]): void {
  const opts = Array.isArray(args[1]) ? args[2] : args[1];
  if (isRecord(opts) && typeof opts.execPath === 'string') {
    checkCommand('child_process.fork', opts.execPath, [], false);
  }
}

// ------------------------------------------------------------ patching

type Fn = (...args: unknown[]) => unknown;

/** Replaces obj[key] with a wrapper that runs check first. Keeps promisify.custom guarded. */
function patch(obj: object, key: string, check: (args: unknown[]) => void): void {
  const target = obj as Record<string | symbol, unknown>;
  const original = target[key];
  if (typeof original !== 'function') return;
  const orig = original as Fn;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    check(args);
    return orig.apply(this, args);
  };
  const custom = (orig as unknown as Record<symbol, unknown>)[promisify.custom];
  if (typeof custom === 'function') {
    const customFn = custom as Fn;
    Object.defineProperty(wrapped, promisify.custom, {
      value: function (this: unknown, ...args: unknown[]) {
        check(args);
        return customFn.apply(this, args);
      },
    });
  }
  target[key] = wrapped;
}

function installNetwork(): void {
  const originalFetch = globalThis.fetch;
  const guardedFetch = function (this: unknown, input: unknown, init?: unknown) {
    if (isRecord(init) && init.unix !== undefined) {
      throw new NoIoGuardError(`fetch to socket path ${String(init.unix)}`);
    }
    checkUrl('fetch', urlOf(input));
    return originalFetch.call(this, input as never, init as never);
  };
  const fetchProps = originalFetch as unknown as Record<string, unknown>;
  const preconnect = fetchProps.preconnect;
  Object.assign(guardedFetch, originalFetch);
  if (typeof preconnect === 'function') {
    // Bun's fetch.preconnect opens a connection ahead of time.
    (guardedFetch as unknown as Record<string, unknown>).preconnect = (url: unknown, ...rest: unknown[]) => {
      checkUrl('fetch.preconnect', urlOf(url));
      return (preconnect as Fn).call(originalFetch, url, ...rest);
    };
  }
  globalThis.fetch = guardedFetch as unknown as typeof fetch;

  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    globalThis.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args, newTarget) {
        checkUrl('WebSocket', urlOf(args[0]));
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
  }

  const socketCheck = (what: string) => (args: unknown[]) => {
    const target = socketTarget(args);
    if (target !== 'already-connected') checkTarget(what, target);
  };
  patch(net, 'connect', socketCheck('net.connect'));
  patch(net, 'createConnection', socketCheck('net.createConnection'));
  patch(net.Socket.prototype, 'connect', socketCheck('net.Socket connect'));
  patch(tls, 'connect', socketCheck('tls.connect'));
  patch(http, 'request', (args) => checkTarget('http.request', requestTarget(args, 80)));
  patch(http, 'get', (args) => checkTarget('http.get', requestTarget(args, 80)));
  patch(https, 'request', (args) => checkTarget('https.request', requestTarget(args, 443)));
  patch(https, 'get', (args) => checkTarget('https.get', requestTarget(args, 443)));
}

function installChildProcess(): void {
  for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync'] as const) {
    patch(childProcess, key, (args) => checkSpawnLike(`child_process.${key}`, args));
  }
  for (const key of ['exec', 'execSync'] as const) {
    patch(childProcess, key, (args) => checkExecLike(`child_process.${key}`, args));
  }
  patch(childProcess, 'fork', checkFork);
}

/** Bun's own APIs. Bun routes named imports of node:child_process through Bun.spawn. */
function installBun(): void {
  const bun = (globalThis as Record<string, unknown>).Bun;
  if (!isRecord(bun)) return;
  const bunSpawnCheck = (api: string) => (args: unknown[]) => {
    const first = args[0];
    const cmd = Array.isArray(first) ? first : isRecord(first) && Array.isArray(first.cmd) ? first.cmd : [];
    checkCommand(api, cmd[0] ?? '', cmd.slice(1), false);
  };
  patch(bun, 'spawn', bunSpawnCheck('Bun.spawn'));
  patch(bun, 'spawnSync', bunSpawnCheck('Bun.spawnSync'));
  patch(bun, 'connect', (args) => {
    const opts = isRecord(args[0]) ? args[0] : {};
    const unix = str(opts.unix);
    checkTarget('Bun.connect', unix !== undefined ? { path: unix } : { host: str(opts.hostname), port: portOf(opts.port) });
  });
  const shell = bun.$;
  if (typeof shell === 'function') {
    bun.$ = new Proxy(shell, {
      apply(target, thisArg, args: unknown[]) {
        const strings = Array.isArray(args[0]) ? (args[0] as unknown[]).map(String) : [String(args[0])];
        const values = args.slice(1).map((v) => (Array.isArray(v) ? v.join(' ') : String(v)));
        checkCommand('Bun.$', '', [strings.join(' '), ...values], true);
        return Reflect.apply(target as Fn, thisArg, args);
      },
    });
  }
}

/** Installs the guard once per process. Safe to call again. */
export function installNoIoGuard(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[INSTALLED]) return;
  installNetwork();
  installChildProcess();
  installBun();
  // Make named ESM imports of the builtins (Node) see the patched functions.
  syncBuiltinESMExports();
  g[INSTALLED] = true;
}

export function isNoIoGuardInstalled(): boolean {
  return (globalThis as Record<symbol, unknown>)[INSTALLED] === true;
}

/** Throws when the guard is missing, so a guard test never makes a real call. */
export function assertNoIoGuardInstalled(): void {
  if (!isNoIoGuardInstalled()) {
    throw new Error('no-io guard is not installed; run tests through bun run test or bun run test:contract');
  }
}
