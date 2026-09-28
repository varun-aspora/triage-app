// The SIM eval case (docs/11 §5, D94): its case file and fixtures are
// well-formed, agree with each other, and hold no id outside the placeholder
// shape. The scripted run over them is
// test/contract/sim/sim-binding.contract.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyTierPolicy } from '../classify/policy.ts';
import { extractIdShaped } from '../gate/id-patterns.ts';
import { createFixtureStore } from '../mock/store.ts';
import type { Fixture } from '../mock/types.ts';
import { CASE_FILE, loadCases, policyContextFor } from './case-schema.ts';
import { validateCaseIds } from './pseudonym.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CASE_ID = 'sim-binding-stuck';
const CASE_DIR = join(ROOT, 'evals', 'cases', CASE_ID);

// Loaded at module level: bun does not await an async describe body.
const loaded = (await loadCases(join(ROOT, 'evals', 'cases'))).find((l) => l.case.id === CASE_ID);
if (loaded === undefined) throw new Error(`${CASE_ID} is missing`);
const c = loaded.case;
const store = createFixtureStore({ fixturesDir: join(ROOT, 'fixtures'), caseId: CASE_ID });
// list() checks every file against the schema, its name and its folder.
const entries = (await store.list()).filter((e) => e.scope === 'case');
const fixtures: Fixture[] = entries.map((e) => JSON.parse(readFileSync(e.path, 'utf8')) as Fixture);

// Every id in the case is a made-up UUID of this shape: <8 hex>-0000-4000-8000-0000000000NN.
const PLACEHOLDER = /^[0-9a-f]{8}-0000-4000-8000-0{10}\d{2}$/;
const DEVICE = 'de71ce00-0000-4000-8000-000000000002';
const PART_1 = '2026-09-07T10:03:57.000Z';

const rowsOf = (f: Fixture | undefined) => ((f?.result ?? {}) as { rows?: Record<string, unknown>[] }).rows ?? [];
const find = (kind: string, entity: string, table: string) =>
  fixtures.find((f) => f.kind === kind && f.entity === entity && JSON.stringify(f.key).includes(table));

describe('sim-binding-stuck case', () => {
  test('is a run case labelled from triager findings, with usable ids and the expected tier', () => {
    expect(c.label_source).toBe('triager_findings');
    expect(c.provenance.origin).toBe('run');
    expect(validateCaseIds(c)).toEqual({ ok: true });
    const result = applyTierPolicy(c.faux_classification, policyContextFor(c));
    expect(result.tier_final).toBe(c.expected.tier);
    expect(result.classification.category).toBe(c.expected.category);
  });

  test('the fixtures sit in the case folder the store serves, one per planned query', () => {
    expect(entries.map((e) => `${e.kind}/${e.entity}`).sort()).toEqual([
      'logs_search/rtl',
      'logs_search/ssfb',
      'logs_search/ssfb',
      'logs_search/ssfb',
      'sql_select/rtl',
      'sql_select/ssfb',
      'sql_select/ssfb',
      'sql_select/ssfb',
      'sql_select/ssfb',
    ]);
    expect(fixtures.every((f) => f.meta.source === 'hand')).toBe(true);
  });

  test('the fixtures agree with the expected answer', () => {
    const attempts = rowsOf(find('sql_select', 'ssfb', 'device_auth_attempts'));
    expect(attempts).toHaveLength(17);
    expect(attempts.every((a) => a.device_id === DEVICE && a.status === 'PENDING' && a.sim_country_code === 0)).toBe(true);
    expect(attempts.reduce((sum, a) => sum + (a.polling_attempts as number), 0)).toBe(145);
    // The 5-per-24h registration limit: five attempts on the first day.
    expect(attempts.filter((a) => String(a.created_at).startsWith('2026-09-07'))).toHaveLength(5);

    const rtlHits = ((find('logs_search', 'rtl', 'appserver')?.result ?? {}) as { hits?: Record<string, unknown>[] }).hits ?? [];
    expect(rtlHits.length).toBeGreaterThan(0);
    expect(rtlHits.every((h) => h['x-device-id'] === DEVICE)).toBe(true);

    const part1 = rowsOf(find('sql_select', 'rtl', 'workflow_executions')).find((row) => row.status === 'COMPLETED');
    expect(Date.parse(String(part1?.updated_at))).toBe(Date.parse(PART_1));

    const polls = find('logs_search', 'ssfb', 'checking verification status')?.result as { num_hits: number };
    expect(polls.num_hits).toBe(145);
    expect((find('logs_search', 'ssfb', 'Processing Twilio callback')?.result as { num_hits: number }).num_hits).toBe(0);
    expect((find('logs_search', 'ssfb', 'twilio/sms')?.result as { count: number }).count).toBe(0);
    // Empty for a user who never verified, and expected before VERIFIED.
    expect(rowsOf(find('sql_select', 'ssfb', 'refresh_tokens'))).toEqual([]);
    expect(rowsOf(find('sql_select', 'ssfb', 'account_forms'))).toEqual([]);
  });

  test('the case and fixtures hold no id outside the placeholder shape, and no phone, email or long number', () => {
    const texts = [readFileSync(join(CASE_DIR, CASE_FILE), 'utf8')];
    const found = [...texts.flatMap((t) => extractIdShaped(t)), ...fixtures.flatMap((f) => extractIdShaped([f.key, f.result]))];
    // The provenance ref is the rejected run's id, which has no id shape.
    expect(found.filter((id) => id.kind !== 'uuid').map((id) => id.kind)).toEqual([]);
    expect([...new Set(found.map((id) => id.normalised))].filter((id) => !PLACEHOLDER.test(id))).toEqual([]);
    expect(found.length).toBeGreaterThan(0);
  });
});
