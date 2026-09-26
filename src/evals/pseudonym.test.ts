import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { extractIdShaped } from '../gate/id-patterns.ts';
import { CaseSchema, TAXONOMY_VERSION, threadTexts, type EvalCase } from './case-schema.ts';
import {
  MIN_KEY_BYTES,
  PseudonymError,
  kindForId,
  pseudonymise,
  pseudonymiseCase,
  validateCaseIds,
} from './pseudonym.ts';

// Test keys and ids are made up for these tests.
const KEY = 'test-key-0123456789abcdef';
const OTHER_KEY = 'other-key-0123456789abcdef';

const V4_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The same shapes src/gate/id-patterns.ts matches, anchored.
const GATE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GATE_PHONE = /^\+\d(?:[ \-.()]?\d){9,14}$/;
const GATE_DIGITS = /^\d{9,}$/;

const UUID_1 = 'a1b2c3d4-2222-4333-8444-555555555555';
const UUID_2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const FORM_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const ACCOUNT = '123456789012345';
const PHONE = '+911234567890';

// Every value found by the gate's extractor is exactly one id of this kind.
function gateSees(value: string): string[] {
  return extractIdShaped(value).map((i) => `${i.kind}:${i.raw}`);
}

describe('pseudonymise', () => {
  test('is deterministic for the same key and value, and differs for another key', () => {
    for (const [value, kind] of [
      [UUID_1, 'uuid'],
      [ACCOUNT, 'account_number'],
      [PHONE, 'phone'],
      [FORM_ID, 'form_id'],
      ['AB12cd34', 'token'],
      ['someone.test@example.org', 'email'],
    ] as const) {
      const a = pseudonymise(value, kind, KEY);
      expect(pseudonymise(value, kind, KEY)).toBe(a);
      expect(pseudonymise(value, kind, OTHER_KEY)).not.toBe(a);
      expect(a).not.toBe(value);
    }
  });

  test('a Uint8Array key gives the same result as its utf8 string', () => {
    expect(pseudonymise(UUID_1, 'uuid', new TextEncoder().encode(KEY))).toBe(pseudonymise(UUID_1, 'uuid', KEY));
  });

  test('UUID output is a valid version 4 UUID that the scope gate sees as a uuid', () => {
    for (const u of [UUID_1, UUID_2, FORM_ID]) {
      const p = pseudonymise(u, 'uuid', KEY);
      expect(p).toMatch(V4_UUID);
      expect(p).toMatch(GATE_UUID);
      expect(gateSees(p)).toEqual([`uuid:${p}`]);
    }
  });

  test('UUID letter case is kept, and both cases map to the same id', () => {
    const lower = pseudonymise(UUID_2, 'uuid', KEY);
    const upper = pseudonymise(UUID_2.toUpperCase(), 'uuid', KEY);
    expect(upper).toBe(lower.toUpperCase());
  });

  test('account number keeps its length and stays a gate digit run', () => {
    for (const acct of ['123456789', ACCOUNT, '0012345678901234567']) {
      const p = pseudonymise(acct, 'account_number', KEY);
      expect(p).toHaveLength(acct.length);
      expect(p).toMatch(GATE_DIGITS);
      expect(p.startsWith('0')).toBe(acct.startsWith('0'));
      expect(gateSees(p)).toEqual([`digits:${p}`]);
    }
  });

  test('two distinct accounts sharing last4 get distinct pseudonyms', () => {
    const a = pseudonymise('111122223333', 'account_number', KEY);
    const b = pseudonymise('999988883333', 'account_number', KEY);
    expect(a).not.toBe(b);
  });

  test('phone keeps its prefix and length', () => {
    for (const [phone, prefix] of [
      ['+911234567890', '+91'],
      ['+91 12345 67890', '+91 '],
      ['+971 50 000 1234', '+971 '],
      ['+1 555-010-0000', '+1 '],
      ['+44 20 7946 0000', '+44 '],
    ] as const) {
      const p = pseudonymise(phone, 'phone', KEY);
      expect(p.startsWith(prefix)).toBe(true);
      expect(p).toHaveLength(phone.length);
      expect(p.replace(/\d/g, '0')).toBe(phone.replace(/\d/g, '0'));
      expect(p).toMatch(GATE_PHONE);
      expect(gateSees(p)).toEqual([`phone:${p}`]);
      expect(p).not.toBe(phone);
    }
  });

  test('a phone written with or without separators maps to the same digits', () => {
    const plain = pseudonymise('+911234567890', 'phone', KEY);
    const spaced = pseudonymise('+91 12345 67890', 'phone', KEY);
    expect(spaced.replace(/\D/g, '')).toBe(plain.replace(/\D/g, ''));
  });

  test('a bare 10-digit phone maps to the last 10 digits of the prefixed one', () => {
    const full = pseudonymise('+911234567890', 'phone', KEY);
    const bare = pseudonymise('1234567890', 'phone', KEY);
    expect(bare).toHaveLength(10);
    expect(full.endsWith(bare)).toBe(true);
  });

  test('form id: a UUID form id becomes a UUID, another shape keeps its character classes', () => {
    expect(pseudonymise(FORM_ID, 'form_id', KEY)).toBe(pseudonymise(FORM_ID, 'uuid', KEY));
    const p = pseudonymise('FRM-2026-ab12', 'form_id', KEY);
    expect(p.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '0')).toBe('AAA-0000-aa00');
  });

  test('email pseudonyms land on example.com', () => {
    expect(pseudonymise('someone.test@example.org', 'email', KEY)).toMatch(/^[a-z0-9._-]+@example\.com$/);
  });

  test('refuses a value that does not have the shape of its kind', () => {
    expect(() => pseudonymise('not-a-uuid', 'uuid', KEY)).toThrow(PseudonymError);
    expect(() => pseudonymise('12ab', 'account_number', KEY)).toThrow(PseudonymError);
    expect(() => pseudonymise('****1234', 'account_number', KEY)).toThrow(PseudonymError);
    expect(() => pseudonymise('+91 12', 'phone', KEY)).toThrow(PseudonymError);
    expect(() => pseudonymise('call me', 'phone', KEY)).toThrow(PseudonymError);
    expect(() => pseudonymise('a b', 'form_id', KEY)).toThrow(PseudonymError);
    expect(() => pseudonymise('nobody', 'email', KEY)).toThrow(PseudonymError);
    expect(() => pseudonymise(UUID_1, 'nope' as never, KEY)).toThrow(PseudonymError);
  });

  test('refuses a short key, and the error does not echo it', () => {
    const short = 'x'.repeat(MIN_KEY_BYTES - 1);
    expect(() => pseudonymise(UUID_1, 'uuid', short)).toThrow(PseudonymError);
    expect(() => pseudonymise(UUID_1, 'uuid', '')).toThrow(PseudonymError);
    try {
      pseudonymise(UUID_1, 'uuid', 'shortsecretkey');
    } catch (err) {
      expect((err as Error).message).not.toContain('shortsecretkey');
    }
  });

  test('kindForId picks the kind by key and shape', () => {
    expect(kindForId('aspora_user_id', UUID_1)).toBe('uuid');
    expect(kindForId('phone_number', PHONE)).toBe('phone');
    expect(kindForId('account_form_id', FORM_ID)).toBe('uuid');
    expect(kindForId('account_form_id', 'FRM-1')).toBe('form_id');
    expect(kindForId('account_number', ACCOUNT)).toBe('account_number');
    expect(kindForId('customer_id', 'ABCD0123456789')).toBe('token');
  });

  test('kindForId keeps country as it is', () => {
    expect(kindForId('country', 'GB')).toBeUndefined();
  });
});

