import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMockLayer } from '../mock/index.ts';
import { keyHash, keyString, semanticKey, type SqlSelectFacts } from '../mock/key.ts';
import type { RealIoOutcome, RecordContext, Recorder } from '../mock/resolve.ts';
import { mockSettingsFrom } from '../mock/settings.ts';
import { createFixtureStore, type FixtureStore } from '../mock/store.ts';
import { DEFAULT_MAX_OUTPUT_BYTES } from './exec.ts';
import { fixtureEntityOf, mockPortFromFixtures, withMock, type MockPort, type RealOutput } from './mock.ts';
import {
  CONNECTOR_ERROR_CODES,
  ConnectorError,
  envVarName,
  InvalidEnvVarNameError,
  isConnectorError,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_HTTP_BODY_BYTES,
  MAX_SQL_RESULT_BYTES,
  type ConnectorContext,
  type ConnectorOutcome,
  type ConnectorResult,
  type EnvVarName,
} from './types.ts';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triage-connector-mock-test-')));
  made.push(dir);
  return dir;
}

const HIT_FACTS: SqlSelectFacts = {
  entity: 'atspl',
  service: 'package',
  tables: ['delivery_requests'],
  params: ['cust-1'],
};
const MISS_FACTS: SqlSelectFacts = { ...HIT_FACTS, params: ['cust-404'] };
const HIT_ROWS = [{ id: 'dr-1', status: 'DELIVERED' }];
const TARGET = 'ATSPL_DB_PACKAGE_DSN';
const OPTS = { target_env: TARGET };

