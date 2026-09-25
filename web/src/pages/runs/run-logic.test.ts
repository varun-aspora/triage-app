import { describe, expect, test } from 'bun:test';
import type { RunDetail, TierDecision } from '../../api/types.ts';
import {
  askPending,
  buildStartBody,
  costTotals,
  deriveInvestigators,
  formFieldOf,
  formatUsd,
  inferFailure,
  joinEntityLabels,
  type NewRunForm,
  newIdempotencyKey,
  permalinkHref,
  reportVersionLabel,
  runningSteps,
  sinceFor,
} from './run-logic.ts';

const baseForm: NewRunForm = {
  source: 'slack',
  slackUrl: ' https://acme.slack.com/archives/C1/p1727275322000100 ',
  pasted: '',
  requestedBy: ' Asha ',
  entitiesMode: 'auto',
  entities: [],
  tierMode: 'auto',
  tier: 'mid',
  ids: [],
  from: '',
  to: '',
};

const decision = (entities: TierDecision['proposed']['entities_likely']): TierDecision => ({
  proposed: {
    category: 'onboarding',
    subcategory: '',
    entities_likely: entities,
    current_ask: '',
    money_moved: false,
    misdirected_funds: false,
    tier_proposed: 'mid',
    confidence: 0.8,
    missing_info: [],
    images_seen: false,
  },
  tier_final: 'mid',
  rule_fired: 'default',
});

describe('sinceFor', () => {
  test('ranges', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    expect(sinceFor('24h', now)).toBe('2026-09-24T12:00:00.000Z');
    expect(sinceFor('7d', now)).toBe('2026-09-18T12:00:00.000Z');
    expect(sinceFor('any', now)).toBeUndefined();
  });
});

describe('buildStartBody', () => {
  test('auto leaves entities and tier out', () => {
    const r = buildStartBody(baseForm, 0);
    expect(r).toEqual({ ok: true, body: { slack_url: 'https://acme.slack.com/archives/C1/p1727275322000100', requested_by: 'Asha' } });
  });

  test('choose sends entities, tier, ids and the window', () => {
    const r = buildStartBody(
      {
        ...baseForm,
        entitiesMode: 'choose',
        entities: ['ssfb', 'rtl'],
        tierMode: 'choose',
        tier: 'strong',
        ids: [
          { key: 'user_id', value: ' u1 ' },
          { key: 'utr', value: '' },
        ],
        from: '2026-09-24T00:00',
        to: '2026-09-25T18:00',
      },
      0,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.entities).toEqual(['ssfb', 'rtl']);
    expect(r.body.tier).toBe('strong');
    expect(r.body.ids).toEqual({ user_id: 'u1' });
    expect(r.body.time_window?.from).toBe(new Date('2026-09-24T00:00').toISOString());
  });

  test('pasted text becomes one parent message with a Slack-style ts', () => {
    const r = buildStartBody({ ...baseForm, source: 'paste', pasted: ' hello \n there ' }, 1_727_275_322_123);
    expect(r).toEqual({
      ok: true,
      body: { messages: [{ ts: '1727275322.123000', author: 'pasted', text: 'hello \n there', is_parent: true }], requested_by: 'Asha' },
    });
  });

  test('local checks', () => {
    const r = buildStartBody(
      {
        ...baseForm,
        slackUrl: '',
        requestedBy: '',
        entitiesMode: 'choose',
        ids: [
          { key: 'utr', value: 'a' },
          { key: 'utr', value: 'b' },
        ],
        from: '2026-09-24T00:00',
      },
      0,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['entities', 'ids', 'requested_by', 'thread', 'time_window']);
    const reversed = buildStartBody({ ...baseForm, from: '2026-09-25T00:00', to: '2026-09-24T00:00' }, 0);
    expect(reversed.ok).toBe(false);
  });
});

test('formFieldOf maps server field paths', () => {
  expect(formFieldOf('messages.0.text')).toBe('thread');
  expect(formFieldOf('slack_url')).toBe('thread');
  expect(formFieldOf('ids.utr')).toBe('ids');
  expect(formFieldOf('time_window.from')).toBe('time_window');
  expect(formFieldOf('Idempotency-Key')).toBeUndefined();
});

test('newIdempotencyKey falls back to getRandomValues outside a secure context', () => {
  const key = newIdempotencyKey({ getRandomValues: <T extends ArrayBufferView | null>(a: T) => a });
  expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
});