function sampleCase(): EvalCase {
  return v.parse(CaseSchema, {
    id: 'syn-sample',
    taxonomy_version: TAXONOMY_VERSION,
    label_source: 'synthetic',
    request: {
      messages: [
        {
          ts: '1.1',
          author: 'triage-bot',
          is_parent: true,
          text: `Horus Customer ID: ${UUID_1}\nAccount Form ID: ${FORM_ID}\nAccount ${ACCOUNT} debited.`,
        },
        {
          ts: '1.2',
          author: 'cx-agent',
          is_parent: false,
          text: `Phone +91 12345 67890 (1234567890). A/c${ACCOUNT}. Upper ${UUID_1.toUpperCase()}. Customer is in GB.`,
        },
      ],
    },
    ids: { customer_id: UUID_1, account_form_id: FORM_ID, phone_number: PHONE, country: 'GB' },
    id_chain: {
      ids: {
        customer_id: UUID_1,
        account_form_id: FORM_ID,
        aspora_user_id: UUID_2,
        phone_number: PHONE,
        account_number: ACCOUNT,
        country: 'GB',
      },
      hops: [
        { from: 'customer_id', to: 'aspora_user_id', source: 'ssfb:harbor.customer', status: 'resolved', taken_at: '2026-09-01T00:00:00.000Z' },
      ],
    },
    basic_state: [
      { item: 'account.number', value: ACCOUNT, taken_at: '2026-09-01T00:00:00.000Z', source: 'ssfb:harbor' },
      { item: 'user', value: `user ${UUID_2}`, taken_at: '2026-09-01T00:00:00.000Z', source: 'ssfb:harbor' },
    ],
    expected: { category: 'transfer_out', tier: 'mid', current_ask: `Check ${ACCOUNT}` },
    provenance: { origin: 'synthetic', ref: 'keep-me' },
  });
}

