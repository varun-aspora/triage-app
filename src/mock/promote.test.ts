import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spyOnSpawns } from '../../test/support/spawn-spy.ts';
import type { EgressResult } from '../gate/redact.ts';
import { keyHash, keyString, semanticKey } from './key.ts';
import {
  decline,
  listUnreviewed,
  promote,
  reviewDirsFrom,
  type EvalCaseReviewItem,
  type FixtureReviewItem,
  type ReviewDirs,
  type ReviewItem,
} from './promote.ts';
import { createFixtureStore } from './store.ts';

const RUN_ID = '01J8ZABCDEFGHJKMNPQRSTVWXY';
const NOW = () => new Date('2026-09-23T12:00:00.000Z');
const PASS = (): EgressResult => ({ ok: true });

const made: string[] = [];
let dirs: ReviewDirs;

beforeEach(() => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triage-promote-test-')));
  made.push(home);
  dirs = { fixturesDir: join(home, 'fixtures'), evalsDir: join(home, 'evals') };
});

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = semanticKey('sql_select', {
  entity: 'atspl',
  service: 'package',
  tables: ['delivery_requests'],
  params: ['cust-1'],
});

function body(key: unknown, extra: { key_string?: string; result?: unknown } = {}) {
  return {
    schema: 1,
    kind: 'sql_select',
    entity: 'atspl',
    key,
    key_string: extra.key_string ?? keyString(key),
    result: extra.result ?? { rows: [{ status: 'SETTLED', ref: 'cust-1' }] },
    meta: { source: 'recorded', recorded_at: '2026-09-20T10:00:00.000Z', run_id: RUN_ID },
  };
}

