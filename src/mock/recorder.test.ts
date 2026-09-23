import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { checkEgress } from '../gate/redact.ts';
import { createMockLayer } from './index.ts';
import { hashKeyString, keyString, semanticKey } from './key.ts';
import { createRecorder, FixtureRecordRefusedError, type CheckPersistedFn } from './recorder.ts';
import type { RealIoOutcome, RecordContext } from './resolve.ts';
import type { MockConfig } from './settings.ts';
import { parseFixture } from './store.ts';
import type { FixtureEntity, FixtureKind } from './types.ts';

// Synthetic values only. None of these belong to a real person or account.
const PHONE = '+91 98765 43210';
const ACCOUNT = '001234567890';
const NAME = 'Asha Verma';
const UUID = '3f2b8c9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const FIXED_NOW = () => new Date('2026-09-23T10:00:00.000Z');

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triage-recorder-test-')));
  made.push(dir);
  return dir;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

const KEY = semanticKey('sql_select', {
  entity: 'atspl',
  service: 'package',
  tables: ['delivery_requests'],
  params: [UUID, 'DELIVERED'],
});

function ctxFor(overrides: Partial<Omit<RecordContext, 'kind' | 'entity'>> & { kind?: string; entity?: string } = {}): RecordContext {
  const key = (overrides.key ?? KEY) as RecordContext['key'];
  const key_string = keyString(key);
  return {
    kind: (overrides.kind ?? 'sql_select') as FixtureKind,
    entity: (overrides.entity ?? 'atspl') as FixtureEntity,
    key,
    key_string,
    hash: hashKeyString(key_string),
    run_id: 'run_abc-1',
    redaction_names: [NAME],
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'kind' && k !== 'entity' && k !== 'key')),
  } as RecordContext;
}

function real<T>(value: T): RealIoOutcome<T> {
  return { value, transport: 'real', fixture: null, fixture_miss: false };
}