describe('pseudonymiseCase', () => {
  const original = sampleCase();
  const out = pseudonymiseCase(original, KEY);
  const text = threadTexts(out).join('\n');
  const acct = out.id_chain.ids.account_number as string;
  const horus = out.id_chain.ids.customer_id as string;

  test('no original id survives anywhere in the rewritten fields', () => {
    const json = JSON.stringify({ ...out, provenance: undefined });
    for (const id of [UUID_1, UUID_2, FORM_ID, ACCOUNT, '1234567890', UUID_1.toUpperCase()]) {
      expect(json).not.toContain(id);
    }
  });

  test('maps the same original id to the same pseudonym across thread text, ids, id_chain and basic_state', () => {
    expect(out.ids.customer_id).toBe(horus);
    expect(horus).toBe(pseudonymise(UUID_1, 'uuid', KEY));
    expect(out.ids.account_form_id).toBe(out.id_chain.ids.account_form_id as string);
    expect(out.ids.phone_number).toBe(out.id_chain.ids.phone_number as string);
    expect(acct).toBe(pseudonymise(ACCOUNT, 'account_number', KEY));
    expect(text).toContain(`Horus Customer ID: ${horus}`);
    expect(text).toContain(`Account ${acct} debited.`);
    expect(text).toContain(`A/c${acct}.`);
    expect(text).toContain(`Upper ${horus.toUpperCase()}.`);
    expect(out.basic_state[0]?.value).toBe(acct);
    expect(out.basic_state[1]?.value).toBe(`user ${out.id_chain.ids.aspora_user_id}`);
    expect(out.expected.current_ask).toBe(`Check ${acct}`);
  });

  test('a phone in the thread, spaced or bare, agrees with the chain phone', () => {
    const phone = out.id_chain.ids.phone_number as string;
    const spaced = pseudonymise('+91 12345 67890', 'phone', KEY);
    expect(spaced.replace(/\D/g, '')).toBe(phone.replace(/\D/g, ''));
    expect(text).toContain(`Phone ${spaced} (${phone.slice(-10)})`);
  });

  test('country is kept as it is, in the ids and the thread', () => {
    expect(out.ids.country).toBe('GB');
    expect(out.id_chain.ids.country).toBe('GB');
    expect(text).toContain('Customer is in GB.');
  });

  test('the rewritten case still passes validateCaseIds and the schema', () => {
    expect(validateCaseIds(original)).toEqual({ ok: true });
    expect(validateCaseIds(out)).toEqual({ ok: true });
    expect(v.safeParse(CaseSchema, out).success).toBe(true);
  });

  test('id, taxonomy_version, label_source and provenance are left alone', () => {
    expect(out.id).toBe(original.id);
    expect(out.taxonomy_version).toBe(original.taxonomy_version);
    expect(out.label_source).toBe(original.label_source);
    expect(out.provenance).toEqual(original.provenance);
    expect(out.id_chain.hops).toEqual(original.id_chain.hops);
  });

  test('is deterministic and does not change its input', () => {
    const before = JSON.stringify(original);
    expect(pseudonymiseCase(original, KEY)).toEqual(out);
    expect(JSON.stringify(original)).toBe(before);
    expect(pseudonymiseCase(original, OTHER_KEY)).not.toEqual(out);
  });

  test('refuses a short key', () => {
    expect(() => pseudonymiseCase(original, 'short')).toThrow(PseudonymError);
  });
});

describe('validateCaseIds', () => {
  test('fails when the thread mentions an id missing from id_chain', () => {
    const c = sampleCase();
    const stray = '99999999-8888-4777-8666-555555555555';
    c.request.messages![1]!.text += ` Also ${stray}.`;
    const r = validateCaseIds(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]?.where).toBe('request.messages.1.text');
      expect(r.problems[0]?.masked).toBe('uuid:***5555');
      // The problem carries the masked form only.
      expect(JSON.stringify(r.problems)).not.toContain(stray);
    }
  });

  test('fails on a digit run or phone missing from id_chain', () => {
    const c = sampleCase();
    c.request.messages![0]!.text += ' Other account 222233334444 and +44 20 7946 0000.';
    const r = validateCaseIds(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.reason).sort()).toEqual(['digits id not in id_chain', 'phone id not in id_chain']);
  });

  test('fails on a redaction mask left in the thread', () => {
    const c = sampleCase();
    c.request.messages![0]!.text += ' Old account ****3333.';
    const r = validateCaseIds(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]?.reason).toContain('mask');
  });

  test('fails when an id in ids is not in id_chain with the same value', () => {
    const c = sampleCase();
    c.ids.aspora_user_id = '12121212-3434-4565-8787-909090909090';
    const r = validateCaseIds(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.where)).toEqual(['ids.aspora_user_id']);
  });

  test('fails on a malformed chain id', () => {
    for (const [key, value] of [
      ['account_form_id', 'FORM-1'],
      ['account_number', '****3333'],
      ['account_number', '12345'],
      ['phone_number', '12345'],
      ['aspora_user_id', 'has space'],
      ['customer_id', 'cust-1'],
      ['account_id', 'not-a-uuid'],
      ['country', 'gb'],
    ] as const) {
      const c = sampleCase();
      delete (c.ids as Record<string, string>)[key];
      (c.id_chain.ids as Record<string, string>)[key] = value;
      const r = validateCaseIds(c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems.some((p) => p.where === `id_chain.ids.${key}`)).toBe(true);
    }
  });

  test('a plain-text request is checked too', () => {
    const c = sampleCase();
    c.request = { text: 'Account 555566667777 blocked.' };
    const r = validateCaseIds(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]?.where).toBe('request.text');
  });
});
