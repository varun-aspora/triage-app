// triage doctor, preflight, tunnel up|status|down and repos sync, run through
// buildProgram and runCli with temp homes, fake io and fake runners. Nothing
// here spawns ssh, git, qw, aws or kubectl, and no probe leaves the process.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { commands as generatedCommands } from '../../src/cli/command-modules.gen.ts';
import { createDoctorCommand, type DoctorDeps } from '../../src/cli/commands/doctor.command.ts';
import { createPreflightCommand, type PreflightCommandOptions } from '../../src/cli/commands/preflight.command.ts';
import { createReposSyncCommand, type ReposSyncCommandOptions } from '../../src/cli/commands/repos-sync.command.ts';
import { createTunnelCommand, type TunnelCommandOptions, type TunnelOp } from '../../src/cli/commands/tunnel-up.command.ts';
import { buildProgram, runCli } from '../../src/cli/index.ts';
import { EXIT } from '../../src/cli/output.ts';
import type { CliCommand, CliContext } from '../../src/cli/types.ts';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import type { ExecOptions, ExecResult, ExecRunner } from '../../src/connectors/exec.ts';
import type { DoctorOps } from '../../src/ops/doctor/checks-probes.ts';
import type { Probes } from '../../src/ops/doctor/probes.ts';
import { DOCTOR_STATUSES, type DoctorCheck, type NamedCheck } from '../../src/ops/doctor/types.ts';
import type { RepoSyncResult, SyncReport } from '../../src/ops/repos.ts';
import type { TunnelDeps, TunnelResult } from '../../src/ops/tunnel.ts';
import { REPO_ROOT, RESOURCES_DIR, makeTestHome, testEnvRecord, type TestHome, type TestHomeOptions } from '../support/home.ts';

// ------------------------------------------------------------------ helpers

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function home(options: TestHomeOptions = {}): TestHome {
  const h = makeTestHome(options);
  cleanups.push(h.cleanup);
  return h;
}

// A real-mode config. makeTestHome forces mock mode, so this builds the
// record by hand from the same blanked .env.example.
function realConfig(overrides: Readonly<Record<string, string>> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'triage-ops-cli-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(RESOURCES_DIR, join(dir, 'resources'), { recursive: true });
  mkdirSync(join(dir, 'fixtures'));
  return configFromRecord(
    { ...testEnvRecord(), TRIAGE_MOCK_MODE: 'false', TRIAGE_ENTITIES: 'ssfb', SSFB_DB_TUNNEL_REQUIRED: 'false', TRIAGE_REPOS_DIR: '', ...overrides },
    dir,
  );
}

type Call = { readonly bin: string; readonly argv: readonly string[] };

type RecordingRunner = ExecRunner & { readonly calls: Call[] };

const FAILED: ExecResult = Object.freeze({ exitCode: 1, stdout: '', stderr: 'failed', timedOut: false, truncated: false, aborted: false });

/** Answers every call with answer(bin, argv), by default a failed exit, and records it. */
function runner(answer: (bin: string, argv: readonly string[]) => Partial<ExecResult> = () => FAILED): RecordingRunner {
  const calls: Call[] = [];
  return {
    calls,
    async run(bin: string, argv: readonly string[], _opts: ExecOptions): Promise<ExecResult> {
      calls.push({ bin, argv: [...argv] });
      return { ...FAILED, ...answer(bin, argv) };
    },
  };
}

type Io = { ctx: CliContext; out(): string; err(): string };

function io(config: Config, isTTY = false): Io {
  let out = '';
  let err = '';
  const ctx: CliContext = {
    config: () => config,
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from([]),
      isTTY,
    },
    deps: {},
  };
  return { ctx, out: () => out, err: () => err };
}

async function cli(config: Config, commands: readonly CliCommand[], argv: readonly string[], isTTY = false) {
  const h = io(config, isTTY);
  const code = await runCli(buildProgram(commands, h.ctx), argv);
  return { code, out: h.out(), err: h.err() };
}