function writeFixture(fixturesDir: string): void {
  const key = semanticKey('sql_select', HIT_FACTS);
  const path = join(fixturesDir, 'shared', 'sql_select', 'atspl', `${keyHash(key)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      kind: 'sql_select',
      entity: 'atspl',
      key,
      key_string: keyString(key),
      result: HIT_ROWS,
      meta: { source: 'hand', recorded_at: '2026-09-23T10:00:00.000Z' },
    }),
  );
}

function fixtureStore(): FixtureStore {
  const dir = tempDir();
  writeFixture(dir);
  return createFixtureStore({ fixturesDir: dir });
}

function clock(): () => Date {
  let t = Date.parse('2026-09-23T10:00:00.000Z');
  return () => {
    const d = new Date(t);
    t += 5;
    return d;
  };
}

function context(port: MockPort, signal: AbortSignal = new AbortController().signal): ConnectorContext {
  return { signal, now: clock(), mock: port, runId: 'run-1' };
}

type Settings = { mockMode: boolean; strict: boolean; record: boolean };

function port(settings: Settings, extra: { store?: FixtureStore; recorder?: Recorder | null } = {}): MockPort {
  return mockPortFromFixtures({ settings, store: extra.store ?? fixtureStore(), recorder: extra.recorder ?? null });
}

function realSpy<T>(data: T, truncated?: boolean) {
  return mock(async (_signal: AbortSignal): Promise<RealOutput<T>> =>
    truncated === undefined ? { data } : { data, truncated },
  );
}

function recorderSpy() {
  const calls: { outcome: RealIoOutcome<unknown>; ctx: RecordContext }[] = [];
  const recorder: Recorder = {
    record: mock(async (outcome, ctx) => {
      calls.push({ outcome, ctx });
    }),
  };
  return { recorder, calls };
}

const MOCK_STRICT: Settings = { mockMode: true, strict: true, record: false };
const MOCK_LOOSE: Settings = { mockMode: true, strict: false, record: false };
const REAL: Settings = { mockMode: false, strict: true, record: false };
const REAL_RECORDING: Settings = { mockMode: false, strict: true, record: true };

describe('withMock in mock mode', () => {
  test('a hit returns the fixture and real() is called 0 times', async () => {
    const real = realSpy([{ id: 'from-real' }]);
    const out = await withMock(context(port(MOCK_STRICT)), 'sql_select', HIT_FACTS, real, OPTS);
    expect(real).toHaveBeenCalledTimes(0);
    expect(out).toEqual({
      data: HIT_ROWS,
      transport: 'mock',
      target_env: TARGET as EnvVarName,
      taken_at: '2026-09-23T10:00:00.000Z',
      duration_ms: 5,
    });
    expect(Object.isFrozen(out)).toBe(true);
  });

  test('keys that differ only in order hit the same fixture', async () => {
    const real = realSpy<unknown>([]);
    const facts: SqlSelectFacts = { ...HIT_FACTS, tables: ['delivery_requests', 'delivery_requests'] };
    const out = await withMock(context(port(MOCK_STRICT)), 'sql_select', facts, real, OPTS);
    expect(out.data).toEqual(HIT_ROWS);
    expect(real).toHaveBeenCalledTimes(0);
  });

  test('a strict miss throws strict_miss naming the semantic key, and real() is not called', async () => {
    const real = realSpy<unknown>([]);
    const key_string = keyString(semanticKey('sql_select', MISS_FACTS));
    const hash = keyHash(semanticKey('sql_select', MISS_FACTS));
    let caught: unknown;
    try {
      await withMock(context(port(MOCK_STRICT)), 'sql_select', MISS_FACTS, real, OPTS);
    } catch (err) {
      caught = err;
    }
    expect(real).toHaveBeenCalledTimes(0);
    expect(isConnectorError(caught, 'strict_miss')).toBe(true);
    const err = caught as ConnectorError;
    expect(err.message).toBe(
      `fixture miss (strict mock): no sql_select fixture for key ${key_string} (file ${hash}.json)`,
    );
    expect(err.fixture).toEqual({ kind: 'sql_select', key_string, hash });
    // It names the key, not the target's env var or anything that looks like a value.
    expect(err.message).not.toContain(TARGET);
    expect(err.message).not.toMatch(/postgres:\/\/|https?:\/\//);
  });

  test('a non-strict miss returns fixture_not_found and never calls real()', async () => {
    const real = realSpy([{ id: 'from-real' }]);
    const out = await withMock(context(port(MOCK_LOOSE)), 'sql_select', MISS_FACTS, real, OPTS);
    expect(real).toHaveBeenCalledTimes(0);
    expect(out.fixture_miss).toBe(true);
    if (out.fixture_miss !== true) throw new Error('expected a miss');
    expect(out.data).toBeNull();
    expect(out.transport).toBe('mock');
    expect(out.error.code).toBe('fixture_not_found');
    expect(out.error.key_string).toBe(keyString(semanticKey('sql_select', MISS_FACTS)));
    expect(out.error.message).toContain(out.error.key_string);
  });

  test('mock mode never records, even with a port that has record()', async () => {
    const record = mock(async () => {});
    const custom: MockPort = {
      enabled: true,
      strict: true,
      lookup: async () => ({ hit: true, value: HIT_ROWS, hash: 'h' }),
      record,
    };
    await withMock(context(custom), 'sql_select', HIT_FACTS, realSpy<unknown>([]), OPTS);
    expect(record).toHaveBeenCalledTimes(0);
  });

  test('an aborted signal rejects before the lookup', async () => {
    const lookup = mock(async () => ({ hit: true as const, value: HIT_ROWS, hash: 'h' }));
    const custom: MockPort = { enabled: true, strict: true, lookup };
    const ac = new AbortController();
    ac.abort();
    await expect(withMock(context(custom, ac.signal), 'sql_select', HIT_FACTS, realSpy<unknown>([]), OPTS)).rejects.toThrow();
    expect(lookup).toHaveBeenCalledTimes(0);
  });

  test('an abort during the lookup rejects', async () => {
    const ac = new AbortController();
    const custom: MockPort = {
      enabled: true,
      strict: true,
      lookup: async () => {
        ac.abort();
        return { hit: true, value: HIT_ROWS, hash: 'h' };
      },
    };
    await expect(withMock(context(custom, ac.signal), 'sql_select', HIT_FACTS, realSpy<unknown>([]), OPTS)).rejects.toThrow();
  });
});

describe('withMock in real mode', () => {
  test('passes through to real() with the signal and never reads the store', async () => {
    const get = mock(async () => null);
    const store = { get } as unknown as FixtureStore;
    const real = realSpy([{ id: 'r-1' }]);
    const ac = new AbortController();
    const out = await withMock(context(port(REAL, { store }), ac.signal), 'sql_select', MISS_FACTS, real, OPTS);
    expect(get).toHaveBeenCalledTimes(0);
    expect(real).toHaveBeenCalledTimes(1);
    expect(real.mock.calls[0]?.[0]).toBe(ac.signal);
    expect(out).toEqual({
      data: [{ id: 'r-1' }],
      transport: 'real',
      target_env: TARGET as EnvVarName,
      taken_at: '2026-09-23T10:00:00.000Z',
      duration_ms: 5,
    });
  });

  test('carries truncated from the real call', async () => {
    const out = await withMock(context(port(REAL)), 'sql_select', HIT_FACTS, realSpy('x', true), OPTS);
    expect(out.fixture_miss).not.toBe(true);
    if (out.fixture_miss === true) throw new Error('expected a result');
    expect(out.truncated).toBe(true);
  });

  test('a real() error passes through unchanged', async () => {
    const boom = new ConnectorError('unreachable', 'ATSPL_DB_PACKAGE_DSN: connection refused');
    const real = mock(async (): Promise<RealOutput<unknown>> => {
      throw boom;
    });
    await expect(withMock(context(port(REAL)), 'sql_select', HIT_FACTS, real, OPTS)).rejects.toBe(boom);
  });
});

describe('recording', () => {
  test('record is called only when recording is on', async () => {
    const off = recorderSpy();
    await withMock(context(port(REAL, { recorder: off.recorder })), 'sql_select', HIT_FACTS, realSpy([1]), OPTS);
    expect(off.calls).toHaveLength(0);

    const on = recorderSpy();
    await withMock(
      { ...context(port(REAL_RECORDING, { recorder: on.recorder })), redactionNames: ['Asha'] },
      'sql_select',
      HIT_FACTS,
      realSpy([1]),
      OPTS,
    );
    expect(on.calls).toHaveLength(1);
    const call = on.calls[0]!;
    const key = semanticKey('sql_select', HIT_FACTS);
    expect(call.outcome).toEqual({ value: [1], transport: 'real', fixture: null, fixture_miss: false });
    expect(call.ctx).toEqual({
      kind: 'sql_select',
      entity: 'atspl',
      key,
      key_string: keyString(key),
      hash: keyHash(key),
      run_id: 'run-1',
      redaction_names: ['Asha'],
    });
  });

  test('the port has no record() in mock mode or without a recorder', () => {
    const { recorder } = recorderSpy();
    expect(port(MOCK_STRICT, { recorder }).record).toBeUndefined();
    expect(port(REAL, { recorder }).record).toBeUndefined();
    expect(port(REAL_RECORDING, { recorder: null }).record).toBeUndefined();
    expect(port(REAL_RECORDING, { recorder }).record).toBeFunction();
  });

  test('a recorder that throws does not fail the real call and is reported', async () => {
    const failing: Recorder = {
      record: async () => {
        throw new Error('disk full');
      },
    };
    const reported: unknown[] = [];
    const p = mockPortFromFixtures(
      { settings: REAL_RECORDING, store: fixtureStore(), recorder: failing },
      { onRecordError: (err, at) => reported.push([(err as Error).message, at]) },
    );
    const out = await withMock(context(p), 'sql_select', HIT_FACTS, realSpy([1]), OPTS);
    expect(out.data).toEqual([1]);
    expect(reported).toEqual([['disk full', { kind: 'sql_select', entity: 'atspl', run_id: 'run-1' }]]);
  });

  test('a custom port whose record() throws does not fail the real call', async () => {
    const custom: MockPort = {
      enabled: false,
      strict: true,
      lookup: async () => ({ hit: false, key_string: 'k', hash: 'h' }),
      record: async () => {
        throw new Error('broken');
      },
    };
    const out = await withMock(context(custom), 'sql_select', HIT_FACTS, realSpy([2]), OPTS);
    expect(out.data).toEqual([2]);
  });

  test('with the T03 mock layer, a real recording run writes only under _unreviewed/', async () => {
    const dir = tempDir();
    const layer = createMockLayer({
      mock: { enabled: false, strict: true, record: true },
      paths: { fixturesDir: dir },
    });
    const p = mockPortFromFixtures(layer);
    await withMock(context(p), 'sql_select', HIT_FACTS, realSpy([{ status: 'DELIVERED' }]), OPTS);
    expect(readdirSync(dir)).toEqual(['_unreviewed']);
    expect(existsSync(join(dir, '_unreviewed', 'run-1', 'sql_select', 'atspl'))).toBe(true);
  });

  test('the T03 mock layer in mock mode serves fixtures and has no recorder', async () => {
    const dir = tempDir();
    writeFixture(dir);
    const layer = createMockLayer({ mock: { enabled: true, strict: true, record: false }, paths: { fixturesDir: dir } });
    const p = mockPortFromFixtures(layer);
    expect(p.record).toBeUndefined();
    const real = realSpy<unknown>([]);
    const out = await withMock(context(p), 'sql_select', HIT_FACTS, real, OPTS);
    expect(out.data).toEqual(HIT_ROWS);
    expect(real).toHaveBeenCalledTimes(0);
  });

  test('mock mode with recording on is refused by the T03 settings', () => {
    expect(() =>
      mockSettingsFrom({ mock: { enabled: true, strict: true, record: true }, paths: { fixturesDir: '/x' } }),
    ).toThrow(/TRIAGE_RECORD_FIXTURES/);
  });
});

describe('target_env holds only an env var name', () => {
  test('a DSN, URL or blank target_env is refused before any I/O, without echoing it', async () => {
    const secret = 'postgres://triage:hunter2@db.internal:5432/package';
    for (const bad of [secret, 'https://admin.internal/api', '', 'lower_case', 'HAS SPACE', '1LEADING_DIGIT']) {
      const real = realSpy<unknown>([]);
      const lookup = mock(async () => ({ hit: true as const, value: [], hash: 'h' }));
      const custom: MockPort = { enabled: true, strict: true, lookup };
      let caught: unknown;
      try {
        await withMock(context(custom), 'sql_select', HIT_FACTS, real, { target_env: bad });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidEnvVarNameError);
      if (bad !== '') expect((caught as Error).message).not.toContain(bad);
      expect(lookup).toHaveBeenCalledTimes(0);
      expect(real).toHaveBeenCalledTimes(0);
    }
  });

  test('envVarName accepts env var names', () => {
    expect(envVarName('SSFB_DB_HARBOR_DSN')).toBe('SSFB_DB_HARBOR_DSN' as EnvVarName);
  });

  test('type level: ConnectorResult has no field that can carry a DSN or URL', () => {
    type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
    type Expect<T extends true> = T;
    type Keys = keyof ConnectorResult<unknown>;

    // The exact field list. A new field fails this line and has to be reviewed.
    type _exact = Expect<
      Equal<Keys, 'data' | 'transport' | 'target_env' | 'taken_at' | 'duration_ms' | 'truncated' | 'fixture_miss'>
    >;
    type Suspect = Extract<
      Lowercase<Keys>,
      `${string}dsn${string}` | `${string}url${string}` | `${string}host${string}` | `${string}token${string}`
    >;
    type _noSuspect = Expect<Equal<Suspect, never>>;
    // target_env is branded: a raw string (such as a DSN) does not type-check.
    type _branded = Expect<Equal<string extends ConnectorResult<unknown>['target_env'] ? true : false, false>>;
    // The miss shape has no such field either.
    type MissKeys = keyof Extract<ConnectorOutcome<unknown>, { fixture_miss: true }>;
    type _missKeys = Expect<
      Equal<MissKeys, 'data' | 'transport' | 'target_env' | 'taken_at' | 'duration_ms' | 'fixture_miss' | 'error'>
    >;

    const result: ConnectorResult<number> = {
      data: 1,
      transport: 'real',
      // @ts-expect-error a plain string is not an EnvVarName
      target_env: 'postgres://u:p@h/db',
      taken_at: '2026-09-23T10:00:00.000Z',
      duration_ms: 0,
    };
    expect(result.data).toBe(1);
  });
});

describe('shared plumbing', () => {
  test('fixture entity comes from the key, else global', () => {
    expect(fixtureEntityOf({ entity: 'ssfb' })).toBe('ssfb');
    expect(fixtureEntityOf({ ids: { aspora_user_id: 'u-1' } })).toBe('global');
    expect(fixtureEntityOf({ entity: 'nope' })).toBe('global');
  });

  test('the error codes are the fixed list', () => {
    expect([...CONNECTOR_ERROR_CODES]).toEqual([
      'not_configured',
      'unreachable',
      'timeout',
      'refused',
      'strict_miss',
      'readonly_role_required',
      'cap_exceeded',
    ]);
    const err = new ConnectorError('timeout', 'ATSPL_DB_PACKAGE_DSN timed out');
    expect(isConnectorError(err)).toBe(true);
    expect(isConnectorError(err, 'refused')).toBe(false);
    expect(isConnectorError(new Error('x'))).toBe(false);
  });

  test('size caps are positive and the exec cap matches the runner default', () => {
    expect(MAX_EXEC_OUTPUT_BYTES).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(MAX_SQL_RESULT_BYTES).toBeGreaterThan(0);
    expect(MAX_HTTP_BODY_BYTES).toBeGreaterThan(0);
  });
});
