import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Each run's /data lives under a temp runsDir, never under the repo.
const TEMP = mkdtempSync(join(tmpdir(), 'triage-sandbox-test-'));
const RUNS = join(TEMP, 'runs');
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

// bun cannot run just-bash's defense-in-depth patches; Node (the app runtime) can.
const UNDER_BUN = { defenseInDepth: false, runsDir: RUNS } as const;

async function open(factory: SandboxFactory, id = 'run_sandbox_test'): Promise<Sandbox> {
  return factory.createSandbox({ id });
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

  test('python3 is absent when TRIAGE_SANDBOX_PYTHON is false', async () => {
    const sandbox = await open(sandboxFactory(config, UNDER_BUN));
    const r = await sandbox.exec('python3 -c "print(1)"');
    expect(r.exitCode).not.toBe(0);
  });
});

describe('per-run /data (D105)', () => {
  const config = configWith({ [SANDBOX_PROVIDER_KEY]: 'virtual' });

  test('a file written by one sandbox is readable by the next sandbox of the same run', async () => {
    const first = await open(sandboxFactory(config, UNDER_BUN), 'run_keep');
    await first.writeFile('/data/kept.json', '{"n":1}');
    const w = await first.exec('mkdir -p /data/scripts && echo \'echo 2\' > /data/scripts/two.sh');
    expect(w.exitCode).toBe(0);
    // A new factory as well, as after a process restart.
    const second = await open(sandboxFactory(config, UNDER_BUN), 'run_keep');
    expect(await second.readFile('/data/kept.json')).toBe('{"n":1}');
    expect((await second.exec('bash /data/scripts/two.sh')).stdout.trim()).toBe('2');
    expect(readFileSync(join(RUNS, 'run_keep', 'sandbox', 'kept.json'), 'utf8')).toBe('{"n":1}');
  });

  test('different run ids are isolated', async () => {
    const a = await open(sandboxFactory(config, UNDER_BUN), 'run_iso_a');
    await a.writeFile('/data/only-here.json', '{}');
    const b = await open(sandboxFactory(config, UNDER_BUN), 'run_iso_b');
    expect(await b.exists('/data/only-here.json')).toBe(false);
    expect((await b.exec('cat /data/only-here.json')).exitCode).not.toBe(0);
  });

  test('the run directory is created with mode 700', async () => {
    await open(sandboxFactory(config, UNDER_BUN), 'run_mode');
    expect(statSync(join(RUNS, 'run_mode', 'sandbox')).mode & 0o777).toBe(0o700);
  });

  test('a run id that is not a valid run id is refused', async () => {
    const factory = sandboxFactory(config, UNDER_BUN);
    for (const id of ['..', '../escape', 'a/b', '']) {
      await expect(open(factory, id)).rejects.toThrow(/not a valid run id/);
    }
    expect(existsSync(join(TEMP, 'escape'))).toBe(false);
  });

  test("'/data/../..' does not leave the run directory", async () => {
    writeFileSync(join(TEMP, 'outside.txt'), 'host file');
    const sandbox = await open(sandboxFactory(config, UNDER_BUN), 'run_dotdot');
    const r = await sandbox.exec('cat /data/../../outside.txt; cat /data/../../../outside.txt');
    expect(r.stdout).not.toContain('host file');
    await sandbox.writeFile('/data/../../planted.txt', 'x');
    expect(existsSync(join(RUNS, 'planted.txt'))).toBe(false);
    expect(existsSync(join(TEMP, 'planted.txt'))).toBe(false);
    expect(await sandbox.exists('/data/planted.txt')).toBe(false);
  });

  test('symlinks are refused, both made in the sandbox and planted on disk', async () => {
    writeFileSync(join(TEMP, 'secret.txt'), 'host secret');
    const sandbox = await open(sandboxFactory(config, UNDER_BUN), 'run_link');
    const made = await sandbox.exec(`ln -s ${join(TEMP, 'secret.txt')} /data/made && cat /data/made`);
    expect(made.exitCode).not.toBe(0);
    expect(made.stdout).not.toContain('host secret');
    symlinkSync(join(TEMP, 'secret.txt'), join(RUNS, 'run_link', 'sandbox', 'planted'));
    await expect(sandbox.readFile('/data/planted')).rejects.toThrow();
    const r = await sandbox.exec('cat /data/planted');
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain('host secret');
  });

  test('writes past TRIAGE_SANDBOX_QUOTA_MB fail with the quota message', async () => {
    const small = configWith({ [SANDBOX_PROVIDER_KEY]: 'virtual', TRIAGE_SANDBOX_QUOTA_MB: '1' });
    const sandbox = await open(sandboxFactory(small, UNDER_BUN), 'run_quota');
    const half = 'x'.repeat(600 * 1024);
    await sandbox.writeFile('/data/a.txt', half);
    await expect(sandbox.writeFile('/data/b.txt', half)).rejects.toThrow('sandbox quota of 1 MB reached');
    // just-bash does not catch a failed redirect write, so the bash call
    // itself fails with the message; the model gets it as the tool error.
    await expect(sandbox.exec(`printf '%0${600 * 1024}d' 0 > /data/c.txt`)).rejects.toThrow('sandbox quota of 1 MB reached');
    await expect(sandbox.exec('cat /data/a.txt >> /data/a.txt')).rejects.toThrow('sandbox quota of 1 MB reached');
    const cp = await sandbox.exec('cp /data/a.txt /data/d.txt');
    expect(cp.exitCode).not.toBe(0);
    expect(cp.stderr).toContain('sandbox quota of 1 MB reached');
    // Removing a file frees its space again.
    expect((await sandbox.exec('rm /data/a.txt')).exitCode).toBe(0);
    await sandbox.writeFile('/data/b.txt', half);
    // The next sandbox of the run starts from what is on disk.
    const again = await open(sandboxFactory(small, UNDER_BUN), 'run_quota');
    await expect(again.writeFile('/data/e.txt', half)).rejects.toThrow('sandbox quota of 1 MB reached');
  });

  test('replacing a file near the quota counts only its new size', async () => {
    const small = configWith({ [SANDBOX_PROVIDER_KEY]: 'virtual', TRIAGE_SANDBOX_QUOTA_MB: '1' });
    const sandbox = await open(sandboxFactory(small, UNDER_BUN), 'run_quota_replace');
    const big = 'x'.repeat(700 * 1024);
    await sandbox.writeFile('/data/out.json', big);
    await sandbox.writeFile('/data/out.json', big);
    await sandbox.writeFile('/data/src.json', 'y'.repeat(200 * 1024));
    expect((await sandbox.exec('cp /data/src.json /data/out.json')).exitCode).toBe(0);
    await sandbox.writeFile('/data/out.json', big);
  });
});

