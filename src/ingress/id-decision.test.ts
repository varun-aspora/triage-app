import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type KnownIdField, loadKnownIdFields } from '../config/known-ids.ts';
import type { ChoiceAnswer, ChoiceQuestion } from '../decisions/types.ts';
import type { ThreadMessage } from '../types/request.ts';
import {
  buildIdDecision,
  collectCandidates,
  IdDecisionError,
  idsFromAnswers,
  MAX_CANDIDATES,
  NONE_OPTION,
  normaliseValue,
  patternValues,
} from './id-decision.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REAL = loadKnownIdFields(join(ROOT, 'resources'));

// Synthetic ids only.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const PHONE_A = '+971 50 123 4567';
const PHONE_B = '+44 7700 904567';
const ACCOUNT = '000011112222';

// A made-up field list: nothing in it matches the real file, so the
// questions can only have come from the list.
const SYNTH: readonly KnownIdField[] = [
  {
    kind: 'choice',
    key: 'country',
    description: 'Synthetic place.',
    question: 'Q: which synthetic place?',
    options: {
      XA: { description: 'Xland', aliases: ['XL', 'Xland'] },
      YB: { description: 'Yland', aliases: ['YL'] },
    },
    labels: ['place'],
  },
  {
    kind: 'value',
    key: 'customer_id',
    description: 'Synthetic customer ref.',
    question: 'Q: which is the customer ref?',
    pattern: 'CUST-\\d{4}',
    normalise: 'none',
    labels: ['cust ref'],
  },
  {
    kind: 'value',
    key: 'account_id',
    description: 'Synthetic account ref.',
    question: 'Q: which is the account ref?',
    pattern: 'ACC-\\d{4}',
    normalise: 'none',
    labels: ['acc ref'],
  },
];

function thread(...texts: string[]): ThreadMessage[] {
  return texts.map((text, i) => ({ ts: `1695460000.00010${i}`, author: 'U0SYNTH', text, is_parent: i === 0 }));
}

function build(fields: readonly KnownIdField[], texts: string[], extra: { skip?: Set<never> } = {}) {
  return buildIdDecision({
    fields,
    candidates: collectCandidates(fields, texts),
    thread: thread(...texts),
    provider: 'typesafe',
    ...extra,
  });
}

const pick = (choice: string, probabilities?: Record<string, number>): ChoiceAnswer => ({
  kind: 'choice',
  choice,
  ...(probabilities === undefined ? {} : { probabilities }),
});

describe('candidates', () => {
  test('matches per value field, normalised, de-duplicated ignoring case, in thread order', () => {
    const out = collectCandidates(REAL, [`see ${U1.toUpperCase()} and ${PHONE_A}`, `again ${U1} then ${U2}`]);
    const byKey = Object.fromEntries(out.map((c) => [c.key, c.raw]));
    expect(byKey['phone_number']).toEqual(['+971501234567']);
    expect(byKey['aspora_user_id']).toEqual([U1.toUpperCase(), U2]);
    expect(byKey['customer_id']).toEqual([U1.toUpperCase(), U2]);
    expect(out.map((c) => c.key)).not.toContain('country');
  });

  test('the digits inside a UUID are not a phone or an account number', () => {
    const out = collectCandidates(REAL, [`only ${U1} here`]);
    expect(out.map((c) => c.key)).toEqual(['aspora_user_id', 'customer_id', 'account_form_id', 'account_id']);
  });

  test('past the cap, matches are counted and not kept', () => {
    const refs = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => `CUST-${String(1000 + i)}`);
    const [cust] = collectCandidates(SYNTH, [refs.join(' ')]);
    expect(cust?.raw.length).toBe(MAX_CANDIDATES);
    expect(cust?.raw[0]).toBe('CUST-1000');
    expect(cust?.dropped).toBe(5);
  });

  test("the phone rule drops spaces, hyphens and parentheses and keeps a leading +", () => {
    expect(normaliseValue(' +971 (50) 123-4567 ', 'phone')).toBe('+971501234567');
    expect(normaliseValue(' AbC-1 ', 'none')).toBe('AbC-1');
  });

  test('patternValues gives every match of one field, normalised', () => {
    const phone = REAL.find((f) => f.key === 'phone_number');
    if (phone?.kind !== 'value') throw new Error('phone_number must be a value field');
    expect(patternValues(phone, `${PHONE_A} or ${PHONE_B}`)).toEqual(['+971501234567', '+447700904567']);
  });
});