// Writes an unreviewed fixture named after `nameKey` (the recorder's view)
// holding `fileBody` (possibly edited by the reviewer).
function writeUnreviewed(fileBody: unknown, nameKey: unknown = (fileBody as { key: unknown }).key): string {
  const path = join(dirs.fixturesDir, '_unreviewed', RUN_ID, 'sql_select', 'atspl', `${keyHash(nameKey)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fileBody, null, 2));
  return path;
}

function writeDraft(files: Record<string, string>, runId = RUN_ID): string {
  const dir = join(dirs.evalsDir, '_unreviewed', runId);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

async function onlyItem<T extends ReviewItem['type']>(type: T): Promise<Extract<ReviewItem, { type: T }>> {
  const items = (await listUnreviewed(dirs)).filter((i) => i.type === type);
  expect(items).toHaveLength(1);
  return items[0] as Extract<ReviewItem, { type: T }>;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('listUnreviewed', () => {
  test('lists fixtures and eval drafts with their parsed content', async () => {
    writeUnreviewed(body(KEY));
    writeDraft({ 'feedback.md': '# verdict: correct\n', 'report.json': '{"status":"done"}' });
    const items = await listUnreviewed(dirs);
    expect(items.map((i) => i.type)).toEqual(['fixture', 'eval_case']);
    const fixture = items[0] as FixtureReviewItem;
    expect(fixture.kind).toBe('sql_select');
    expect(fixture.entity).toBe('atspl');
    expect(fixture.hash).toBe(keyHash(KEY));
    expect(fixture.fixture?.key_string).toBe(keyString(KEY));
    expect(fixture.problem).toBeUndefined();
    expect((items[1] as EvalCaseReviewItem).files).toEqual(['feedback.md', 'report.json']);
  });

  test('returns nothing when the _unreviewed folders do not exist', async () => {
    expect(await listUnreviewed(dirs)).toEqual([]);
  });

  test('marks a file that fails the schema or still has a masked key', async () => {
    writeUnreviewed({ ...body(KEY), schema: 2 });
    const masked = { ...KEY, params: ['****1234'] };
    writeUnreviewed(body(masked));
    const items = (await listUnreviewed(dirs)) as FixtureReviewItem[];
    expect(items).toHaveLength(2);
    const problems = items.map((i) => i.problem ?? '').sort();
    expect(problems.some((p) => p.includes('fails the fixture schema at schema'))).toBe(true);
    expect(problems.some((p) => p.includes("mask token '****'"))).toBe(true);
  });

  test('refuses relative dirs instead of using the cwd', async () => {
    await expect(listUnreviewed({ fixturesDir: 'fixtures', evalsDir: dirs.evalsDir })).rejects.toThrow('absolute');
  });

  test('reviewDirsFrom reads the fixtures dir and <home>/evals', () => {
    expect(reviewDirsFrom({ home: '/srv/home', paths: { fixturesDir: '/srv/home/fixtures' } })).toEqual({
      fixturesDir: '/srv/home/fixtures',
      evalsDir: '/srv/home/evals',
    });
  });
});

describe('promote a fixture', () => {
  test('moves it to shared/ with reviewed_by and reviewed_at set', async () => {
    const source = writeUnreviewed(body(KEY));
    const item = await onlyItem('fixture');
    const result = await promote(item, { reviewer: 'reviewer-a', now: NOW });
    const target = join(dirs.fixturesDir, 'shared', 'sql_select', 'atspl', `${keyHash(KEY)}.json`);
    expect(result).toEqual({ status: 'promoted', type: 'fixture', from: source, to: target });
    expect(existsSync(source)).toBe(false);
    const promoted = readJson(target);
    expect(promoted.meta.reviewed_by).toBe('reviewer-a');
    expect(promoted.meta.reviewed_at).toBe('2026-09-23T12:00:00.000Z');
    expect(promoted.meta.run_id).toBe(RUN_ID);
    expect(promoted.result).toEqual(body(KEY).result);

    // The store serves the promoted file.
    const store = createFixtureStore({ fixturesDir: dirs.fixturesDir });
    const hit = await store.get('sql_select', 'atspl', KEY);
    expect(hit?.scope).toBe('shared');
    expect(await listUnreviewed(dirs)).toEqual([]);
  });

  test('moves it to cases/<caseId>/ when a case id is given', async () => {
    const source = writeUnreviewed(body(KEY));
    const result = await promote(await onlyItem('fixture'), { reviewer: 'reviewer-a', caseId: 'case-42', now: NOW });
    const target = join(dirs.fixturesDir, 'cases', 'case-42', 'sql_select', 'atspl', `${keyHash(KEY)}.json`);
    expect(result.status).toBe('promoted');
    expect(result.status === 'promoted' && result.to).toBe(target);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(dirs.fixturesDir, 'shared'))).toBe(false);
    const store = createFixtureStore({ fixturesDir: dirs.fixturesDir, caseId: 'case-42' });
    expect((await store.get('sql_select', 'atspl', KEY))?.scope).toBe('case');
  });

  test('an edited key gets a new file name and key_string', async () => {
    const masked = { ...KEY, params: ['****0001'] };
    const edited = { ...KEY, params: ['cust-pseudo-7'] };
    // The recorder named the file after the masked key; the reviewer edited
    // only the key object and left key_string stale.
    const source = writeUnreviewed(body(edited, { key_string: keyString(masked) }), masked);
    const result = await promote(await onlyItem('fixture'), { reviewer: 'reviewer-a', now: NOW });
    expect(result.status).toBe('promoted');
    const target = join(dirs.fixturesDir, 'shared', 'sql_select', 'atspl', `${keyHash(edited)}.json`);
    expect(result.status === 'promoted' && result.to).toBe(target);
    expect(keyHash(edited)).not.toBe(keyHash(masked));
    expect(existsSync(source)).toBe(false);
    expect(readJson(target).key_string).toBe(keyString(edited));
  });

  test('an edited key is normalised before hashing', async () => {
    const unsorted = { ...KEY, tables: ['z_table', 'a_table'] };
    writeUnreviewed(body(unsorted));
    const result = await promote(await onlyItem('fixture'), { reviewer: 'reviewer-a', now: NOW });
    const normal = semanticKey('sql_select', unsorted);
    expect(normal.tables).toEqual(['a_table', 'z_table']);
    expect(result.status === 'promoted' && result.to.endsWith(`${keyHash(normal)}.json`)).toBe(true);
  });

  test('a key with the mask token is refused and the file stays', async () => {
    const source = writeUnreviewed(body({ ...KEY, params: ['****1234'] }));
    const result = await promote(await onlyItem('fixture'), { reviewer: 'reviewer-a', check: PASS, now: NOW });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain("mask token '****'");
    expect(result.reason).toContain('key.params[0]');
    expect(result.reason).toContain('pseudonymise the ids');
    expect(result.reason).not.toContain('1234');
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(dirs.fixturesDir, 'shared'))).toBe(false);
  });

  test('a fake check that flags phone refuses with pattern names only', async () => {
    const source = writeUnreviewed(body(KEY));
    const seen: unknown[] = [];
    const check = (value: unknown): EgressResult => {
      seen.push(value);
      return { ok: false, unmasked: ['phone'], paths: ['$.result.rows[0].ref'] };
    };
    const result = await promote(await onlyItem('fixture'), { reviewer: 'reviewer-a', check, now: NOW });
    expect(result).toEqual({
      status: 'refused',
      type: 'fixture',
      from: source,
      reason: 'fails the persisted redaction check: phone',
      patterns: ['phone'],
    });
    // The check sees the stamped result it would promote.
    expect((seen[0] as { meta: { reviewed_by: string } }).meta.reviewed_by).toBe('reviewer-a');
    expect(existsSync(source)).toBe(true);
  });

  test('the default check is the persisted profile and refuses an unmasked phone', async () => {
    const phone = '+91 98765 43210';
    const source = writeUnreviewed(body(KEY, { result: { rows: [{ mobile: phone }] } }));
    const result = await promote(await onlyItem('fixture'), { reviewer: 'reviewer-a', now: NOW });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.patterns).toContain('phone');
    expect(result.reason).not.toContain('98765');
    expect(existsSync(source)).toBe(true);
  });

  test('a target with different content is refused and nothing moves', async () => {
    const source = writeUnreviewed(body(KEY));
    const target = join(dirs.fixturesDir, 'shared', 'sql_select', 'atspl', `${keyHash(KEY)}.json`);
    mkdirSync(dirname(target), { recursive: true });
    const other = JSON.stringify(body(KEY, { result: { rows: [] } }));
    writeFileSync(target, other);
    const result = await promote(await onlyItem('fixture'), { reviewer: 'reviewer-a', now: NOW });
    expect(result.status).toBe('refused');
    expect(result.status === 'refused' && result.reason).toBe('target exists with different content');
    expect(readFileSync(target, 'utf8')).toBe(other);
    expect(existsSync(source)).toBe(true);
  });

  test('a target with the same content is a no-op success', async () => {
    writeUnreviewed(body(KEY));
    const first = await promote(await onlyItem('fixture'), { reviewer: 'reviewer-a', now: NOW });
    expect(first.status).toBe('promoted');
    const target = first.status === 'promoted' ? first.to : '';
    const before = readFileSync(target, 'utf8');

    // The same recording again, reviewed later by someone else.
    const source = writeUnreviewed(body(KEY));
    const later = () => new Date('2026-09-24T09:00:00.000Z');
    const second = await promote(await onlyItem('fixture'), { reviewer: 'reviewer-b', now: later });
    expect(second).toEqual({ status: 'unchanged', type: 'fixture', from: source, to: target });
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(existsSync(source)).toBe(false);
  });

  test('refuses without a reviewer, with a bad case id, or for a file outside _unreviewed', async () => {
    const source = writeUnreviewed(body(KEY));
    const item = await onlyItem('fixture');
    expect((await promote(item, { reviewer: '  ' })).status).toBe('refused');
    expect((await promote(item, { reviewer: 'r', caseId: '../escape' })).status).toBe('refused');
    expect((await promote(item, { reviewer: 'r', caseId: '_unreviewed' })).status).toBe('refused');

    const outside = join(dirs.fixturesDir, 'elsewhere.json');
    writeFileSync(outside, JSON.stringify(body(KEY)));
    const forged = await promote({ ...item, path: outside }, { reviewer: 'r' });
    expect(forged.status === 'refused' && forged.reason).toContain('not inside _unreviewed/');
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(source)).toBe(true);
  });

  test('refuses a symlinked item', async () => {
    const real = join(dirs.fixturesDir, 'real.json');
    mkdirSync(dirs.fixturesDir, { recursive: true });
    writeFileSync(real, JSON.stringify(body(KEY)));
    const link = join(dirs.fixturesDir, '_unreviewed', RUN_ID, 'sql_select', 'atspl', `${keyHash(KEY)}.json`);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link);
    const result = await promote(await onlyItem('fixture'), { reviewer: 'r' });
    expect(result.status === 'refused' && result.reason).toBe('item is a symlink');
    expect(existsSync(real)).toBe(true);
  });

  test('refuses a file that fails the schema', async () => {
    const source = writeUnreviewed({ ...body(KEY), result: undefined });
    const result = await promote(await onlyItem('fixture'), { reviewer: 'r', check: PASS });
    expect(result.status === 'refused' && result.reason).toContain('fails the fixture schema at result');
    expect(existsSync(source)).toBe(true);
  });
});

describe('decline', () => {
  test('keeps a fixture and an eval draft in _unreviewed', async () => {
    const source = writeUnreviewed(body(KEY));
    const draft = writeDraft({ 'feedback.md': 'fine\n' });
    const items = await listUnreviewed(dirs);
    for (const item of items) expect(decline(item)).toEqual({ status: 'declined', type: item.type, path: item.path });
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(draft, 'feedback.md'))).toBe(true);
    expect(await listUnreviewed(dirs)).toHaveLength(2);
  });
});

describe('promote an eval case draft', () => {
  const FILES = {
    'feedback.md': '---\nverdict: correct\n---\nRoot cause: stale cache in the package service.\n',
    'report.json': JSON.stringify({ status: 'done', amount: 1500000 }),
    'fixtures/notes.txt': 'uses shared fixtures\n',
  };

  test('moves the folder to evals/cases/<case_id>/', async () => {
    const draft = writeDraft(FILES);
    const result = await promote(await onlyItem('eval_case'), { reviewer: 'reviewer-a', caseId: 'mpin-city' });
    const target = join(dirs.evalsDir, 'cases', 'mpin-city');
    expect(result).toEqual({ status: 'promoted', type: 'eval_case', from: draft, to: target });
    expect(existsSync(draft)).toBe(false);
    for (const [name, text] of Object.entries(FILES)) expect(readFileSync(join(target, name), 'utf8')).toBe(text);
  });

  test('uses the run id as the case id when none is given', async () => {
    writeDraft(FILES);
    const result = await promote(await onlyItem('eval_case'), { reviewer: 'reviewer-a' });
    expect(result.status === 'promoted' && result.to).toBe(join(dirs.evalsDir, 'cases', RUN_ID));
  });

  test('is refused when one file fails the check, and nothing moves', async () => {
    const draft = writeDraft({ ...FILES, 'feedback.md': 'Customer called from +91 98765 43210.\n' });
    const result = await promote(await onlyItem('eval_case'), { reviewer: 'reviewer-a', caseId: 'c1' });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('feedback.md: phone');
    expect(result.reason).not.toContain('report.json');
    expect(result.reason).not.toContain('98765');
    expect(result.patterns).toEqual(['phone']);
    expect(existsSync(join(draft, 'feedback.md'))).toBe(true);
    expect(existsSync(join(dirs.evalsDir, 'cases'))).toBe(false);
  });

  test('runs the check over every file', async () => {
    writeDraft(FILES);
    const seen: unknown[] = [];
    const check = (value: unknown): EgressResult => {
      seen.push(value);
      return { ok: true };
    };
    await promote(await onlyItem('eval_case'), { reviewer: 'r', caseId: 'c1', check });
    expect(seen).toHaveLength(3);
    // JSON files are checked as parsed values, so numbers are not read as digit runs.
    expect(seen).toContainEqual({ status: 'done', amount: 1500000 });
  });

  test('refuses a binary file or a symlink inside the draft', async () => {
    const draft = writeDraft(FILES);
    writeFileSync(join(draft, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    const binary = await promote(await onlyItem('eval_case'), { reviewer: 'r', caseId: 'c1', check: PASS });
    expect(binary.status === 'refused' && binary.reason).toContain('blob.bin: not a text file');

    rmSync(join(draft, 'blob.bin'));
    symlinkSync(join(dirs.evalsDir, 'x'), join(draft, 'link.md'));
    const linked = await promote(await onlyItem('eval_case'), { reviewer: 'r', caseId: 'c1', check: PASS });
    expect(linked.status === 'refused' && linked.reason).toContain('symlinks: link.md');
    expect(existsSync(draft)).toBe(true);
  });

  test('an existing case with different content is refused; the same content is a no-op', async () => {
    writeDraft(FILES);
    expect((await promote(await onlyItem('eval_case'), { reviewer: 'r', caseId: 'c1' })).status).toBe('promoted');

    const same = writeDraft(FILES);
    const again = await promote(await onlyItem('eval_case'), { reviewer: 'r', caseId: 'c1' });
    expect(again.status).toBe('unchanged');
    expect(existsSync(same)).toBe(false);

    const different = writeDraft({ ...FILES, 'feedback.md': 'another verdict\n' });
    const clash = await promote(await onlyItem('eval_case'), { reviewer: 'r', caseId: 'c1' });
    expect(clash.status === 'refused' && clash.reason).toBe('target case folder exists with different content');
    expect(existsSync(different)).toBe(true);
    expect(readFileSync(join(dirs.evalsDir, 'cases', 'c1', 'feedback.md'), 'utf8')).toBe(FILES['feedback.md']);
  });
});

describe('no subprocess', () => {
  test('listing, promoting and declining spawn nothing', async () => {
    const spy = spyOnSpawns();
    try {
      writeUnreviewed(body(KEY));
      writeUnreviewed(body({ ...KEY, params: ['****9999'] }));
      writeDraft({ 'feedback.md': 'ok\n' });
      const items = await listUnreviewed(dirs);
      for (const item of items) await promote(item, { reviewer: 'r', caseId: 'c1', now: NOW });
      for (const item of await listUnreviewed(dirs)) decline(item);
      expect(spy.calls()).toEqual([]);
    } finally {
      spy.restore();
    }
  });
});
