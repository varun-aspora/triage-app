// The usage parts of the --json shapes (D59): the strict UsageViewSchema, and
// usage on status, wait and usage. All values are synthetic.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { SubmissionUsage, UsageRow } from '../../types/usage.ts';
import { summariseUsage } from '../../usage/summary.ts';
import { StatusOutputSchema, UsageOutputSchema, UsageViewSchema, WaitOutputSchema } from './output-schemas.ts';

const RUN_ID = '01J8ZQ7XK3PSEUDRUNAAAAAAAA';

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    model: 'anthropic/claude-sonnet-4-5',
    agent: 'triage',
    purpose: 'agent',
    calls: 2,
    failed_calls: 0,
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 3000,
    cache_write_tokens: 100,
    usd: 0.02,
    ...over,
  };
}

function submission(seq: number, rows: readonly UsageRow[], final = true): SubmissionUsage {
  return { seq, rows: [...rows], updated_at: '2026-09-20T10:00:00.000Z', final };
}

const full = summariseUsage(
  [submission(0, [row({ agent: 'classifier', purpose: 'classify', model: 'anthropic/claude-haiku-4-5-20251001' })]), submission(1, [row()])],
  { running: false },
);
const partial = summariseUsage([submission(1, [row(), row({ model: 'typesafe/jev-1', agent: 'synthesis', usd: null })], false)], {
  running: true,
});
const none = summariseUsage([], { running: false });

describe('UsageViewSchema', () => {
  test('accepts what summariseUsage builds: full rows, non-final rows and nothing recorded', () => {
    for (const view of [full, partial, none]) expect(v.is(UsageViewSchema, view)).toBe(true);
    expect(partial.live).toBe(true);
    expect(none.recorded).toBe(false);
  });

  test('refuses an extra key at the top and inside a totals bucket', () => {
    expect(v.is(UsageViewSchema, { ...full, cost: 1 })).toBe(false);
    expect(v.is(UsageViewSchema, { ...full, total: { ...full.total, requests: 1 } })).toBe(false);
    const model = Object.keys(full.by_model)[0] as string;
    expect(v.is(UsageViewSchema, { ...full, by_model: { [model]: { ...full.by_model[model], note: 'x' } } })).toBe(false);
  });

  test('breakdown keys are checked like the rows they come from', () => {
    const t = full.total;
    expect(v.is(UsageViewSchema, { ...full, by_model: { 'not a spec': t } })).toBe(false);
    expect(v.is(UsageViewSchema, { ...full, by_agent: { 'ops@example.com': t } })).toBe(false);
    expect(v.is(UsageViewSchema, { ...full, by_submission: { first: t } })).toBe(false);
    expect(v.is(UsageViewSchema, { ...full, by_submission: { '-1': t } })).toBe(false);
    expect(v.is(UsageViewSchema, { ...full, by_submission: { '0': t, '12': t } })).toBe(true);
  });

  test('refuses negative or fractional counts and a masked model id', () => {
    expect(v.is(UsageViewSchema, { ...full, total: { ...full.total, calls: -1 } })).toBe(false);
    expect(v.is(UsageViewSchema, { ...full, total: { ...full.total, input_tokens: 1.5 } })).toBe(false);
    expect(v.is(UsageViewSchema, { ...full, total: { ...full.total, unpriced_models: ['anthropic/claude-haiku-4-5-****1001'] } })).toBe(false);
  });
});

describe('usage on the command shapes', () => {
  const status = { run_id: RUN_ID, status: 'completed', phase: 'completed', tier_final: 'mid', submissions: 1, preflight_warnings: [] };

  test('status and wait validate with usage missing (a run from before D59), non-final and full', () => {
    expect(v.is(StatusOutputSchema, status)).toBe(true);
    expect(v.is(StatusOutputSchema, { ...status, usage: partial })).toBe(true);
    expect(v.is(StatusOutputSchema, { ...status, usage: full })).toBe(true);
    const wait = { run_id: RUN_ID, status: 'timeout', phase: 'investigating' };
    expect(v.is(WaitOutputSchema, wait)).toBe(true);
    expect(v.is(WaitOutputSchema, { ...wait, usage: partial })).toBe(true);
    expect(v.is(WaitOutputSchema, { ...wait, usage: full })).toBe(true);
  });

  test('a loose usage object is refused inside status and wait', () => {
    expect(v.is(StatusOutputSchema, { ...status, usage: { ...full, extra: true } })).toBe(false);
    expect(v.is(WaitOutputSchema, { run_id: RUN_ID, status: 'completed', usage: { recorded: true } })).toBe(false);
  });

  test('usage --json always carries the view', () => {
    expect(v.is(UsageOutputSchema, { run_id: RUN_ID, status: 'completed', usage: none })).toBe(true);
    expect(v.is(UsageOutputSchema, { run_id: RUN_ID, status: 'running', usage: partial })).toBe(true);
    expect(v.is(UsageOutputSchema, { run_id: RUN_ID, status: 'completed' })).toBe(false);
    expect(v.is(UsageOutputSchema, { run_id: RUN_ID, status: 'timeout', usage: none })).toBe(false);
  });
});