test('joinEntityLabels', () => {
  expect(joinEntityLabels(['ssfb', 'atspl', 'rtl'])).toBe('SSFB, ATSPL and RTL');
  expect(joinEntityLabels(['rtl'])).toBe('RTL');
});

describe('inferFailure', () => {
  test('no classification: before classification', () => {
    const g = inferFailure({ classification: null, evidence: [] });
    expect(g.title).toBe('Failed before classification (preflight or identity)');
    expect(g.steps.preflight).toBe('failed');
    expect(g.steps.classifying).toBe('todo');
  });
  test('classified, no evidence', () => {
    const g = inferFailure({ classification: decision(['ssfb']), evidence: [] });
    expect(g.title).toBe('Failed after classification');
    expect(g.steps.classifying).toBe('done');
    expect(g.steps.dispatched).toBe('failed');
  });
  test('with evidence', () => {
    const g = inferFailure({ classification: decision(['ssfb']), evidence: [{ key: 'ssfb', version: 1 }] });
    expect(g.title).toBe('Failed while investigating');
    expect(g.steps.investigating).toBe('failed');
  });
});

describe('deriveInvestigators', () => {
  const run = (over: Partial<RunDetail>) =>
    ({ phase: 'investigating', classification: decision(['ssfb', 'rtl']), evidence: [], ...over }) as Pick<
      RunDetail,
      'phase' | 'classification' | 'evidence'
    >;

  test('evidence means findings in, the rest working, code waiting', () => {
    const rows = deriveInvestigators(run({ evidence: [{ key: 'ssfb', version: 2 }] }));
    expect(rows.map((r) => [r.label, r.state, r.detail])).toEqual([
      ['SSFB investigator', 'findings in', 'Version 2 stored'],
      ['RTL investigator', 'working', 'No findings stored yet'],
      ['Code walker', 'waiting', 'Starts when an investigator asks for code'],
    ]);
  });

  test('an entity with evidence that the classifier did not expect is still listed', () => {
    const rows = deriveInvestigators(run({ classification: decision([]), evidence: [{ key: 'atspl', version: 1 }, { key: 'code', version: 1 }] }));
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      ['atspl', 'findings in'],
      ['code', 'findings in'],
    ]);
  });

  test('before dispatch everything waits; nothing classified means no rows', () => {
    expect(deriveInvestigators(run({ phase: 'classifying' }))[0]?.state).toBe('waiting');
    expect(deriveInvestigators(run({ phase: 'identity', classification: null }))).toEqual([]);
  });
});

test('runningSteps', () => {
  expect(runningSteps('created').preflight).toBe('current');
  const s = runningSteps('investigating');
  expect([s.preflight, s.dispatched, s.investigating, s.completed]).toEqual(['done', 'done', 'current', 'todo']);
});

test('permalinkHref only links unmasked https links', () => {
  expect(permalinkHref('https://acme.slack.com/archives/C1/p1727275322000100')).toBe('https://acme.slack.com/archives/C1/p1727275322000100');
  expect(permalinkHref('https://acme.slack.com/archives/C1/p17272******00100')).toBeUndefined();
  expect(permalinkHref('javascript:alert(1)')).toBeUndefined();
  expect(permalinkHref(undefined)).toBeUndefined();
});

test('reportVersionLabel', () => {
  const s = (seq: number, has: boolean) => ({ seq, kind: 'ask' as const, created_at: '', has_report: has });
  expect(reportVersionLabel([s(1, true), s(2, true)])).toBe('Report v2 of 2');
  expect(reportVersionLabel([s(1, true), s(2, false)])).toBe('Report v1 of 2');
  expect(reportVersionLabel([s(1, false)])).toBeUndefined();
});

test('askPending waits for a newer submission with a report', () => {
  const s = (seq: number, has: boolean) => ({ seq, kind: 'ask' as const, created_at: '', has_report: has });
  expect(askPending([s(1, true)], 1)).toBe(true);
  expect(askPending([s(1, true), s(2, false)], 1)).toBe(true);
  expect(askPending([s(1, true), s(2, true)], 1)).toBe(false);
});

test('cost helpers', () => {
  expect(
    costTotals({ a: { calls: 2, input_tokens: 100, output_tokens: 10 }, b: { calls: 1, input_tokens: 50, output_tokens: 5 } }),
  ).toEqual({ calls: 3, input: 150, output: 15 });
  expect(formatUsd(undefined)).toBe('—');
  expect(formatUsd(0.4231)).toBe('$0.42');
  expect(formatUsd(0.001)).toBe('<$0.01');
});
