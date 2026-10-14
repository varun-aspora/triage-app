import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type KnownIdField, loadKnownIdFields } from '../config/known-ids.ts';
import type { KnownIds } from '../types/core.ts';
import type { RequestHints, ThreadMessage } from '../types/request.ts';
import { extractKnownIds, hintedIds, hintLeads, labelledIds, leadLabel, MAX_LEADS, orderedTexts, threadLeads, withHints } from './extract-ids.ts';

// The real resources/known-ids.json: the labels under test are the ones the
// fallback reads in production.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIELDS = loadKnownIdFields(join(ROOT, 'resources'));

// Synthetic ids only.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';

function msg(text: string, is_parent = false, ts = '1695460000.000100'): ThreadMessage {
  return { ts, author: 'U0SYNTH', text, is_parent };
}

function req(texts: string[], hints: RequestHints = {}) {
  return { messages: texts.map((t, i) => msg(t, i === 0, `1695460000.00010${i}`)), hints };
}

const ids = (texts: string[], hints: RequestHints = {}): Partial<KnownIds> => extractKnownIds(req(texts, hints), FIELDS);

describe('labels from resources/known-ids.json', () => {
  const cases: { name: string; text: string; want: Partial<KnownIds> }[] = [
    { name: "'aspora user' is the Aspora user id", text: `aspora user: ${U1}`, want: { aspora_user_id: U1 } },
    { name: "'User ID' is the Aspora user id", text: `User ID: ${U1}`, want: { aspora_user_id: U1 } },
    { name: "'Horus Customer ID' is the SSFB customer id", text: `*Horus Customer ID:* ${U1}`, want: { customer_id: U1 } },
    { name: "'NSTP Application ID' is the account form id", text: `*NSTP Application ID:* ${U2}`, want: { account_form_id: U2 } },
    { name: "'Form ID' is the account form id", text: `Form ID: ${U2}`, want: { account_form_id: U2 } },
    { name: "'SSFB Account ID' is the account id", text: `SSFB Account ID: ${U3}`, want: { account_id: U3 } },
    { name: 'a country alias maps to its option key', text: 'Country: UK', want: { country: 'GB' } },
    { name: 'a longer country alias', text: 'Region: United Arab Emirates', want: { country: 'AE' } },
    { name: 'a phone number is normalised', text: 'Phone: +971 50 123 4567', want: { phone_number: '+971501234567' } },
    { name: 'an account number', text: 'A/C No.: 000011112222', want: { account_number: '000011112222' } },
    {
      name: 'the bot template with bold labels',
      text: `*New CX Issue Raised*\n*Priority:* P2\n*Horus Customer ID:* ${U1}\n*NSTP Application ID:* ${U2}\n*Alphadesk User ID:* ${U3}`,
      want: { aspora_user_id: U3, customer_id: U1, account_form_id: U2 },
    },
    {
      name: 'block-field form with the value on the next line',
      text: `*Aspora User ID:*\n${U4}\n*Country:*\nUAE`,
      want: { country: 'AE', aspora_user_id: U4 },
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(ids([c.text])).toEqual(c.want);
    });
  }

  test("the longest label wins: 'Aspora User ID' is not read as 'User ID' plus text", () => {
    expect(ids([`Aspora User ID: ${U1}`, `Customer ID: ${U2}`])).toEqual({ aspora_user_id: U1, customer_id: U2 });
  });

  test('an unlabelled UUID is not guessed into any key', () => {
    expect(ids([`please check ${U1}`, `and ${U2} too`])).toEqual({});
  });

  test('a label whose value does not match the pattern is skipped', () => {
    expect(ids(['User ID: not-a-uuid', 'Country: Mars'])).toEqual({});
  });

  test('the parent is read first and the first value per key wins', () => {
    const messages = [msg(`User ID: ${U2}`, false, '2'), msg(`User ID: ${U1}`, true, '1')];
    expect(orderedTexts(messages)).toEqual([`User ID: ${U1}`, `User ID: ${U2}`]);
    expect(extractKnownIds({ messages, hints: {} }, FIELDS)).toEqual({ aspora_user_id: U1 });
  });
});

describe('hints', () => {
  test('hints win over the text for the same key and add keys the text lacks', () => {
    expect(ids([`User ID: ${U1}`, 'Country: UK'], { ids: { aspora_user_id: ` ${U2} `, account_number: '000011112222' } })).toEqual({
      country: 'GB',
      aspora_user_id: U2,
      account_number: '000011112222',
    });
  });

  test('an empty hint does not replace a value', () => {
    expect(ids([`User ID: ${U1}`], { ids: { aspora_user_id: '  ' } })).toEqual({ aspora_user_id: U1 });
    expect(hintedIds({ ids: { aspora_user_id: '' } })).toEqual({});
  });

  test('withHints keeps KNOWN_ID_KEYS order and freezes the result', () => {
    const out = withHints({ account_number: '000011112222' }, { ids: { country: 'AE' } });
    expect(Object.keys(out)).toEqual(['country', 'account_number']);
    expect(Object.isFrozen(out)).toBe(true);
  });
});

