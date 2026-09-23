import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { loadRegistry } from '../../src/config/registry.ts';
import { createFakeRunner, type FakeRunner, type FakeStep } from '../../src/connectors/exec-fake.ts';
import { mockPortFromFixtures } from '../../src/connectors/mock.ts';
import { createSqlConnector } from '../../src/connectors/sql/pg-client.ts';
import { fakePg } from '../../src/connectors/sql/pg-fake.ts';
import { ROLE_CHECK_SQL, RoleCheckCache } from '../../src/connectors/sql/readonly-role.ts';
import type { CodegraphResult } from '../../src/ops/codegraph.ts';
import { probeChecks, type DoctorOps } from '../../src/ops/doctor/checks-probes.ts';
import { mountedToolsCheck } from '../../src/ops/doctor/checks-tools.ts';
import {
  DOCTOR_SELECT_ONE_SQL,
  DOCTOR_SQL,
  createRealProbes,
  probeKey,
  type ProbeResult,
  type Probes,
} from '../../src/ops/doctor/probes.ts';
import { runDoctor } from '../../src/ops/doctor/run.ts';
import type { DoctorCheck, DoctorContext, DoctorReport } from '../../src/ops/doctor/types.ts';
import type { RepoStatus, ReposStatusReport } from '../../src/ops/repos.ts';
import type { TunnelResult } from '../../src/ops/tunnel.ts';
import type { Entity } from '../../src/types/core.ts';
import { RESOURCES_DIR, testEnvRecord } from '../support/home.ts';
import { memoryFixtures } from '../support/ssfb-tools.ts';

// ------------------------------------------------------------------ helpers

const homes: string[] = [];

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

// Hosts end in .invalid, so nothing here could resolve even if a probe escaped.
const HARBOR_DSN = 'postgresql://doctor_user:s3cret-pw@harbor-db.fixture.invalid:5432/harbor_db';
const QW_URL = 'http://quickwit.fixture.invalid:7080';

// Every SSFB DB key except harbor is left blank, so one DB row per test.
function makeConfig(overrides: Readonly<Record<string, string>> = {}): Config {
  const home = mkdtempSync(join(tmpdir(), 'triage-doctor-probes-'));
  homes.push(home);
  cpSync(RESOURCES_DIR, join(home, 'resources'), { recursive: true });
  mkdirSync(join(home, 'fixtures'));
  const record: Record<string, string> = {
    ...testEnvRecord(),
    TRIAGE_ENTITIES: 'ssfb',
    SSFB_DB_TUNNEL_REQUIRED: 'false',
    SSFB_QUICKWIT_TRANSPORT: '',
    TRIAGE_REPOS_DIR: '',
    ...overrides,
  };
  return configFromRecord(record, home);
}

const realMode = { TRIAGE_MOCK_MODE: 'false' };

const QW_HTTP = {
  SSFB_QUICKWIT_TRANSPORT: 'http',
  SSFB_QUICKWIT_INDEX: 'logs-v1',
  SSFB_QUICKWIT_URL: QW_URL,
};

// A tunnel config that readTunnelConfig accepts. Nothing here is ever dialled.
const TUNNEL_ON = {
  SSFB_DB_TUNNEL_REQUIRED: 'true',
  SSFB_DB_TUNNEL_BASTION: 'jump.fixture.invalid',
  SSFB_DB_TUNNEL_IDENTITY_FILE: 'keys/ssfb_test',
  SSFB_DB_TUNNEL_REMOTE_HOST: 'reader.fixture.invalid',
  SSFB_DB_TUNNEL_LOCAL_PORT: '55432',
  TRIAGE_DATA_DIR: '/tmp/tdp',
};

const QW_CLI = { SSFB_QUICKWIT_TRANSPORT: 'qw', SSFB_QUICKWIT_INDEX: 'logs-v1', SSFB_QW_CONTEXT: 'ssfb-test' };

type FakeProbeAnswers = {
  readonly select?: ProbeResult<true>;
  readonly writable?: ProbeResult<boolean>;
  readonly live?: ProbeResult<true>;
  readonly tcp?: ProbeResult<boolean>;
};

