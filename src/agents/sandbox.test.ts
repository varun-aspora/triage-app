import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sandbox, SandboxFactory } from '@flue/runtime';
import { parse } from 'dotenv';
import { type Config, configFromRecord } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';
import {
  type DaytonaSandboxLike,
  type E2bSandboxLike,
  SANDBOX_PROVIDER_KEY,
  SandboxNotConfiguredError,
  SandboxProviderError,
  sandboxFactory,
  selectSandboxProvider,
  withCommandTimeout,
} from './sandbox.ts';

const ROOT = join(import.meta.dir, '../..');
const HOME = '/triage-test/home';
const EXAMPLE: Readonly<Record<string, string>> = parse(readFileSync(join(ROOT, '.env.example'), 'utf8'));

/** Config from .env.example with overrides; undefined removes a key. */
function configWith(env: Record<string, string | undefined>, opts?: { policyChecks?: boolean }): Config {
  const record: Record<string, string> = { ...EXAMPLE };
  for (const [k, val] of Object.entries(env)) {
    if (val === undefined) delete record[k];
    else record[k] = val;
  }
  return configFromRecord(record, HOME, opts);
}

// bun cannot run just-bash's defense-in-depth patches; Node (the app runtime) can.
const UNDER_BUN = { defenseInDepth: false } as const;

async function open(factory: SandboxFactory): Promise<Sandbox> {
  return factory.createSandbox({ id: 'run_sandbox_test' });
}

function expectProviderError(fn: () => unknown, detail: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxProviderError);
  const message = (caught as Error).message;
  expect(message).toContain(SANDBOX_PROVIDER_KEY);
  expect(message).toMatch(detail);
}

describe('provider selection', () => {
  test('unset means virtual', () => {
    expect(selectSandboxProvider(undefined)).toBe('virtual');
  });

  test('virtual, e2b and daytona are accepted as written', () => {
    for (const p of ['virtual', 'e2b', 'daytona'] as const) expect(selectSandboxProvider(p)).toBe(p);
  });

  test("'local', 'LOCAL', ' local ', 'docker' and '' each throw naming the key", () => {
    expectProviderError(() => selectSandboxProvider('local'), /local is refused/);
    expectProviderError(() => selectSandboxProvider('LOCAL'), /local is refused/);
    expectProviderError(() => selectSandboxProvider(' local '), /local is refused/);
    expectProviderError(() => selectSandboxProvider('docker'), /must be one of virtual, e2b, daytona/);
    expectProviderError(() => selectSandboxProvider(''), /must be one of/);
    expectProviderError(() => selectSandboxProvider('Virtual'), /must be one of/);
  });

  test('the refusal text never echoes the value', () => {
    expect(() => selectSandboxProvider('docker-secret-host')).toThrow(/^(?!.*docker-secret-host).*$/);
  });

  test('a config with the key missing gives a working virtual sandbox', async () => {
    const config = configWith({ [SANDBOX_PROVIDER_KEY]: undefined });
    const sandbox = await open(sandboxFactory(config, UNDER_BUN));
    const r = await sandbox.exec('echo ok');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
  });

  test("an explicitly empty key throws instead of falling back to virtual", () => {
    const config = configWith({ [SANDBOX_PROVIDER_KEY]: '' });
    expect(config.sandbox.provider).toBe('virtual');
    expectProviderError(() => sandboxFactory(config), /must be one of/);
  });

  test("'LOCAL' and 'docker' are refused by the loader, naming the key", () => {
    for (const value of ['LOCAL', 'docker']) {
      for (const policyChecks of [true, false]) {
        let caught: unknown;
        try {
          configWith({ [SANDBOX_PROVIDER_KEY]: value }, { policyChecks });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).keys).toContain(SANDBOX_PROVIDER_KEY);
        expect((caught as Error).message).not.toContain(value);
      }
    }
  });

  test('local is refused by the loader with policy checks on', () => {
    expect(() => configWith({ [SANDBOX_PROVIDER_KEY]: 'local' })).toThrow(ConfigError);
  });

  test('local is refused at use time with a policyChecks:false config', () => {
    const config = configWith({ [SANDBOX_PROVIDER_KEY]: 'local' }, { policyChecks: false });
    expect(config.sandbox.provider).toBe('local');
    expectProviderError(() => sandboxFactory(config), /local is refused \(D45\)/);
  });
});

