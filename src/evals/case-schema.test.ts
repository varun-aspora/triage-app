import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';

import { applyTierPolicy } from '../classify/policy.ts';
import { checkEgress } from '../gate/redact.ts';
import { CATEGORIES } from '../types/classification.ts';
import {
  CASE_FILE,
  CaseLoadError,
  CaseSchema,
  TAXONOMY_VERSION,
  loadCases,
  parseCase,
  parseCaseYaml,
  policyContextFor,
  threadTexts,
  toIdChain,
  type EvalCase,
} from './case-schema.ts';
import { validateCaseIds } from './pseudonym.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CASES_DIR = join(ROOT, 'evals', 'cases');
const CATEGORY_IDS: string[] = (
  JSON.parse(readFileSync(join(ROOT, 'knowledge', 'classifier', 'categories.json'), 'utf8')) as { id: string }[]
).map((c) => c.id);

const UUID_A = '11111111-2222-4333-8444-555555555555';

function minimalCase(): Record<string, unknown> {
  return {
    id: 'syn-test',
    taxonomy_version: TAXONOMY_VERSION,
    label_source: 'synthetic',
    request: { text: `User ${UUID_A} cannot log in.` },
    ids: { aspora_user_id: UUID_A },
    id_chain: { ids: { aspora_user_id: UUID_A }, hops: [] },
    basic_state: [{ item: 'customer.state', value: 'ACTIVE', taken_at: '2026-09-01T00:00:00.000Z', source: 'ssfb:harbor' }],
    expected: { category: 'auth', tier: 'mid' },
    provenance: { origin: 'synthetic' },
  };
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cases-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('CaseSchema', () => {
  test('accepts a minimal case', () => {
    expect(parseCase(minimalCase()).ok).toBe(true);
  });

  test('rejects a case without taxonomy_version', () => {
    const c = minimalCase();
    delete c.taxonomy_version;
    const r = parseCase(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.startsWith('taxonomy_version'))).toBe(true);
  });

  test('rejects a basic_state item without taken_at', () => {
    const c = minimalCase();
    c.basic_state = [{ item: 'customer.state', value: 'ACTIVE', source: 'ssfb:harbor' }];
    const r = parseCase(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.startsWith('basic_state.0.taken_at'))).toBe(true);
  });

  test('rejects an expected.tier outside cheap|mid|strong', () => {
    const c = minimalCase();
    c.expected = { category: 'auth', tier: 'premium' };
    const r = parseCase(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.startsWith('expected.tier'))).toBe(true);
  });

  test('rejects a category outside the taxonomy', () => {
    const c = minimalCase();
    c.expected = { category: 'loans', tier: 'mid' };
    expect(parseCase(c).ok).toBe(false);
  });

  test('rejects an unknown label_source and unknown fields', () => {
    expect(parseCase({ ...minimalCase(), label_source: 'guess' }).ok).toBe(false);
    expect(parseCase({ ...minimalCase(), notes: 'stray' }).ok).toBe(false);
    expect(parseCase({ ...minimalCase(), expected: { category: 'auth', tier: 'mid', teir: 'x' } }).ok).toBe(false);
  });

  test('rejects a request with both or neither of messages and text, or empty messages', () => {
    expect(parseCase({ ...minimalCase(), request: {} }).ok).toBe(false);
    expect(parseCase({ ...minimalCase(), request: { messages: [] } }).ok).toBe(false);
    expect(
      parseCase({
        ...minimalCase(),
        request: { text: 'x', messages: [{ ts: '1', author: 'a', text: 'x', is_parent: true }] },
      }).ok,
    ).toBe(false);
  });

  test('synthetic label_source requires synthetic origin, and the other way round', () => {
    expect(parseCase({ ...minimalCase(), provenance: { origin: 'run' } }).ok).toBe(false);
    expect(parseCase({ ...minimalCase(), label_source: 'verified' }).ok).toBe(false);
    expect(parseCase({ ...minimalCase(), label_source: 'verified', provenance: { origin: 'run' } }).ok).toBe(true);
  });

  test('problems name paths, never the received value', () => {
    const c = minimalCase();
    c.expected = { category: 'secret-value-123', tier: 'mid' };
    const r = parseCase(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join('\n')).not.toContain('secret-value-123');
  });

  test('toIdChain and threadTexts', () => {
    const c = v.parse(CaseSchema, minimalCase());
    expect(toIdChain(c)).toEqual({ ids: { aspora_user_id: UUID_A }, hops: [], basic_state: c.basic_state });
    expect(threadTexts(c)).toEqual([`User ${UUID_A} cannot log in.`]);
  });
});

describe('parseCaseYaml', () => {
  test('a YAML syntax error is reported by position, not content', () => {
    const r = parseCaseYaml('id: [unclosed\nsecret: hunter2-value');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems[0]).toStartWith('yaml:');
      expect(r.problems.join('')).not.toContain('hunter2');
    }
  });

  test('duplicate keys are refused', () => {
    const r = parseCaseYaml('id: a\nid: b\n');
    expect(r.ok).toBe(false);
  });

  test('an unquoted numeric ts is refused rather than coerced', () => {
    const yaml = [
      'id: syn-test',
      `taxonomy_version: ${TAXONOMY_VERSION}`,
      'label_source: synthetic',
      'request:',
      '  messages:',
      '    - {ts: 1788775200.0001, author: a, text: hi, is_parent: true}',
      'ids: {}',
      'id_chain: {ids: {}, hops: []}',
      'basic_state: []',
      'expected: {category: auth, tier: mid}',
      'provenance: {origin: synthetic}',
    ].join('\n');
    const r = parseCaseYaml(yaml);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.startsWith('request.messages.0.ts'))).toBe(true);
  });
});

