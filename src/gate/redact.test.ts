// All values below are synthetic: well-known test card numbers, example.com
// and example.test domains, and made-up names, phones and addresses.
import { describe, expect, test } from 'bun:test';

import { checkEgress, isPersisted, redactModelFacing, redactPersisted, type Persisted } from './redact.ts';
import { compileNames, luhnValid } from './redact-patterns.ts';

const PAN = '4111111111111111'; // Luhn-valid test Visa
const NOT_PAN = '4111111111111112'; // same shape, fails Luhn
const ACCOUNT = '912010012345678';
const PHONE = '+91 98765 43210';
const PHONE_PLAIN = '9876543210';
const EMAIL = 'jane.doe@example.com';
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const NAME = 'Asha Verma';
const ADDRESS = 'Flat 12B, Lotus Residency, MG Road, Bengaluru 560001';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const persisted = (value: unknown, names: string[] = []) => redactPersisted(value, { names }).value;

describe('PAN and card', () => {
  test('a Luhn-valid PAN is masked in both profiles', () => {
    expect(luhnValid(PAN)).toBe(true);
    expect(redactModelFacing(`card ${PAN} used`)).toBe('card ****1111 used');
    expect(persisted(`card ${PAN} used`)).toBe('card ****1111 used');
    expect(checkEgress(`card ${PAN}`)).toEqual({ ok: false, unmasked: ['pan'], paths: ['$'] });
  });

  test('a Luhn-invalid 16-digit run is not a PAN, but persisted masks it as digits6', () => {
    expect(luhnValid(NOT_PAN)).toBe(false);
    expect(redactModelFacing(`ref ${NOT_PAN}`)).toBe(`ref ${NOT_PAN}`);
    expect(persisted(`ref ${NOT_PAN}`)).toBe('ref ****1112');
    expect(checkEgress(`ref ${NOT_PAN}`)).toEqual({ ok: false, unmasked: ['digits6'], paths: ['$'] });
  });

  test('grouped card numbers are masked in both profiles', () => {
    for (const grouped of ['4111 1111 1111 1111', '5500-0055-5555-5559', '3782 822463 10005']) {
      const out = redactModelFacing(`card ${grouped}.`);
      expect(out).not.toContain(grouped);
      expect(out).toMatch(/^card \*\*\*\*\d{4}\.$/);
      expect(persisted(`card ${grouped}.`)).toBe(out);
    }
    expect(checkEgress('card 4111 1111 1111 1111')).toMatchObject({ unmasked: ['card'] });
  });

  test('an account number starting with a non-card digit is never read as a PAN', () => {
    // Luhn-valid, but 9 is not a card network prefix.
    expect(luhnValid('9111111111111110')).toBe(true);
    expect(redactModelFacing('acct 9111111111111110')).toBe('acct 9111111111111110');
  });
});

describe('model-facing keeps search keys, persisted masks them', () => {
  test('account number visible model-facing, ****last4 when persisted', () => {
    expect(redactModelFacing(`account ${ACCOUNT}`)).toBe(`account ${ACCOUNT}`);
    expect(persisted(`account ${ACCOUNT}`)).toBe('account ****5678');
  });

  test('phone visible model-facing, masked when persisted', () => {
    const text = `call ${PHONE} or ${PHONE_PLAIN}`;
    expect(redactModelFacing(text)).toBe(text);
    const out = persisted(text);
    expect(out).toBe('call ****3210 or ****3210');
    expect(out).not.toContain('98765');
    expect(checkEgress(text)).toEqual({ ok: false, unmasked: ['phone'], paths: ['$'] });
  });

  test('landline and a phone after a short reference number are masked when persisted', () => {
    expect(persisted('office (022) 2345 6789')).toBe('office ****6789');
    expect(persisted('ref 2026 98765 43210')).toBe('ref 2026 ****3210');
  });

  test('email local part masked model-facing, whole email masked when persisted', () => {
    expect(redactModelFacing(`mail ${EMAIL} now`)).toBe('mail ****@example.com now');
    expect(persisted(`mail ${EMAIL} now`)).toBe('mail [email] now');
    // A model-facing mask still fails the egress check: the domain remains.
    expect(checkEgress('mail ****@example.com')).toMatchObject({ ok: false, unmasked: ['email'] });
  });

  test('passport masked in both profiles', () => {
    expect(redactModelFacing('passport K1234567 seen')).toBe('passport [passport] seen');
    expect(redactModelFacing('Passport No: Z9876543')).toBe('Passport No: [passport]');
    expect(persisted('passport K1234567')).toBe('passport [passport]');
  });

  test('names and UTRs stay visible model-facing', () => {
    const text = `${NAME} sent UTR SBINR52023092300012345`;
    expect(redactModelFacing(text)).toBe(text);
  });

  test('timestamps and dates are not phones', () => {
    const text = 'at 2026-09-23 10:11:12 and 23-09-2026 10:11';
    expect(persisted(text)).toBe(text);
  });
});

