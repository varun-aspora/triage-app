// The one sandbox the Triage root mounts (D45, HLD 02 §2). sandboxFactory()
// picks the backend from TRIAGE_SANDBOX_PROVIDER:
//
// - virtual (the default when unset): just-bash over an in-memory
//   filesystem. No network (curl and wget are not even registered), python3
//   only when TRIAGE_SANDBOX_PYTHON is true, the hardened resource limits,
//   and a per-command timeout of TRIAGE_SANDBOX_TIMEOUT_MS.
// - e2b and daytona: the remote backends. Their SDKs are loaded by dynamic
//   import inside createSandbox(), so nothing is fetched until an agent
//   initializes. A blank API key or an SDK that does not load throws
//   'sandbox not configured'. There is no fallback to another backend.
// - local, or any other value: refused. local() is not an isolation
//   boundary. The config loader refuses it too; this is the second check.
//
// This file only builds the sandbox. Staging rows into /data is
// stageRows() in src/tools/_lib/pipeline.ts (T05.1).

import {
  bash,
  type FileStat,
  type Sandbox,
  type SandboxDriver,
  type SandboxFactory,
  sandboxFromDriver,
  SandboxOperationUnsupportedError,
  type ShellResult,
} from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';
import { type Config, loadConfig, rawKeyState } from '../config/env.ts';

export const SANDBOX_PROVIDER_KEY = 'TRIAGE_SANDBOX_PROVIDER';
export const SANDBOX_PROVIDERS = ['virtual', 'e2b', 'daytona'] as const;
export type AllowedSandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

/** Base directory of the remote backends when the provider does not say. */
const E2B_CWD = '/home/user';
const DAYTONA_CWD = '/home/daytona';

/** A refused TRIAGE_SANDBOX_PROVIDER value. The message names the key, never the value. */
export class SandboxProviderError extends Error {
  override readonly name = 'SandboxProviderError';
  readonly key = SANDBOX_PROVIDER_KEY;
}

/** A remote backend without its API key or SDK. */
export class SandboxNotConfiguredError extends Error {
  override readonly name = 'SandboxNotConfiguredError';
  readonly provider: AllowedSandboxProvider;
  constructor(provider: AllowedSandboxProvider, detail: string, options?: { cause?: unknown }) {
    super(`sandbox not configured: ${provider}: ${detail}`, options);
    this.provider = provider;
  }
}

/**
 * Maps the raw setting to a backend. undefined (unset) means virtual. Any
 * value other than virtual, e2b or daytona throws, including '' and case
 * variants such as 'LOCAL'.
 */
export function selectSandboxProvider(raw: string | undefined): AllowedSandboxProvider {
  if (raw === undefined) return 'virtual';
  if ((SANDBOX_PROVIDERS as readonly string[]).includes(raw)) return raw as AllowedSandboxProvider;
  if (raw.trim().toLowerCase() === 'local') {
    throw new SandboxProviderError(
      `${SANDBOX_PROVIDER_KEY}=local is refused (D45): local() is not an isolation boundary; use virtual, e2b or daytona`,
    );
  }
  throw new SandboxProviderError(`${SANDBOX_PROVIDER_KEY} must be one of ${SANDBOX_PROVIDERS.join(', ')}`);
}

/**
 * The provider setting as the factory sees it. The loader turns a blank
 * value into the default, so an explicitly empty key is read back as ''
 * here and refused rather than silently becoming virtual.
 */
function providerSetting(config: Config): string | undefined {
  if (rawKeyState(config, SANDBOX_PROVIDER_KEY) === 'empty') return '';
  return config.sandbox.provider;
}

// ------------------------------------------------------------ SDK shapes
// Only the members this file calls. The real SDK objects satisfy them, and
// tests pass small fakes through SandboxFactoryOptions.importModule.

type E2bCommandResult = { stdout: string; stderr: string; exitCode: number };
type E2bEntry = { name: string; type?: string; size?: number; modifiedTime?: Date };

export type E2bSandboxLike = {
  files: {
    read(path: string, opts?: { format?: 'text' | 'bytes' }): Promise<string | Uint8Array>;
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    getInfo(path: string): Promise<E2bEntry>;
    list(path: string): Promise<E2bEntry[]>;
    exists(path: string): Promise<boolean>;
    makeDir(path: string): Promise<unknown>;
    remove(path: string): Promise<void>;
  };
  commands: {
    run(
      cmd: string,
      opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
    ): Promise<E2bCommandResult>;
  };
};

export type E2bModule = {
  Sandbox: {
    create(opts: { apiKey: string; timeoutMs?: number; allowInternetAccess?: boolean }): Promise<E2bSandboxLike>;
  };
};

type DaytonaFileInfo = { name: string; isDir?: boolean; size?: number; modTime?: string };

export type DaytonaSandboxLike = {
  fs: {
    downloadFile(path: string): Promise<Uint8Array>;
    uploadFile(file: Buffer, path: string): Promise<void>;
    getFileDetails(path: string): Promise<DaytonaFileInfo>;
    listFiles(path: string): Promise<DaytonaFileInfo[]>;
    createFolder(path: string, mode: string): Promise<void>;
    deleteFile(path: string, recursive?: boolean): Promise<void>;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSec?: number,
    ): Promise<{ exitCode: number; result?: string; artifacts?: { stdout?: string } }>;
  };
  getWorkDir?(): Promise<string | undefined>;
};