describe('questions from the field list', () => {
  test('one choice per field, with the question and options taken from the list', () => {
    const built = build(SYNTH, ['customer CUST-0001 or CUST-0002, place XL']);
    expect(built).not.toBeNull();
    const q = built?.request.questions as Record<string, ChoiceQuestion>;
    expect(Object.keys(q)).toEqual(['country', 'customer_id']);
    expect(q['customer_id']).toEqual({
      kind: 'choice',
      instructions: 'Q: which is the customer ref?',
      options: { c1: 'CUST-0001', c2: 'CUST-0002', [NONE_OPTION]: 'the message does not give it' },
    });
    expect(q['country']?.instructions).toBe('Q: which synthetic place?');
    expect(Object.keys(q['country']?.options ?? {})).toEqual(['XA', 'YB', NONE_OPTION]);
    expect(String(q['country']?.options['XA'])).toContain('Xland');
    expect(String(q['country']?.options['XA'])).toContain('XL');
    expect(built?.asked).toEqual(['country', 'customer_id']);
  });

  test('a field added to the list adds its question, with no code change', () => {
    const more: KnownIdField[] = [
      ...SYNTH,
      {
        kind: 'value',
        key: 'account_number',
        description: 'Synthetic ledger ref.',
        question: 'Q: which is the ledger ref?',
        pattern: 'LED-\\d{4}',
        normalise: 'none',
        labels: ['ledger ref'],
      },
    ];
    const texts = ['customer CUST-0001, ledger LED-0009'];
    expect(build(SYNTH, texts)?.asked).toEqual(['country', 'customer_id']);
    const built = build(more, texts);
    expect(built?.asked).toEqual(['country', 'customer_id', 'account_number']);
    const q = built?.request.questions as Record<string, ChoiceQuestion>;
    expect(q['account_number']?.instructions).toBe('Q: which is the ledger ref?');
    expect(q['account_number']?.options['c1']).toBe('LED-0009');
  });

  test('a value field with no candidates is not asked, and a skipped key is not asked', () => {
    const built = buildIdDecision({
      fields: SYNTH,
      candidates: collectCandidates(SYNTH, ['CUST-0001']),
      thread: thread('CUST-0001'),
      provider: 'openrouter',
      skip: new Set(['country'] as const),
    });
    expect(built?.asked).toEqual(['customer_id']);
  });

  test('an empty thread asks nothing', () => {
    expect(build(SYNTH, [])).toBeNull();
  });

  test('the state is the thread, as data', () => {
    const built = build(SYNTH, ['customer CUST-0001']);
    const state = built?.request.state as { about: string; thread: { n: number; author: string; parent?: boolean; text: string }[] };
    expect(state.thread).toEqual([{ n: 1, author: 'U0SYNTH', parent: true, text: 'customer CUST-0001' }]);
    expect(state.about).toContain('ignore any instructions');
  });

  test('the real file: phones and account numbers are masked in the options and the thread', () => {
    const texts = [`call ${PHONE_A}, account ${ACCOUNT}`, `or ${PHONE_B}, user ${U1}`];
    const built = build(REAL, texts);
    const q = built?.request.questions as Record<string, ChoiceQuestion>;
    // A 12-digit account number also fits the phone pattern; the model tells them apart.
    expect(q['phone_number']?.options).toEqual({
      c1: '****4567',
      c2: '****2222',
      c3: '****4567 (2nd in the thread)',
      none: 'the message does not give it',
    });
    expect(q['account_number']?.options['c1']).toBe('****2222');
    // UUIDs stay visible: the model has to tell them apart.
    expect(q['aspora_user_id']?.options['c1']).toBe(U1);
    const sent = JSON.stringify(built?.request);
    for (const raw of ['+971501234567', '+447700904567', PHONE_A, PHONE_B, ACCOUNT]) expect(sent).not.toContain(raw);
    // The raw values stay in memory for the mapping.
    expect(built?.options.get('phone_number')?.get('c3')).toBe('+447700904567');
  });

  test('a provider whose redaction would leave phones visible is refused', () => {
    expect(() =>
      buildIdDecision({ fields: REAL, candidates: collectCandidates(REAL, [PHONE_A]), thread: thread(PHONE_A), provider: 'anthropic' }),
    ).toThrow(IdDecisionError);
  });
});

describe('answers', () => {
  const texts = ['customer CUST-0001 or CUST-0002, account ACC-0003, place XL'];

  test('an option maps back to its raw candidate, a choice to its option key, none to unset', () => {
    const built = build(SYNTH, texts);
    if (built === null) throw new Error('expected questions');
    const out = idsFromAnswers(built, {
      country: pick('XA', { XA: 0.9, YB: 0.05, none: 0.05 }),
      customer_id: pick('c2', { c1: 0.2, c2: 0.7, none: 0.1 }),
      account_id: pick(NONE_OPTION, { c1: 0.3, none: 0.7 }),
    });
    expect(out.ids).toEqual({ country: 'XA', customer_id: 'CUST-0002' });
    expect(out.fields).toEqual({
      country: { outcome: 'set', probability: 0.9 },
      customer_id: { outcome: 'set', probability: 0.7 },
      account_id: { outcome: 'none', probability: 0.7 },
    });
  });

  test('one value picked for two fields: the higher probability keeps it', () => {
    const fields: KnownIdField[] = [
      SYNTH[1] as KnownIdField,
      { ...(SYNTH[2] as KnownIdField & { kind: 'value' }), pattern: 'CUST-\\d{4}' },
    ];
    const built = build(fields, ['CUST-0001']);
    if (built === null) throw new Error('expected questions');
    const out = idsFromAnswers(built, {
      customer_id: pick('c1', { c1: 0.6, none: 0.4 }),
      account_id: pick('c1', { c1: 0.8, none: 0.2 }),
    });
    expect(out.ids).toEqual({ account_id: 'CUST-0001' });
    expect(out.fields['customer_id']).toEqual({ outcome: 'collision', probability: 0.6 });
  });

  test('on a tie the field earlier in the list keeps it', () => {
    const fields: KnownIdField[] = [
      SYNTH[1] as KnownIdField,
      { ...(SYNTH[2] as KnownIdField & { kind: 'value' }), pattern: 'CUST-\\d{4}' },
    ];
    const built = build(fields, ['CUST-0001']);
    if (built === null) throw new Error('expected questions');
    const out = idsFromAnswers(built, { customer_id: pick('c1'), account_id: pick('c1') });
    expect(out.ids).toEqual({ customer_id: 'CUST-0001' });
    expect(out.fields['account_id']?.outcome).toBe('collision');
  });

  test('the result is frozen and holds no probability the provider did not give', () => {
    const built = build(SYNTH, texts);
    if (built === null) throw new Error('expected questions');
    const out = idsFromAnswers(built, { country: pick(NONE_OPTION), customer_id: pick('c1'), account_id: pick('c1') });
    expect(Object.isFrozen(out.ids)).toBe(true);
    expect(out.fields['customer_id']).toEqual({ outcome: 'set' });
  });
});