describe('addresses', () => {
  test('postcode-shaped address line masked when persisted', () => {
    expect(persisted(`Address: ${ADDRESS}`)).toBe('Address: [address]');
    expect(persisted('ship to 221B Baker Street, London NW1 6XE\nthanks')).toBe('[address]\nthanks');
    expect(redactModelFacing(`Address: ${ADDRESS}`)).toBe(`Address: ${ADDRESS}`);
    expect(checkEgress(`Address: ${ADDRESS}`)).toEqual({ ok: false, unmasked: ['postcode_address'], paths: ['$'] });
  });

  test('a 6-digit number with no address around it is digits6, not an address', () => {
    expect(persisted('amount 150000, code 400001')).toBe('amount ****0000, code ****0001');
    expect(checkEgress('code 400001')).toMatchObject({ unmasked: ['digits6'] });
  });
});

describe('UUIDs and hex ids (A11)', () => {
  test('UUID unchanged in both profiles', () => {
    const text = `customer_id ${UUID}`;
    expect(redactModelFacing(text)).toBe(text);
    expect(persisted(text)).toBe(text);
    expect(persisted({ customer_id: UUID.toUpperCase() })).toEqual({ customer_id: UUID.toUpperCase() });
    expect(checkEgress({ form_id: UUID })).toEqual({ ok: true });
  });

  test('a commit SHA is not masked as digits', () => {
    const sha = '3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d523456';
    expect(persisted({ commit: sha })).toEqual({ commit: sha });
  });
});

describe('secrets and DSN-like strings', () => {
  const cases: Array<[string, string, string]> = [
    [
      'quoted DSN',
      'SSFB_PG_URL="postgres://triage_ro:Synth3tic-Pass@db.example.test:5432/core"',
      'SSFB_PG_URL="postgres://triage_ro:****@db.example.test:5432/core"',
    ],
    ['export-prefixed password', "export ATSPL_DB_PASSWORD='Synthetic!Pass#1'", "export ATSPL_DB_PASSWORD='****'"],
    [
      'multi-line env text',
      'PGHOST=db.example.test\nPGPASSWORD=synthetic-secret-42\nDATABASE_URL=postgresql://app:another-synth@h.example.test/db',
      'PGHOST=db.example.test\nPGPASSWORD=****\nDATABASE_URL=postgresql://app:****@h.example.test/db',
    ],
    ['quoted value over two lines', 'SECRET="synthetic line one\nsynthetic line two"', 'SECRET="****"'],
    [
      'DSN password wrapped over a line break',
      'DB_URL=postgres://app:synthetic-pa\nss-42@db.example.test/core',
      'DB_URL=postgres://app:****@db.example.test/core',
    ],
    ['JSON keys', '{"password": "synthetic1", "api_key":"synthetic2"}', '{"password": "****", "api_key":"****"}'],
    ['bearer header', 'Authorization: Bearer synthetictoken.abc123', 'Authorization: Bearer ****'],
    [
      'private key block',
      '-----BEGIN PRIVATE KEY-----\nU3ludGhldGlj\n-----END PRIVATE KEY-----',
      '-----BEGIN PRIVATE KEY-----****-----END PRIVATE KEY-----',
    ],
  ];

  for (const [label, input, expected] of cases) {
    test(`${label} is masked in both profiles`, () => {
      expect(redactModelFacing(input)).toBe(expected);
      expect(persisted(input)).toBe(expected);
      expect(checkEgress(input)).toMatchObject({ ok: false, unmasked: ['credential'] });
      expect(checkEgress(expected)).toEqual({ ok: true });
    });
  }

  test('$VAR placeholders in suggested fixes are kept', () => {
    const cmd = 'psql "postgres://$PG_USER:$PG_PASSWORD@$PG_HOST/core" -c "select 1" && curl -H "Authorization: Bearer $TOKEN"';
    expect(persisted(cmd)).toBe(cmd);
    expect(checkEgress({ suggested_fix: [{ command: 'PGPASSWORD=$SSFB_PG_PASSWORD psql' }] })).toEqual({ ok: true });
  });
});