export type DaytonaModule = {
  Daytona: new (config: { apiKey: string; apiUrl?: string }) => {
    create(params?: { networkBlockAll?: boolean }): Promise<DaytonaSandboxLike>;
  };
};

export type SandboxFactoryOptions = {
  /** Loads an SDK by package name. Defaults to dynamic import(). */
  readonly importModule?: (specifier: string) => Promise<unknown>;
  /**
   * just-bash's defense-in-depth patches (virtual only). On by default.
   * Unit tests under bun turn it off, because bun does not let just-bash
   * patch Node's module loader and every command would fail. Node, where
   * the app runs, supports it.
   */
  readonly defenseInDepth?: boolean;
};

const E2B_PACKAGE = 'e2b';
const DAYTONA_PACKAGE = '@daytonaio/sdk';

const defaultImport = (specifier: string): Promise<unknown> => import(specifier);

// ------------------------------------------------------------ factory

/**
 * The sandbox factory for useSandbox() on the Triage root. Throws right away
 * for a refused provider or a missing API key; an SDK that does not load
 * fails agent initialization with 'sandbox not configured'.
 */
export function sandboxFactory(config: Config = loadConfig(), options: SandboxFactoryOptions = {}): SandboxFactory {
  const provider = selectSandboxProvider(providerSetting(config));
  const load = options.importModule ?? defaultImport;
  const capMs = config.sandbox.timeoutMs;
  switch (provider) {
    case 'virtual':
      return withCommandTimeout(virtualFactory(config, options.defenseInDepth ?? true), capMs);
    case 'e2b':
      return withCommandTimeout(e2bFactory(config, load), capMs);
    case 'daytona':
      return withCommandTimeout(daytonaFactory(config, load), capMs);
  }
}

function virtualFactory(config: Config, defenseInDepth: boolean): SandboxFactory {
  // No network and no fetch: just-bash registers curl and wget only when one
  // of them is given, so neither command exists in this sandbox.
  return bash(
    () =>
      new Bash({
        fs: new InMemoryFs(),
        python: config.sandbox.python,
        executionLimitProfile: 'hardened',
        defenseInDepth,
      }),
  );
}

function e2bFactory(config: Config, load: (s: string) => Promise<unknown>): SandboxFactory {
  const apiKey = config.sandbox.e2bApiKey;
  if (apiKey === undefined) throw new SandboxNotConfiguredError('e2b', 'E2B_API_KEY is blank');
  return {
    async createSandbox() {
      const mod = await loadSdk<E2bModule>('e2b', E2B_PACKAGE, load, (m) => typeof (m.Sandbox as { create?: unknown } | undefined)?.create === 'function');
      const remote = await mod.Sandbox.create({
        apiKey,
        // The sandbox should outlive the run, and reach nothing on the network.
        timeoutMs: config.budgets.runTimeoutMs,
        allowInternetAccess: false,
      });
      return sandboxFromDriver(e2bDriver(remote), E2B_CWD);
    },
  };
}

function daytonaFactory(config: Config, load: (s: string) => Promise<unknown>): SandboxFactory {
  const apiKey = config.sandbox.daytonaApiKey;
  if (apiKey === undefined) throw new SandboxNotConfiguredError('daytona', 'DAYTONA_API_KEY is blank');
  const apiUrl = config.sandbox.daytonaApiUrl;
  return {
    async createSandbox() {
      const mod = await loadSdk<DaytonaModule>('daytona', DAYTONA_PACKAGE, load, (m) => typeof m.Daytona === 'function');
      const client = new mod.Daytona({ apiKey, ...(apiUrl !== undefined ? { apiUrl } : {}) });
      const remote = await client.create({ networkBlockAll: true });
      const cwd = (await remote.getWorkDir?.()) ?? DAYTONA_CWD;
      return sandboxFromDriver(daytonaDriver(remote), cwd);
    },
  };
}

async function loadSdk<M>(
  provider: AllowedSandboxProvider,
  specifier: string,
  load: (s: string) => Promise<unknown>,
  looksRight: (m: Record<string, unknown>) => boolean,
): Promise<M> {
  let mod: unknown;
  try {
    mod = await load(specifier);
  } catch (cause) {
    throw new SandboxNotConfiguredError(provider, `the ${specifier} package did not load`, { cause });
  }
  if (mod === null || typeof mod !== 'object' || !looksRight(mod as Record<string, unknown>)) {
    throw new SandboxNotConfiguredError(provider, `the ${specifier} package does not export the expected API`);
  }
  return mod as M;
}

// ------------------------------------------------------------ per-command timeout

/**
 * Caps every exec at capMs. A caller may ask for less, never more.
 * Every other member is passed through unchanged.
 */