describe('loadCases', () => {
  function writeCase(dir: string, name: string, body: string): void {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, CASE_FILE), body);
  }

  test('loads cases sorted by id and skips _ and . directories and loose files', async () => {
    const dir = tmp();
    const c = minimalCase();
    writeCase(dir, 'syn-b', JSON.stringify({ ...c, id: 'syn-b' }));
    writeCase(dir, 'syn-a', JSON.stringify({ ...c, id: 'syn-a' }));
    writeCase(dir, '_unreviewed', 'not: [valid');
    writeCase(dir, '.hidden', 'not: [valid');
    mkdirSync(join(dir, 'empty-dir'));
    writeFileSync(join(dir, 'README.md'), 'notes');
    const loaded = await loadCases(dir);
    expect(loaded.map((l) => l.case.id)).toEqual(['syn-a', 'syn-b']);
  });

  test('refuses a case whose id does not match its directory', async () => {
    const dir = tmp();
    writeCase(dir, 'syn-a', JSON.stringify({ ...minimalCase(), id: 'syn-other' }));
    await expect(loadCases(dir)).rejects.toBeInstanceOf(CaseLoadError);
  });

  test('refuses an invalid case, naming the file', async () => {
    const dir = tmp();
    const c = minimalCase();
    delete c.taxonomy_version;
    writeCase(dir, 'syn-test', JSON.stringify(c));
    const err = await loadCases(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseLoadError);
    expect((err as CaseLoadError).file).toEndWith(join('syn-test', CASE_FILE));
  });

  test('refuses a missing directory', async () => {
    await expect(loadCases(join(tmp(), 'nope'))).rejects.toBeInstanceOf(CaseLoadError);
  });
});

// Loaded at module level: bun does not await an async describe body.
const loaded = await loadCases(CASES_DIR);
const synthetic = loaded.filter((l) => l.case.id.startsWith('syn-'));

describe('committed cases under evals/cases', () => {
  test('there are six synthetic cases', () => {
    expect(synthetic).toHaveLength(6);
  });

  test.each(loaded.map((l) => [l.case.id, l.case] as [string, EvalCase]))('%s passes validateCaseIds', (_id, c) => {
    expect(validateCaseIds(c)).toEqual({ ok: true });
  });

  test('synthetic cases carry the current taxonomy_version and T12 categories', () => {
    for (const { case: c } of synthetic) {
      expect(c.taxonomy_version).toBe(TAXONOMY_VERSION);
      expect(c.label_source).toBe('synthetic');
      expect(CATEGORY_IDS).toContain(c.expected.category);
      if (c.faux_classification) expect(CATEGORY_IDS).toContain(c.faux_classification.category);
    }
    // The T12 list and the schema enum agree, so the check above is the same either way.
    expect([...CATEGORY_IDS].sort()).toEqual([...CATEGORIES].sort());
  });

  test('every synthetic case has a faux_classification whose policy result is the expected tier', () => {
    for (const { case: c } of synthetic) {
      expect(c.faux_classification).toBeDefined();
      const result = applyTierPolicy(c.faux_classification, policyContextFor(c));
      expect({ id: c.id, tier: result.tier_final }).toEqual({ id: c.id, tier: c.expected.tier });
      expect(result.classification.category).toBe(c.expected.category);
      if (c.expected.money_moved !== undefined) expect(c.faux_classification?.money_moved).toBe(c.expected.money_moved);
    }
  });

  test('the synthetic cases cover each tier-policy branch', () => {
    const fired = new Set<string>(
      synthetic.map(({ case: c }) => applyTierPolicy(c.faux_classification, policyContextFor(c)).rule_fired),
    );
    for (const rule of [
      'rule_1_invalid_or_unknown',
      'rule_2_high_risk_category',
      'rule_3_low_confidence',
      'rule_4_money_moved',
      'rule_5_stable_pattern',
      'rule_6_images',
    ]) {
      expect(fired).toContain(rule);
    }
  });

  test('synthetic cases hold no hostnames, URLs, emails or names the persisted check finds', () => {
    for (const { file, case: c } of synthetic) {
      const raw = readFileSync(file, 'utf8');
      expect(raw).not.toMatch(/https?:\/\//);
      expect(raw).not.toMatch(/@/);
      expect(raw).not.toMatch(/\b[a-z0-9-]+\.(?:local|internal|com|in|net|io|org|cloud)\b/i);
      // Phones and long digit runs are expected: they are pseudonymous ids.
      const egress = checkEgress(c);
      const unmasked = egress.ok ? [] : egress.unmasked;
      expect(unmasked.filter((p) => p !== 'phone' && p !== 'digits6')).toEqual([]);
      const authors = (c.request.messages ?? []).map((m) => m.author);
      for (const a of authors) expect(['triage-bot', 'cx-agent', 'ops-oncall']).toContain(a);
    }
  });
});
