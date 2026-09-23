import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { ConfigError } from '../../src/config/errors.ts';
import { createFakeRunner, type FakeRunner, type FakeStep } from '../../src/connectors/exec-fake.ts';
import type { ExecResult } from '../../src/connectors/exec.ts';
import {
  TUNNEL_KEYS,
  buildControlArgv,
  buildTunnelUpArgv,
  readTunnelConfig,
  tunnelDown,
  tunnelStatus,
  tunnelUp,
  type EnabledTunnelConfig,
  type TcpProbe,
  type TunnelDeps,
  type TunnelResult,
} from '../../src/ops/tunnel.ts';
import { REPO_ROOT, testEnvRecord } from '../support/home.ts';

// Seeded fake values. None of them names a real system: 203.0.113.0/24 is a
// documentation range and .invalid never resolves.
const HOME = '/triage/home';
const BASTION = 'tunnelop@203.0.113.7';
const IDENTITY = '/keys/fake-ssfb-bastion.pem';
const REMOTE_HOST = 'ssfb-reader.fixture.invalid';
const LOCAL_PORT = '55432';
const REMOTE_PORT = '5432';
const SOCKET = '/triage/home/.data/tunnel/ssfb-db.sock';

const FIXTURE: Readonly<Record<string, string>> = {
  SSFB_DB_TUNNEL_REQUIRED: 'true',
  SSFB_DB_TUNNEL_BASTION: BASTION,
  SSFB_DB_TUNNEL_IDENTITY_FILE: IDENTITY,
  SSFB_DB_TUNNEL_LOCAL_PORT: LOCAL_PORT,
  SSFB_DB_TUNNEL_REMOTE_HOST: REMOTE_HOST,
  SSFB_DB_TUNNEL_REMOTE_PORT: REMOTE_PORT,
};

const SEEDED_VALUES = [BASTION, 'tunnelop', '203.0.113.7', IDENTITY, 'fake-ssfb-bastion', REMOTE_HOST, SOCKET, REMOTE_PORT];

function configWith(overrides: Readonly<Record<string, string>> = {}): Config {
  return configFromRecord({ ...testEnvRecord(), ...FIXTURE, ...overrides }, HOME);
}

const UP_ARGV = [
  '-f',
  '-N',
  '-M',
  '-S',
  SOCKET,
  '-o',
  'ExitOnForwardFailure=yes',
  '-o',
  'BatchMode=yes',
  '-o',
  'ServerAliveInterval=30',
  '-i',
  IDENTITY,
  '-L',
  `127.0.0.1:${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT}`,
  BASTION,
];
const CHECK_ARGV = ['-S', SOCKET, '-O', 'check', BASTION];
const EXIT_ARGV = ['-S', SOCKET, '-O', 'exit', BASTION];

type Probe = TcpProbe & { calls: { host: string; port: number; timeoutMs: number }[] };

/** Answers are used in order; the last one repeats. */
function probeOf(...answers: (boolean | Error)[]): Probe {
  const calls: Probe['calls'] = [];
  const fn = (async (host: string, port: number, timeoutMs: number) => {
    calls.push({ host, port, timeoutMs });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a ?? false;
  }) as Probe;
  fn.calls = calls;
  return fn;
}

function step(argv: readonly string[], result: Partial<ExecResult> = {}): FakeStep {
  return { bin: 'ssh', argv, result };
}

type Harness = { deps: TunnelDeps; runner: FakeRunner; probe: Probe; dirs: string[] };

function harness(script: readonly FakeStep[], probe: Probe, overrides: Readonly<Record<string, string>> = {}): Harness {
  const runner = createFakeRunner(script);
  const dirs: string[] = [];
  const deps: TunnelDeps = { config: configWith(overrides), runner, tcpProbe: probe, ensureDir: (d) => dirs.push(d) };
  return { deps, runner, probe, dirs };
}

const upCalls = (runner: FakeRunner): number => runner.calls.filter((c) => c.argv.includes('-f')).length;
const exitCalls = (runner: FakeRunner): number => runner.calls.filter((c) => c.argv.includes('exit')).length;

function leakText(r: TunnelResult): string {
  return JSON.stringify(r);
}