describe('decoding before scanning', () => {
  test('deny/egress: base64-encoded phone in reply_text', () => {
    const report = { cx_answer: { reply_text: `Please call ${b64('call me on +91 98765 43210')} today` } };
    expect(checkEgress(report)).toEqual({ ok: false, unmasked: ['phone'], paths: ['$.cx_answer.reply_text'] });
    const out = persisted(report) as typeof report;
    expect(out.cx_answer.reply_text).toBe('Please call call me on ****3210 today');
    expect(checkEgress(out)).toEqual({ ok: true });
  });

  test('deny/egress: URL-encoded email in suggested_fix.command', () => {
    const report = {
      suggested_fix: [{ title: 'Look up', kind: 'curl', command: 'curl "$ADMIN_URL/users?email=jane.doe%40example.com"' }],
    };
    expect(checkEgress(report)).toEqual({ ok: false, unmasked: ['email'], paths: ['$.suggested_fix[0].command'] });
    const out = persisted(report) as typeof report;
    expect(out.suggested_fix[0]!.command).toBe('curl "$ADMIN_URL/users?email=[email]"');
  });

  test('deny/egress: JSON-escaped digits inside a nested string', () => {
    const value = { evidence: { rows: [{ note: 'acct \\u0031\\u0032\\u0033\\u0034\\u0035\\u0036\\u0037\\u0038 seen' }] } };
    expect(checkEgress(value)).toEqual({ ok: false, unmasked: ['digits6'], paths: ['$.evidence.rows[0].note'] });
    expect((persisted(value) as typeof value).evidence.rows[0]!.note).toBe('acct ****5678 seen');
  });

  test('double encoding (base64 of URL-encoded text) is reached', () => {
    const text = `blob ${b64('contact=jane.doe%40example.com&x=1')}`;
    expect(checkEgress(text)).toMatchObject({ ok: false, unmasked: ['email'] });
    expect(persisted(text)).toBe('blob contact=[email]&x=1');
  });

  test('model-facing also sees through encoding for PAN', () => {
    expect(redactModelFacing(`x ${b64(`card number ${PAN}`)}`)).toBe('x card number ****1111');
  });

  test('innocent encoded text is left as it is', () => {
    const text = 'path /a%20b?q=%7Bx%7D line\\n next aGVsbG8gdGhlcmUgZnJpZW5kIG9mIG1pbmU=';
    expect(persisted(text)).toBe(text);
    expect(checkEgress(text)).toEqual({ ok: true });
  });
});

describe('names', () => {
  test('deny/egress: an ingress-collected name in reply_text', () => {
    const report = { cx_answer: { reply_text: 'Hi asha VERMA, the transfer is on its way.' } };
    expect(checkEgress(report, { names: [NAME] })).toEqual({
      ok: false,
      unmasked: ['name'],
      paths: ['$.cx_answer.reply_text'],
    });
    expect((persisted(report, [NAME]) as typeof report).cx_answer.reply_text).toBe('Hi [name], the transfer is on its way.');
  });

  test('name matching is whole-word', () => {
    expect(checkEgress('Ashaverma and Asha Vermani wrote', { names: [NAME] })).toEqual({ ok: true });
    expect(persisted('Asha  Verma.', [NAME])).toBe('[name].');
  });

  test('without names, no name is masked; mask words are not accepted as names', () => {
    expect(checkEgress(`Hi ${NAME}`)).toEqual({ ok: true });
    expect(compileNames(['name', 'email', ' ', 'x'])).toBeNull();
  });

  test('regex characters in names are matched literally', () => {
    expect(persisted('from R. K. (Ops) and RxK', ['R. K. (Ops)'])).toBe('from [name] and RxK');
  });
});

