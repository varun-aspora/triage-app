// Pattern note drafts from a reviewed eval case (D92). The case folder is
// written by hand in a temp dir; every id below is made up.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { checkEgress } from '../gate/redact.ts';
import sampleReport from '../report/__fixtures__/sample-report.json' with { type: 'json' };
import { buildPatternDraft, stripIds, TRIGGER_TODO } from './pattern-draft.ts';
import { parsePatterns } from './patterns.ts';

const CUSTOMER = sampleReport.id_chain.ids.customer_id;
const FORM = sampleReport.id_chain.ids.account_form_id;
const STRAY = '0f1e2d3c-4b5a-4968-8776-655443322110';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function caseDir(groundTruth: Record<string, string>, report: unknown = sampleReport): string {
  const dir = mkdtempSync(join(tmpdir(), 'pattern-draft-'));
  dirs.push(dir);
  const front = {
    id: 'run',
    type: 'resolved',
    input: { problem: `Card not dispatched for ${CUSTOMER}`, identifiers: { customer_id: CUSTOMER, account_form_id: FORM }, ref: 'none' },
    investigation: { root_cause: 'x', queries: [] },
    ground_truth: { verdict: 'wrong', ...groundTruth },
    captured_at: '2026-09-28T10:00:00.000Z',
  };
  writeFileSync(join(dir, 'feedback.md'), `---\n${stringifyYaml(front)}---\n\n## Feedback history\n`);
  if (report !== null) writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
  return dir;
}

describe('buildPatternDraft', () => {
  test('a case with a root cause and a faster path gives a schema-valid entry with the ids stripped', async () => {
    const dir = caseDir({
      actual_root_cause: `The form ${FORM} never reached harbor; request ${STRAY} failed with account 12345678.`,
      faster_path: `- sql_select on harbor account_forms for ${CUSTOMER}\n- logs_search on rtl app-server for the device id; then guardian attempts`,
    });
    const result = await buildPatternDraft(dir, 'Case_7.b');
    if (result.status !== 'draft') throw new Error(`expected a draft, got ${JSON.stringify(result)}`);
    const { pattern, problem } = result.draft;

    expect(parsePatterns([pattern])).toHaveLength(1);
    expect(checkEgress(result.draft).ok).toBe(true);
    const all = JSON.stringify(result.draft);
    for (const id of [CUSTOMER, FORM, STRAY, '12345678']) expect(all).not.toContain(id);

    expect(pattern).toMatchObject({
      id: 'reviewed-case-7-b',
      category: 'delivery',
      signature: { regex: [TRIGGER_TODO], services: [] },
      tier_hint: 'mid',
      stable: false,
      source_ref: 'evals/cases/Case_7.b',
      lesson: 'The form <account_form_id> never reached harbor; request <uuid> failed with account <id>.',
    });
    expect(pattern.first_queries).toEqual([
      { entity: 'ssfb', query: 'sql_select on harbor account_forms for <customer_id>' },
      { entity: 'rtl', query: 'logs_search on rtl app-server for the device id' },
      { entity: 'ssfb', query: 'then guardian attempts' },
    ]);
    expect(pattern.entities).toEqual(['ssfb', 'rtl']);
    expect(problem).toBe('Card not dispatched for <customer_id>');
  });

  test('no draft without both an actual root cause and a faster path', async () => {
    expect((await buildPatternDraft(caseDir({ actual_root_cause: 'x' }), 'c')).status).toBe('none');
    expect((await buildPatternDraft(caseDir({ faster_path: 'x' }), 'c')).status).toBe('none');
  });

  test('refused, with the reason, when the report is missing or its category is not one', async () => {
    const gt = { actual_root_cause: 'x', faster_path: 'y' };
    expect(await buildPatternDraft(caseDir(gt, null), 'c')).toEqual({ status: 'refused', reason: 'report.json is missing or not JSON' });
    const bad = { ...sampleReport, classification: { ...sampleReport.classification, proposed: { ...sampleReport.classification.proposed, category: 'nope' } } };
    const result = await buildPatternDraft(caseDir(gt, bad), 'c');
    expect(result.status).toBe('refused');
    expect(result.status === 'refused' && result.reason).toContain('category');
  });
});

describe('stripIds', () => {
  test('id chain values become <key>, and the longest value is replaced first', () => {
    expect(stripIds('ab12cd34 and ab12cd34ef', { short: 'ab12cd34', long: 'ab12cd34ef' })).toBe('<short> and <long>');
  });
});
