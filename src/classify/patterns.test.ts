import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadPatterns,
  loadPatternsFile,
  matchPattern,
  parsePatterns,
  PatternsLoadError,
  type Pattern,
} from './patterns.ts';

const FIXTURE = join(import.meta.dir, '__fixtures__', 'patterns.json');

const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'some-pattern',
  category: 'onboarding',
  signature: { regex: ['boom'], services: [] },
  entities: ['ssfb'],
  query_recipe: 'logs_search',
  tier_hint: 'cheap',
  stable: false,
  source_ref: 'fixture',
  ...over,
});

describe('loadPatterns', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test('loads the fixture file', async () => {
    const patterns = await loadPatternsFile(FIXTURE);
    expect(patterns.map((p) => p.id)).toEqual([
      'sim-binding-phone-mismatch',
      'neft-return-credited',
      'welcome-letter-vendor-fail',
      'remittance-order-out-of-reach',
    ]);
  });

  test('reads <knowledgeDir>/patterns/patterns.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'triage-patterns-'));
    dirs.push(dir);
    await mkdir(join(dir, 'patterns'));
    await writeFile(join(dir, 'patterns', 'patterns.json'), JSON.stringify([good()]));
    const patterns = await loadPatterns(dir);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.id).toBe('some-pattern');
  });

  test('a missing file rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'triage-patterns-'));
    dirs.push(dir);
    await expect(loadPatterns(dir)).rejects.toThrow();
  });

  test('invalid JSON is rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'triage-patterns-'));
    dirs.push(dir);
    await mkdir(join(dir, 'patterns'));
    await writeFile(join(dir, 'patterns', 'patterns.json'), '[{"id":');
    await expect(loadPatterns(dir)).rejects.toThrow(PatternsLoadError);
  });
});

describe('parsePatterns rejects invalid files', () => {
  const expectFail = (raw: unknown, ...fragments: string[]) => {
    let err: unknown;
    try {
      parsePatterns(raw);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PatternsLoadError);
    for (const f of fragments) expect((err as Error).message).toContain(f);
  };

  test('a missing field names the entry id', () => {
    const { stable: _drop, ...noStable } = good({ id: 'no-stable-flag' });
    expectFail([good(), noStable], '"no-stable-flag"', 'stable');
  });

  test('a missing signature.services names the entry id', () => {
    expectFail([good({ id: 'no-services', signature: { regex: ['x'] } })], '"no-services"', 'signature.services');
  });

  test('a bad regex names the entry id and the regex', () => {
    expectFail([good({ id: 'bad-regex', signature: { regex: ['ok', '(unclosed'], services: [] } })], '"bad-regex"', '(unclosed');
  });

  test('an empty regex list is rejected', () => {
    expectFail([good({ id: 'no-regex', signature: { regex: [], services: [] } })], '"no-regex"');
  });

  test('a missing id is reported by index', () => {
    const { id: _drop, ...noId } = good();
    expectFail([good(), noId], '#1');
  });

  test('a duplicate id is rejected', () => {
    expectFail([good({ id: 'dup' }), good({ id: 'dup' })], '"dup"', 'duplicate');
  });

  test('an unknown category, entity or tier is rejected', () => {
    expectFail([good({ id: 'bad-cat', category: 'weather' })], '"bad-cat"', 'category');
    expectFail([good({ id: 'bad-entity', entities: ['shivalik'] })], '"bad-entity"', 'entities');
    expectFail([good({ id: 'bad-tier', tier_hint: 'huge' })], '"bad-tier"', 'tier_hint');
  });

  test('stable must be a boolean', () => {
    expectFail([good({ id: 'str-stable', stable: 'true' })], '"str-stable"', 'stable');
  });

  test('an unexpected field is rejected', () => {
    expectFail([good({ id: 'typo', stabel: true })], '"typo"');
  });

  test('a non-kebab id is rejected', () => {
    expectFail([good({ id: 'Not_Kebab' })], '"Not_Kebab"', 'kebab');
  });

  test('a non-array top level is rejected', () => {
    expectFail({ patterns: [] }, 'array');
  });
});

describe('matchPattern', () => {
  let patterns: Pattern[] = [];
  beforeAll(async () => {
    patterns = await loadPatternsFile(FIXTURE);
  });

  test('signature regex match returns the id and stable flag', () => {
    const m = matchPattern('harbor: PHONE_NUMBER_MISMATCH on bind', ['ssfb:harbor'], 'onboarding', patterns);
    expect(m).toEqual({ matched_pattern_id: 'sim-binding-phone-mismatch', stable: true });
  });

  test('regexes match case-insensitively', () => {
    const m = matchPattern('SIM binding FAILED', ['ssfb:harbor'], 'onboarding', patterns);
    expect(m?.matched_pattern_id).toBe('sim-binding-phone-mismatch');
  });

  test('a non-stable pattern reports stable false', () => {
    const m = matchPattern('POST /appserver/v3/order returned 500', [], 'transfer_out', patterns);
    expect(m).toEqual({ matched_pattern_id: 'remittance-order-out-of-reach', stable: false });
  });

  test('service filter: a listed service is required when the pattern names services', () => {
    expect(matchPattern('PHONE_NUMBER_MISMATCH', ['ssfb:rhythm'], 'onboarding', patterns)).toBeNull();
    expect(matchPattern('PHONE_NUMBER_MISMATCH', [], 'onboarding', patterns)).toBeNull();
    expect(matchPattern('PHONE_NUMBER_MISMATCH', ['SSFB:Harbor'], 'onboarding', patterns)?.matched_pattern_id).toBe(
      'sim-binding-phone-mismatch',
    );
  });

  test('service filter: an empty service list matches any service', () => {
    const m = matchPattern('welcome letter failed at vendor', ['rtl:workflow'], 'delivery', patterns);
    expect(m?.matched_pattern_id).toBe('welcome-letter-vendor-fail');
  });

  test('category must match', () => {
    expect(matchPattern('PHONE_NUMBER_MISMATCH', ['ssfb:harbor'], 'auth', patterns)).toBeNull();
    expect(matchPattern('PHONE_NUMBER_MISMATCH', ['ssfb:harbor'], 'unknown', patterns)).toBeNull();
  });

  test('no match returns null', () => {
    expect(matchPattern('nothing interesting here', ['ssfb:harbor'], 'onboarding', patterns)).toBeNull();
    expect(matchPattern('PHONE_NUMBER_MISMATCH', ['ssfb:harbor'], 'onboarding', [])).toBeNull();
  });

  test('first match in file order wins', () => {
    const two = parsePatterns([
      good({ id: 'first', signature: { regex: ['boom'], services: [] } }),
      good({ id: 'second', signature: { regex: ['boom'], services: [] }, stable: true }),
    ]);
    expect(matchPattern('boom', [], 'onboarding', two)?.matched_pattern_id).toBe('first');
  });

  test('repeated calls give the same answer', () => {
    for (let i = 0; i < 3; i++) {
      expect(matchPattern('NEFT returned', ['ssfb:rhythm'], 'transfer_out', patterns)?.matched_pattern_id).toBe(
        'neft-return-credited',
      );
    }
  });
});