function fakeProbes(answers: FakeProbeAnswers = {}): Probes & { calls: string[] } {
  const calls: string[] = [];
  const skip = { status: 'skipped', reason: 'not scripted' } as const;
  return {
    calls,
    async dbSelectOne(entity, service) {
      calls.push(`select ${entity}:${service}`);
      return answers.select ?? skip;
    },
    async dbWritable(entity, service) {
      calls.push(`writable ${entity}:${service}`);
      return answers.writable ?? skip;
    },
    async quickwitHttpLive(entity) {
      calls.push(`live ${entity}`);
      return answers.live ?? skip;
    },
    async tcp(host, port) {
      calls.push(`tcp ${host}:${port}`);
      return answers.tcp ?? skip;
    },
  };
}

const OK_TRUE: ProbeResult<true> = { status: 'ok', value: true, transport: 'real' };

// Replaces repo status and codegraph so the only checks that do work are the
// ones under test.
function quietOps(extra: DoctorOps = {}): DoctorOps {
  return {
    repoStatus: async () => ({ status: 'not_configured', key: 'TRIAGE_REPOS_DIR', message: 'repos not configured' }),
    codegraphVersion: async () => ({ status: 'not_configured', key: 'CODEGRAPH_BIN', message: 'codegraph not configured' }),
    ...extra,
  };
}

async function run(ctx: DoctorContext): Promise<DoctorReport> {
  return runDoctor([probeChecks], { ops: quietOps(), runner: createFakeRunner([]), ...ctx });
}

function rows(report: DoctorReport, id: string): DoctorCheck[] {
  return report.checks.filter((c) => c.id === id);
}

function only(report: DoctorReport, id: string): DoctorCheck {
  const found = rows(report, id);
  expect(found.length).toBe(1);
  return found[0] as DoctorCheck;
}

function spyFetch(respond: (url: string, init: RequestInit) => Response = () => new Response('{}', { status: 200 })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fn, calls };
}

// A SQL connector stand-in that counts calls. Used where nothing may reach it.
function spySql() {
  const counts = { runSelect: 0, checkReadOnlyRole: 0, close: 0 };
  return {
    counts,
    sql: {
      runSelect: async () => {
        counts.runSelect += 1;
        throw new Error('spy sql: runSelect');
      },
      checkReadOnlyRole: async () => {
        counts.checkReadOnlyRole += 1;
        throw new Error('spy sql: checkReadOnlyRole');
      },
      close: async () => {
        counts.close += 1;
      },
    },
  };
}

// ------------------------------------------------------------------ db

describe('db check with fake probes', () => {
  test('a writable role is a warning by default and names the env key, never the DSN', async () => {
    const config = makeConfig({ ...realMode, SSFB_HARBOR_DB_URL: HARBOR_DSN });
    const probes = fakeProbes({ select: OK_TRUE, writable: { status: 'ok', value: true, transport: 'real' } });
    const r = only(await run({ config, probes }), 'db');
    expect(r.status).toBe('warn');
    expect(r.entity).toBe('ssfb');
    expect(r.key_names).toContain('SSFB_HARBOR_DB_URL');
    expect(r.message).toContain('SSFB_HARBOR_DB_URL');
    expect(r.message).not.toContain('s3cret');
    expect(r.message).not.toContain('fixture.invalid');
    expect(probes.calls).toEqual(['select ssfb:harbor', 'writable ssfb:harbor']);
  });

  test('with TRIAGE_REQUIRE_READONLY_DB_ROLE=true a writable role is fail naming the entity', async () => {
    const config = makeConfig({ ...realMode, SSFB_HARBOR_DB_URL: HARBOR_DSN, TRIAGE_REQUIRE_READONLY_DB_ROLE: 'true' });
    const probes = fakeProbes({ select: OK_TRUE, writable: { status: 'ok', value: true, transport: 'real' } });
    const r = only(await run({ config, probes }), 'db');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('real mode blocked for ssfb');
    expect(r.key_names).toEqual(['SSFB_HARBOR_DB_URL', 'TRIAGE_REQUIRE_READONLY_DB_ROLE']);
    expect(r.message).not.toContain('s3cret');
  });

  test('a read-only role is ok', async () => {
    const config = makeConfig({ ...realMode, SSFB_HARBOR_DB_URL: HARBOR_DSN, TRIAGE_REQUIRE_READONLY_DB_ROLE: 'true' });
    const probes = fakeProbes({ select: OK_TRUE, writable: { status: 'ok', value: false, transport: 'real' } });
    expect(only(await run({ config, probes }), 'db').status).toBe('ok');
  });

  test('an unreachable DB is a warning with a tunnel hint, and the check does not throw', async () => {
    const config = makeConfig({ ...realMode, SSFB_HARBOR_DB_URL: HARBOR_DSN });
    const probes = fakeProbes({
      select: { status: 'failed', code: 'unreachable', message: 'could not reach SSFB_HARBOR_DB_URL', transport: 'real' },
    });
    const r = only(await run({ config, probes }), 'db');
    expect(r.status).toBe('warn');
    expect(r.message).toContain('triage tunnel status');
    // The role check is not tried against a database that did not answer.
    expect(probes.calls).toEqual(['select ssfb:harbor']);
  });

  test('a probe that throws becomes one fail row, not a crash', async () => {
    const config = makeConfig({ ...realMode, SSFB_HARBOR_DB_URL: HARBOR_DSN });
    const probes = fakeProbes();
    probes.dbSelectOne = async () => {
      throw new Error(`boom ${HARBOR_DSN}`);
    };
    const report = await run({ config, probes });
    const r = only(report, 'db');
    expect(r.status).toBe('fail');
    expect(r.message).not.toContain('s3cret');
  });

  test('services with a blank DB key get no probe', async () => {
    const config = makeConfig(realMode);
    const probes = fakeProbes();
    const r = only(await run({ config, probes }), 'db');
    expect(r.status).toBe('skipped');
    expect(probes.calls).toEqual([]);
  });
});

