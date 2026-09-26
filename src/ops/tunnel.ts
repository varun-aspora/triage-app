// SSFB DB tunnel: `ssh -L` from the laptop through the bastion to the SSFB
// reader, held open by an ssh control master so triage can tell its own
// tunnel apart from one somebody else started (D15, D32).
//
// Who calls this: the CLI (`triage tunnel up|status|down`), the server
// process and pre-flight in local mode. A tool never calls it (D15: starting
// `ssh -L` inside a tool call stays rejected).
//
// Rules this file keeps:
// - The argv is fixed and built only from the SSFB_DB_TUNNEL_* keys and
//   TRIAGE_DATA_DIR. Every value passes assertSafeArg, ports are integers
//   from 1 to 65535, and ssh runs through the one ExecRunner.
// - Ownership means the control socket answers `ssh -O check`. `down` sends
//   `-O exit` only then, so a tunnel triage did not start is never touched.
// - No returned string carries a value from the config. Messages name keys
//   and the local port only. ssh's stderr is mapped to fixed reasons and is
//   never echoed, because it quotes the bastion and the identity path.
// - up, status and down return a result for every expected failure (bad
//   config, ssh exit codes, timeouts, a probe that throws). Only a runner
//   programming error, such as the test fake's unscripted call, throws.
//
// ssh -f detaches after the forward is set up (ExitOnForwardFailure=yes), and
// current OpenSSH points the detached child's stdio at /dev/null, so the
// runner sees the parent exit and returns.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config } from '../config/env.ts';
import { lookupEnv } from '../config/env.ts';
import { ConfigError, type ConfigProblem } from '../config/errors.ts';
import { UnsafeArgError, assertSafeArg, succeeded, type ExecResult, type ExecRunner } from '../connectors/exec.ts';

export const TUNNEL_KEYS = Object.freeze({
  required: 'SSFB_DB_TUNNEL_REQUIRED',
  bastion: 'SSFB_DB_TUNNEL_BASTION',
  identityFile: 'SSFB_DB_TUNNEL_IDENTITY_FILE',
  localPort: 'SSFB_DB_TUNNEL_LOCAL_PORT',
  remoteHost: 'SSFB_DB_TUNNEL_REMOTE_HOST',
  remotePort: 'SSFB_DB_TUNNEL_REMOTE_PORT',
} as const);

const DATA_DIR_KEY = 'TRIAGE_DATA_DIR';
const SSH_BIN = 'ssh';
const BIND_ADDRESS = '127.0.0.1';
const SOCKET_DIR = 'tunnel';
const SOCKET_FILE = 'ssfb-db.sock';

// Unix socket paths are capped at 104 bytes on macOS (108 on Linux), and ssh
// -M first binds a temp name of the path plus 17 characters.
const MAX_SOCKET_PATH_BYTES = 86;

export const TUNNEL_TIMEOUTS = Object.freeze({
  upMs: 30_000,
  checkMs: 5_000,
  exitMs: 10_000,
  probeMs: 1_500,
});

export type EnabledTunnelConfig = {
  readonly enabled: true;
  readonly bastion: string;
  readonly identityFile: string;
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly socketPath: string;
};

export type DisabledTunnelConfig = {
  readonly enabled: false;
  readonly reason: string;
  readonly keys: readonly string[];
};

export type TunnelConfig = EnabledTunnelConfig | DisabledTunnelConfig;

/** True when something accepts a TCP connection on host:port within timeoutMs. */
export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export type TunnelDeps = {
  readonly config: Config;
  readonly runner: ExecRunner;
  readonly tcpProbe: TcpProbe;
  readonly signal?: AbortSignal;
  /** Creates the control socket directory. Defaults to mkdir -p with mode 0700. */
  readonly ensureDir?: (dir: string) => void;
};

export type TunnelState = 'up' | 'down' | 'disabled';