describe('createRecorder', () => {
  test('writes only under _unreviewed/<run_id>/<kind>/<entity>/', async () => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root, now: FIXED_NOW });
    const res = await recorder.record(real([{ id: UUID, status: 'DELIVERED' }]), ctxFor());

    expect(res.status).toBe('written');
    const files = listFiles(root);
    expect(files).toHaveLength(1);
    const [only] = files as [string];
    expect(only.split(sep).slice(0, 4)).toEqual(['_unreviewed', 'run_abc-1', 'sql_select', 'atspl']);
    expect(only).toMatch(/[0-9a-f]{16}\.json$/);
    if (res.status !== 'dropped') expect(res.path).toBe(join(root, only));

    const fixture = JSON.parse(readFileSync(join(root, only), 'utf8'));
    expect(fixture.meta).toEqual({ source: 'recorded', recorded_at: '2026-09-23T10:00:00.000Z', run_id: 'run_abc-1' });
    expect(statSync(join(root, only)).mode & 0o777).toBe(0o600);
  });

  test('masks a phone, an account number and an ingress name; keeps the UUID', async () => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root, now: FIXED_NOW });
    const rows = [{ id: UUID, phone: PHONE, account_no: ACCOUNT, note: `Raised by ${NAME}` }];
    const res = await recorder.record(real(rows), ctxFor());
    expect(res.status).toBe('written');

    const text = readFileSync(join(root, listFiles(root)[0] as string), 'utf8');
    expect(text).not.toContain('98765');
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain(NAME);
    expect(text).toContain(UUID);
    const [row] = JSON.parse(text).result;
    expect(row.id).toBe(UUID);
    expect(row.phone).toBe('****3210');
    expect(row.account_no).toBe('****7890');
    expect(checkEgress(JSON.parse(text), { names: [NAME] })).toEqual({ ok: true });
  });

  test('redacts the key too, and names the file by the hash of the redacted key_string', async () => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root, now: FIXED_NOW });
    const key = semanticKey('sql_select', {
      entity: 'atspl',
      service: 'package',
      tables: ['users'],
      params: [ACCOUNT, PHONE, NAME, UUID],
    });
    const res = await recorder.record(real([]), ctxFor({ key }));
    expect(res.status).toBe('written');

    const rel = listFiles(root)[0] as string;
    const text = readFileSync(join(root, rel), 'utf8');
    const fixture = JSON.parse(text);
    expect(fixture.key_string).not.toContain(ACCOUNT);
    expect(fixture.key_string).not.toContain('98765');
    expect(fixture.key_string).not.toContain(NAME);
    expect(fixture.key.params).toContain(UUID);
    expect(fixture.key_string).toBe(keyString(fixture.key));
    const hash = hashKeyString(fixture.key_string);
    expect(rel.endsWith(`${hash}.json`)).toBe(true);
    // The raw key's hash is not used.
    expect(hash).not.toBe(hashKeyString(keyString(key)));
    // The store would accept the file once promoted.
    expect(() => parseFixture(join(root, rel), text, { kind: 'sql_select', entity: 'atspl', hash })).not.toThrow();
  });

  test.each(['../x', '..', 'a/b', '', 'x'.repeat(65)])('refuses run_id %p and writes nothing', async (run_id) => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root });
    await expect(recorder.record(real([]), ctxFor({ run_id }))).rejects.toBeInstanceOf(FixtureRecordRefusedError);
    expect(listFiles(root)).toEqual([]);
  });

  test('refuses a missing run_id', async () => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root });
    const ctx = { ...ctxFor() } as { run_id?: string };
    delete ctx.run_id;
    await expect(recorder.record(real([]), ctx as RecordContext)).rejects.toThrow('run_id');
    expect(listFiles(root)).toEqual([]);
  });

  test.each(['../ssfb', 'global/../..', 'SSFB'])('refuses entity %p', async (entity) => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root });
    await expect(recorder.record(real([]), ctxFor({ entity }))).rejects.toThrow('entity');
    expect(listFiles(root)).toEqual([]);
  });

  test('refuses an unknown kind', async () => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root });
    await expect(recorder.record(real([]), ctxFor({ kind: '../sql_select' }))).rejects.toThrow('kind');
    expect(listFiles(root)).toEqual([]);
  });

  test('refuses an _unreviewed folder that is a symlink out of the fixtures tree', async () => {
    const root = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(root, '_unreviewed'));
    const recorder = createRecorder({ fixturesDir: root });
    await expect(recorder.record(real([]), ctxFor())).rejects.toBeInstanceOf(FixtureRecordRefusedError);
    expect(listFiles(outside)).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
  });

  test('a fixtures dir inside _unreviewed is refused at construction', () => {
    const root = tempDir();
    expect(() => createRecorder({ fixturesDir: join(root, '_unreviewed') })).toThrow();
  });

  test('a candidate that still fails the persisted check is dropped with pattern names only', async () => {
    const root = tempDir();
    const secret = '4111111111111111';
    const checkPersisted: CheckPersistedFn = () => ({ ok: false, unmasked: ['pan'], paths: ['$.result[0].card'] });
    const gaps: string[] = [];
    const recorder = createRecorder({ fixturesDir: root, checkPersisted, onGap: (gap) => gaps.push(gap) });

    const res = await recorder.record(real([{ card: secret }]), ctxFor());

    expect(res.status).toBe('dropped');
    const gap = res.status === 'dropped' ? res.gap : '';
    expect(gap).toContain('pan');
    expect(gap).not.toContain(secret);
    expect(gap).not.toContain('1111');
    expect(gaps).toEqual([gap]);
    expect(listFiles(root)).toEqual([]);
  });

  test('a checker that returns something other than pattern names does not leak it into the gap', async () => {
    const root = tempDir();
    const checkPersisted = (() => ({ ok: false, unmasked: ['9876543210'], paths: [] })) as unknown as CheckPersistedFn;
    const recorder = createRecorder({ fixturesDir: root, checkPersisted });
    const res = await recorder.record(real([]), ctxFor());
    expect(res.status).toBe('dropped');
    const gap = res.status === 'dropped' ? res.gap : '';
    expect(gap).not.toContain('9876543210');
    expect(gap).toContain('unknown pattern');
  });

  test('a second record of the same key in the same run does not overwrite', async () => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root, now: FIXED_NOW });
    const first = await recorder.record(real([{ status: 'FIRST' }]), ctxFor());
    const second = await recorder.record(real([{ status: 'SECOND' }]), ctxFor());

    expect(first.status).toBe('written');
    expect(second.status).toBe('kept');
    const files = listFiles(root);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(root, files[0] as string), 'utf8');
    expect(text).toContain('FIRST');
    expect(text).not.toContain('SECOND');
  });

  test('two records of the same key at once write one file and leave no temp files', async () => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root, now: FIXED_NOW });
    const results = await Promise.all([
      recorder.record(real([{ status: 'A' }]), ctxFor()),
      recorder.record(real([{ status: 'B' }]), ctxFor()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['kept', 'written']);
    expect(listFiles(root)).toHaveLength(1);
  });

  test('the same key in another run gets its own file', async () => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root, now: FIXED_NOW });
    await recorder.record(real([]), ctxFor({ run_id: 'run-1' }));
    await recorder.record(real([]), ctxFor({ run_id: 'run-2' }));
    expect(listFiles(root).map((f) => f.split(sep)[1])).toEqual(['run-1', 'run-2']);
  });

  test('an undefined result is recorded as null', async () => {
    const root = tempDir();
    const recorder = createRecorder({ fixturesDir: root, now: FIXED_NOW });
    await recorder.record(real(undefined), ctxFor());
    const fixture = JSON.parse(readFileSync(join(root, listFiles(root)[0] as string), 'utf8'));
    expect(fixture.result).toBeNull();
  });
});

