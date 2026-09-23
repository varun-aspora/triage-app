import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FixtureMissError } from './errors.ts';
import { keyHash, keyString, semanticKey } from './key.ts';
import {
  createResolver,
  resolveIo,
  type IoOutcome,
  type RealIoOutcome,
  type RecordContext,
  type Recorder,
  type ResolverDeps,
} from './resolve.ts';
import type { MockSettings } from './settings.ts';
import { createFixtureStore, type FixtureStore } from './store.ts';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triage-resolve-test-')));
  made.push(dir);
  return dir;
}

const HIT_KEY = semanticKey('sql_select', {
  entity: 'atspl',
  service: 'package',
  tables: ['delivery_requests'],
  params: ['cust-1'],
});
const MISS_KEY = semanticKey('sql_select', {
  entity: 'atspl',
  service: 'package',
  tables: ['delivery_requests'],
  params: ['cust-404'],
});
const HIT_ROWS = [{ id: 'dr-1', status: 'DELIVERED' }];

function writeFixture(fixturesDir: string): string {
  const hash = keyHash(HIT_KEY);
  const path = join(fixturesDir, 'shared', 'sql_select', 'atspl', `${hash}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      kind: 'sql_select',
      entity: 'atspl',
      key: HIT_KEY,
      key_string: keyString(HIT_KEY),
      result: HIT_ROWS,
      meta: { source: 'hand', recorded_at: '2026-09-23T10:00:00.000Z' },
    }),
  );
  return hash;
}

function settings(over: Partial<MockSettings> = {}): MockSettings {
  return { mockMode: true, strict: true, record: false, fixturesDir: '/unused', ...over };
}

// A real fixture store on a temp dir, wrapped so every get() is counted.
function spiedStore(): { store: FixtureStore; get: ReturnType<typeof mock>; hash: string } {
  const fixturesDir = tempDir();
  const hash = writeFixture(fixturesDir);
  const inner = createFixtureStore({ fixturesDir });
  const get = mock(inner.get);
  return { store: { ...inner, get: get as unknown as FixtureStore['get'] }, get, hash };
}

// A store that fails the test if it is read.
function untouchableStore(): { store: Pick<FixtureStore, 'get'>; get: ReturnType<typeof mock> } {
  const get = mock(async () => {
    throw new Error('store must not be read');
  });
  return { store: { get: get as unknown as FixtureStore['get'] }, get };
}

function realSpy<T>(value: T) {
  return mock(async (_signal: AbortSignal) => value);
}

function request(key = HIT_KEY, real = realSpy<unknown>('real value')) {
  return { kind: 'sql_select' as const, entity: 'atspl' as const, key, real, signal: new AbortController().signal };
}

describe('mock mode', () => {
  test('a hit returns the fixture result with transport mock and the fixture hash', async () => {
    const { store, hash } = spiedStore();
    const resolve = createResolver({ settings: settings(), store });
    const out = await resolve(request());
    expect(out).toEqual({
      value: HIT_ROWS,
      transport: 'mock',
      fixture: { hash, hit: true },
      fixture_miss: false,
    });
  });

  test('a strict miss throws FixtureMissError naming the kind and the key_string', async () => {
    const { store } = spiedStore();
    const resolve = createResolver({ settings: settings({ strict: true }), store });
    let caught: unknown;
    try {
      await resolve(request(MISS_KEY));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FixtureMissError);
    const err = caught as FixtureMissError;
    expect(err.kind).toBe('sql_select');
    expect(err.key_string).toBe(keyString(MISS_KEY));
    expect(err.hash).toBe(keyHash(MISS_KEY));
    expect(err.message).toContain('sql_select');
    expect(err.message).toContain(keyString(MISS_KEY));
    expect(err.message).toMatchSnapshot();
  });

  test('a non-strict miss returns fixture_miss true and value null', async () => {
    const { store } = spiedStore();
    const resolve = createResolver({ settings: settings({ strict: false }), store });
    const out = await resolve(request(MISS_KEY));
    expect(out).toEqual({
      value: null,
      transport: 'mock',
      fixture: { hash: keyHash(MISS_KEY), hit: false },
      fixture_miss: true,
    });
  });

  test('real() is never called across hit, strict miss and non-strict miss', async () => {
    const { store, get } = spiedStore();
    const real = realSpy<unknown>('real value');
    const strict = createResolver({ settings: settings({ strict: true }), store });
    const lax = createResolver({ settings: settings({ strict: false }), store });

    await strict(request(HIT_KEY, real));
    await expect(strict(request(MISS_KEY, real))).rejects.toBeInstanceOf(FixtureMissError);
    await lax(request(MISS_KEY, real));
    await lax(request(HIT_KEY, real));

    expect(real).toHaveBeenCalledTimes(0);
    expect(get).toHaveBeenCalledTimes(4);
  });

  test('the recorder is never called in mock mode', async () => {
    const { store } = spiedStore();
    const record = mock(async () => undefined);
    const resolve = createResolver({ settings: settings({ strict: false }), store, recorder: { record } });
    await resolve(request(HIT_KEY));
    await resolve(request(MISS_KEY));
    expect(record).toHaveBeenCalledTimes(0);
  });

  test('a store load error propagates instead of turning into a miss', async () => {
    const boom = new Error('fixture file is broken');
    const store = { get: mock(async () => Promise.reject(boom)) as unknown as FixtureStore['get'] };
    const resolve = createResolver({ settings: settings({ strict: false }), store });
    await expect(resolve(request())).rejects.toBe(boom);
  });
});

describe('real mode', () => {
  test('calls real() once with the signal, reports transport real and does not touch the store', async () => {
    const { store, get } = untouchableStore();
    const real = realSpy({ rows: 3 });
    const controller = new AbortController();
    const resolve = createResolver({ settings: settings({ mockMode: false }), store });
    const out = await resolve({ ...request(HIT_KEY, real), signal: controller.signal });
    expect(out).toEqual({ value: { rows: 3 }, transport: 'real', fixture: null, fixture_miss: false });
    expect(real).toHaveBeenCalledTimes(1);
    expect(real.mock.calls[0]?.[0]).toBe(controller.signal);
    expect(get).toHaveBeenCalledTimes(0);
  });

  test('a failing real() rejects with its own error', async () => {
    const { store } = untouchableStore();
    const boom = new Error('connection refused');
    const resolve = createResolver({ settings: settings({ mockMode: false }), store });
    const real = mock(async () => Promise.reject(boom));
    await expect(resolve(request(HIT_KEY, real))).rejects.toBe(boom);
  });

  test('the one-off resolveIo form behaves the same', async () => {
    const { store } = untouchableStore();
    const out = await resolveIo({ settings: settings({ mockMode: false }), store }, request(HIT_KEY, realSpy(7)));
    expect(out.transport).toBe('real');
    expect(out.value).toBe(7);
  });
});

describe('recorder', () => {
  function recorderSpy(impl: Recorder['record'] = async () => undefined) {
    const record = mock(impl);
    return { recorder: { record } as Recorder, record };
  }

  test('is not called when record is off', async () => {
    const { store } = untouchableStore();
    const { recorder, record } = recorderSpy();
    const resolve = createResolver({ settings: settings({ mockMode: false, record: false }), store, recorder });
    await resolve({ ...request(HIT_KEY, realSpy(1)), recorder });
    expect(record).toHaveBeenCalledTimes(0);
  });

  test('is called once with the outcome and the key context when record is on', async () => {
    const { store } = untouchableStore();
    const { recorder, record } = recorderSpy();
    const resolve = createResolver({ settings: settings({ mockMode: false, record: true }), store, recorder });
    const out = await resolve({
      ...request(HIT_KEY, realSpy(HIT_ROWS)),
      run_id: 'run-1',
      redaction_names: ['A Person'],
    });
    expect(record).toHaveBeenCalledTimes(1);
    const [outcome, ctx] = record.mock.calls[0] as [RealIoOutcome<unknown>, RecordContext];
    expect(outcome).toBe(out as RealIoOutcome<unknown>);
    expect(ctx).toEqual({
      kind: 'sql_select',
      entity: 'atspl',
      key: HIT_KEY,
      key_string: keyString(HIT_KEY),
      hash: keyHash(HIT_KEY),
      run_id: 'run-1',
      redaction_names: ['A Person'],
    });
  });

  test('a per-call recorder overrides the resolver recorder', async () => {
    const { store } = untouchableStore();
    const base = recorderSpy();
    const perCall = recorderSpy();
    const resolve = createResolver({ settings: settings({ mockMode: false, record: true }), store, recorder: base.recorder });
    await resolve({ ...request(HIT_KEY, realSpy(1)), recorder: perCall.recorder });
    expect(base.record).toHaveBeenCalledTimes(0);
    expect(perCall.record).toHaveBeenCalledTimes(1);
  });

  test('a throwing or rejecting recorder does not change the returned value', async () => {
    const { store } = untouchableStore();
    const errors: unknown[] = [];
    const deps = (recorder: Recorder): ResolverDeps => ({
      settings: settings({ mockMode: false, record: true }),
      store,
      recorder,
      onRecorderError: (err) => errors.push(err),
    });
    const expected: IoOutcome<unknown> = { value: HIT_ROWS, transport: 'real', fixture: null, fixture_miss: false };

    const sync = recorderSpy(() => {
      throw new Error('disk full');
    });
    expect(await createResolver(deps(sync.recorder))(request(HIT_KEY, realSpy(HIT_ROWS)))).toEqual(expected);

    const rejecting = recorderSpy(async () => Promise.reject(new Error('rename failed')));
    expect(await createResolver(deps(rejecting.recorder))(request(HIT_KEY, realSpy(HIT_ROWS)))).toEqual(expected);

    expect(sync.record).toHaveBeenCalledTimes(1);
    expect(rejecting.record).toHaveBeenCalledTimes(1);
    expect(errors.map((e) => (e as Error).message)).toEqual(['disk full', 'rename failed']);
  });

  test('a throwing onRecorderError is swallowed too', async () => {
    const { store } = untouchableStore();
    const { recorder } = recorderSpy(() => {
      throw new Error('disk full');
    });
    const resolve = createResolver({
      settings: settings({ mockMode: false, record: true }),
      store,
      recorder,
      onRecorderError: () => {
        throw new Error('sink broken');
      },
    });
    const out = await resolve(request(HIT_KEY, realSpy('ok')));
    expect(out.value).toBe('ok');
  });

  test('record on with no recorder still returns the real outcome', async () => {
    const { store } = untouchableStore();
    const resolve = createResolver({ settings: settings({ mockMode: false, record: true }), store });
    const out = await resolve(request(HIT_KEY, realSpy('ok')));
    expect(out).toEqual({ value: 'ok', transport: 'real', fixture: null, fixture_miss: false });
  });
});

describe('abort', () => {
  function aborted(): AbortSignal {
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    return controller.signal;
  }

  test.each([
    ['mock strict', settings({ strict: true })],
    ['mock non-strict', settings({ strict: false })],
    ['real', settings({ mockMode: false })],
    ['real recording', settings({ mockMode: false, record: true })],
  ])('a pre-aborted signal rejects with no side effects (%s)', async (_label, s) => {
    const { store, get } = untouchableStore();
    const real = realSpy('real value');
    const record = mock(async () => undefined);
    const resolve = createResolver({ settings: s, store, recorder: { record } });
    await expect(resolve({ ...request(HIT_KEY, real), signal: aborted() })).rejects.toThrow('run cancelled');
    expect(get).toHaveBeenCalledTimes(0);
    expect(real).toHaveBeenCalledTimes(0);
    expect(record).toHaveBeenCalledTimes(0);
  });

  test('an abort during the store read rejects instead of returning the fixture', async () => {
    const controller = new AbortController();
    const { store: inner } = spiedStore();
    const store = {
      get: (async (...args: Parameters<FixtureStore['get']>) => {
        const out = await inner.get(...args);
        controller.abort(new Error('run cancelled'));
        return out;
      }) as FixtureStore['get'],
    };
    const resolve = createResolver({ settings: settings(), store });
    await expect(resolve({ ...request(), signal: controller.signal })).rejects.toThrow('run cancelled');
  });
});