export type TunnelResult = {
  readonly state: TunnelState;
  /** The control socket answered, so triage started this tunnel. */
  readonly owned: boolean;
  /** The TCP probe found the local port listening. */
  readonly listening: boolean;
  /** This call started ssh. Only up sets it. */
  readonly started: boolean;
  /** This call stopped ssh. Only down sets it. */
  readonly stopped: boolean;
  /** Absent when the config is disabled or invalid. */
  readonly localPort?: number;
  readonly message: string;
  /** Set when something failed. Names keys and fixed reasons only. */
  readonly error?: string;
  /** Env key names the message or error refers to. */
  readonly keys: readonly string[];
};

// ------------------------------------------------------------------ config

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const PORT = /^\d{1,5}$/;

/**
 * Reads the tunnel settings from config. Returns enabled:false when
 * SSFB_DB_TUNNEL_REQUIRED=false or SSFB_DB_TUNNEL_BASTION is blank. Throws a
 * ConfigError naming every bad key when a value is set but unusable.
 */
export function readTunnelConfig(config: Config): TunnelConfig {
  const problems: ConfigProblem[] = [];
  const get = (key: string): string | undefined => {
    const found = lookupEnv(config, key);
    return found.state === 'set' ? found.value.trim() : undefined;
  };

  const required = get(TUNNEL_KEYS.required)?.toLowerCase();
  if (required === 'false') {
    return disabled(`${TUNNEL_KEYS.required}=false`, [TUNNEL_KEYS.required]);
  }
  if (required !== undefined && required !== 'true') {
    throw ConfigError.of(TUNNEL_KEYS.required, 'must be true or false');
  }

  const bastionRaw = get(TUNNEL_KEYS.bastion);
  if (bastionRaw === undefined) {
    return disabled(`${TUNNEL_KEYS.bastion} is blank`, [TUNNEL_KEYS.bastion]);
  }

  const bastion = checked(problems, TUNNEL_KEYS.bastion, bastionRaw, isBastion, 'must be host or user@host');
  const remoteHost = checked(problems, TUNNEL_KEYS.remoteHost, requiredValue(problems, TUNNEL_KEYS.remoteHost, get), isHost, 'must be a host name or IPv4 address');
  const localPort = port(problems, TUNNEL_KEYS.localPort, get);
  const remotePort = port(problems, TUNNEL_KEYS.remotePort, get);

  const identityRaw = requiredValue(problems, TUNNEL_KEYS.identityFile, get);
  let identityFile: string | undefined;
  if (identityRaw !== undefined && safe(problems, TUNNEL_KEYS.identityFile, identityRaw)) {
    identityFile = checked(problems, TUNNEL_KEYS.identityFile, resolve(config.home, identityRaw), noToken, 'must not contain %');
  }

  const socketPath = checked(problems, DATA_DIR_KEY, join(config.paths.dataDir, SOCKET_DIR, SOCKET_FILE), socketOk, `is too long for a control socket (keep the socket path under ${MAX_SOCKET_PATH_BYTES} bytes) or contains %`);

  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze({
    enabled: true,
    bastion: bastion as string,
    identityFile: identityFile as string,
    localPort: localPort as number,
    remoteHost: remoteHost as string,
    remotePort: remotePort as number,
    socketPath: socketPath as string,
  });
}

function disabled(reason: string, keys: readonly string[]): DisabledTunnelConfig {
  return Object.freeze({ enabled: false, reason, keys: Object.freeze([...keys]) });
}

function requiredValue(problems: ConfigProblem[], key: string, get: (k: string) => string | undefined): string | undefined {
  const value = get(key);
  if (value === undefined) problems.push({ key, reason: `is required when ${TUNNEL_KEYS.bastion} is set` });
  return value;
}

// assertSafeArg as a problem entry instead of a throw.
function safe(problems: ConfigProblem[], key: string, value: string): boolean {
  try {
    assertSafeArg(value, key);
    return true;
  } catch (e) {
    if (!(e instanceof UnsafeArgError)) throw e;
    problems.push({ key, reason: e.reason });
    return false;
  }
}