describe('virtual sandbox', () => {
  const config = configWith({ [SANDBOX_PROVIDER_KEY]: 'virtual', TRIAGE_SANDBOX_PYTHON: 'false' });

  test('curl and wget fail for every origin', async () => {
    const sandbox = await open(sandboxFactory(config, UNDER_BUN));
    const commands = [
      'curl https://example.com/',
      'curl -s http://127.0.0.1:8080/',
      'curl http://localhost/',
      'curl https://api.anthropic.com/v1/messages',
      'wget https://example.com/',
    ];
    for (const command of commands) {
      const r = await sandbox.exec(command);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  test('a file written to /data can be read back with jq', async () => {
    const sandbox = await open(sandboxFactory(config, UNDER_BUN));
    const rows = { rows: [{ id: 'a1', amount: 10 }, { id: 'b2', amount: 32 }] };
    await sandbox.writeFile('/data/x.json', JSON.stringify(rows));
    const r = await sandbox.exec("jq -r '[.rows[].amount] | add' /data/x.json");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('42');
    expect(await sandbox.readFile('/data/x.json')).toBe(JSON.stringify(rows));
  });

  test('a file written by the shell under /data can be read by jq', async () => {
    const sandbox = await open(sandboxFactory(config, UNDER_BUN));
    const w = await sandbox.exec(`mkdir -p /data && echo '{"n":7}' > /data/y.json`);
    expect(w.exitCode).toBe(0);
    const r = await sandbox.exec('jq .n /data/y.json');
    expect(r.stdout.trim()).toBe('7');
  });

  test('each sandbox starts empty', async () => {
    const first = await open(sandboxFactory(config, UNDER_BUN));
    await first.writeFile('/data/only-here.json', '{}');
    const second = await open(sandboxFactory(config, UNDER_BUN));
    expect(await second.exists('/data/only-here.json')).toBe(false);
  });

  test('python3 is absent when TRIAGE_SANDBOX_PYTHON is false', async () => {
    const sandbox = await open(sandboxFactory(config, UNDER_BUN));
    const r = await sandbox.exec('python3 -c "print(1)"');
    expect(r.exitCode).not.toBe(0);
  });
});

describe('per-command timeout', () => {
  function recordingFactory(seen: (number | undefined)[]): SandboxFactory {
    return {
      async createSandbox() {
        return {
          exec: async (_cmd, opts) => {
            seen.push(opts?.timeoutMs);
            return { stdout: '', stderr: '', exitCode: 0 };
          },
          readFile: async () => '',
          readFileBuffer: async () => new Uint8Array(),
          writeFile: async () => {},
          stat: async () => ({ isFile: true, isDirectory: false }),
          readdir: async () => [],
          exists: async () => false,
          mkdir: async () => {},
          rm: async () => {},
          cwd: '/',
          resolvePath: (p) => p,
        };
      },
    };
  }

  test('commands get the configured timeout, and a caller may only ask for less', async () => {
    const seen: (number | undefined)[] = [];
    const sandbox = await open(withCommandTimeout(recordingFactory(seen), 30_000));
    await sandbox.exec('true');
    await sandbox.exec('true', { timeoutMs: 5_000 });
    await sandbox.exec('true', { timeoutMs: 600_000 });
    expect(seen).toEqual([30_000, 5_000, 30_000]);
  });

  test('the virtual factory applies TRIAGE_SANDBOX_TIMEOUT_MS', async () => {
    const config = configWith({ TRIAGE_SANDBOX_TIMEOUT_MS: '50' });
    const sandbox = await open(sandboxFactory(config, UNDER_BUN));
    const started = Date.now();
    const r = await sandbox.exec('while true; do :; done');
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('remote backends', () => {
  test('e2b with a blank E2B_API_KEY throws sandbox not configured', () => {
    const config = configWith({ [SANDBOX_PROVIDER_KEY]: 'e2b', E2B_API_KEY: '' });
    expect(() => sandboxFactory(config, UNDER_BUN)).toThrow(SandboxNotConfiguredError);
    expect(() => sandboxFactory(config, UNDER_BUN)).toThrow(/^sandbox not configured: e2b: E2B_API_KEY is blank$/);
  });

  test('daytona with a blank DAYTONA_API_KEY throws sandbox not configured', () => {
    const config = configWith({ [SANDBOX_PROVIDER_KEY]: 'daytona', DAYTONA_API_KEY: '' });
    expect(() => sandboxFactory(config, UNDER_BUN)).toThrow(SandboxNotConfiguredError);
    expect(() => sandboxFactory(config, UNDER_BUN)).toThrow(/^sandbox not configured: daytona: DAYTONA_API_KEY is blank$/);
  });

  test('building the factory loads nothing; a missing SDK fails createSandbox with no fallback', async () => {
    for (const provider of ['e2b', 'daytona'] as const) {
      const loads: string[] = [];
      const config = configWith({
        [SANDBOX_PROVIDER_KEY]: provider,
        E2B_API_KEY: 'test-key-not-real',
        DAYTONA_API_KEY: 'test-key-not-real',
      });
      const factory = sandboxFactory(config, {
        importModule: async (s) => {
          loads.push(s);
          throw new Error('Cannot find package');
        },
      });
      expect(loads).toEqual([]);
      const failed = open(factory);
      expect(failed).rejects.toThrow(SandboxNotConfiguredError);
      await expect(failed).rejects.toThrow(`sandbox not configured: ${provider}`);
      expect(loads).toEqual([provider === 'e2b' ? 'e2b' : '@daytonaio/sdk']);
    }
  });

  test('an SDK without the expected export is not configured either', async () => {
    const config = configWith({ [SANDBOX_PROVIDER_KEY]: 'e2b', E2B_API_KEY: 'test-key-not-real' });
    const factory = sandboxFactory(config, { importModule: async () => ({ something: 1 }) });
    await expect(open(factory)).rejects.toThrow(/sandbox not configured: e2b/);
  });

  test('e2b: created without internet, commands map to results, non-zero exits are results', async () => {
    const files = new Map<string, string>();
    const created: unknown[] = [];
    const runs: unknown[] = [];
    const remote: E2bSandboxLike = {
      files: {
        read: async (p) => files.get(p) ?? '',
        write: async (p, d) => void files.set(p, typeof d === 'string' ? d : Buffer.from(d).toString('utf8')),
        getInfo: async (p) => ({ name: p, type: 'file', size: files.get(p)?.length ?? 0 }),
        list: async () => [...files.keys()].map((name) => ({ name })),
        exists: async (p) => files.has(p),
        makeDir: async () => true,
        remove: async (p) => void files.delete(p),
      },
      commands: {
        run: async (cmd, opts) => {
          runs.push({ cmd, opts });
          if (cmd === 'false') throw Object.assign(new Error('exit 1'), { exitCode: 1, stdout: '', stderr: 'no' });
          return { stdout: 'hi\n', stderr: '', exitCode: 0 };
        },
      },
    };
    const config = configWith({ [SANDBOX_PROVIDER_KEY]: 'e2b', E2B_API_KEY: 'test-key-not-real' });
    const sandbox = await open(
      sandboxFactory(config, {
        importModule: async () => ({
          Sandbox: {
            create: async (opts: unknown) => {
              created.push(opts);
              return remote;
            },
          },
        }),
      }),
    );
    expect(created).toEqual([
      { apiKey: 'test-key-not-real', timeoutMs: config.budgets.runTimeoutMs, allowInternetAccess: false },
    ]);
    expect(sandbox.cwd).toBe('/home/user');
    expect(await sandbox.exec('echo hi')).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    expect(await sandbox.exec('false')).toEqual({ stdout: '', stderr: 'no', exitCode: 1 });
    expect((runs[0] as { opts: { timeoutMs: number } }).opts.timeoutMs).toBe(config.sandbox.timeoutMs);
    await sandbox.writeFile('/data/x.json', '{"a":1}');
    expect(await sandbox.readFile('/data/x.json')).toBe('{"a":1}');
    expect(sandbox.rm('/data', { recursive: true })).rejects.toThrow();
  });

  test('daytona: created with the network blocked, cwd from the provider, timeout in whole seconds', async () => {
    const created: unknown[] = [];
    const clients: unknown[] = [];
    const runs: unknown[] = [];
    const remote: DaytonaSandboxLike = {
      fs: {
        downloadFile: async () => Buffer.from('{"a":1}'),
        uploadFile: async () => {},
        getFileDetails: async (p) => {
          if (p.endsWith('missing')) throw new Error('not found');
          return { name: p, isDir: false, size: 7 };
        },
        listFiles: async () => [{ name: 'x.json' }],
        createFolder: async () => {},
        deleteFile: async () => {},
      },
      process: {
        executeCommand: async (command, cwd, env, timeoutSec) => {
          runs.push({ command, cwd, env, timeoutSec });
          return { exitCode: 0, result: 'ok' };
        },
      },
      getWorkDir: async () => '/workspace',
    };
    class FakeDaytona {
      constructor(cfg: unknown) {
        clients.push(cfg);
      }
      async create(params: unknown) {
        created.push(params);
        return remote;
      }
    }
    const config = configWith({
      [SANDBOX_PROVIDER_KEY]: 'daytona',
      DAYTONA_API_KEY: 'test-key-not-real',
      TRIAGE_SANDBOX_TIMEOUT_MS: '1500',
    });
    const sandbox = await open(sandboxFactory(config, { importModule: async () => ({ Daytona: FakeDaytona }) }));
    expect(clients).toEqual([{ apiKey: 'test-key-not-real' }]);
    expect(created).toEqual([{ networkBlockAll: true }]);
    expect(sandbox.cwd).toBe('/workspace');
    expect(await sandbox.exec('ls')).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect((runs[0] as { timeoutSec: number }).timeoutSec).toBe(2);
    expect(await sandbox.readFile('/workspace/x.json')).toBe('{"a":1}');
    expect(await sandbox.exists('/workspace/missing')).toBe(false);
    expect(sandbox.rm('/workspace/x.json', { force: true })).rejects.toThrow();
  });
});