describe('/scripts', () => {
  test('is mounted read-only from <knowledgeDir>/scripts', async () => {
    const knowledge = join(TEMP, 'knowledge');
    mkdirSync(join(knowledge, 'scripts'), { recursive: true });
    writeFileSync(join(knowledge, 'scripts', 'sum.sh'), "jq '[.[]] | add'\n");
    const config = configWith({ [SANDBOX_PROVIDER_KEY]: 'virtual', TRIAGE_KNOWLEDGE_DIR: knowledge });
    const sandbox = await open(sandboxFactory(config, UNDER_BUN), 'run_scripts');
    const r = await sandbox.exec("echo '[1,2,3]' | bash /scripts/sum.sh");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('6');
    await expect(sandbox.exec('echo x > /scripts/new.sh')).rejects.toThrow(/EROFS/);
    expect((await sandbox.exec('rm /scripts/sum.sh')).exitCode).not.toBe(0);
    await expect(sandbox.writeFile('/scripts/sum.sh', 'echo changed')).rejects.toThrow();
    expect(readFileSync(join(knowledge, 'scripts', 'sum.sh'), 'utf8')).toBe("jq '[.[]] | add'\n");
    expect(existsSync(join(knowledge, 'scripts', 'new.sh'))).toBe(false);
  });

  test('is absent when the folder does not exist', async () => {
    const config = configWith({ [SANDBOX_PROVIDER_KEY]: 'virtual', TRIAGE_KNOWLEDGE_DIR: join(TEMP, 'no-knowledge') });
    const sandbox = await open(sandboxFactory(config, UNDER_BUN), 'run_no_scripts');
    expect(await sandbox.exists('/scripts')).toBe(false);
    expect((await sandbox.exec('ls /scripts')).exitCode).not.toBe(0);
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