function checked(
  problems: ConfigProblem[],
  key: string,
  value: string | undefined,
  ok: (v: string) => boolean,
  reason: string,
): string | undefined {
  if (value === undefined || !safe(problems, key, value)) return undefined;
  if (!ok(value)) {
    problems.push({ key, reason });
    return undefined;
  }
  return value;
}

function port(problems: ConfigProblem[], key: string, get: (k: string) => string | undefined): number | undefined {
  const raw = requiredValue(problems, key, get);
  if (raw === undefined) return undefined;
  const n = PORT.test(raw) ? Number(raw) : Number.NaN;
  if (!isPort(n)) {
    problems.push({ key, reason: 'must be a whole number from 1 to 65535' });
    return undefined;
  }
  return n;
}

function isPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
}

function isHost(v: string): boolean {
  return v.length <= 253 && HOST.test(v);
}

function isBastion(v: string): boolean {
  const at = v.indexOf('@');
  if (at === -1) return isHost(v);
  return USER.test(v.slice(0, at)) && isHost(v.slice(at + 1));
}

// ssh expands %-tokens in -S and -i paths.
function noToken(v: string): boolean {
  return !v.includes('%');
}

function socketOk(v: string): boolean {
  return noToken(v) && Buffer.byteLength(v, 'utf8') <= MAX_SOCKET_PATH_BYTES;
}

// ------------------------------------------------------------------- argv

/**
 * The argv for `ssh` that starts the control master and the forward. Checks
 * every value again, so a hand-built config cannot slip anything through.
 */
export function buildTunnelUpArgv(cfg: EnabledTunnelConfig): readonly string[] {
  assertEnabled(cfg);
  return Object.freeze([
    '-f',
    '-N',
    '-M',
    '-S',
    cfg.socketPath,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=30',
    '-i',
    cfg.identityFile,
    '-L',
    `${BIND_ADDRESS}:${cfg.localPort}:${cfg.remoteHost}:${cfg.remotePort}`,
    cfg.bastion,
  ]);
}

/** `ssh -S <sock> -O check|exit <bastion>`. ssh wants a destination even for -O. */
export function buildControlArgv(cfg: EnabledTunnelConfig, op: 'check' | 'exit'): readonly string[] {
  assertEnabled(cfg);
  return Object.freeze(['-S', cfg.socketPath, '-O', op, cfg.bastion]);
}

function assertEnabled(cfg: EnabledTunnelConfig): void {
  const problems: ConfigProblem[] = [];
  checked(problems, TUNNEL_KEYS.bastion, cfg.bastion, isBastion, 'must be host or user@host');
  checked(problems, TUNNEL_KEYS.remoteHost, cfg.remoteHost, isHost, 'must be a host name or IPv4 address');
  checked(problems, TUNNEL_KEYS.identityFile, cfg.identityFile, noToken, 'must not contain %');
  checked(problems, DATA_DIR_KEY, cfg.socketPath, socketOk, 'is not usable for a control socket');
  if (!isPort(cfg.localPort)) problems.push({ key: TUNNEL_KEYS.localPort, reason: 'must be a whole number from 1 to 65535' });
  if (!isPort(cfg.remotePort)) problems.push({ key: TUNNEL_KEYS.remotePort, reason: 'must be a whole number from 1 to 65535' });
  if (problems.length > 0) throw new ConfigError(problems);
}

// ------------------------------------------------------------ operations

type Loaded = { readonly ok: true; readonly cfg: EnabledTunnelConfig } | { readonly ok: false; readonly result: TunnelResult };

function result(fields: Partial<TunnelResult> & Pick<TunnelResult, 'state' | 'message'>): TunnelResult {
  return Object.freeze({
    owned: false,
    listening: false,
    started: false,
    stopped: false,
    keys: Object.freeze([]),
    ...fields,
  });
}

