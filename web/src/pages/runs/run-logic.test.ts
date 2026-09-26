import { describe, expect, test } from 'bun:test';
import type { RunDetail, RunRequest, RunUsageView, TierDecision, UsageTotals } from '../../api/types.ts';
import {
  blockedSteps,
  buildStartBody,
  deriveInvestigators,
  followUpPending,
  formatCalls,
  formatCost,
  formFieldOf,
  formatTokenSplit,
  formatUsd,
  inferFailure,
  isLongText,
  joinEntityLabels,
  listCost,
  MAX_CONTEXT,
  type NewRunForm,
  newIdempotencyKey,
  PASTED_AUTHOR,
  permalinkHref,
  reportVersionLabel,
  requestSourceLine,
  runningSteps,
  runTitle,
  sinceFor,
  splitLead,
  submissionCost,
  usageLines,
  usageNotes,
} from './run-logic.ts';

const baseForm: NewRunForm = {
  source: 'slack',
  slackUrl: ' https://acme.slack.com/archives/C1/p1727275322000100 ',
  pasted: '',
  context: '',
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
    money_moved: false,
    misdirected_funds: false,
    tier_proposed: 'mid',
    confidence: 0.8,
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

  test('context is sent trimmed with either source, and left out when blank', () => {
    const slack = buildStartBody({ ...baseForm, context: '  checked KYC  ' }, 0);
    expect(slack.ok && slack.body.context).toBe('checked KYC');
    const paste = buildStartBody({ ...baseForm, source: 'paste', pasted: 'stuck', context: 'checked KYC' }, 0);
    expect(paste.ok && paste.body.context).toBe('checked KYC');
    const blank = buildStartBody({ ...baseForm, context: '   ' }, 0);
    expect(blank.ok && 'context' in blank.body).toBe(false);
  });

  test('context over the limit is flagged', () => {
    const r = buildStartBody({ ...baseForm, context: 'x'.repeat(MAX_CONTEXT + 1) }, 0);
    expect(r.ok ? undefined : r.errors.context).toBeDefined();
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
          { key: 'aspora_user_id', value: ' u1 ' },
          { key: 'account_number', value: '' },
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
    expect(r.body.ids).toEqual({ aspora_user_id: 'u1' });
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
          { key: 'account_number', value: 'a' },
          { key: 'account_number', value: 'b' },
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
  expect(formFieldOf('ids.account_number')).toBe('ids');
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

test('blockedSteps parks on investigating', () => {
  const s = blockedSteps();
  expect([s.preflight, s.dispatched, s.investigating, s.completed]).toEqual(['done', 'done', 'waiting', 'todo']);
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

test('followUpPending waits for the newer submission, then for the run to settle', () => {
  const s = (seq: number, has: boolean) => ({ seq, kind: 'ask' as const, created_at: '', has_report: has });
  expect(followUpPending({ status: 'completed', submissions: [s(1, true)] }, 1)).toBe(true);
  expect(followUpPending({ status: 'running', submissions: [s(1, true), s(2, false)] }, 1)).toBe(true);
  expect(followUpPending({ status: 'completed', submissions: [s(1, true), s(2, true)] }, 1)).toBe(false);
  // A resume that blocked again, or a follow-up that failed or was stopped, settled without a report.
  expect(followUpPending({ status: 'blocked', submissions: [s(1, true), s(2, false)] }, 1)).toBe(false);
  expect(followUpPending({ status: 'failed', submissions: [s(1, true), s(2, false)] }, 1)).toBe(false);
  expect(followUpPending({ status: 'stopped', submissions: [s(1, true), s(2, false)] }, 1)).toBe(false);
});

test('formatUsd', () => {
  expect(formatUsd(undefined)).toBe('—');
  expect(formatUsd(0)).toBe('$0.00');
  expect(formatUsd(0.4231)).toBe('$0.42');
  expect(formatUsd(0.001)).toBe('<$0.01');
});

describe('usage (D59)', () => {
  const NOW = Date.parse('2026-09-26T10:00:10.000Z');
  const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
    calls: 4,
    failed_calls: 0,
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_tokens: 4000,
    cache_write_tokens: 500,
    usd: 0.42,
    unpriced_models: [],
    ...over,
  });
  const view = (over: Partial<RunUsageView> = {}): RunUsageView => ({
    recorded: true,
    total: totals(),
    by_model: { 'anthropic/claude-haiku-4-5-20251001': totals() },
    by_agent: { triage: totals() },
    by_submission: { '1': totals() },
    pricing: 'full',
    fake: false,
    live: false,
    incomplete: false,
    updated_at: '2026-09-26T10:00:06.000Z',
    ...over,
  });
  const texts = (u: RunUsageView | undefined, running = false) => usageNotes(u, running, NOW).map((n) => n.text);

  test('not recorded, or waiting while the run is running', () => {
    expect(texts(undefined)).toEqual(['not recorded']);
    expect(texts(view({ recorded: false }))).toEqual(['not recorded']);
    expect(texts(view({ recorded: false }), true)).toEqual(['waiting for the first count']);
    expect(texts(undefined, true)).toEqual(['waiting for the first count']);
  });

  test('a fully priced, final run has no labels', () => {
    expect(texts(view())).toEqual([]);
  });

  test('partial and no pricing name the unpriced models', () => {
    const unpriced = totals({ unpriced_models: ['openai/text-embedding-3-small', 'typesafe/jev-1'] });
    expect(texts(view({ pricing: 'partial', total: unpriced }))).toEqual(['partial: no pricing for openai/text-embedding-3-small, typesafe/jev-1']);
    expect(texts(view({ pricing: 'none', total: { ...unpriced, usd: 0 } }))).toEqual(['no pricing for openai/text-embedding-3-small, typesafe/jev-1']);
  });

  test('fake, incomplete and live labels', () => {
    expect(texts(view({ fake: true }))).toEqual(['estimates, fake model']);
    expect(texts(view({ incomplete: true }))).toEqual(['incomplete: the worker ended before the final count']);
    expect(texts(view({ live: true }), true)).toEqual(['live, updated 4s ago']);
    expect(texts(view({ live: true, updated_at: null }), true)).toEqual(['live']);
    expect(usageNotes(view({ incomplete: true }), false, NOW)[0]?.look.tone).toBe('amber');
  });

  test('formatCost reads the run pricing, or the bucket unpriced list', () => {
    expect(formatCost(totals(), 'full')).toBe('$0.42');
    expect(formatCost(totals(), 'partial')).toBe('$0.42 (partial)');
    expect(formatCost(totals({ usd: 0 }), 'none')).toBe('not priced');
    expect(formatCost(totals())).toBe('$0.42');
    expect(formatCost(totals({ unpriced_models: ['typesafe/jev-1'] }))).toBe('$0.42 (partial)');
    expect(formatCost(totals({ usd: 0, unpriced_models: ['typesafe/jev-1'] }))).toBe('not priced');
    expect(formatCost(totals({ usd: 0 }))).toBe('$0.00');
  });

  test('calls and the token split', () => {
    expect(formatCalls(totals())).toBe('4');
    expect(formatCalls(totals({ failed_calls: 1 }))).toBe('4 (1 failed)');
    expect(formatTokenSplit(totals({ input_tokens: 120_000, cache_read_tokens: 90_000, cache_write_tokens: 4000, output_tokens: 8000 }))).toBe(
      '120k in / 90k cache read / 4k cache write / 8k out',
    );
  });

  test('usageLines: most expensive first, then most tokens, then by name', () => {
    const u = view({
      by_agent: {
        classifier: totals({ usd: 0.01 }),
        embedder: totals({ usd: 0, input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }),
        synthesis: totals({ usd: 0.01, output_tokens: 900 }),
        triage: totals({ usd: 0.3 }),
      },
    });
    expect(usageLines(u, 'agent').map((l) => l.key)).toEqual(['triage', 'synthesis', 'classifier', 'embedder']);
    expect(usageLines(u, 'model').map((l) => l.key)).toEqual(['anthropic/claude-haiku-4-5-20251001']);
  });

  test('submissionCost: intake and submissions, a dash when nothing was counted', () => {
    const u = view({ by_submission: { '0': totals({ usd: 0.01 }), '1': totals({ unpriced_models: ['typesafe/jev-1'] }) } });
    expect(submissionCost(u, 0)).toBe('$0.01');
    expect(submissionCost(u, 1)).toBe('$0.42 (partial)');
    expect(submissionCost(u, 2)).toBe('—');
    expect(submissionCost(undefined, 1)).toBe('—');
  });

  test('listCost: the priced total, partial, not priced, not recorded, and live for a running run', () => {
    expect(listCost({ phase: 'completed', usd_total: 0.42, tokens_total: 1000 })).toEqual({ text: '$0.42', live: false });
    expect(listCost({ phase: 'completed', usd_total: 0.42, tokens_total: 1000, usd_partial: true })).toEqual({
      text: '$0.42 (partial)',
      live: false,
    });
    expect(listCost({ phase: 'investigating', usd_total: 0.004, usd_partial: true })).toEqual({ text: '<$0.01 (partial)', live: true });
    expect(listCost({ phase: 'completed', tokens_total: 1000 })).toEqual({ text: 'not priced', live: false });
    expect(listCost({ phase: 'failed' })).toEqual({ text: '—', live: false });
    expect(listCost({ phase: 'investigating', usd_total: 0.1, tokens_total: 10 })).toEqual({ text: '$0.10', live: true });
    expect(listCost({ phase: 'needs_input' }).live).toBe(true);
    expect(listCost({ phase: 'blocked', usd_total: 0.1 }).live).toBe(false);
  });
});

describe('request (D66)', () => {
  const msg = (text: string, is_parent = false, author = 'ops') => ({ author, text, is_parent });
  const req = (over: Partial<RunRequest> = {}): RunRequest => ({ source: 'slack', messages: [], attachments: 0, ...over });

  test('splitLead puts the parent first, else the first message; the rest keep their order', () => {
    const a = msg('a');
    const b = msg('b', true);
    const c = msg('c');
    expect(splitLead([a, b, c])).toEqual({ lead: b, rest: [a, c] });
    expect(splitLead([a, c])).toEqual({ lead: a, rest: [c] });
    expect(splitLead([])).toEqual({ lead: undefined, rest: [] });
  });

  test('runTitle: the current ask, else the first line of the lead message, clamped; else Run', () => {
    expect(runTitle({ current_ask: 'where is the refund', request: req({ messages: [msg('other', true)] }) })).toBe('where is the refund');
    expect(runTitle({ current_ask: '  ', request: req({ messages: [msg('\n  refund   missing  \nmore detail', true)] }) })).toBe('refund missing');
    const long = 'x'.repeat(300);
    const title = runTitle({ current_ask: null, request: req({ messages: [msg(long)] }) });
    expect(title.length).toBe(120);
    expect(title.endsWith('…')).toBe(true);
    expect(runTitle({ current_ask: null, request: req() })).toBe('Run');
    expect(runTitle({ current_ask: null, request: req({ messages: [msg('   ')] }) })).toBe('Run');
    expect(runTitle({ current_ask: null })).toBe('Run');
  });

  test('requestSourceLine: an open link, a masked link, then a label by source', () => {
    const link = 'https://acme.slack.com/archives/C1/p1727275322000100';
    expect(requestSourceLine({ permalink: link, request: req() })).toEqual({ text: 'Open in Slack', href: link });
    const masked = requestSourceLine({ permalink: 'https://acme.slack.com/archives/C1/p****0100', request: req() });
    expect(masked.text).toBe('Slack thread (link masked)');
    expect(masked.href).toBeUndefined();
    expect(requestSourceLine({ request: req({ source: 'thread_file' }) }).text).toBe('From a thread file');
    expect(requestSourceLine({ request: req({ source: 'text' }) }).text).toBe('Sent as text');
    expect(requestSourceLine({ request: req({ source: 'json', messages: [msg('hi', true, PASTED_AUTHOR)] }) }).text).toBe('Pasted in the web form');
    expect(requestSourceLine({ request: req({ source: 'json', messages: [msg('hi', true, 'support')] }) }).text).toBe('Sent as JSON');
    expect(requestSourceLine({}).text).toBe('Not recorded');
  });

  test('isLongText counts wrapped lines, not only line breaks', () => {
    expect(isLongText('short')).toBe(false);
    expect(isLongText('a\n'.repeat(8).trimEnd())).toBe(false);
    expect(isLongText('a\n'.repeat(9).trimEnd())).toBe(true);
    expect(isLongText('word '.repeat(80))).toBe(true);
  });
});