export function withCommandTimeout(factory: SandboxFactory, capMs: number): SandboxFactory {
  return {
    ...factory,
    async createSandbox(options) {
      const inner = await factory.createSandbox(options);
      return capExec(inner, capMs);
    },
  };
}

function capExec(inner: Sandbox, capMs: number): Sandbox {
  return {
    exec: (command, opts) =>
      inner.exec(command, {
        ...opts,
        timeoutMs: opts?.timeoutMs !== undefined ? Math.min(opts.timeoutMs, capMs) : capMs,
      }),
    readFile: (p) => inner.readFile(p),
    readFileBuffer: (p) => inner.readFileBuffer(p),
    writeFile: (p, c) => inner.writeFile(p, c),
    stat: (p) => inner.stat(p),
    readdir: (p) => inner.readdir(p),
    exists: (p) => inner.exists(p),
    mkdir: (p, o) => inner.mkdir(p, o),
    rm: (p, o) => inner.rm(p, o),
    cwd: inner.cwd,
    resolvePath: (p) => inner.resolvePath(p),
  };
}

// ------------------------------------------------------------ drivers

function refuseRmOptions(provider: string, opts: { recursive?: boolean; force?: boolean } | undefined, allowed: string[]): void {
  const asked = Object.entries(opts ?? {})
    .filter(([name, on]) => on === true && !allowed.includes(name))
    .map(([name]) => name);
  if (asked.length > 0) throw new SandboxOperationUnsupportedError({ operation: 'rm', provider, options: asked });
}

function toArrayBuffer(content: string | Uint8Array): string | ArrayBuffer {
  if (typeof content === 'string') return content;
  return content.slice().buffer as ArrayBuffer;
}

function isCommandExit(err: unknown): err is E2bCommandResult {
  const e = err as Partial<E2bCommandResult> | null;
  return typeof e?.exitCode === 'number' && typeof e.stdout === 'string' && typeof e.stderr === 'string';
}

/** SandboxDriver over an E2B sandbox. E2B throws on a non-zero exit; that becomes a result. */
export function e2bDriver(remote: E2bSandboxLike): SandboxDriver {
  const { files, commands } = remote;
  return {
    readFile: async (p) => String(await files.read(p)),
    readFileBuffer: async (p) => (await files.read(p, { format: 'bytes' })) as Uint8Array,
    writeFile: async (p, c) => void (await files.write(p, toArrayBuffer(c))),
    async stat(p): Promise<FileStat> {
      const info = await files.getInfo(p);
      return {
        isFile: info.type === 'file',
        isDirectory: info.type === 'dir',
        ...(info.size !== undefined ? { size: info.size } : {}),
        ...(info.modifiedTime !== undefined ? { mtime: info.modifiedTime } : {}),
      };
    },
    readdir: async (p) => (await files.list(p)).map((e) => e.name),
    exists: (p) => files.exists(p).catch(() => false),
    mkdir: async (p) => void (await files.makeDir(p)),
    async rm(p, opts) {
      refuseRmOptions('e2b', opts, []);
      await files.remove(p);
    },
    async exec(command, opts): Promise<ShellResult> {
      try {
        const r = await commands.run(command, {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts?.env !== undefined ? { envs: opts.env } : {}),
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
        return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
      } catch (err) {
        if (isCommandExit(err)) return { stdout: err.stdout, stderr: err.stderr, exitCode: err.exitCode };
        throw err;
      }
    },
  };
}

/** SandboxDriver over a Daytona sandbox. Daytona merges stdout and stderr into one result. */
export function daytonaDriver(remote: DaytonaSandboxLike): SandboxDriver {
  const { fs, process: proc } = remote;
  const details = (p: string) => fs.getFileDetails(p);
  return {
    readFile: async (p) => Buffer.from(await fs.downloadFile(p)).toString('utf8'),
    readFileBuffer: async (p) => new Uint8Array(await fs.downloadFile(p)),
    writeFile: (p, c) => fs.uploadFile(typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c), p),
    async stat(p): Promise<FileStat> {
      const d = await details(p);
      const mtime = d.modTime !== undefined ? new Date(d.modTime) : undefined;
      return {
        isFile: d.isDir !== true,
        isDirectory: d.isDir === true,
        ...(d.size !== undefined ? { size: d.size } : {}),
        ...(mtime !== undefined && !Number.isNaN(mtime.getTime()) ? { mtime } : {}),
      };
    },
    readdir: async (p) => (await fs.listFiles(p)).map((f) => f.name),
    exists: (p) =>
      details(p).then(
        () => true,
        () => false,
      ),
    mkdir: (p) => fs.createFolder(p, '755'),
    async rm(p, opts) {
      refuseRmOptions('daytona', opts, ['recursive']);
      await fs.deleteFile(p, opts?.recursive === true);
    },
    async exec(command, opts): Promise<ShellResult> {
      const timeoutSec = opts?.timeoutMs !== undefined ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : undefined;
      const r = await proc.executeCommand(command, opts?.cwd, opts?.env, timeoutSec);
      return { stdout: r.result ?? r.artifacts?.stdout ?? '', stderr: '', exitCode: r.exitCode };
    },
  };
}