function load(config: Config): Loaded {
  let cfg: TunnelConfig;
  try {
    cfg = readTunnelConfig(config);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    // ConfigError text is key names and fixed reasons only.
    return {
      ok: false,
      result: result({ state: 'down', message: 'SSFB DB tunnel config is invalid', error: e.message, keys: e.keys }),
    };
  }
  if (!cfg.enabled) {
    return { ok: false, result: result({ state: 'disabled', message: `SSFB DB tunnel is off: ${cfg.reason}`, keys: cfg.keys }) };
  }
  return { ok: true, cfg };
}

async function probe(deps: TunnelDeps, cfg: EnabledTunnelConfig): Promise<boolean> {
  try {
    return (await deps.tcpProbe(BIND_ADDRESS, cfg.localPort, TUNNEL_TIMEOUTS.probeMs)) === true;
  } catch {
    return false;
  }
}

async function controlCheck(deps: TunnelDeps, cfg: EnabledTunnelConfig): Promise<boolean> {
  const res = await deps.runner.run(SSH_BIN, buildControlArgv(cfg, 'check'), runOpts(deps, TUNNEL_TIMEOUTS.checkMs));
  return succeeded(res);
}

function runOpts(deps: TunnelDeps, timeoutMs: number): { timeoutMs: number; signal?: AbortSignal } {
  return deps.signal !== undefined ? { timeoutMs, signal: deps.signal } : { timeoutMs };
}

const ADVICE_KEYS = [TUNNEL_KEYS.bastion, TUNNEL_KEYS.identityFile] as const;

// Fixed reasons for the common ssh failures. The stderr text itself is never returned.
const SSH_REASONS: readonly (readonly [RegExp, string, readonly string[]])[] = [
  [/permission denied|no such identity|load key|bad permissions/i, 'authentication failed', ADVICE_KEYS],
  [/host key verification failed|remote host identification has changed/i, 'host key verification failed', [TUNNEL_KEYS.bastion]],
  [/could not resolve hostname|name or service not known|nodename nor servname/i, 'the bastion name did not resolve', [TUNNEL_KEYS.bastion]],
  [/connection timed out|operation timed out|connection refused|no route to host|network is unreachable/i, 'the bastion is unreachable', [TUNNEL_KEYS.bastion]],
  [/address already in use|cannot listen to port|port forwarding failed|forwarding failed/i, 'the local forward could not be set up', [TUNNEL_KEYS.localPort]],
  [/controlsocket|control socket|unix_listener/i, 'the control socket could not be created', [DATA_DIR_KEY]],
];

function describeFailure(res: ExecResult): { reason: string; keys: readonly string[] } {
  if (res.spawnError !== undefined) return { reason: 'the ssh binary could not be started', keys: [] };
  if (res.aborted) return { reason: 'the call was aborted', keys: [] };
  if (res.timedOut) return { reason: 'ssh did not finish in time', keys: ADVICE_KEYS };
  const code = res.exitCode === null ? 'no exit code' : `exit ${res.exitCode}`;
  for (const [re, reason, keys] of SSH_REASONS) {
    if (re.test(res.stderr)) return { reason: `${reason} (${code})`, keys };
  }
  return { reason: `ssh failed (${code})`, keys: ADVICE_KEYS };
}

function defaultEnsureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Starts the tunnel unless the local port already listens. Idempotent: a
 * listening port starts nothing, and owned says whether the control socket
 * answers. A failed start returns state 'down' with an error.
 */