const failRow: NamedCheck = { id: 'fake', run: async () => [{ id: 'fake', status: 'fail', key_names: ['SOME_KEY'], message: 'fake failed' }] };
const okRow: NamedCheck = { id: 'fake', run: async () => [{ id: 'fake', status: 'ok', key_names: [], message: 'fake ok' }] };
const warnRow: NamedCheck = { id: 'other', run: async () => [{ id: 'other', status: 'warn', key_names: [], message: 'other warned' }] };

// Probes that answer skipped, so the probe checks never reach a network.
const skippedProbes: Probes = {
  dbSelectOne: async () => ({ status: 'skipped', reason: 'test' }),
  dbWritable: async () => ({ status: 'skipped', reason: 'test' }),
  quickwitHttpLive: async () => ({ status: 'skipped', reason: 'test' }),
  tcp: async () => ({ status: 'skipped', reason: 'test' }),
};

const quietOps: DoctorOps = {
  repoStatus: async () => ({ status: 'not_configured', key: 'TRIAGE_REPOS_DIR', message: 'repos not configured: TRIAGE_REPOS_DIR is blank' }),
  tunnelStatus: async () => ({ state: 'down', owned: false, listening: false, started: false, stopped: false, message: 'down', keys: [] }),
};

function fakeDoctorDeps(r: RecordingRunner = runner()): () => DoctorDeps {
  return () => ({ runner: r, probes: skippedProbes, ops: quietOps, tcpConnect: async () => false, embedder: null });
}

const tunnelCommands = (options: TunnelCommandOptions = {}): CliCommand[] =>
  (['up', 'status', 'down'] as const).map((op) => createTunnelCommand(op, options));

function tunnelResult(fields: Partial<TunnelResult> & Pick<TunnelResult, 'state' | 'message'>): TunnelResult {
  return { owned: false, listening: false, started: false, stopped: false, keys: [], localPort: 55432, ...fields };
}

// A tunnel config readTunnelConfig accepts. Nothing here is ever dialled.
const TUNNEL_ON = {
  SSFB_DB_TUNNEL_REQUIRED: 'true',
  SSFB_DB_TUNNEL_BASTION: 'jump.fixture.invalid',
  SSFB_DB_TUNNEL_IDENTITY_FILE: 'keys/ssfb_test',
  SSFB_DB_TUNNEL_REMOTE_HOST: 'reader.fixture.invalid',
  SSFB_DB_TUNNEL_LOCAL_PORT: '55432',
  TRIAGE_DATA_DIR: '/tmp/tdp-cli',
};

const isControl = (op: 'check' | 'exit') => (bin: string, argv: readonly string[]) =>
  bin === 'ssh' && argv.includes('-O') && argv[argv.indexOf('-O') + 1] === op;

// ------------------------------------------------------------------ reachability

describe('ops commands are in the generated command list', () => {
  test('doctor, preflight, tunnel up|status|down and repos sync are reachable', () => {
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    for (const p of ['doctor', 'preflight', 'tunnel up', 'tunnel status', 'tunnel down', 'repos sync']) expect(paths).toContain(p);
  });

  test('the generated ops commands build (buildProgram refuses --env) and each has its own --json', () => {
    const h = home();
    const mine = (generatedCommands as readonly CliCommand[]).filter((c) => ['doctor', 'preflight', 'tunnel', 'repos'].includes(c.path[0] as string));
    expect(mine.length).toBe(6);
    const program = buildProgram(mine, io(h.config).ctx);
    const leaves = program.commands.flatMap((c) => (c.commands.length > 0 ? c.commands : [c]));
    for (const leaf of leaves.filter((c) => ['doctor', 'preflight', 'up', 'status', 'down', 'sync'].includes(c.name()))) {
      expect(leaf.options.map((o) => o.long)).toContain('--json');
    }
  });
});

// ------------------------------------------------------------------ doctor