describe('the fields list', () => {
  test('labels come from the list: a list without a label reads nothing for it', () => {
    const withoutUser: KnownIdField[] = FIELDS.map((f) => (f.key === 'aspora_user_id' ? { ...f, labels: ['synthetic user ref'] } : f));
    expect(labelledIds(withoutUser, [`User ID: ${U1}`])).toEqual({});
    expect(labelledIds(withoutUser, [`Synthetic User Ref: ${U1}`])).toEqual({ aspora_user_id: U1 });
  });
});

describe('thread leads (D96)', () => {
  const leadsOf = (texts: string[]) => threadLeads(req(texts).messages, 'thread');

  test('every id-shaped value is a seed lead with its label and position, labelled or not', () => {
    const text = `*Alphadesk user ID:* ${U1}\nplease check ${U2}`;
    const { leads, dropped } = leadsOf([text]);
    expect(dropped).toBe(0);
    expect(leads).toEqual([
      { value: U1, kind: 'uuid', source: 'thread', label: 'Alphadesk user ID', at: { message: 0, offset: text.indexOf(U1) }, status: 'seed' },
      { value: U2, kind: 'uuid', source: 'thread', label: 'please check', at: { message: 0, offset: text.indexOf(U2) }, status: 'seed' },
    ]);
  });

  test('the label starts after the previous value on its line', () => {
    const { leads } = leadsOf([`user: ${U1}, form = ${U2}`]);
    expect(leads.map((l) => l.label)).toEqual(['user', 'form']);
  });

  test('a value with nothing before it on its line has no label', () => {
    const { leads } = leadsOf([`the id is below\n${U1}`]);
    expect(leads[0]?.label).toBeUndefined();
  });

  test('the parent is read first; positions keep the message index as given', () => {
    const messages = [msg(`reply ${U2}`), msg(`parent ${U1}`, true)];
    const { leads } = threadLeads(messages, 'answer');
    expect(leads.map((l) => [l.value, l.at?.message, l.source])).toEqual([
      [U1, 1, 'answer'],
      [U2, 0, 'answer'],
    ]);
  });

  test('one lead per kind and value: case and a repeat in a later message are folded', () => {
    const { leads } = leadsOf([`id ${U1.toUpperCase()}`, `again ${U1}`]);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ value: U1, label: 'id', at: { message: 0 } });
  });

  test('phones keep their country code and digits; emails are lowercased', () => {
    const { leads } = leadsOf(['Phone: +971 50 123 4567, acct 000011112222, mail <mailto:Ops.User@Example.com|Ops.User@Example.com>']);
    expect(leads.map((l) => [l.kind, l.value, l.label])).toEqual([
      ['phone', '+971501234567', 'Phone'],
      ['digits', '000011112222', 'acct'],
      ['email', 'ops.user@example.com', 'mail'],
    ]);
  });

  test('past MAX_LEADS the rest are counted as dropped', () => {
    const many = Array.from({ length: MAX_LEADS + 4 }, (_, i) => String(100000000 + i));
    const { leads, dropped } = leadsOf([many.join(' ')]);
    expect(leads).toHaveLength(MAX_LEADS);
    expect(dropped).toBe(4);
  });

  test('a thread with no id-shaped value has no leads', () => {
    expect(leadsOf(['stuck on the form step, ref 12345'])).toEqual({ leads: [], dropped: 0 });
  });

  test('a long label keeps the words nearest the value, within 60 characters, on one line', () => {
    const label = leadLabel(`${'word '.repeat(30)}the\tAlphadesk \u0007user id:`);
    expect(label?.length).toBeLessThanOrEqual(60);
    expect(label?.startsWith('…')).toBe(true);
    expect(label?.endsWith('the Alphadesk user id')).toBe(true);
    expect(leadLabel(' > • _*Form ID*_ = ')).toBe('Form ID');
    expect(leadLabel(' : ')).toBeUndefined();
  });

  test('hint values that are id-shaped become hint leads with their key', () => {
    expect(hintLeads({ ids: { customer_id: ` ${U3} `, country: 'GB', phone_number: '+91 98765 43210' } })).toEqual([
      { value: '+919876543210', kind: 'phone', source: 'hint', key: 'phone_number', status: 'seed' },
      { value: U3, kind: 'uuid', source: 'hint', key: 'customer_id', status: 'seed' },
    ]);
  });
});