describe('deep walk', () => {
  test('object keys and non-string scalars (booleans, null) are preserved', () => {
    const input = {
      [EMAIL]: 'x',
      ok: true,
      no: false,
      nothing: null,
      count: 1234567,
      nested: [{ flag: true, value: null, phone: PHONE_PLAIN }],
    };
    const out = persisted(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(Object.keys(input));
    expect(out).toEqual({
      [EMAIL]: 'x',
      ok: true,
      no: false,
      nothing: null,
      count: 1234567,
      nested: [{ flag: true, value: null, phone: '****3210' }],
    });
    expect(redactModelFacing(input)).toEqual(input);
  });

  test('a __proto__ key stays an own property', () => {
    const input = JSON.parse('{"__proto__": {"x": "9876543210"}}') as Record<string, unknown>;
    const out = persisted(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__']);
  });

  test('redaction is pure: the input is not changed', () => {
    const input = { a: [`mail ${EMAIL}`], b: { c: PHONE } };
    const copy = structuredClone(input);
    redactPersisted(input, { names: [NAME] });
    redactModelFacing(input);
    checkEgress(input);
    expect(input).toEqual(copy);
  });

  test('cycles do not loop', () => {
    const input: Record<string, unknown> = { phone: PHONE_PLAIN };
    input.self = input;
    const out = persisted(input) as Record<string, unknown>;
    expect(out.phone).toBe('****3210');
    expect(out.self).toBe(out);
  });

  test('a key holding PII is shown as [*] in paths', () => {
    const result = checkEgress({ [PHONE_PLAIN]: { note: EMAIL } });
    expect(result).toEqual({ ok: false, unmasked: ['email'], paths: ['$[*].note'] });
  });

  test('paths use brackets for keys that are not identifiers', () => {
    expect(checkEgress({ 'reply text': EMAIL })).toMatchObject({ paths: ['$["reply text"]'] });
  });
});

// A corpus mixing everything, used for idempotency and the no-leak check.
const PII_VALUES = [PAN, NOT_PAN, ACCOUNT, PHONE, PHONE_PLAIN, EMAIL, NAME, ADDRESS, 'K1234567', 'Synth3tic-Pass'];
const CORPUS = {
  cx_answer: { reply_text: `Hi ${NAME}, we called ${PHONE} and wrote to ${EMAIL}. ${b64(`backup ${PHONE_PLAIN} number`)}` },
  root_cause: { statement: `card ${PAN} and ref ${NOT_PAN} on account ${ACCOUNT}; passport K1234567` },
  suggested_fix: [
    {
      title: 'check',
      kind: 'curl',
      command: `curl "$ADMIN_URL/u?email=${encodeURIComponent(EMAIL)}" && psql postgres://ro:Synth3tic-Pass@db.example.test/x`,
      preconditions: [`Address: ${ADDRESS}`],
      verify_with: `id ${UUID}`,
    },
  ],
  flags: [true, false, null, 42],
};

describe('idempotency', () => {
  const samples: unknown[] = [
    CORPUS,
    `${PAN} ${NOT_PAN} ${PHONE} ${EMAIL} ****@example.com [email] ****1234`,
    'SECRET="a\nb" PGPASSWORD=**** postgres://a:****@h.example.test/x',
    `Address: ${ADDRESS}\nsecond ${ADDRESS}`,
  ];

  test('redacting twice gives the same result in both profiles', () => {
    for (const s of samples) {
      const once = persisted(s, [NAME]);
      expect(persisted(once, [NAME])).toEqual(once);
      const mf = redactModelFacing(s);
      expect(redactModelFacing(mf)).toEqual(mf);
    }
  });

  test('persisted output passes the egress check', () => {
    for (const s of samples) {
      expect(checkEgress(persisted(s, [NAME]), { names: [NAME] })).toEqual({ ok: true });
    }
  });

  test('redacting model-facing output with the persisted profile equals persisting the raw input', () => {
    // Not a hard rule of the profiles, but true for this corpus, which shows
    // the model-facing masks are a subset.
    expect(persisted(redactModelFacing(CORPUS), [NAME])).toEqual(persisted(CORPUS, [NAME]));
  });
});

describe('checkEgress output', () => {
  test('checkEgress output contains no substring of any input PII value', () => {
    const result = checkEgress(CORPUS, { names: [NAME] });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    // Every 5-character piece of every value (the last 4 digits of a phone are
    // covered by the 5-character pieces around them).
    for (const value of PII_VALUES) {
      for (let i = 0; i + 5 <= value.length; i++) {
        expect(text).not.toContain(value.slice(i, i + 5));
      }
    }
    for (const digits of ['1111', '1112', '5678', '3210', '0001']) expect(text).not.toContain(digits);
    expect(result).toEqual({
      ok: false,
      unmasked: ['credential', 'email', 'pan', 'postcode_address', 'phone', 'passport', 'name', 'digits6'],
      paths: [
        '$.cx_answer.reply_text',
        '$.root_cause.statement',
        '$.suggested_fix[0].command',
        '$.suggested_fix[0].preconditions[0]',
      ],
    });
  });

  test('ok for clean input', () => {
    expect(checkEgress({ statement: 'The payout is pending at the bank.', n: 12, ok: true })).toEqual({ ok: true });
  });
});

describe('Persisted<T>', () => {
  test('redactPersisted is the producer and the brand is checkable at runtime', () => {
    const p = redactPersisted({ a: PHONE_PLAIN });
    expect(isPersisted(p)).toBe(true);
    expect(p.value).toEqual({ a: '****3210' });
    expect(JSON.stringify(p)).toBe('{"a":"****3210"}');
    expect(isPersisted({ value: { a: '****3210' } })).toBe(false);
    expect(Object.isFrozen(p)).toBe(true);
  });

  test('a nested Persisted value is re-scanned and stays Persisted', () => {
    const inner = redactPersisted(`hi ${NAME}`);
    expect(inner.value).toBe(`hi ${NAME}`);
    expect(checkEgress({ inner }, { names: [NAME] })).toMatchObject({ ok: false, unmasked: ['name'], paths: ['$.inner'] });
    const outer = redactPersisted({ inner }, { names: [NAME] });
    expect(isPersisted(outer.value.inner)).toBe(true);
    expect(outer.value.inner.value).toBe('hi [name]');
  });

  test('Persisted<T> cannot be made by casting', () => {
    const takesPersisted = (p: Persisted<string>): string => p.value;
    // @ts-expect-error a plain string is not Persisted
    const fromString = 'hello' as Persisted<string>;
    // @ts-expect-error an object of the same shape is not Persisted
    const fromObject = { a: 'x' } as Persisted<{ a: string }>;
    // @ts-expect-error an unredacted value is refused where Persisted is required
    const refused = () => takesPersisted('hello');
    expect([typeof fromString, typeof fromObject, typeof refused]).toEqual(['string', 'object', 'function']);
    expect(takesPersisted(redactPersisted('hello'))).toBe('hello');
  });
});

describe('large input', () => {
  test('long tokens do not make the scan quadratic', () => {
    const inputs = [
      'x'.repeat(200_000),
      'password'.repeat(20_000),
      `a@${'a'.repeat(50_000)}`,
      `http://${'a'.repeat(50_000)}`,
      Buffer.from('x'.repeat(200_000)).toString('base64'),
    ];
    const started = performance.now();
    for (const s of inputs) {
      redactPersisted(s);
      checkEgress(s);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