export async function tunnelUp(deps: TunnelDeps): Promise<TunnelResult> {
  const loaded = load(deps.config);
  if (!loaded.ok) return loaded.result;
  const { cfg } = loaded;
  const localPort = cfg.localPort;
  const where = `${BIND_ADDRESS}:${localPort}`;

  if (await probe(deps, cfg)) {
    const owned = await controlCheck(deps, cfg);
    return result({
      state: 'up',
      owned,
      listening: true,
      localPort,
      message: owned
        ? `SSFB DB tunnel is already up on ${where} and triage owns it`
        : `Port ${localPort} already listens on ${BIND_ADDRESS} but triage did not start it; nothing started`,
      keys: owned ? [] : [TUNNEL_KEYS.localPort],
    });
  }

  try {
    (deps.ensureDir ?? defaultEnsureDir)(dirname(cfg.socketPath));
  } catch {
    return result({
      state: 'down',
      localPort,
      message: 'SSFB DB tunnel did not start',
      error: `the control socket directory under ${DATA_DIR_KEY} could not be created`,
      keys: [DATA_DIR_KEY],
    });
  }

  const res = await deps.runner.run(SSH_BIN, buildTunnelUpArgv(cfg), runOpts(deps, TUNNEL_TIMEOUTS.upMs));
  if (!succeeded(res)) {
    const { reason, keys } = describeFailure(res);
    return result({ state: 'down', localPort, message: 'SSFB DB tunnel did not start', error: reason, keys });
  }

  if (!(await probe(deps, cfg))) {
    return result({
      state: 'down',
      owned: true,
      started: true,
      localPort,
      message: 'SSFB DB tunnel did not come up',
      error: `ssh started but port ${localPort} does not listen; run triage tunnel down and try again`,
      keys: [TUNNEL_KEYS.localPort],
    });
  }
  return result({
    state: 'up',
    owned: true,
    listening: true,
    started: true,
    localPort,
    message: `SSFB DB tunnel is up on ${where} (started by triage)`,
  });
}

/** Reports whether the local port listens and whether triage's control socket answers. */
export async function tunnelStatus(deps: TunnelDeps): Promise<TunnelResult> {
  const loaded = load(deps.config);
  if (!loaded.ok) return loaded.result;
  const { cfg } = loaded;
  const localPort = cfg.localPort;
  const listening = await probe(deps, cfg);
  const owned = await controlCheck(deps, cfg);
  const where = `${BIND_ADDRESS}:${localPort}`;

  if (listening) {
    return result({
      state: 'up',
      owned,
      listening,
      localPort,
      message: owned
        ? `SSFB DB tunnel is up on ${where} and triage owns it`
        : `Port ${localPort} listens on ${BIND_ADDRESS} but triage did not start that tunnel`,
      keys: owned ? [] : [TUNNEL_KEYS.localPort],
    });
  }
  if (owned) {
    return result({
      state: 'down',
      owned,
      localPort,
      message: `SSFB DB tunnel is down on ${where}`,
      error: `the control socket answers but port ${localPort} does not listen; run triage tunnel down and then up`,
      keys: [TUNNEL_KEYS.localPort],
    });
  }
  return result({ state: 'down', localPort, message: `SSFB DB tunnel is down on ${where}` });
}

/** Stops the tunnel through its control socket, and only when triage owns it. */
export async function tunnelDown(deps: TunnelDeps): Promise<TunnelResult> {
  const loaded = load(deps.config);
  if (!loaded.ok) return loaded.result;
  const { cfg } = loaded;
  const localPort = cfg.localPort;
  const owned = await controlCheck(deps, cfg);

  if (!owned) {
    const listening = await probe(deps, cfg);
    return result({
      state: listening ? 'up' : 'down',
      listening,
      localPort,
      message: listening
        ? `Port ${localPort} listens on ${BIND_ADDRESS} but triage did not start that tunnel; left running`
        : 'No tunnel started by triage is running; nothing stopped',
      keys: listening ? [TUNNEL_KEYS.localPort] : [],
    });
  }

  const res = await deps.runner.run(SSH_BIN, buildControlArgv(cfg, 'exit'), runOpts(deps, TUNNEL_TIMEOUTS.exitMs));
  if (!succeeded(res)) {
    const { reason } = describeFailure(res);
    return result({
      state: 'up',
      owned: true,
      listening: await probe(deps, cfg),
      localPort,
      message: 'SSFB DB tunnel did not stop',
      error: reason,
      keys: [],
    });
  }
  return result({ state: 'down', stopped: true, localPort, message: `SSFB DB tunnel on port ${localPort} stopped` });
}