describe('db check over the real SQL connector with a fake pg pool', () => {
  function realProbes(config: Config, pg: ReturnType<typeof fakePg>) {
    const registry = loadRegistry(config);
    const sql = createSqlConnector({ registry, config, pgFactory: pg.factory, roleCache: new RoleCheckCache() });
    const fetchSpy = spyFetch();
    return { registry, probes: createRealProbes({ config, registry, sql, fetch: fetchSpy.fn }), fetchSpy };
  }

  const WRAPPER = /^(BEGIN READ ONLY|SET LOCAL (statement|lock)_timeout = \d+|COMMIT|ROLLBACK)$/;

  test('the only data statements sent are SELECT 1 and the role check constant', async () => {
    const config = makeConfig({ ...realMode, SSFB_HARBOR_DB_URL: HARBOR_DSN });
    const pg = fakePg({ writable: false });
    const { registry, probes } = realProbes(config, pg);
    const r = only(await runDoctor([probeChecks[0]!], { config, registry, probes }), 'db');
    expect(r.status).toBe('ok');

    const texts = pg.clients.flatMap((c) => c.queries.map((q) => q.text));
    const data = texts.filter((t) => !WRAPPER.test(t));
    expect(data.length).toBeGreaterThan(0);
    expect(new Set(data)).toEqual(new Set(DOCTOR_SQL));
    expect([...DOCTOR_SQL]).toEqual([DOCTOR_SELECT_ONE_SQL, ROLE_CHECK_SQL]);
    // Every client ran inside a read-only transaction.
    for (const c of pg.clients) expect(c.queries[0]?.text).toBe('BEGIN READ ONLY');
    // No values are bound: both statements are constants.
    for (const q of pg.clients.flatMap((c) => c.queries)) expect(q.values ?? []).toEqual([]);
  });

  test('a writable role blocked by policy still counts as reachable and gives fail', async () => {
    const config = makeConfig({ ...realMode, SSFB_HARBOR_DB_URL: HARBOR_DSN, TRIAGE_REQUIRE_READONLY_DB_ROLE: 'true' });
    const pg = fakePg({ writable: true });
    const { registry, probes } = realProbes(config, pg);
    const r = only(await runDoctor([probeChecks[0]!], { config, registry, probes }), 'db');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('real mode blocked for ssfb');
    expect(r.message).not.toContain('s3cret');
    const data = pg.clients.flatMap((c) => c.queries.map((q) => q.text)).filter((t) => !WRAPPER.test(t));
    expect(new Set(data).size).toBeLessThanOrEqual(2);
    for (const t of data) expect(DOCTOR_SQL).toContain(t);
  });

  test('a refused connection is a warning with the tunnel hint', async () => {
    const config = makeConfig({ ...realMode, SSFB_HARBOR_DB_URL: HARBOR_DSN });
    const pg = fakePg({ connectError: () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const { registry, probes } = realProbes(config, pg);
    const r = only(await runDoctor([probeChecks[0]!], { config, registry, probes }), 'db');
    expect(r.status).toBe('warn');
    expect(r.message).toContain('SSFB_HARBOR_DB_URL');
    expect(r.message).toContain('tunnel');
    expect(r.message).not.toContain('fixture.invalid');
  });
});

// ------------------------------------------------------------------ mock mode

describe('mock-mode probes', () => {
  function mockCtx(overrides: Readonly<Record<string, string>>) {
    const config = makeConfig({ SSFB_HARBOR_DB_URL: HARBOR_DSN, ...overrides });
    expect(config.mock.enabled).toBe(true);
    const fixtures = memoryFixtures();
    const mockPort = mockPortFromFixtures({ settings: { mockMode: true, strict: true, record: false }, store: fixtures.store });
    const sqlSpy = spySql();
    const fetchSpy = spyFetch();
    let tcpCalls = 0;
    const runner: FakeRunner = createFakeRunner([{ bin: 'qw', argv: ['--version'], result: { stdout: 'qw 0.4.2\n' } }]);
    const ctx: DoctorContext = {
      config,
      mockPort,
      sql: sqlSpy.sql,
      fetch: fetchSpy.fn,
      tcpConnect: async () => {
        tcpCalls += 1;
        return true;
      },
      runner,
      ops: quietOps(),
    };
    return { ctx, fixtures, sqlSpy, fetchSpy, runner, tcpCalls: () => tcpCalls };
  }

  const zeroRealCalls = (m: ReturnType<typeof mockCtx>): void => {
    expect(m.sqlSpy.counts).toEqual({ runSelect: 0, checkReadOnlyRole: 0, close: 0 });
    expect(m.fetchSpy.calls.length).toBe(0);
    expect(m.tcpCalls()).toBe(0);
    expect(m.runner.calls.some((c) => c.argv.includes('whoami'))).toBe(false);
    expect(m.runner.calls.some((c) => c.bin === 'ssh')).toBe(false);
  };

  test('fixture hits give ok rows and nothing real is called', async () => {
    const m = mockCtx({ ...QW_HTTP, ...TUNNEL_ON });
    const add = (probe: Parameters<typeof probeKey>[0], entity: Entity | 'global', key: string, result: unknown): void =>
      m.fixtures.add('doctor_probe', { entity, probe: probeKey(probe, entity, key) }, result);
    add('db_select_one', 'ssfb', 'SSFB_HARBOR_DB_URL', { reachable: true });
    add('db_writable', 'ssfb', 'SSFB_HARBOR_DB_URL', { writable: false });
    add('quickwit_http_live', 'ssfb', 'SSFB_QUICKWIT_URL', { live: true });
    add('tcp', 'global', "127.0.0.1:55432", { open: true });

    const report = await runDoctor([probeChecks], m.ctx);
    expect(only(report, 'db').status).toBe('ok');
    expect(only(report, 'db').message).toContain('(fixture)');
    expect(only(report, 'quickwit').status).toBe('ok');
    expect(only(report, 'tunnel').status).toBe('ok');
    zeroRealCalls(m);
  });

  test('fixture misses give skipped rows, even under strict mock mode, and nothing real is called', async () => {
    const m = mockCtx({ ...QW_HTTP, ...TUNNEL_ON });
    const report = await runDoctor([probeChecks], m.ctx);
    const db = only(report, 'db');
    expect(db.status).toBe('skipped');
    expect(db.message).toContain('doctor|db_select_one|ssfb|SSFB_HARBOR_DB_URL');
    expect(only(report, 'quickwit').status).toBe('skipped');
    expect(only(report, 'tunnel').status).toBe('skipped');
    expect(m.fixtures.gets).toBeGreaterThan(0);
    zeroRealCalls(m);
  });

  test('a writable-role fixture is judged by the same policy', async () => {
    const m = mockCtx({ TRIAGE_REQUIRE_READONLY_DB_ROLE: 'true' });
    m.fixtures.add('doctor_probe', { entity: 'ssfb', probe: 'doctor|db_select_one|ssfb|SSFB_HARBOR_DB_URL' }, { reachable: true });
    m.fixtures.add('doctor_probe', { entity: 'ssfb', probe: 'doctor|db_writable|ssfb|SSFB_HARBOR_DB_URL' }, { writable: true });
    const r = only(await runDoctor([probeChecks[0]!], m.ctx), 'db');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('real mode blocked for ssfb');
    zeroRealCalls(m);
  });

  test('qw in mock mode runs --version only and skips whoami', async () => {
    const m = mockCtx(QW_CLI);
    const r = only(await runDoctor([probeChecks[1]!], m.ctx), 'quickwit');
    expect(r.status).toBe('skipped');
    expect(m.runner.calls.map((c) => c.argv)).toEqual([['--version']]);
    zeroRealCalls(m);
  });
});

// ------------------------------------------------------------------ quickwit

describe('quickwit dry check', () => {
  test('http with auth bearer and a blank token is fail naming SSFB_QUICKWIT_TOKEN', async () => {
    const config = makeConfig({ ...realMode, ...QW_HTTP, SSFB_QUICKWIT_AUTH: 'bearer', SSFB_QUICKWIT_TOKEN: '' });
    const probes = fakeProbes({ live: OK_TRUE });
    const r = only(await run({ config, probes }), 'quickwit');
    expect(r.status).toBe('fail');
    expect(r.key_names).toContain('SSFB_QUICKWIT_TOKEN');
    expect(r.message).toContain('SSFB_QUICKWIT_TOKEN');
    expect(probes.calls).toEqual([]);
  });

  test('http liveness is one GET of /health/livez with the bearer token, never a search', async () => {
    const config = makeConfig({ ...realMode, ...QW_HTTP, SSFB_QUICKWIT_AUTH: 'bearer', SSFB_QUICKWIT_TOKEN: 'qw-fake-token-01' });
    const fetchSpy = spyFetch();
    const sqlSpy = spySql();
    const report = await runDoctor([probeChecks[1]!], { config, fetch: fetchSpy.fn, sql: sqlSpy.sql, runner: createFakeRunner([]) });
    const r = only(report, 'quickwit');
    expect(r.status).toBe('ok');
    expect(r.message).toContain('bearer');
    expect(r.message).not.toContain('qw-fake-token-01');
    expect(r.message).not.toContain('fixture.invalid');
    expect(fetchSpy.calls.length).toBe(1);
    const call = fetchSpy.calls[0]!;
    expect(call.url).toBe(`${QW_URL}/health/livez`);
    expect(call.init.method).toBe('GET');
    expect(call.init.body).toBeUndefined();
    expect(call.init.redirect).toBe('manual');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer qw-fake-token-01');
    for (const c of fetchSpy.calls) expect(c.url).not.toMatch(/search|aggs|histogram/);
  });

  test('http liveness that answers 401 is a warning naming the auth keys', async () => {
    const config = makeConfig({ ...realMode, ...QW_HTTP, SSFB_QUICKWIT_AUTH: 'bearer', SSFB_QUICKWIT_TOKEN: 'qw-fake-token-01' });
    const fetchSpy = spyFetch(() => new Response('no', { status: 401 }));
    const r = only(await runDoctor([probeChecks[1]!], { config, fetch: fetchSpy.fn, runner: createFakeRunner([]) }), 'quickwit');
    expect(r.status).toBe('warn');
    expect(r.message).toContain('SSFB_QUICKWIT_TOKEN');
  });

  test('http liveness whose fetch throws is a warning, not a crash', async () => {
    const config = makeConfig({ ...realMode, ...QW_HTTP, SSFB_QUICKWIT_AUTH: 'none' });
    const fetchSpy = spyFetch(() => {
      throw new TypeError(`fetch failed ${QW_URL}`);
    });
    const r = only(await runDoctor([probeChecks[1]!], { config, fetch: fetchSpy.fn, runner: createFakeRunner([]) }), 'quickwit');
    expect(r.status).toBe('warn');
    expect(r.message).not.toContain('fixture.invalid');
  });

  const qwSteps = (whoami: FakeStep['result']): FakeStep[] => [
    { bin: 'qw', argv: ['--version'], result: { stdout: 'qw 0.4.2\n' } },
    { bin: 'qw', argv: ['whoami', '--context', 'ssfb-test'], result: whoami },
  ];

  test('qw: version and whoami from the fake runner give ok', async () => {
    const config = makeConfig({ ...realMode, ...QW_CLI });
    const runner = createFakeRunner(qwSteps({ stdout: 'someone\n' }));
    const r = only(await run({ config, runner, probes: fakeProbes() }), 'quickwit');
    expect(r.status).toBe('ok');
    expect(r.message).toContain('qw 0.4.2');
    expect(r.message).not.toContain('ssfb-test');
    expect(runner.calls.map((c) => c.argv)).toEqual([['--version'], ['whoami', '--context', 'ssfb-test']]);
    for (const c of runner.calls) expect(c.argv).not.toContain('search');
  });

  test('qw: whoami exit 1 gives a warning with the login command', async () => {
    const config = makeConfig({ ...realMode, ...QW_CLI });
    const runner = createFakeRunner(qwSteps({ exitCode: 1, stderr: 'not logged in' }));
    const r = only(await run({ config, runner, probes: fakeProbes() }), 'quickwit');
    expect(r.status).toBe('warn');
    expect(r.message).toContain('qw login --context $SSFB_QW_CONTEXT');
    expect(r.key_names).toContain('SSFB_QW_CONTEXT');
  });

  test('qw: a missing binary is a warning and whoami is not tried', async () => {
    const config = makeConfig({ ...realMode, ...QW_CLI });
    const runner = createFakeRunner([{ bin: 'qw', argv: ['--version'], result: { exitCode: null, spawnError: 'ENOENT' } }]);
    const r = only(await run({ config, runner, probes: fakeProbes() }), 'quickwit');
    expect(r.status).toBe('warn');
    expect(r.key_names).toContain('QW_BIN');
    expect(runner.calls.length).toBe(1);
  });

  test('a blank transport is disabled and runs nothing', async () => {
    const config = makeConfig(realMode);
    const probes = fakeProbes();
    const runner = createFakeRunner([]);
    const r = only(await run({ config, runner, probes }), 'quickwit');
    expect(r.status).toBe('disabled');
    expect(r.key_names).toEqual(['SSFB_QUICKWIT_TRANSPORT']);
    expect(probes.calls).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ tunnel, codegraph, repos

function repoRow(repo: string, patch: Partial<RepoStatus> = {}): RepoStatus {
  return {
    repo,
    expectedBranch: 'main',
    actualBranch: 'main',
    commit: '0123456789abcdef0123456789abcdef01234567',
    dirty: false,
    drift: false,
    indexed: true,
    present: true,
    ...patch,
  };
}

describe('tunnel, codegraph and repos', () => {
  test('tunnel status from T11.2 maps down to a warning with the up command', async () => {
    const config = makeConfig(realMode);
    const down: TunnelResult = {
      state: 'down',
      owned: false,
      listening: false,
      started: false,
      stopped: false,
      localPort: 55432,
      message: 'SSFB DB tunnel is down on 127.0.0.1:55432',
      keys: [],
    };
    const cfgConfig = makeConfig({ ...realMode, ...TUNNEL_ON });
    let seenProbe = false;
    const report = await runDoctor([probeChecks[2]!], {
      config: cfgConfig,
      probes: fakeProbes({ tcp: { status: 'ok', value: false, transport: 'real' } }),
      runner: createFakeRunner([]),
      ops: quietOps({
        tunnelStatus: async (deps) => {
          seenProbe = !(await deps.tcpProbe('127.0.0.1', 55432, 1000));
          return down;
        },
      }),
    });
    const r = only(report, 'tunnel');
    expect(r.status).toBe('warn');
    expect(r.message).toContain('triage tunnel up');
    expect(seenProbe).toBe(true);
    // A tunnel that is not required is disabled and nothing is probed.
    const off = await runDoctor([probeChecks[2]!], { config, probes: fakeProbes(), runner: createFakeRunner([]) });
    expect(only(off, 'tunnel').status).toBe('disabled');
  });

  test('repo drift from a fake repoStatus is a warning', async () => {
    const config = makeConfig(realMode);
    const report: ReposStatusReport = {
      status: 'ok',
      repos: [repoRow('harbor'), repoRow('rhythm', { actualBranch: 'feature/x', drift: true })],
    };
    const out = await runDoctor([probeChecks[4]!], { config, ops: quietOps({ repoStatus: async () => report }) });
    const repos = rows(out, 'repos');
    expect(repos.map((r) => r.status)).toEqual(['ok', 'warn']);
    expect(repos[1]!.message).toContain('rhythm');
    expect(repos[1]!.message).toContain('expected main');
  });

  test('a missing codegraph index is a warning', async () => {
    const config = makeConfig(realMode);
    const report: ReposStatusReport = {
      status: 'ok',
      repos: [repoRow('harbor'), repoRow('rhythm', { indexed: false })],
    };
    const version: CodegraphResult = { status: 'ok', command: 'version', output: 'codegraph 1.2.3', truncated: false };
    const out = await runDoctor([probeChecks[3]!], {
      config,
      ops: quietOps({ repoStatus: async () => report, codegraphVersion: async () => version }),
    });
    const cg = rows(out, 'codegraph');
    expect(cg.find((r) => r.message.includes('rhythm'))?.status).toBe('warn');
    expect(cg.find((r) => r.message.includes('1.2.3'))?.status).toBe('ok');
  });

  test('a blank CODEGRAPH_BIN is disabled and repos are not read for it', async () => {
    const config = makeConfig(realMode);
    let reads = 0;
    const out = await runDoctor([probeChecks[3]!], {
      config,
      ops: quietOps({
        repoStatus: async () => {
          reads += 1;
          return { status: 'ok', repos: [] };
        },
      }),
    });
    expect(only(out, 'codegraph').status).toBe('disabled');
    expect(reads).toBe(0);
  });

  test('repos and codegraph share one status read per doctor run', async () => {
    const config = makeConfig(realMode);
    let reads = 0;
    const version: CodegraphResult = { status: 'ok', command: 'version', output: 'codegraph 1.2.3', truncated: false };
    await runDoctor([probeChecks[3]!, probeChecks[4]!], {
      config,
      ops: quietOps({
        codegraphVersion: async () => version,
        repoStatus: async () => {
          reads += 1;
          return { status: 'ok', repos: [repoRow('harbor')] };
        },
      }),
    });
    expect(reads).toBe(1);
  });
});

// ------------------------------------------------------------------ mounted tools

describe('mounted tools check', () => {
  const CRYPTO_TOOLS = ['encrypt_lookup_value', 'decrypt_fields'];

  function ssfbRow(report: DoctorReport): DoctorCheck {
    const found = report.checks.filter((c) => c.id === 'tools' && c.entity === 'ssfb' && c.status === 'ok');
    expect(found.length).toBe(1);
    return found[0] as DoctorCheck;
  }

  test('lists no SSFB crypto tools when SSFB_HARBOR_FIELD_ENC_KEY is blank', async () => {
    const config = makeConfig({ SSFB_HARBOR_FIELD_ENC_KEY: '' });
    const report = await runDoctor([mountedToolsCheck], { config });
    const r = ssfbRow(report);
    expect(r.message).toContain('investigator:');
    for (const name of CRYPTO_TOOLS) expect(r.message).not.toContain(name);
    const off = report.checks.find((c) => c.id === 'tools' && c.entity === 'ssfb' && c.status === 'disabled');
    expect(off?.key_names).toContain('SSFB_HARBOR_FIELD_ENC_KEY');
  });

  test('lists them when the key is set', async () => {
    const config = makeConfig({ SSFB_HARBOR_FIELD_ENC_KEY: 'ZmFrZS1rZXktZm9yLXRlc3RzLW9ubHktMDEyMzQ1Njc4OWFiY2RlZg==' });
    const report = await runDoctor([mountedToolsCheck], { config });
    const r = ssfbRow(report);
    for (const name of CRYPTO_TOOLS) expect(r.message).toContain(name);
    for (const c of report.checks) expect(c.message).not.toContain('ZmFrZS1rZXk');
  });

  test('has one row each for triage and code_walker', async () => {
    const config = makeConfig();
    const report = await runDoctor([mountedToolsCheck], { config });
    const ok = report.checks.filter((c) => c.id === 'tools' && c.status === 'ok' && c.entity === undefined);
    expect(ok.map((c) => c.message.split(':')[0])).toEqual(['triage', 'code_walker']);
  });
});