function expectNoLeak(r: TunnelResult): void {
  const text = leakText(r);
  for (const v of SEEDED_VALUES) {
    // The remote port shares digits with the local port, so only whole tokens count.
    if (v === REMOTE_PORT) expect(text).not.toMatch(new RegExp(`(^|[^0-9])${v}([^0-9]|$)`));
    else expect(text).not.toContain(v);
  }
}

describe('readTunnelConfig', () => {
  test('reads the fixture env', () => {
    const cfg = readTunnelConfig(configWith());
    expect(cfg).toEqual({
      enabled: true,
      bastion: BASTION,
      identityFile: IDENTITY,
      localPort: 55432,
      remoteHost: REMOTE_HOST,
      remotePort: 5432,
      socketPath: SOCKET,
    });
  });

  test('a relative identity file resolves under the home', () => {
    const cfg = readTunnelConfig(configWith({ SSFB_DB_TUNNEL_IDENTITY_FILE: 'keys/id_fake' }));
    expect(cfg.enabled && cfg.identityFile).toBe('/triage/home/keys/id_fake');
  });

  test('a blank bastion gives enabled:false naming the key', () => {
    for (const blank of ['', '   ']) {
      const cfg = readTunnelConfig(configWith({ SSFB_DB_TUNNEL_BASTION: blank }));
      expect(cfg).toEqual({ enabled: false, reason: 'SSFB_DB_TUNNEL_BASTION is blank', keys: ['SSFB_DB_TUNNEL_BASTION'] });
    }
  });

  test('SSFB_DB_TUNNEL_REQUIRED=false gives enabled:false naming the key, even with a bad bastion', () => {
    for (const value of ['false', 'FALSE']) {
      const cfg = readTunnelConfig(configWith({ SSFB_DB_TUNNEL_REQUIRED: value, SSFB_DB_TUNNEL_BASTION: 'a;b' }));
      expect(cfg).toEqual({ enabled: false, reason: 'SSFB_DB_TUNNEL_REQUIRED=false', keys: ['SSFB_DB_TUNNEL_REQUIRED'] });
    }
  });

  test('a blank REQUIRED counts as true', () => {
    expect(readTunnelConfig(configWith({ SSFB_DB_TUNNEL_REQUIRED: '' })).enabled).toBe(true);
  });

  test('a REQUIRED value that is not a boolean is refused', () => {
    expect(() => readTunnelConfig(configWith({ SSFB_DB_TUNNEL_REQUIRED: 'yes' }))).toThrow(ConfigError);
  });

  test.each([
    ['a semicolon', 'ops@host;id'],
    ['a space', 'ops@host id'],
    ['a leading dash', '-oProxyCommand=id'],
    ['the placeholder', '<user>@<bastion-ip>'],
    ['a port suffix', 'ops@203.0.113.7:22'],
    ['a url', 'ssh://ops@203.0.113.7'],
    ['two at signs', 'a@b@c'],
  ])('a bastion with %s is refused and the error names the key only', (_label, bad) => {
    let err: unknown;
    try {
      readTunnelConfig(configWith({ SSFB_DB_TUNNEL_BASTION: bad }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    expect(ce.keys).toEqual(['SSFB_DB_TUNNEL_BASTION']);
    expect(ce.message).not.toContain(bad);
  });

  test.each(['0', '70000', 'abc', '-1', '1.5', ' ', '65536'])('port %p is refused for both port keys', (bad) => {
    for (const key of [TUNNEL_KEYS.localPort, TUNNEL_KEYS.remotePort]) {
      if (bad.trim() === '') {
        expect(() => readTunnelConfig(configWith({ [key]: bad }))).toThrow(/is required/);
        continue;
      }
      let err: unknown;
      try {
        readTunnelConfig(configWith({ [key]: bad }));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).keys).toEqual([key]);
    }
  });

  test('ports 1 and 65535 are accepted', () => {
    const cfg = readTunnelConfig(configWith({ SSFB_DB_TUNNEL_LOCAL_PORT: '1', SSFB_DB_TUNNEL_REMOTE_PORT: '65535' }));
    expect(cfg.enabled && [cfg.localPort, cfg.remotePort]).toEqual([1, 65535]);
  });

  test.each([
    [TUNNEL_KEYS.remoteHost, 'db.invalid;id'],
    [TUNNEL_KEYS.remoteHost, 'db.invalid:5432'],
    [TUNNEL_KEYS.remoteHost, '-db.invalid'],
    [TUNNEL_KEYS.identityFile, '/keys/my key.pem'],
    [TUNNEL_KEYS.identityFile, '~/.ssh/id_fake'],
    [TUNNEL_KEYS.identityFile, '/keys/%h.pem'],
    [TUNNEL_KEYS.identityFile, '-oProxyCommand=id'],
  ])('%s = %p is refused', (key, bad) => {
    expect(() => readTunnelConfig(configWith({ [key]: bad }))).toThrow(ConfigError);
  });

  test('blank required keys are all listed together', () => {
    try {
      readTunnelConfig(
        configWith({
          SSFB_DB_TUNNEL_IDENTITY_FILE: '',
          SSFB_DB_TUNNEL_REMOTE_HOST: '',
          SSFB_DB_TUNNEL_LOCAL_PORT: '',
          SSFB_DB_TUNNEL_REMOTE_PORT: '',
        }),
      );
      throw new Error('expected a ConfigError');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect([...(e as ConfigError).keys].sort()).toEqual(
        ['SSFB_DB_TUNNEL_IDENTITY_FILE', 'SSFB_DB_TUNNEL_LOCAL_PORT', 'SSFB_DB_TUNNEL_REMOTE_HOST', 'SSFB_DB_TUNNEL_REMOTE_PORT'].sort(),
      );
    }
  });

  test('a data dir too long for a unix socket is refused naming TRIAGE_DATA_DIR', () => {
    const long = `/${'d'.repeat(80)}`;
    try {
      readTunnelConfig(configWith({ TRIAGE_DATA_DIR: long }));
      throw new Error('expected a ConfigError');
    } catch (e) {
      expect((e as ConfigError).keys).toEqual(['TRIAGE_DATA_DIR']);
      expect((e as ConfigError).message).not.toContain(long);
    }
  });

  test('a data dir with whitespace is refused', () => {
    expect(() => readTunnelConfig(configWith({ TRIAGE_DATA_DIR: '/tmp/my data' }))).toThrow(ConfigError);
  });
});

describe('buildTunnelUpArgv', () => {
  test('argv snapshot from the fixture env', () => {
    const cfg = readTunnelConfig(configWith()) as EnabledTunnelConfig;
    expect(buildTunnelUpArgv(cfg)).toEqual(UP_ARGV);
    expect(buildControlArgv(cfg, 'check')).toEqual(CHECK_ARGV);
    expect(buildControlArgv(cfg, 'exit')).toEqual(EXIT_ARGV);
  });

  test('a hand-built config with unsafe values is refused', () => {
    const good = readTunnelConfig(configWith()) as EnabledTunnelConfig;
    const bad: Partial<EnabledTunnelConfig>[] = [
      { bastion: 'ops@host;id' },
      { bastion: '-oProxyCommand=id' },
      { remoteHost: 'a b' },
      { identityFile: '/k/%d' },
      { socketPath: '/tmp/x y.sock' },
      { localPort: 0 },
      { localPort: 70000 },
      { remotePort: Number.NaN },
      { remotePort: 1.5 },
    ];
    for (const patch of bad) {
      expect(() => buildTunnelUpArgv({ ...good, ...patch })).toThrow(ConfigError);
      expect(() => buildControlArgv({ ...good, ...patch }, 'exit')).toThrow(ConfigError);
    }
  });
});

describe('tunnelUp', () => {
  test('starts ssh when the port is free and reports up and owned', async () => {
    const h = harness([step(UP_ARGV)], probeOf(false, true));
    const r = await tunnelUp(h.deps);
    expect(r).toMatchObject({ state: 'up', owned: true, listening: true, started: true, localPort: 55432 });
    expect(r.error).toBeUndefined();
    expect(h.runner.calls.map((c) => c.argv)).toEqual([UP_ARGV]);
    expect(h.dirs).toEqual(['/triage/home/.data/tunnel']);
    expect(h.probe.calls.every((c) => c.host === '127.0.0.1' && c.port === 55432)).toBe(true);
    expectNoLeak(r);
  });

  test('is idempotent: a listening port gives no ssh -f call, and owned follows the control socket', async () => {
    const owned = harness([step(CHECK_ARGV)], probeOf(true));
    const a = await tunnelUp(owned.deps);
    expect(a).toMatchObject({ state: 'up', owned: true, listening: true, started: false });
    expect(upCalls(owned.runner)).toBe(0);
    expect(owned.dirs).toEqual([]);

    const foreign = harness([step(CHECK_ARGV, { exitCode: 255, stderr: `Control socket connect(${SOCKET}): No such file or directory` })], probeOf(true));
    const b = await tunnelUp(foreign.deps);
    expect(b).toMatchObject({ state: 'up', owned: false, listening: true, started: false });
    expect(b.message).toContain('did not start');
    expect(upCalls(foreign.runner)).toBe(0);
    expectNoLeak(a);
    expectNoLeak(b);
  });

  test('ssh exit 255 returns state down with an error and does not throw', async () => {
    const h = harness([step(UP_ARGV, { exitCode: 255, stderr: `ssh: connect to host ${BASTION} port 22: Connection refused` })], probeOf(false));
    const r = await tunnelUp(h.deps);
    expect(r).toMatchObject({ state: 'down', owned: false, started: false });
    expect(r.error).toBe('the bastion is unreachable (exit 255)');
    expect(r.keys).toContain('SSFB_DB_TUNNEL_BASTION');
    expectNoLeak(r);
  });

  test.each([
    [{ exitCode: 255, stderr: `${BASTION}: Permission denied (publickey).` }, 'authentication failed (exit 255)'],
    [{ exitCode: 255, stderr: `Warning: Identity file ${IDENTITY} not accessible: No such identity` }, 'authentication failed (exit 255)'],
    [{ exitCode: 255, stderr: `ssh: Could not resolve hostname 203.0.113.7: nodename nor servname provided` }, 'the bastion name did not resolve (exit 255)'],
    [{ exitCode: 255, stderr: 'Host key verification failed.' }, 'host key verification failed (exit 255)'],
    [{ exitCode: 255, stderr: 'bind [127.0.0.1]:55432: Address already in use' }, 'the local forward could not be set up (exit 255)'],
    [{ exitCode: 1, stderr: `something odd about ${REMOTE_HOST}` }, 'ssh failed (exit 1)'],
    [{ exitCode: null, timedOut: true }, 'ssh did not finish in time'],
    [{ exitCode: null, spawnError: 'ENOENT' }, 'the ssh binary could not be started'],
    [{ exitCode: null, aborted: true }, 'the call was aborted'],
  ] as const)('failure %# maps to a fixed reason without echoing stderr', async (res, reason) => {
    const h = harness([step(UP_ARGV, res)], probeOf(false));
    const r = await tunnelUp(h.deps);
    expect(r.state).toBe('down');
    expect(r.error).toBe(reason);
    expectNoLeak(r);
  });

  test('ssh exit 0 without a listening port reports down', async () => {
    const h = harness([step(UP_ARGV)], probeOf(false, false));
    const r = await tunnelUp(h.deps);
    expect(r).toMatchObject({ state: 'down', started: true });
    expect(r.error).toContain('does not listen');
  });

  test('a probe that throws counts as not listening', async () => {
    const h = harness([step(UP_ARGV)], probeOf(new Error(`connect ECONNREFUSED ${REMOTE_HOST}`), true));
    const r = await tunnelUp(h.deps);
    expect(r).toMatchObject({ state: 'up', started: true });
    expectNoLeak(r);
  });

  test('a directory that cannot be created returns down and runs no ssh', async () => {
    const runner = createFakeRunner([]);
    const deps: TunnelDeps = {
      config: configWith(),
      runner,
      tcpProbe: probeOf(false),
      ensureDir: () => {
        throw new Error(`EACCES ${SOCKET}`);
      },
    };
    const r = await tunnelUp(deps);
    expect(r).toMatchObject({ state: 'down', keys: ['TRIAGE_DATA_DIR'] });
    expect(runner.calls).toEqual([]);
    expectNoLeak(r);
  });

  test('disabled by a blank bastion or REQUIRED=false: returns disabled with zero calls', async () => {
    const cases: Record<string, string>[] = [{ SSFB_DB_TUNNEL_BASTION: '' }, { SSFB_DB_TUNNEL_REQUIRED: 'false' }];
    for (const overrides of cases) {
      const h = harness([], probeOf(true), overrides);
      const r = await tunnelUp(h.deps);
      expect(r.state).toBe('disabled');
      expect(r.keys.length).toBe(1);
      expect(r.message).toContain(r.keys[0] as string);
      expect(h.runner.calls).toEqual([]);
      expect(h.runner.unscripted).toEqual([]);
      expect(h.probe.calls).toEqual([]);
    }
  });

  test.each([
    ['a semicolon', 'ops@host;id'],
    ['a space', 'ops@host id'],
    ['a leading dash', '-oProxyCommand=id'],
    ['the placeholder', '<user>@<bastion-ip>'],
  ])('a bastion with %s is refused before any runner or probe call', async (_label, bad) => {
    for (const op of [tunnelUp, tunnelStatus, tunnelDown]) {
      const h = harness([], probeOf(false), { SSFB_DB_TUNNEL_BASTION: bad });
      const r = await op(h.deps);
      expect(r.state).toBe('down');
      expect(r.keys).toEqual(['SSFB_DB_TUNNEL_BASTION']);
      expect(r.error).toContain('SSFB_DB_TUNNEL_BASTION');
      expect(JSON.stringify(r)).not.toContain(bad);
      expect(h.runner.calls).toEqual([]);
      expect(h.runner.unscripted).toEqual([]);
      expect(h.probe.calls).toEqual([]);
    }
  });

  test.each(['0', '70000', 'abc'])('local port %p is refused before any call', async (bad) => {
    const h = harness([], probeOf(false), { SSFB_DB_TUNNEL_LOCAL_PORT: bad });
    const r = await tunnelUp(h.deps);
    expect(r).toMatchObject({ state: 'down', keys: ['SSFB_DB_TUNNEL_LOCAL_PORT'] });
    expect(r.localPort).toBeUndefined();
    expect(h.runner.calls).toEqual([]);
    expect(h.probe.calls).toEqual([]);
  });

  test('passes the abort signal and a timeout to the runner', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const ctl = new AbortController();
    const runner = createFakeRunner([step(UP_ARGV)]);
    const spy = {
      run: (bin: string, argv: readonly string[], opts: Parameters<FakeRunner['run']>[2]) => {
        seen.push(opts.signal);
        expect(opts.timeoutMs).toBeGreaterThan(0);
        return runner.run(bin, argv, opts);
      },
    };
    await tunnelUp({ config: configWith(), runner: spy, tcpProbe: probeOf(false, true), ensureDir: () => {}, signal: ctl.signal });
    expect(seen).toEqual([ctl.signal]);
  });
});

describe('tunnelStatus', () => {
  test('check exit 0 and probe true is up and owned', async () => {
    const h = harness([step(CHECK_ARGV)], probeOf(true));
    const r = await tunnelStatus(h.deps);
    expect(r).toMatchObject({ state: 'up', owned: true, listening: true, started: false, stopped: false });
    expect(upCalls(h.runner)).toBe(0);
    expectNoLeak(r);
  });

  test('probe true and check non-zero is up and not owned', async () => {
    const h = harness([step(CHECK_ARGV, { exitCode: 255 })], probeOf(true));
    const r = await tunnelStatus(h.deps);
    expect(r).toMatchObject({ state: 'up', owned: false, listening: true });
    expectNoLeak(r);
  });

  test('probe false and check non-zero is down', async () => {
    const h = harness([step(CHECK_ARGV, { exitCode: 255 })], probeOf(false));
    const r = await tunnelStatus(h.deps);
    expect(r).toMatchObject({ state: 'down', owned: false, listening: false });
    expect(r.error).toBeUndefined();
  });

  test('probe false and check 0 is down with an error', async () => {
    const h = harness([step(CHECK_ARGV)], probeOf(false));
    const r = await tunnelStatus(h.deps);
    expect(r).toMatchObject({ state: 'down', owned: true, listening: false });
    expect(r.error).toContain('does not listen');
  });

  test('a timed out check counts as not owned', async () => {
    const h = harness([step(CHECK_ARGV, { exitCode: null, timedOut: true })], probeOf(true));
    expect(await tunnelStatus(h.deps)).toMatchObject({ state: 'up', owned: false });
  });

  test('disabled makes no calls', async () => {
    const h = harness([], probeOf(true), { SSFB_DB_TUNNEL_REQUIRED: 'false' });
    expect((await tunnelStatus(h.deps)).state).toBe('disabled');
    expect(h.runner.calls).toEqual([]);
    expect(h.probe.calls).toEqual([]);
  });
});

describe('tunnelDown', () => {
  test('calls -O exit when owned', async () => {
    const h = harness([step(CHECK_ARGV), step(EXIT_ARGV)], probeOf(false));
    const r = await tunnelDown(h.deps);
    expect(r).toMatchObject({ state: 'down', stopped: true });
    expect(h.runner.calls.map((c) => c.argv)).toEqual([CHECK_ARGV, EXIT_ARGV]);
    expectNoLeak(r);
  });

  test('a tunnel triage does not own gets a message and no exit call', async () => {
    const h = harness([step(CHECK_ARGV, { exitCode: 255 })], probeOf(true));
    const r = await tunnelDown(h.deps);
    expect(r).toMatchObject({ state: 'up', owned: false, stopped: false });
    expect(r.message).toContain('left running');
    expect(exitCalls(h.runner)).toBe(0);
    expectNoLeak(r);
  });

  test('nothing running gets a message and no exit call', async () => {
    const h = harness([step(CHECK_ARGV, { exitCode: 255 })], probeOf(false));
    const r = await tunnelDown(h.deps);
    expect(r).toMatchObject({ state: 'down', owned: false, stopped: false });
    expect(r.message).toContain('nothing stopped');
    expect(exitCalls(h.runner)).toBe(0);
  });

  test('a failed exit returns an error and does not throw', async () => {
    const h = harness([step(CHECK_ARGV), step(EXIT_ARGV, { exitCode: 255, stderr: `mux_client ${SOCKET}: broken` })], probeOf(true));
    const r = await tunnelDown(h.deps);
    expect(r).toMatchObject({ state: 'up', owned: true, stopped: false });
    expect(r.error).toBeDefined();
    expectNoLeak(r);
  });

  test('disabled makes no calls', async () => {
    const h = harness([], probeOf(true), { SSFB_DB_TUNNEL_BASTION: '' });
    expect((await tunnelDown(h.deps)).state).toBe('disabled');
    expect(h.runner.calls).toEqual([]);
  });
});

describe('outputs never carry config values', () => {
  test('the seeded identity path, bastion and remote host appear in no result of any scenario', async () => {
    const stderr = `debug: ${BASTION} ${IDENTITY} ${REMOTE_HOST} ${SOCKET}`;
    const scenarios: [(d: TunnelDeps) => Promise<TunnelResult>, FakeStep[], Probe][] = [
      [tunnelUp, [step(UP_ARGV)], probeOf(false, true)],
      [tunnelUp, [step(UP_ARGV, { exitCode: 255, stderr })], probeOf(false)],
      [tunnelUp, [step(CHECK_ARGV, { exitCode: 255, stderr })], probeOf(true)],
      [tunnelStatus, [step(CHECK_ARGV, { stderr })], probeOf(true)],
      [tunnelStatus, [step(CHECK_ARGV, { exitCode: 255, stderr })], probeOf(false)],
      [tunnelDown, [step(CHECK_ARGV), step(EXIT_ARGV, { exitCode: 1, stderr })], probeOf(true)],
      [tunnelDown, [step(CHECK_ARGV, { exitCode: 255, stderr })], probeOf(true)],
    ];
    for (const [op, script, probe] of scenarios) {
      const r = await op(harness(script, probe).deps);
      expectNoLeak(r);
    }
  });
});

describe('no tool calls the tunnel (D15)', () => {
  test('nothing under src/tools or src/agents imports src/ops/tunnel.ts', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.[cm]?ts$/.test(name) && /ops\/tunnel(\.ts)?['"]/.test(readFileSync(path, 'utf8'))) {
          offenders.push(relative(REPO_ROOT, path));
        }
      }
    };
    walk(join(REPO_ROOT, 'src', 'tools'));
    walk(join(REPO_ROOT, 'src', 'agents'));
    expect(offenders).toEqual([]);
  });
});