describe('triage doctor', () => {
  test('a fail row exits 1', async () => {
    const h = home();
    const r = await cli(h.config, [createDoctorCommand({ checks: [okRow, failRow], deps: fakeDoctorDeps() })], ['doctor']);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.out).toContain('fake failed');
    expect(r.out).toContain('check');
  });

  test('all rows ok exits 0, and a warn row alone does not fail', async () => {
    const h = home();
    const ok = await cli(h.config, [createDoctorCommand({ checks: [okRow], deps: fakeDoctorDeps() })], ['doctor']);
    expect(ok.code).toBe(EXIT.OK);
    const warn = await cli(h.config, [createDoctorCommand({ checks: [okRow, warnRow], deps: fakeDoctorDeps() })], ['doctor', '--json']);
    expect(warn.code).toBe(EXIT.OK);
  });

  test('a check that throws becomes a fail row and exits 1', async () => {
    const h = home();
    const boom: NamedCheck = { id: 'boom', run: async () => { throw new Error('postgresql://u:p@h/db'); } };
    const r = await cli(h.config, [createDoctorCommand({ checks: [boom], deps: fakeDoctorDeps() })], ['doctor', '--json']);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.out).not.toContain('postgresql://');
    expect((JSON.parse(r.out) as { checks: DoctorCheck[] }).checks[0]?.status).toBe('fail');
  });

  test('--json with the default checks parses and matches the DoctorReport shape', async () => {
    const h = home();
    const r = await cli(h.config, [createDoctorCommand({ deps: fakeDoctorDeps() })], ['doctor', '--json']);
    const report = JSON.parse(r.out) as { checks: DoctorCheck[]; counts: Record<string, number> };
    expect(Object.keys(report).sort()).toEqual(['checks', 'counts']);
    expect(report.checks.length).toBeGreaterThan(0);
    for (const c of report.checks) {
      expect(typeof c.id).toBe('string');
      expect(DOCTOR_STATUSES as readonly string[]).toContain(c.status);
      expect(Array.isArray(c.key_names)).toBe(true);
      expect(typeof c.message).toBe('string');
      for (const k of Object.keys(c)) expect(['id', 'entity', 'status', 'key_names', 'message']).toContain(k);
    }
    expect(Object.keys(report.counts).sort()).toEqual([...DOCTOR_STATUSES].sort());
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(report.checks.length);
    const ids = new Set(report.checks.map((c) => c.id));
    for (const id of ['env', 'sandbox', 'models', 'db', 'tunnel', 'repos', 'tools']) expect(ids).toContain(id);
    expect(r.code).toBe(report.checks.some((c) => c.status === 'fail') ? EXIT.ERROR : EXIT.OK);
  });

  test('a registry that does not load still gives a report', async () => {
    const h = home();
    writeFileSync(join(h.home, 'resources', 'ssfb.entity.json'), '{ not json');
    const r = await cli(h.config, [createDoctorCommand({ deps: fakeDoctorDeps() })], ['doctor', '--json']);
    const report = JSON.parse(r.out) as { checks: DoctorCheck[] };
    expect(report.checks.some((c) => c.id === 'env' && c.status === 'fail')).toBe(true);
    expect(r.code).toBe(EXIT.ERROR);
  });
});

// ------------------------------------------------------------------ preflight

