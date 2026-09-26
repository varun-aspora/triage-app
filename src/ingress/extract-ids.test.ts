import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type KnownIdField, loadKnownIdFields } from '../config/known-ids.ts';
import type { KnownIds } from '../types/core.ts';
import type { RequestHints, ThreadMessage } from '../types/request.ts';
import { extractKnownIds, hintedIds, labelledIds, orderedTexts, withHints } from './extract-ids.ts';

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