describe('createMockLayer', () => {
  function config(root: string, mock: { enabled: boolean; strict?: boolean; record: boolean }): MockConfig {
    return { mock: { strict: true, ...mock }, paths: { fixturesDir: root } };
  }

  test('mock mode has no recorder and never writes', async () => {
    const root = tempDir();
    const layer = createMockLayer(config(root, { enabled: true, strict: false, record: false }));
    expect(layer.recorder).toBeNull();
    let called = false;
    const out = await layer.resolveIo({
      kind: 'sql_select',
      entity: 'atspl',
      key: KEY,
      real: async () => {
        called = true;
        return [];
      },
      signal: new AbortController().signal,
      run_id: 'run-1',
    });
    expect(out.transport).toBe('mock');
    expect(called).toBe(false);
    expect(listFiles(root)).toEqual([]);
  });

  test('mock mode together with record is refused', () => {
    const root = tempDir();
    expect(() => createMockLayer(config(root, { enabled: true, record: true }))).toThrow('TRIAGE_RECORD_FIXTURES');
  });

  test('a real run with recording off has no recorder and writes nothing', async () => {
    const root = tempDir();
    const layer = createMockLayer(config(root, { enabled: false, record: false }));
    expect(layer.recorder).toBeNull();
    const out = await layer.resolveIo({
      kind: 'sql_select',
      entity: 'atspl',
      key: KEY,
      real: async () => [{ phone: PHONE }],
      signal: new AbortController().signal,
      run_id: 'run-1',
    });
    expect(out.transport).toBe('real');
    expect(listFiles(root)).toEqual([]);
  });

  test('a real run with recording on records through resolveIo end to end', async () => {
    const root = tempDir();
    const layer = createMockLayer(config(root, { enabled: false, record: true }), { now: FIXED_NOW });
    expect(layer.recorder).not.toBeNull();
    const rows = [{ id: UUID, phone: PHONE, owner: NAME }];
    let calls = 0;
    const out = await layer.resolveIo({
      kind: 'sql_select',
      entity: 'atspl',
      key: KEY,
      real: async () => {
        calls += 1;
        return rows;
      },
      signal: new AbortController().signal,
      run_id: 'run-e2e',
      redaction_names: [NAME],
    });

    expect(calls).toBe(1);
    // The caller gets the real, unredacted value; only the file is redacted.
    expect(out).toMatchObject({ transport: 'real', value: rows, fixture: null, fixture_miss: false });
    const files = listFiles(root);
    expect(files).toHaveLength(1);
    expect((files[0] as string).startsWith(join('_unreviewed', 'run-e2e', 'sql_select', 'atspl') + sep)).toBe(true);
    const text = readFileSync(join(root, files[0] as string), 'utf8');
    expect(text).not.toContain('98765');
    expect(text).not.toContain(NAME);
    expect(text).toContain(UUID);
  });

  test('a refused record is reported and the real call still succeeds', async () => {
    const root = tempDir();
    const errors: unknown[] = [];
    const layer = createMockLayer(config(root, { enabled: false, record: true }), {
      onRecorderError: (err) => errors.push(err),
    });
    const out = await layer.resolveIo({
      kind: 'sql_select',
      entity: 'atspl',
      key: KEY,
      real: async () => [],
      signal: new AbortController().signal,
      run_id: '../escape',
    });
    expect(out.transport).toBe('real');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(FixtureRecordRefusedError);
    expect(listFiles(root)).toEqual([]);
  });

  test('a dropped candidate reaches onRecordGap', async () => {
    const root = tempDir();
    const gaps: string[] = [];
    const layer = createMockLayer(config(root, { enabled: false, record: true }), {
      checkPersisted: () => ({ ok: false, unmasked: ['pan'], paths: [] }),
      onRecordGap: (gap) => gaps.push(gap),
    });
    await layer.resolveIo({
      kind: 'sql_select',
      entity: 'atspl',
      key: KEY,
      real: async () => [],
      signal: new AbortController().signal,
      run_id: 'run-1',
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('pan');
    expect(listFiles(root)).toEqual([]);
  });
});

describe('source guard', () => {
  test('the recorder and the layer never run git or a subprocess', () => {
    for (const file of ['recorder.ts', 'index.ts']) {
      const src = readFileSync(join(import.meta.dir, file), 'utf8');
      expect(src).not.toMatch(/child_process|\bspawn\b|\bexecFile\b|\bexecSync\b|Bun\.|from 'bun/);
      expect(src).not.toMatch(/['"`]git['"`]/);
    }
  });
});

// Make sure a nested directory can exist before a record (mkdir is recursive).
test('an existing run folder is reused', async () => {
  const root = tempDir();
  mkdirSync(join(root, '_unreviewed', 'run_abc-1', 'sql_select', 'atspl'), { recursive: true });
  const recorder = createRecorder({ fixturesDir: root, now: FIXED_NOW });
  const res = await recorder.record(real([]), ctxFor());
  expect(res.status).toBe('written');
});

test('a fixtures dir that does not exist yet is created', async () => {
  const root = join(tempDir(), 'fixtures');
  const recorder = createRecorder({ fixturesDir: root, now: FIXED_NOW });
  const res = await recorder.record(real([]), ctxFor());
  expect(res.status).toBe('written');
  expect(listFiles(root)).toHaveLength(1);
});
