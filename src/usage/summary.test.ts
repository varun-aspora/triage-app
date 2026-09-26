import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { RunUsageViewSchema, type SubmissionUsage, type UsageRow } from '../types/usage.ts';
import { summariseUsage } from './summary.ts';

const T1 = '2026-09-26T10:00:00.000Z';
const T2 = '2026-09-26T10:05:00.000Z';

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    model: 'anthropic/claude-sonnet-4-5',
    agent: 'triage',
    purpose: 'agent',
    calls: 1,
    failed_calls: 0,
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    usd: 0.01,
    ...over,
  };
}

function sub(seq: number, rows: UsageRow[], over: Partial<SubmissionUsage> = {}): SubmissionUsage {
  return { seq, rows, updated_at: T1, final: true, ...over };
}

const RUNNING = { running: true } as const;
const SETTLED = { running: false } as const;

describe('summariseUsage', () => {
  test('adds up totals and breaks them down by model, agent and submission', () => {
    const view = summariseUsage(
      [
        sub(0, [row({ model: 'openrouter/typesafe/jev-1', agent: 'classifier', purpose: 'classify', input_tokens: 50, output_tokens: 5, usd: 0.001 })]),
        sub(1, [
          row({ calls: 3, failed_calls: 1, input_tokens: 300, output_tokens: 30, cache_read_tokens: 1000, cache_write_tokens: 200, usd: 0.02 }),
          row({ agent: 'investigate_ledger', input_tokens: 200, output_tokens: 20, usd: 0.03 }),
          row({ purpose: 'compaction', input_tokens: 400, output_tokens: 40, usd: 0.04 }),
        ]),
        sub(2, [row({ usd: 0.1 })], { updated_at: T2 }),
      ],
      SETTLED,
    );

    expect(view.recorded).toBe(true);
    const { usd, ...counts } = view.total;
    expect(usd).toBeCloseTo(0.191, 10);
    expect(counts).toEqual({
      calls: 7,
      failed_calls: 1,
      input_tokens: 1050,
      output_tokens: 105,
      cache_read_tokens: 1000,
      cache_write_tokens: 200,
      unpriced_models: [],
    });
    expect(Object.keys(view.by_model)).toEqual(['anthropic/claude-sonnet-4-5', 'openrouter/typesafe/jev-1']);
    expect(view.by_model['anthropic/claude-sonnet-4-5']?.calls).toBe(6);
    expect(view.by_model['openrouter/typesafe/jev-1']?.input_tokens).toBe(50);

    expect(Object.keys(view.by_agent)).toEqual(['classifier', 'investigate_ledger', 'triage']);
    // The root row and its compaction row share the agent.
    expect(view.by_agent.triage?.calls).toBe(5);
    expect(view.by_agent.triage?.input_tokens).toBe(800);
    expect(view.by_agent.investigate_ledger?.usd).toBeCloseTo(0.03, 10);

    expect(Object.keys(view.by_submission)).toEqual(['0', '1', '2']);
    expect(view.by_submission['0']?.calls).toBe(1);
    expect(view.by_submission['1']?.calls).toBe(5);
    expect(view.by_submission['1']?.cache_read_tokens).toBe(1000);
    expect(view.by_submission['2']?.usd).toBeCloseTo(0.1, 10);

    expect(view.pricing).toBe('full');
    expect(view.fake).toBe(false);
    expect(view.live).toBe(false);
    expect(view.incomplete).toBe(false);
    expect(view.updated_at).toBe(T2);
    expect(v.safeParse(RunUsageViewSchema, view).success).toBe(true);
  });

  test('orders submissions by seq whatever order they come in', () => {
    const view = summariseUsage([sub(10, [row()]), sub(2, [row()]), sub(0, [row()])], SETTLED);
    expect(Object.keys(view.by_submission)).toEqual(['0', '2', '10']);
  });

  test('pricing is full when every row has a price', () => {
    expect(summariseUsage([sub(1, [row(), row({ agent: 'synthesis' })])], SETTLED).pricing).toBe('full');
  });

  test('pricing is partial when some rows have no price, and names those models once', () => {
    const view = summariseUsage(
      [
        sub(0, [row({ model: 'openrouter/typesafe/jev-1', agent: 'classifier', purpose: 'classify', usd: null })]),
        sub(1, [
          row({ usd: 0.05 }),
          row({ model: 'ollama/qwen3', agent: 'investigate_ledger', usd: null }),
          row({ model: 'ollama/qwen3', agent: 'synthesis', usd: null }),
        ]),
      ],
      SETTLED,
    );
    expect(view.pricing).toBe('partial');
    expect(view.total.usd).toBeCloseTo(0.05, 10);
    expect(view.total.unpriced_models).toEqual(['ollama/qwen3', 'openrouter/typesafe/jev-1']);
    expect(view.by_model['anthropic/claude-sonnet-4-5']?.unpriced_models).toEqual([]);
    expect(view.by_model['ollama/qwen3']?.usd).toBe(0);
    expect(view.by_submission['0']?.unpriced_models).toEqual(['openrouter/typesafe/jev-1']);
    expect(view.by_submission['1']?.unpriced_models).toEqual(['ollama/qwen3']);
    expect(view.by_agent.triage?.unpriced_models).toEqual([]);
  });

  test('pricing is none when rows exist but none has a price', () => {
    const view = summariseUsage([sub(1, [row({ usd: null }), row({ agent: 'synthesis', usd: null })])], SETTLED);
    expect(view.recorded).toBe(true);
    expect(view.pricing).toBe('none');
    expect(view.total.usd).toBe(0);
    expect(view.total.unpriced_models).toEqual(['anthropic/claude-sonnet-4-5']);
  });

  test('a price of 0 counts as priced', () => {
    const view = summariseUsage([sub(1, [row({ model: 'ollama/qwen3', usd: 0 })])], SETTLED);
    expect(view.pricing).toBe('full');
    expect(view.total.unpriced_models).toEqual([]);
  });

  test('fake when every model is faux/*', () => {
    const faux = [sub(0, [row({ model: 'faux/classifier', agent: 'classifier', usd: 0 })]), sub(1, [row({ model: 'faux/cheap', usd: 0 })])];
    expect(summariseUsage(faux, SETTLED).fake).toBe(true);

    const mixed = [...faux, sub(2, [row()])];
    expect(summariseUsage(mixed, SETTLED).fake).toBe(false);
  });

  test('recorded is false with no submissions', () => {
    const view = summariseUsage([], SETTLED);
    expect(view).toEqual({
      recorded: false,
      total: {
        calls: 0,
        failed_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        usd: 0,
        unpriced_models: [],
      },
      by_model: {},
      by_agent: {},
      by_submission: {},
      pricing: 'full',
      fake: false,
      live: false,
      incomplete: false,
      updated_at: null,
    });
    expect(v.safeParse(RunUsageViewSchema, view).success).toBe(true);
  });

  test('recorded is false when submissions hold no rows', () => {
    const view = summariseUsage([sub(1, [], { final: false })], RUNNING);
    expect(view.recorded).toBe(false);
    expect(view.by_submission).toEqual({});
    expect(view.fake).toBe(false);
    // Still live: the run page shows "waiting for the first count".
    expect(view.live).toBe(true);
    expect(view.updated_at).toBe(T1);
  });

  test('live while running with a non-final submission', () => {
    const view = summariseUsage([sub(0, [row()]), sub(1, [row()], { final: false, updated_at: T2 })], RUNNING);
    expect(view.live).toBe(true);
    expect(view.incomplete).toBe(false);
    expect(view.updated_at).toBe(T2);
  });

  test('incomplete when a non-final submission is left on a run that is not running', () => {
    // Stalled (dead worker), failed, completed and stopped runs all reach here as running: false.
    const view = summariseUsage([sub(0, [row()]), sub(1, [row()], { final: false })], SETTLED);
    expect(view.live).toBe(false);
    expect(view.incomplete).toBe(true);
    expect(view.recorded).toBe(true);
  });

  test('neither live nor incomplete when every submission is final', () => {
    const usage = [sub(0, [row()]), sub(1, [row()])];
    for (const opts of [RUNNING, SETTLED]) {
      const view = summariseUsage(usage, opts);
      expect(view.live).toBe(false);
      expect(view.incomplete).toBe(false);
    }
  });

  test('updated_at compares instants, not strings', () => {
    const view = summariseUsage(
      [sub(1, [row()], { updated_at: '2026-09-26T12:00:00+05:30' }), sub(2, [row()], { updated_at: '2026-09-26T07:00:00Z' })],
      SETTLED,
    );
    expect(view.updated_at).toBe('2026-09-26T07:00:00Z');
  });

  test('does not change its input', () => {
    const usage = [sub(1, [row({ usd: null })], { final: false })];
    const before = structuredClone(usage);
    summariseUsage(usage, RUNNING);
    expect(usage).toEqual(before);
  });
});
