import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configFromRecord } from '../config/env.ts';
import { keyHash, keyString, semanticKey } from './key.ts';
import {
  FixtureLoadError,
  FixtureStoreError,
  createFixtureStore,
  resolveFixturesDir,
  type FixtureStore,
} from './store.ts';
import type { FixtureEntity, FixtureKind, SemanticKey } from './types.ts';

const made: string[] = [];
let savedCwd = '';

function tempDir(prefix = 'triage-fixtures-test-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  savedCwd = process.cwd();
});

afterEach(() => {
  process.chdir(savedCwd);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SQL_KEY = semanticKey('sql_select', {
  entity: 'atspl',
  service: 'package',
  tables: ['delivery_requests'],
  params: ['cust-1'],
});
const OTHER_KEY = semanticKey('sql_select', {
  entity: 'atspl',
  service: 'package',
  tables: ['delivery_requests'],
  params: ['cust-2'],
});

function fixtureBody<K extends FixtureKind>(kind: K, entity: FixtureEntity, key: SemanticKey<K>, result: unknown) {
  return {
    schema: 1,
    kind,
    entity,
    key,
    key_string: keyString(key),
    result,
    meta: { source: 'hand', recorded_at: '2026-09-23T10:00:00.000Z' },
  };
}

// Writes <base>/<kind>/<entity>/<name>.json and returns the path.
function writeAt(base: string, kind: string, entity: string, name: string, body: unknown): string {
  const path = join(base, kind, entity, `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return path;
}

function writeFixture(base: string, result: unknown, key: SemanticKey<'sql_select'> = SQL_KEY): string {
  return writeAt(base, 'sql_select', 'atspl', keyHash(key), fixtureBody('sql_select', 'atspl', key, result));
}

async function loadError(fn: () => Promise<unknown>): Promise<FixtureLoadError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FixtureLoadError) return err;
    throw err;
  }
  throw new Error('expected a FixtureLoadError');
}

describe('lookup order', () => {
  test('a case fixture shadows the shared fixture', async () => {
    const root = tempDir();
    writeFixture(join(root, 'shared'), { rows: ['shared'] });
    const casePath = writeFixture(join(root, 'cases', 'case-1'), { rows: ['case'] });

    const store = createFixtureStore({ fixturesDir: root, caseId: 'case-1' });
    const hit = await store.get('sql_select', 'atspl', SQL_KEY);
    expect(hit?.scope).toBe('case');
    expect(hit?.path).toBe(casePath);
    expect(hit?.fixture.result).toEqual({ rows: ['case'] });
    expect(hit?.hash).toBe(keyHash(SQL_KEY));
  });

  test('the shared fixture is used when the case has none, or no case is set', async () => {
    const root = tempDir();
    writeFixture(join(root, 'shared'), { rows: ['shared'] });
    mkdirSync(join(root, 'cases', 'case-1'), { recursive: true });

    for (const store of [createFixtureStore({ fixturesDir: root, caseId: 'case-1' }), createFixtureStore({ fixturesDir: root })]) {
      const hit = await store.get('sql_select', 'atspl', SQL_KEY);
      expect(hit?.scope).toBe('shared');
      expect(hit?.fixture.result).toEqual({ rows: ['shared'] });
    }
  });

  test('another case folder is never read', async () => {
    const root = tempDir();
    writeFixture(join(root, 'cases', 'case-2'), { rows: ['other case'] });
    const store = createFixtureStore({ fixturesDir: root, caseId: 'case-1' });
    expect(await store.get('sql_select', 'atspl', SQL_KEY)).toBeNull();
  });

  test('a miss returns null, including a missing fixtures dir', async () => {
    const root = tempDir();
    writeFixture(join(root, 'shared'), { rows: [] });
    expect(await createFixtureStore({ fixturesDir: root }).get('sql_select', 'atspl', OTHER_KEY)).toBeNull();
    expect(await createFixtureStore({ fixturesDir: join(root, 'nope') }).get('sql_select', 'atspl', SQL_KEY)).toBeNull();
  });

  test('a key built in a different order finds the same fixture', async () => {
    const root = tempDir();
    const key = semanticKey('http_call', {
      entity: 'ssfb',
      service: 'harbor',
      method: 'GET',
      path: '/admin/v1/users/U-1',
      query: { a: '1', b: '2' },
    });
    writeAt(join(root, 'shared'), 'http_call', 'ssfb', keyHash(key), fixtureBody('http_call', 'ssfb', key, { status: 200 }));
    const again = semanticKey('http_call', {
      entity: 'ssfb',
      service: 'harbor',
      method: 'get',
      path: '/admin/v1/users/U-1/',
      query: [['b', '2'], ['a', '1']],
    });
    const hit = await createFixtureStore({ fixturesDir: root }).get('http_call', 'ssfb', again);
    expect(hit?.fixture.result).toEqual({ status: 200 });
  });
});

describe('_unreviewed/ is never read', () => {
  test('a file under _unreviewed/ is not found by get or list', async () => {
    const root = tempDir();
    const hash = keyHash(SQL_KEY);
    const body = fixtureBody('sql_select', 'atspl', SQL_KEY, { rows: ['unreviewed'] });
    writeAt(join(root, '_unreviewed'), 'sql_select', 'atspl', hash, body);
    writeAt(join(root, '_unreviewed', 'run-1'), 'sql_select', 'atspl', hash, body);
    writeAt(join(root, '_unreviewed', 'shared'), 'sql_select', 'atspl', hash, body);

    for (const store of [createFixtureStore({ fixturesDir: root }), createFixtureStore({ fixturesDir: root, caseId: 'run-1' })]) {
      expect(await store.get('sql_select', 'atspl', SQL_KEY)).toBeNull();
      expect(await store.list()).toEqual([]);
    }
  });

  test('a symlink from shared/ into _unreviewed/ is a load error', async () => {
    const root = tempDir();
    const target = writeAt(
      join(root, '_unreviewed', 'run-1'),
      'sql_select',
      'atspl',
      keyHash(SQL_KEY),
      fixtureBody('sql_select', 'atspl', SQL_KEY, { rows: [] }),
    );
    const link = join(root, 'shared', 'sql_select', 'atspl', `${keyHash(SQL_KEY)}.json`);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);

    const err = await loadError(() => createFixtureStore({ fixturesDir: root }).get('sql_select', 'atspl', SQL_KEY));
    expect(err.path).toBe(link);
    expect(err.message).toContain('_unreviewed');
  });

  test('a fixtures dir inside _unreviewed/ is refused', () => {
    const root = tempDir();
    expect(() => createFixtureStore({ fixturesDir: join(root, '_unreviewed') })).toThrow(FixtureStoreError);
    expect(() => createFixtureStore({ fixturesDir: join(root, '_unreviewed', 'run-1') })).toThrow(FixtureStoreError);
  });

  test('a case id that is _unreviewed or tries to leave the tree is refused', () => {
    const root = tempDir();
    for (const caseId of ['_unreviewed', '..', '../x', 'a/b', '', '.hidden']) {
      expect(() => createFixtureStore({ fixturesDir: root, caseId })).toThrow(FixtureStoreError);
    }
  });
});

describe('load errors', () => {
  test('a renamed file (name does not equal the hash of its key_string) is a load error', async () => {
    const root = tempDir();
    // The content is the fixture for SQL_KEY, saved under the name OTHER_KEY hashes to.
    const path = writeAt(
      join(root, 'shared'),
      'sql_select',
      'atspl',
      keyHash(OTHER_KEY),
      fixtureBody('sql_select', 'atspl', SQL_KEY, { rows: [] }),
    );
    const store = createFixtureStore({ fixturesDir: root });
    const err = await loadError(() => store.get('sql_select', 'atspl', OTHER_KEY));
    expect(err.path).toBe(path);
    expect(err.message).toContain(path);
    expect(err.message).toContain('hash');
    expect(await store.get('sql_select', 'atspl', SQL_KEY)).toBeNull();
    const listErr = await loadError(() => store.list());
    expect(listErr.path).toBe(path);
  });

  test('a key_string that is not the canonical form of key is a load error', async () => {
    const root = tempDir();
    const body = { ...fixtureBody('sql_select', 'atspl', SQL_KEY, { rows: [] }), key: { ...SQL_KEY, params: ['cust-9'] } };
    const path = writeAt(join(root, 'shared'), 'sql_select', 'atspl', keyHash(SQL_KEY), body);
    const err = await loadError(() => createFixtureStore({ fixturesDir: root }).get('sql_select', 'atspl', SQL_KEY));
    expect(err.path).toBe(path);
    expect(err.fields).toContain('key_string');
  });

  test('a file in the wrong kind or entity folder is a load error', async () => {
    const root = tempDir();
    const body = fixtureBody('sql_select', 'atspl', SQL_KEY, { rows: [] });
    writeAt(join(root, 'shared'), 'sql_select', 'ssfb', keyHash(SQL_KEY), body);
    const err = await loadError(() => createFixtureStore({ fixturesDir: root }).get('sql_select', 'ssfb', SQL_KEY));
    expect(err.fields).toContain('entity');

    const root2 = tempDir();
    writeAt(join(root2, 'shared'), 'doctor_probe', 'atspl', keyHash(SQL_KEY), body);
    const err2 = await loadError(() => createFixtureStore({ fixturesDir: root2 }).list());
    expect(err2.fields).toContain('kind');
  });

  test('a schema-invalid file names the path and the field, never the result value', async () => {
    const root = tempDir();
    const body = {
      ...fixtureBody('sql_select', 'atspl', SQL_KEY, { account_number: 'RESULT-VALUE-918273645' }),
      meta: { source: 'SOURCE-VALUE-bogus', recorded_at: '2026-09-23T10:00:00.000Z' },
    };
    const path = writeAt(join(root, 'shared'), 'sql_select', 'atspl', keyHash(SQL_KEY), body);
    const err = await loadError(() => createFixtureStore({ fixturesDir: root }).get('sql_select', 'atspl', SQL_KEY));
    expect(err.path).toBe(path);
    expect(err.message).toContain(path);
    expect(err.message).toContain('meta.source');
    expect(err.fields).toContain('meta.source');
    expect(err.message).not.toContain('RESULT-VALUE-918273645');
    expect(err.message).not.toContain('SOURCE-VALUE-bogus');
  });

  test('a missing result or an extra field is a schema error', async () => {
    const root = tempDir();
    const { result: _drop, ...noResult } = fixtureBody('sql_select', 'atspl', SQL_KEY, 1);
    writeAt(join(root, 'shared'), 'sql_select', 'atspl', keyHash(SQL_KEY), noResult);
    const err = await loadError(() => createFixtureStore({ fixturesDir: root }).get('sql_select', 'atspl', SQL_KEY));
    expect(err.fields).toContain('result');
    expect(err.message).toContain('is required');

    const root2 = tempDir();
    const extra = { ...fixtureBody('sql_select', 'atspl', SQL_KEY, 1), transport: 'qw' };
    writeAt(join(root2, 'shared'), 'sql_select', 'atspl', keyHash(SQL_KEY), extra);
    const err2 = await loadError(() => createFixtureStore({ fixturesDir: root2 }).get('sql_select', 'atspl', SQL_KEY));
    expect(err2.fields).toContain('transport');
  });

  test('a file that is not JSON is a load error that does not quote the file', async () => {
    const root = tempDir();
    const path = writeAt(join(root, 'shared'), 'sql_select', 'atspl', keyHash(SQL_KEY), '{"result": "TEXT-IN-FILE-5551234" oops');
    const err = await loadError(() => createFixtureStore({ fixturesDir: root }).get('sql_select', 'atspl', SQL_KEY));
    expect(err.path).toBe(path);
    expect(err.message).toContain('not valid JSON');
    expect(err.message).not.toContain('TEXT-IN-FILE-5551234');
  });

  test('list refuses a file whose name is not a hash', async () => {
    const root = tempDir();
    const path = writeAt(join(root, 'shared'), 'sql_select', 'atspl', 'my-fixture', fixtureBody('sql_select', 'atspl', SQL_KEY, 1));
    const err = await loadError(() => createFixtureStore({ fixturesDir: root }).list());
    expect(err.path).toBe(path);
  });
});

describe('list', () => {
  test('lists case entries first and leaves out shadowed shared entries', async () => {
    const root = tempDir();
    writeFixture(join(root, 'shared'), { rows: ['shared'] });
    writeFixture(join(root, 'shared'), { rows: ['other'] }, OTHER_KEY);
    const casePath = writeFixture(join(root, 'cases', 'case-1'), { rows: ['case'] });

    const entries = await createFixtureStore({ fixturesDir: root, caseId: 'case-1' }).list();
    expect(entries.map((e) => [e.scope, e.hash])).toEqual([
      ['case', keyHash(SQL_KEY)],
      ['shared', keyHash(OTHER_KEY)],
    ]);
    expect(entries[0]?.path).toBe(casePath);
    expect(entries[0]?.key_string).toBe(keyString(SQL_KEY));
  });
});

describe('fixtures dir resolution', () => {
  test('a relative TRIAGE_FIXTURES_DIR resolves under TRIAGE_HOME, not the cwd', async () => {
    const home = tempDir('triage-home-');
    const elsewhere = tempDir('triage-cwd-');
    writeFixture(join(home, 'fx', 'shared'), { rows: ['home'] });
    // A decoy at the same relative path under the cwd must not be read.
    writeFixture(join(elsewhere, 'fx', 'shared'), { rows: ['cwd'] });
    process.chdir(elsewhere);

    const config = configFromRecord({ TRIAGE_FIXTURES_DIR: './fx' }, home);
    expect(config.paths.fixturesDir).toBe(join(home, 'fx'));

    const fromConfig: FixtureStore = createFixtureStore({ fixturesDir: config.paths.fixturesDir });
    expect((await fromConfig.get('sql_select', 'atspl', SQL_KEY))?.fixture.result).toEqual({ rows: ['home'] });

    const fromHome = createFixtureStore({ fixturesDir: 'fx', home });
    expect(fromHome.fixturesDir).toBe(join(home, 'fx'));
    expect((await fromHome.get('sql_select', 'atspl', SQL_KEY))?.fixture.result).toEqual({ rows: ['home'] });
  });

  test('a relative fixtures dir without an absolute home is refused', () => {
    expect(() => resolveFixturesDir('fx')).toThrow(FixtureStoreError);
    expect(() => resolveFixturesDir('fx', 'relative/home')).toThrow(FixtureStoreError);
  });
});