describe('triage preflight', () => {
  test('mock mode prints skipped, exits 0 and makes no runner, probe or tunnel call', async () => {
    const h = home();
    const r0 = runner();
    let probes = 0;
    let tunnels = 0;
    const options: PreflightCommandOptions = {
      runner: r0,
      tcpProbe: async () => {
        probes++;
        return false;
      },
      tunnel: async () => {
        tunnels++;
        throw new Error('not expected');
      },
    };
    const json = await cli(h.config, [createPreflightCommand(options)], ['preflight', '--json']);
    expect(json.code).toBe(EXIT.OK);
    const body = JSON.parse(json.out) as { mode: string; skipped?: string; warnings: unknown[] };
    expect(body.skipped).toBe('mock');
    expect(body.warnings).toEqual([]);
    expect(['local', 'server', 'unknown']).toContain(body.mode);

    const human = await cli(h.config, [createPreflightCommand(options)], ['preflight']);
    expect(human.code).toBe(EXIT.OK);
    expect(human.out).toContain('skipped');
    expect(r0.calls).toEqual([]);
    expect(probes).toBe(0);
    expect(tunnels).toBe(0);
  });

  test('every step warning still exits 0', async () => {
    const config = realConfig({ ...TUNNEL_ON, TRIAGE_DEPLOY_MODE: 'local', SSFB_AWS_PROFILE: 'ssfb-test', SSFB_KUBE_CONTEXT: 'ssfb-ctx', SSFB_QUICKWIT_TRANSPORT: 'qw', SSFB_QW_CONTEXT: 'ssfb-test' });
    const r0 = runner();
    const options: PreflightCommandOptions = {
      runner: r0,
      tcpProbe: async () => false,
      tunnel: async () => tunnelResult({ state: 'down', message: 'SSFB DB tunnel did not start', error: 'the bastion is unreachable (exit 255)' }),
    };
    const json = await cli(config, [createPreflightCommand(options)], ['preflight', '--json']);
    expect(json.code).toBe(EXIT.OK);
    const body = JSON.parse(json.out) as { mode: string; skipped?: string; steps: { status: string }[]; warnings: { step: string; message: string }[] };
    expect(body.mode).toBe('local');
    expect(body.skipped).toBeUndefined();
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.steps.some((s) => s.status === 'warn')).toBe(true);
    expect(body.steps.every((s) => s.status !== 'ok')).toBe(true);

    const human = await cli(config, [createPreflightCommand(options)], ['preflight']);
    expect(human.code).toBe(EXIT.OK);
    expect(human.out).toContain('warning(s)');
  });

  test('a runner and probe that throw still exit 0', async () => {
    const config = realConfig({ TRIAGE_DEPLOY_MODE: 'server' });
    const options: PreflightCommandOptions = {
      runner: { run: async () => { throw new Error('boom'); } },
      tcpProbe: async () => { throw new Error('boom'); },
    };
    const r = await cli(config, [createPreflightCommand(options)], ['preflight', '--json']);
    expect(r.code).toBe(EXIT.OK);
    expect((JSON.parse(r.out) as { mode: string }).mode).toBe('server');
  });

  test('a registry that does not load is a warning, not a failure', async () => {
    const h = home();
    writeFileSync(join(h.home, 'resources', 'ssfb.entity.json'), '{ not json');
    const r0 = runner();
    const r = await cli(h.config, [createPreflightCommand({ runner: r0, tcpProbe: async () => false })], ['preflight', '--json']);
    expect(r.code).toBe(EXIT.OK);
    expect((JSON.parse(r.out) as { warnings: { step: string }[] }).warnings[0]?.step).toBe('preflight');
    expect(r0.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ tunnel

const TUNNEL_JSON_KEYS = ['error', 'keys', 'listening', 'message', 'owned', 'port', 'started', 'state', 'stopped'];

describe('triage tunnel', () => {
  test('status --json has the stable shape and uses the injected runner and probe', async () => {
    const h = home({ overrides: TUNNEL_ON });
    const r0 = runner((bin, argv) => (isControl('check')(bin, argv) ? { exitCode: 0, stderr: '' } : {}));
    const r = await cli(h.config, tunnelCommands({ runner: r0, tcpProbe: async () => true }), ['tunnel', 'status', '--json']);
    expect(r.code).toBe(EXIT.OK);
    const body = JSON.parse(r.out) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(TUNNEL_JSON_KEYS);
    expect(body).toMatchObject({ state: 'up', port: 55432, owned: true, listening: true, error: null });
    expect(r0.calls.map((c) => c.bin)).toEqual(['ssh']);
  });

  test('status with the tunnel off prints disabled with a null port and runs nothing', async () => {
    const h = home();
    const r0 = runner();
    const r = await cli(h.config, tunnelCommands({ runner: r0, tcpProbe: async () => true }), ['tunnel', 'status', '--json']);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toMatchObject({ state: 'disabled', port: null, owned: false });
    expect(r0.calls).toEqual([]);
  });

  test('status exits 0 even when it reports an error', async () => {
    const h = home({ overrides: TUNNEL_ON });
    const r0 = runner((bin, argv) => (isControl('check')(bin, argv) ? { exitCode: 0 } : {}));
    const r = await cli(h.config, tunnelCommands({ runner: r0, tcpProbe: async () => false }), ['tunnel', 'status']);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('error:');
  });

  test('an unknown subcommand is a usage error', async () => {
    const h = home();
    const human = await cli(h.config, tunnelCommands({ runner: runner() }), ['tunnel', 'sideways']);
    expect(human.code).toBe(EXIT.USAGE);
    const json = await cli(h.config, tunnelCommands({ runner: runner() }), ['--json', 'tunnel', 'sideways']);
    expect(json.code).toBe(EXIT.USAGE);
    expect((JSON.parse(json.out) as { error: { code: string } }).error.code).toBe('USAGE');
  });

  test('up exits 1 when ssh fails and 0 when it starts', async () => {
    const h = home({ overrides: TUNNEL_ON });
    const noDir = { ensureDir: () => {} };
    const failing = runner(() => ({ exitCode: 255, stderr: 'ssh: connect to host: Connection refused' }));
    const bad = await cli(h.config, tunnelCommands({ runner: failing, tcpProbe: async () => false, ...noDir }), ['tunnel', 'up', '--json']);
    expect(bad.code).toBe(EXIT.ERROR);
    expect(JSON.parse(bad.out)).toMatchObject({ state: 'down', owned: false });
    expect(bad.out).not.toContain('Connection refused');

    let listening = false;
    const starting = runner((bin, argv) => {
      if (bin === 'ssh' && argv.includes('-f')) listening = true;
      return { exitCode: 0 };
    });
    const good = await cli(h.config, tunnelCommands({ runner: starting, tcpProbe: async () => listening, ...noDir }), ['tunnel', 'up', '--json']);
    expect(good.code).toBe(EXIT.OK);
    expect(JSON.parse(good.out)).toMatchObject({ state: 'up', owned: true, started: true });
  });

  test('down leaves a forward triage did not start and exits 0; a failed stop exits 1', async () => {
    const h = home({ overrides: TUNNEL_ON });
    const notOwned = runner();
    const left = await cli(h.config, tunnelCommands({ runner: notOwned, tcpProbe: async () => true }), ['tunnel', 'down', '--json']);
    expect(left.code).toBe(EXIT.OK);
    expect(JSON.parse(left.out)).toMatchObject({ state: 'up', owned: false, stopped: false });
    expect(notOwned.calls.some((c) => isControl('exit')(c.bin, c.argv))).toBe(false);

    const stuck = runner((bin, argv) => (isControl('check')(bin, argv) ? { exitCode: 0 } : { exitCode: 255 }));
    const failed = await cli(h.config, tunnelCommands({ runner: stuck, tcpProbe: async () => true }), ['tunnel', 'down']);
    expect(failed.code).toBe(EXIT.ERROR);
  });

  test('an injected op replaces the T11.2 function for that path only', async () => {
    const h = home();
    const seen: TunnelOp[] = [];
    const op = (name: TunnelOp) => async (_deps: TunnelDeps) => {
      seen.push(name);
      return tunnelResult({ state: 'down', message: 'x', error: 'y' });
    };
    const cmds = (['up', 'status', 'down'] as const).map((name) => createTunnelCommand(name, { op: op(name) }));
    expect((await cli(h.config, cmds, ['tunnel', 'up'])).code).toBe(EXIT.ERROR);
    expect((await cli(h.config, cmds, ['tunnel', 'status'])).code).toBe(EXIT.OK);
    expect((await cli(h.config, cmds, ['tunnel', 'down'])).code).toBe(EXIT.ERROR);
    expect(seen).toEqual(['up', 'status', 'down']);
  });
});

// ------------------------------------------------------------------ repos sync

function syncResult(repo: string, status: RepoSyncResult['status']): RepoSyncResult {
  return { repo, status, warnings: [], line: `${repo}: ${status}` };
}

function fakeSync(report: SyncReport, seen: unknown[] = []): ReposSyncCommandOptions['sync'] {
  return async (sel) => {
    seen.push(sel);
    return report;
  };
}

/** A test home whose TRIAGE_REPOS_DIR is a temp dir, removed after the test. */
function reposHome(overrides: Readonly<Record<string, string>> = {}): TestHome & { reposDir: string } {
  const reposDir = mkdtempSync(join(tmpdir(), 'triage-repos-cli-'));
  cleanups.push(() => rmSync(reposDir, { recursive: true, force: true }));
  return { ...home({ overrides: { TRIAGE_REPOS_DIR: reposDir, ...overrides } }), reposDir };
}

describe('triage repos sync', () => {
  test('--repo unknown exits 1 with the list of valid names and runs nothing', async () => {
    const h = reposHome();
    const r0 = runner();
    const r = await cli(h.config, [createReposSyncCommand({ runner: r0 })], ['repos', 'sync', '--repo', 'no-such-repo-xyz']);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('valid names');
    expect(r.err).toContain('harbor');
    expect(r.err).not.toContain('no-such-repo-xyz');
    expect(r0.calls).toEqual([]);

    const json = await cli(h.config, [createReposSyncCommand({ runner: r0 })], ['repos', 'sync', '--repo', 'no-such-repo-xyz', '--json']);
    expect(json.code).toBe(EXIT.ERROR);
    const body = JSON.parse(json.out) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('ERROR');
    expect(body.error.message).toContain('harbor');
  });

  test('prints one line per repo and exits 1 when any repo failed', async () => {
    const h = reposHome();
    const report: SyncReport = {
      status: 'done',
      results: [syncResult('harbor', 'ok'), syncResult('rhythm', 'failed'), syncResult('guardian', 'skipped')],
      ok: ['harbor'],
      skipped: ['guardian'],
      failed: ['rhythm'],
    };
    const r = await cli(h.config, [createReposSyncCommand({ sync: fakeSync(report) })], ['repos', 'sync']);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.out.trimEnd().split('\n')).toEqual(['harbor: ok', 'rhythm: failed', 'guardian: skipped']);
  });

  test('--json prints {results} and exits 0 when nothing failed; --repo is passed through', async () => {
    const h = reposHome();
    const seen: unknown[] = [];
    const report: SyncReport = { status: 'done', results: [syncResult('harbor', 'ok')], ok: ['harbor'], skipped: [], failed: [] };
    const r = await cli(h.config, [createReposSyncCommand({ sync: fakeSync(report, seen) })], ['repos', 'sync', '--repo', 'harbor', '--json']);
    expect(r.code).toBe(EXIT.OK);
    const body = JSON.parse(r.out) as { results: RepoSyncResult[] };
    expect(body.results.map((x) => x.repo)).toEqual(['harbor']);
    expect(seen).toEqual([{ repo: 'harbor' }]);
  });

  test('a blank TRIAGE_REPOS_DIR exits 1 and names the key', async () => {
    const h = home({ overrides: { TRIAGE_REPOS_DIR: '' } });
    const r0 = runner();
    const r = await cli(h.config, [createReposSyncCommand({ runner: r0 })], ['repos', 'sync', '--json']);
    expect(r.code).toBe(EXIT.ERROR);
    expect(JSON.parse(r.out)).toEqual({ results: [], not_configured: { key: 'TRIAGE_REPOS_DIR', message: 'repos not configured: TRIAGE_REPOS_DIR is blank' } });
    expect(r0.calls).toEqual([]);
  });

  test('a full sync records itself; --if-stale then finds nothing due and does not sync', async () => {
    const h = reposHome();
    let calls = 0;
    const report: SyncReport = { status: 'done', results: [syncResult('harbor', 'ok')], ok: ['harbor'], skipped: [], failed: [] };
    const sync: ReposSyncCommandOptions['sync'] = async () => {
      calls++;
      return report;
    };
    const first = await cli(h.config, [createReposSyncCommand({ sync })], ['repos', 'sync']);
    expect(first.code).toBe(EXIT.OK);
    const state = JSON.parse(readFileSync(join(h.reposDir, '.triage-sync.json'), 'utf8')) as { trigger: string; last_ok_at?: string; ok: string[] };
    expect(state.trigger).toBe('cli');
    expect(state.ok).toEqual(['harbor']);
    expect(typeof state.last_ok_at).toBe('string');

    const again = await cli(h.config, [createReposSyncCommand({ sync })], ['repos', 'sync', '--if-stale', '--json']);
    expect(again.code).toBe(EXIT.OK);
    const body = JSON.parse(again.out) as { results: unknown[]; not_due: { reason: string; last_ok_at: string } };
    expect(body.not_due.reason).toBe('fresh');
    expect(body.not_due.last_ok_at).toBe(state.last_ok_at as string);
    expect(calls).toBe(1);
  });

  test('--if-stale syncs when there is no record yet, and refuses --repo', async () => {
    const h = reposHome();
    let calls = 0;
    const sync: ReposSyncCommandOptions['sync'] = async () => {
      calls++;
      return { status: 'done', results: [], ok: [], skipped: [], failed: [] };
    };
    expect((await cli(h.config, [createReposSyncCommand({ sync })], ['repos', 'sync', '--if-stale'])).code).toBe(EXIT.OK);
    expect(calls).toBe(1);
    const both = await cli(h.config, [createReposSyncCommand({ sync })], ['repos', 'sync', '--if-stale', '--repo', 'harbor']);
    expect(both.code).toBe(EXIT.USAGE);
    expect(calls).toBe(1);
  });

  test('a lock held by another live process answers busy and exits 1', async () => {
    const h = reposHome();
    mkdirSync(join(h.reposDir, '.triage-sync.lock'));
    writeFileSync(
      join(h.reposDir, '.triage-sync.lock', 'owner.json'),
      JSON.stringify({ pid: process.pid, token: 'other-holder', started_at: new Date().toISOString() }),
    );
    let calls = 0;
    const sync: ReposSyncCommandOptions['sync'] = async () => {
      calls++;
      return { status: 'done', results: [], ok: [], skipped: [], failed: [] };
    };
    const r = await cli(h.config, [createReposSyncCommand({ sync })], ['repos', 'sync', '--json']);
    expect(r.code).toBe(EXIT.ERROR);
    expect(JSON.parse(r.out)).toEqual({ results: [], busy: { reason: 'another process is syncing the repos' } });
    expect(calls).toBe(0);
  });
});

// ------------------------------------------------------------------ no values in output

const SECRET = 'LEAKED-S3CRET';
const SEEDED = {
  SSFB_HARBOR_DB_URL: `postgresql://leakuser:${SECRET}-pw@leak-db.fixture.invalid:5432/harbor_db`,
  SSFB_DB_TUNNEL_REQUIRED: 'true',
  SSFB_DB_TUNNEL_BASTION: 'leakuser@leak-bastion.fixture.invalid',
  SSFB_DB_TUNNEL_IDENTITY_FILE: `keys/${SECRET}-id`,
  SSFB_DB_TUNNEL_REMOTE_HOST: 'leak-reader.fixture.invalid',
  SSFB_DB_TUNNEL_LOCAL_PORT: '55432',
  SSFB_AWS_PROFILE: `${SECRET}-profile`,
  SSFB_KUBE_CONTEXT: `${SECRET}-ctx`,
  SSFB_QW_CONTEXT: `${SECRET}-qw`,
  OPENAI_API_KEY: `sk-${SECRET}`,
  TRIAGE_DATA_DIR: '/tmp/tdp-leak',
};
const NEEDLES = [SECRET, 'leak-bastion', 'leak-db', 'leak-reader', 'leakuser'];

function expectClean(label: string, text: string): void {
  for (const n of NEEDLES) {
    if (text.includes(n)) throw new Error(`${label} output contains a seeded value (${n})`);
  }
}

describe('no command prints an env value', () => {
  const argvs: readonly (readonly string[])[] = [
    ['doctor'],
    ['doctor', '--json'],
    ['preflight'],
    ['preflight', '--json'],
    ['tunnel', 'up'],
    ['tunnel', 'up', '--json'],
    ['tunnel', 'status'],
    ['tunnel', 'status', '--json'],
    ['tunnel', 'down'],
    ['tunnel', 'down', '--json'],
    ['repos', 'sync'],
    ['repos', 'sync', '--json'],
    ['repos', 'sync', '--repo', SECRET],
  ];

  // ssh and every other binary fail with stderr that repeats the seeded values.
  const echoingRunner = (): RecordingRunner =>
    runner((_bin, argv) => ({ exitCode: 255, stderr: `Permission denied ${argv.join(' ')} ${SECRET}`, stdout: SECRET }));

  function commandsFor(r: ExecRunner): CliCommand[] {
    return [
      createDoctorCommand({ deps: () => ({ runner: r, probes: skippedProbes, tcpConnect: async () => false, embedder: null }) }),
      createPreflightCommand({ runner: r, tcpProbe: async () => false }),
      ...tunnelCommands({ runner: r, tcpProbe: async () => false, ensureDir: () => {} }),
      createReposSyncCommand({ runner: r }),
    ];
  }

  test('mock mode home with seeded values', async () => {
    // repos sync clones every pin into this dir, so it is a temp dir.
    const reposDir = mkdtempSync(join(tmpdir(), 'triage-repos-leak-'));
    try {
      const h = home({ overrides: { ...SEEDED, TRIAGE_REPOS_DIR: reposDir } });
      for (const argv of argvs) {
        const r = await cli(h.config, commandsFor(echoingRunner()), argv);
        expectClean(argv.join(' '), r.out + r.err);
      }
    } finally {
      rmSync(reposDir, { recursive: true, force: true });
    }
  });

  test('real mode config with seeded values', async () => {
    const config = realConfig({ ...SEEDED, TRIAGE_DEPLOY_MODE: 'local', SSFB_QUICKWIT_TRANSPORT: 'qw', SSFB_QUICKWIT_INDEX: 'logs-v1' });
    for (const argv of argvs) {
      const r = await cli(config, commandsFor(echoingRunner()), argv);
      expectClean(argv.join(' '), r.out + r.err);
    }
  });
});

// ------------------------------------------------------------------ any cwd

describe('bin/triage.mjs from another cwd', () => {
  // Mock mode and a blank bastion mean neither command runs a process or dials anything.
  test('preflight and tunnel status load config from TRIAGE_HOME, not the cwd', () => {
    const h = home();
    const cwd = mkdtempSync(join(tmpdir(), 'triage-cwd-'));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TRIAGE_HOME: h.home };
    const run = (argv: string[]) =>
      spawnSync('node', [join(REPO_ROOT, 'bin/triage.mjs'), ...argv], { cwd, env, encoding: 'utf8', timeout: 60_000 });

    const pre = run(['preflight', '--json']);
    expect(pre.status).toBe(0);
    expect(JSON.parse(pre.stdout)).toMatchObject({ skipped: 'mock', warnings: [] });

    const tun = run(['tunnel', 'status', '--json']);
    expect(tun.status).toBe(0);
    expect(JSON.parse(tun.stdout)).toMatchObject({ state: 'disabled', port: null });
  });
});
