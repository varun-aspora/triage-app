import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeTestHome, SSFB_QW_ENV } from '../../test/support/home.ts';
import {
  DENOISE_FILTER,
  EMPTY_MESSAGE_LABEL,
  HIT_LIMIT,
  MAX_TERMS,
  PAGE_SIZE,
  QwArgError,
  assertQwSafe,
  buildLogsQuery,
  escapeTerm,
  normalizeMessage,
  qwSafeProblem,
  quickwitGateConfig,
  type LogsQuery,
  type LogsQueryInput,
  type LogsQueryResult,
  type QuickwitGateConfig,
} from './quickwit.ts';

// Synthetic config shaped like the SSFB registry entry.
const CFG: QuickwitGateConfig = {
  entity: 'ssfb',
  fields: ['service', 'level', 'message', 'error', 'raw_message', 'timestamp', 'x-req-id', 'form_id', 'x-device-id', 'status_code'],
  services: { harbor: 'harbor', workflow: 'workflow-op', rhythm: 'rhythm', finacle: undefined },
  maxHits: 500,
};
const RTL: QuickwitGateConfig = {
  entity: 'rtl',
  fields: ['service', 'level', 'message', 'error', 'timestamp', 'customer_id'],
  services: { comms: 'comms-service', workflow: 'workflow-op-service' },
  maxHits: 500,
};

const UUID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OWNER_UUID = '26caff50-d980-4c95-bcc9-fdd3b7fac43f';

function build(input: LogsQueryInput, cfg: QuickwitGateConfig = CFG): LogsQueryResult {
  return buildLogsQuery(cfg, input);
}

function ok(input: LogsQueryInput, cfg: QuickwitGateConfig = CFG): LogsQuery {
  const r = build(input, cfg);
  if (!r.ok) throw new Error(`expected a query, got refusal: ${r.reason}`);
  return r;
}

function query(input: LogsQueryInput, cfg: QuickwitGateConfig = CFG): string {
  return ok(input, cfg).query;
}

function reason(input: LogsQueryInput, cfg: QuickwitGateConfig = CFG): string {
  const r = build(input, cfg);
  if (r.ok) throw new Error(`expected a refusal, got query: ${r.query}`);
  return r.reason;
}

const H = { service: 'harbor' } as const;

describe('buildLogsQuery: refusals', () => {
  const cases: [string, LogsQueryInput, RegExp, QuickwitGateConfig?][] = [
    ['service alone', H, /needs a selective part/],
    ['nothing at all', {}, /needs a selective part/],
    ['service and level only', { ...H, level: 'error' }, /needs a selective part/],
    ['exclude alone', { exclude: ['noise'] }, /needs a selective part/],
    ['an any_of of levels only', { any_of: [{ level: ['error', 'warn'] }] }, /needs a selective part/],
    ['an any_of of services only', { any_of: [{ service: ['harbor', 'rhythm'] }] }, /needs a selective part/],
    ['unknown service', { service: 'nope', terms: ['x'] }, /unknown service "nope".*harbor, workflow/],
    ['unknown service in any_of', { terms: ['x'], any_of: [{ service: ['nope'] }] }, /unknown service "nope"/],
    ['service without a log name', { service: 'finacle', terms: ['x'] }, /finacle has no log service name/],
    ['unknown field', { ...H, fields: { customer_id: 'abc' } }, /unknown field "customer_id"/],
    ['service via fields', { ...H, fields: { service: 'rhythm' } }, /use the service input/],
    ['timestamp via fields', { ...H, fields: { timestamp: '2026' } }, /from\/to/],
    ['a broken range', { ...H, fields: { status_code: '[400 TO' } }, /looks like a range/],
    ['a range with words', { ...H, fields: { status_code: '[a TO b]' } }, /looks like a range/],
    ['unknown group_by', { ...H, terms: ['x'], group_by: ['secret'] }, /unknown group_by field "secret"/],
    ['five group_by fields', { ...H, terms: ['x'], group_by: ['service', 'level', 'message', 'error', 'form_id'] }, /at most 4 fields, got 5/],
    ['empty group_by', { ...H, terms: ['x'], group_by: [] }, /group_by is empty/],
    ['group_by twice the same field', { ...H, terms: ['x'], group_by: ['level', 'level'] }, /same field twice/],
    ['unknown count_distinct', { ...H, terms: ['x'], count_distinct: 'secret' }, /unknown count_distinct field "secret"/],
    ['count and group_by together', { ...H, terms: ['x'], count: true, group_by: ['message'] }, /not both/],
    ['count and count_distinct together', { ...H, terms: ['x'], count: true, count_distinct: 'form_id' }, /not both/],
    ['offset with count', { ...H, terms: ['x'], count: true, offset: 250 }, /offset apply to hits only/],
    ['columns and raw with group_by', { ...H, terms: ['x'], group_by: ['level'], columns: ['path'], raw: true }, /columns, raw apply to hits only/],
    ['negative offset', { ...H, terms: ['x'], offset: -1 }, /offset must be a whole number/],
    ['offset at the hit limit', { ...H, terms: ['x'], offset: HIT_LIMIT }, /offset 5000 is past the 5000 hits/],
    ['a column that is not a field name', { ...H, terms: ['x'], columns: ['a b'] }, /column "a b" is not a field name/],
    ['too many columns', { ...H, terms: ['x'], columns: Array.from({ length: 11 }, (_, i) => `c${i}`) }, /at most 10 columns, got 11/],
    ['max_hits zero', { ...H, terms: ['x'], max_hits: 0 }, /whole number/],
    ['max_hits fractional', { ...H, terms: ['x'], max_hits: 2.5 }, /whole number/],
    ['level with spaces', { ...H, terms: ['x'], level: 'error OR 1' }, /single word/],
    ['a bad level in any_of', { terms: ['x'], any_of: [{ level: ['error OR 1'] }] }, /any_of\[0\]\.level must be a single word/],
    ['an empty any_of group', { terms: ['x'], any_of: [{}] }, /any_of\[0\] is empty/],
    ['too many any_of groups', { terms: ['x'], any_of: Array.from({ length: 6 }, () => ({ terms: ['a'] })) }, /at most 5 any_of groups per query, got 6/],
    ['empty term', { ...H, terms: ['  '] }, /empty/],
    ['empty message', { ...H, message: '' }, /empty/],
    ['message of only punctuation', { ...H, message: ';;;' }, /no searchable text/],
    ['error with no words', { ...H, error: '!!' }, /no searchable words/],
    ['newline in a term', { ...H, terms: ['a\nb'] }, /control character/],
    ['NUL in a field value', { ...H, fields: { form_id: 'a\u0000b' } }, /control character/],
    ['too many terms', { ...H, terms: Array.from({ length: MAX_TERMS + 1 }, (_, i) => `t${i}`) }, /at most 20 terms per query, got 21/],
    ['over-long value', { ...H, terms: ['x'.repeat(513)] }, /513 characters, longer than 512/],
    ['semicolon in a term', { ...H, terms: ['a;b'] }, /contains ;/],
    ['pipe in a field value', { ...H, fields: { form_id: 'a|b' } }, /contains \|/],
    ['ampersand in a term', { ...H, terms: ['a&b'] }, /contains &/],
    ['command substitution in a term', { ...H, terms: ['$(id)'] }, /\$\(/],
    ['shell syntax in an exclude value', { terms: ['x'], exclude: ['a;b'] }, /an exclude value contains ;/],
    ['a single quote in a term', { terms: ["it's"] }, /a term contains a single quote/],
    ['a single quote in a message', { message: "can't find" }, /message contains a single quote/],
    ['a single quote in an exclude value', { terms: ['x'], exclude: ["o'brien"] }, /an exclude value contains a single quote/],
    ['a backslash in a term', { terms: ['a\\b'] }, /contains a backslash/],
    ['contains with a space', { contains: 'two words' }, /no spaces: a wildcard over several words returns 0 hits/],
    ['contains with a reserved character', { contains: 'a:b' }, /only letters, digits and _ \. @ -/],
    ['contains without raw_message in the field list', { contains: 'abc' }, /raw_message, which is not in the rtl field list/, RTL],
    ['denoise outside ssfb', { terms: ['x'], denoise: 'only' }, /denoise is for ssfb only/, RTL],
    ['denoise with_message without a message', { denoise: 'with_message' }, /needs message/],
  ];
  for (const [name, input, expected, cfg] of cases) {
    test(name, () => {
      expect(reason(input, cfg)).toMatch(expected);
    });
  }

  test('a UUID in a field is refused on rtl and atspl with the reason, and kept on ssfb', () => {
    for (const entity of ['rtl', 'atspl'] as const) {
      expect(reason({ fields: { customer_id: UUID } }, { ...RTL, entity })).toMatch(
        new RegExp(`fields.customer_id holds a UUID; on ${entity} search a UUID as a term`),
      );
    }
    expect(query({ fields: { form_id: UUID } })).toBe(`form_id:${UUID}`);
  });
});

describe('buildLogsQuery: query text', () => {
  const cases: [string, LogsQueryInput, string][] = [
    ['no service means no service clause', { terms: ['abc'] }, 'abc'],
    ['service is mapped to its log name', { service: 'workflow', terms: ['abc'] }, 'service:workflow-op AND abc'],
    ['the log name is accepted too', { service: 'workflow-op', terms: ['abc'] }, 'service:workflow-op AND abc'],
    ['level is lowercased', { ...H, level: 'ERROR', terms: ['abc'] }, 'service:harbor AND level:error AND abc'],
    ['message is the whole label in single quotes', { ...H, message: 'failed to pull form' }, "service:harbor AND 'failed to pull form'"],
    ['double quotes in a message need no escaping', { ...H, message: 'say "hi"' }, `service:harbor AND 'say "hi"'`],
    ['shell characters in message become spaces', { ...H, message: 'failed; retry | later' }, "service:harbor AND 'failed retry later'"],
    ['error is a per-word AND', { ...H, error: 'foo bar' }, 'service:harbor AND (error:foo AND error:bar)'],
    [
      'error punctuation splits words',
      { ...H, error: 'country code: cannot be null' },
      'service:harbor AND (error:country AND error:code AND error:cannot AND error:be AND error:null)',
    ],
    ['a boolean word in error is quoted', { ...H, error: 'NOT found' }, 'service:harbor AND (error:"NOT" AND error:found)'],
    ['a plain term goes bare', { terms: ['savingaccount'] }, 'savingaccount'],
    ['an underscore term goes bare', { terms: ['accounts_home_v2'] }, 'accounts_home_v2'],
    ['a dashed UUID term is sent whole in single quotes', { terms: [OWNER_UUID] }, `'${OWNER_UUID}'`],
    ['a term with spaces is single-quoted', { terms: ['a OR b'] }, "'a OR b'"],
    ['a colon in a term is single-quoted', { terms: ['level:error'] }, "'level:error'"],
    ['parentheses in a term are single-quoted', { terms: ['(a)'] }, "'(a)'"],
    ['a double quote in a term is single-quoted', { terms: ['a"b'] }, `'a"b'`],
    ['a bare OR term is quoted', { terms: ['OR'] }, "'OR'"],
    ['a leading dash is quoted, not an exclusion', { terms: ['-secret'] }, "'-secret'"],
    ['a wildcard in a term is literal', { terms: ['abc*'] }, "'abc*'"],
    ['terms are ANDed', { terms: ['a', 'b-c'] }, "a AND 'b-c'"],
    ['allowlisted hyphenated field goes bare', { fields: { 'x-req-id': 'r-1' } }, 'x-req-id:r-1'],
    ['x-device-id goes bare', { fields: { 'x-device-id': 'ab12-cd34' } }, 'x-device-id:ab12-cd34'],
    ['a UUID field value is kept whole on ssfb', { fields: { form_id: UUID } }, `form_id:${UUID}`],
    ['a field value with a space is single-quoted', { fields: { form_id: 'a b' } }, "form_id:'a b'"],
    ['a numeric range goes bare', { fields: { status_code: '[400 TO 599]' } }, 'status_code:[400 TO 599]'],
    ['contains is a raw_message wildcard', { contains: OWNER_UUID }, `raw_message:*${OWNER_UUID}*`],
    ['exclude is NOT per value', { terms: ['x'], exclude: ['a', 'b c'] }, "x AND NOT 'a' AND NOT 'b c'"],
    [
      'any_of levels',
      { ...H, message: 'CBS API error', any_of: [{ level: ['error', 'warn'] }] },
      "service:harbor AND 'CBS API error' AND (level:error OR level:warn)",
    ],
    [
      'any_of labels',
      { ...H, any_of: [{ message: ['package delivery failed', 'package webhook received'] }] },
      "service:harbor AND ('package delivery failed' OR 'package webhook received')",
    ],
    ['any_of id tokens', { any_of: [{ terms: [UUID, '3f2b1c4d'] }] }, `('${UUID}' OR 3f2b1c4d)`],
    [
      'any_of services, with a message',
      { message: 'generating challenge', any_of: [{ service: ['harbor', 'rhythm'] }] },
      "'generating challenge' AND (service:harbor OR service:rhythm)",
    ],
    ['a one-value any_of group needs no parentheses', { any_of: [{ terms: ['abc'] }] }, 'abc'],
    [
      'two any_of groups are ANDed',
      { any_of: [{ terms: ['a', 'b'] }, { level: ['error', 'warn'] }] },
      '(a OR b) AND (level:error OR level:warn)',
    ],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(query(input)).toBe(expected);
    });
  }

  test('parts are ANDed in a fixed order', () => {
    expect(
      query({
        ...H,
        level: 'warn',
        message: 'm',
        error: 'e',
        fields: { form_id: 'f1' },
        terms: ['t1'],
        contains: 'c1',
        any_of: [{ terms: ['o1', 'o2'] }],
        exclude: ['x1'],
      }),
    ).toBe("service:harbor AND level:warn AND 'm' AND (error:e) AND form_id:f1 AND t1 AND raw_message:*c1* AND (o1 OR o2) AND NOT 'x1'");
  });

  test("the owner's example query", () => {
    expect(
      query(
        { service: 'comms', exclude: ['Api execution completed', 'cache refresh completed'], terms: [OWNER_UUID] },
        { ...CFG, services: { comms: 'comms' } },
      ),
    ).toBe(`service:comms AND '${OWNER_UUID}' AND NOT 'Api execution completed' AND NOT 'cache refresh completed'`);
  });

  test('a UUID term on rtl is the quoted whole value', () => {
    expect(query({ service: 'comms', terms: [OWNER_UUID] }, RTL)).toBe(`service:comms-service AND '${OWNER_UUID}'`);
  });

  test('no note about a UUID cut any more', () => {
    expect(ok({ terms: [UUID] }).notes).toEqual([]);
  });

  test('error on workflow-op warns that the line is in message', () => {
    const r = ok({ service: 'workflow', error: 'timeout' });
    expect(r.notes).toEqual([expect.stringContaining('workflow-op logs the whole line in message')]);
    expect(ok({ ...H, error: 'timeout' }).notes).toEqual([]);
  });

  test('a phone search on guardian warns that guardian redacts phones', () => {
    const cfg: QuickwitGateConfig = { ...CFG, services: { ...CFG.services, guardian: 'guardian' } };
    const note = 'guardian redacts phone numbers in its lines (from, to, sim_card_number), so a phone search there can return 0 hits';
    for (const input of [
      { service: 'guardian', terms: ['9000012345'] },
      { service: 'guardian', terms: ['+91 90000 12345'] },
      { service: 'guardian', contains: '9000012345' },
      { service: 'guardian', message: 'otp sent', any_of: [{ terms: ['9000012345', '9000012346'] }] },
    ] as LogsQueryInput[]) {
      expect(ok(input, cfg).notes).toEqual([expect.stringContaining(note)]);
    }
    expect(ok({ service: 'guardian', terms: ['100200300400'] }, cfg).notes).toEqual([]);
    expect(ok({ service: 'harbor', terms: ['9000012345'] }, cfg).notes).toEqual([]);
  });

  test('no query ever starts with a dash or holds shell syntax', () => {
    for (const t of ['-x', 'AND', 'a:b', UUID, '(x)', 'a b', 'x$y']) {
      for (const input of [{ terms: [t] }, { terms: ['k'], exclude: [t] }, { any_of: [{ terms: [t, 'k'] }] }] as LogsQueryInput[]) {
        expect(qwSafeProblem(query(input))).toBeUndefined();
      }
    }
  });
});

describe('buildLogsQuery: denoise', () => {
  test('"only" builds the owner\'s filter exactly', () => {
    expect(query({ denoise: 'only' })).toBe(
      "((* AND NOT service:'kong'* AND NOT service:'kafka'* AND NOT 'Api execution completed') OR level:error)",
    );
    expect(query({ denoise: 'only' })).toBe(DENOISE_FILTER);
  });

  test('"with_message" ORs the message onto the filter exactly', () => {
    expect(query({ denoise: 'with_message', message: 'CBS API error' })).toBe(
      "((* AND NOT service:'kong'* AND NOT service:'kafka'* AND NOT 'Api execution completed') OR level:error) OR 'CBS API error'",
    );
  });

  test('other filters are ANDed with the whole expression', () => {
    expect(query({ denoise: 'with_message', message: 'CBS API error', fields: { form_id: UUID } })).toBe(
      `(${DENOISE_FILTER} OR 'CBS API error') AND form_id:${UUID}`,
    );
    expect(query({ ...H, denoise: 'only', terms: [OWNER_UUID] })).toBe(`service:harbor AND ${DENOISE_FILTER} AND '${OWNER_UUID}'`);
    expect(query({ denoise: 'only', message: 'm' })).toBe(`${DENOISE_FILTER} AND 'm'`);
  });

  test('the denoise query passes the qw argv check', () => {
    expect(qwSafeProblem(query({ denoise: 'with_message', message: 'x' }))).toBeUndefined();
  });
});

describe('buildLogsQuery: mode, paging and projection', () => {
  test('default: search, one page of 250, newest first, offset 0, the allowlist projection', () => {
    const r = ok({ ...H, terms: ['x'] });
    expect(r).toMatchObject({ mode: 'search', maxHits: PAGE_SIZE, order: 'newest', offset: 0, raw: false, columns: [], service: 'harbor', notes: [] });
    expect(r.fields).toEqual(CFG.fields);
    expect(r.groupBy).toBeUndefined();
    expect(r.countDistinct).toBeUndefined();
  });

  test('no service leaves service out of the result', () => {
    expect('service' in ok({ terms: ['x'] })).toBe(false);
  });

  test('count maps to mode count', () => {
    expect(ok({ ...H, terms: ['x'], count: true }).mode).toBe('count');
  });

  test('group_by maps to mode histogram with its fields; service is allowed', () => {
    expect(ok({ terms: ['x'], group_by: ['service'] })).toMatchObject({ mode: 'histogram', groupBy: ['service'] });
    expect(ok({ terms: ['x'], group_by: ['service', 'level', 'message', 'error'] }).groupBy).toEqual(['service', 'level', 'message', 'error']);
    const noService = { ...CFG, fields: CFG.fields.filter((f) => f !== 'service') };
    expect(ok({ terms: ['x'], group_by: ['service'] }, noService).groupBy).toEqual(['service']);
  });

  test('count_distinct maps to mode histogram, alone or with group_by', () => {
    expect(ok({ ...H, message: 'm', count_distinct: 'form_id' })).toMatchObject({ mode: 'histogram', countDistinct: 'form_id' });
    const both = ok({ ...H, message: 'm', group_by: ['level'], count_distinct: 'form_id' });
    expect(both).toMatchObject({ mode: 'histogram', groupBy: ['level'], countDistinct: 'form_id' });
  });

  test('order, offset, raw and columns are returned; columns join the projection once', () => {
    const r = ok({ ...H, terms: ['x'], order: 'oldest', offset: 250, raw: true, columns: ['status', 'User-Agent', 'status', 'message'] });
    expect(r).toMatchObject({ order: 'oldest', offset: 250, raw: true, columns: ['status', 'User-Agent', 'message'] });
    expect(r.fields).toEqual([...CFG.fields, 'status', 'User-Agent']);
  });

  test('max_hits under the page is kept', () => {
    expect(ok({ ...H, terms: ['x'], max_hits: 20 })).toMatchObject({ maxHits: 20, notes: [] });
  });

  test('max_hits above the page is clamped with a note', () => {
    const r = ok({ ...H, terms: ['x'], max_hits: 10_000 });
    expect(r.maxHits).toBe(250);
    expect(r.notes).toEqual([expect.stringContaining('clamped to 250')]);
  });

  test('a lower entity cap lowers the page', () => {
    expect(ok({ ...H, terms: ['x'] }, { ...CFG, maxHits: 50 }).maxHits).toBe(50);
  });

  test('max_hits equal to the page is not noted', () => {
    expect(ok({ ...H, terms: ['x'], max_hits: 250 })).toMatchObject({ maxHits: 250, notes: [] });
  });
});

describe('escapeTerm', () => {
  test('plain words pass through', () => {
    expect(escapeTerm('harbor-2')).toBe('harbor-2');
    expect(escapeTerm('and')).toBe('and');
  });
});

describe('normalizeMessage', () => {
  test('messages that differ only by ids and numbers fold into one', () => {
    const a = normalizeMessage('form 3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d failed for account 123456789 ref deadbeefdeadbeef00');
    const b = normalizeMessage('form 9a8b7c6d-5e4f-4a3b-9c1d-ffeeddccbbaa failed for account 987654321 ref 0123456789abcdef01');
    expect(a).toBe(b);
    expect(a).toBe('form <uuid> failed for account <num> ref <hex>');
  });

  test('short numbers are kept', () => {
    expect(normalizeMessage('HTTP 400 after 3 tries')).toBe('HTTP 400 after 3 tries');
  });

  test('different messages stay different', () => {
    expect(normalizeMessage('country code cannot be null')).not.toBe(normalizeMessage('AccountTypes is empty'));
  });

  test('empty forms get the empty label', () => {
    for (const s of ['', '  ', '{}', '{ }', 'null']) expect(normalizeMessage(s)).toBe(EMPTY_MESSAGE_LABEL);
  });

  test('surrounding whitespace is trimmed', () => {
    expect(normalizeMessage('  boom  ')).toBe('boom');
  });
});

describe('assertQwSafe', () => {
  const denied: [string, string][] = [
    ['newline', 'a\nb'],
    ['carriage return', 'a\rb'],
    ['NUL', 'a\u0000b'],
    ['tab', 'a\tb'],
    ['backtick', 'a`id`'],
    ['command substitution', 'a$(id)'],
    ['brace expansion', 'a${HOME}'],
    ['semicolon', 'a;b'],
    ['pipe', 'a|b'],
    ['ampersand', 'a&b'],
    ['leading dash', '--context=other'],
    ['single leading dash', '-o'],
    ['empty string', ''],
  ];
  for (const [name, value] of denied) {
    test(`refuses ${name}`, () => {
      expect(() => assertQwSafe(value)).toThrow(QwArgError);
      expect(qwSafeProblem(value)).toBeDefined();
    });
  }

  test('the error names the problem, not the value', () => {
    try {
      assertQwSafe('secret-value;rm');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QwArgError);
      expect((err as Error).message).not.toContain('secret-value');
    }
  });

  const allowed = ['search', 'logs-v1', '6h', 'ssfb-prod', 'json', "service:harbor AND 'a \"b\"' AND (error:x AND error:y)", DENOISE_FILTER, 'a-b', 'x$y'];
  for (const value of allowed) {
    test(`allows ${JSON.stringify(value)}`, () => {
      expect(() => assertQwSafe(value)).not.toThrow();
    });
  }
});

describe('quickwitGateConfig from the registry', () => {
  const home = makeTestHome({ entities: ['ssfb'], overrides: SSFB_QW_ENV });
  afterAll(() => home.cleanup());

  test('reads fields, services and the hit cap', () => {
    const cfg = quickwitGateConfig(home.registry, 'ssfb');
    if (cfg === undefined) throw new Error('expected SSFB quickwit to be configured in the test home');
    expect(cfg.maxHits).toBe(500);
    expect(cfg.fields).toContain('x-customer-id');
    expect(cfg.services.workflow).toBe('workflow-op');
    expect(cfg.services.finacle).toBeUndefined();
    expect(buildLogsQuery(cfg, { service: 'workflow', terms: ['abc'] })).toMatchObject({ ok: true, query: 'service:workflow-op AND abc' });
  });

  test('a lower MAX_HITS in the .env lowers the clamp', () => {
    const low = makeTestHome({ entities: ['ssfb'], overrides: { ...SSFB_QW_ENV, SSFB_QUICKWIT_MAX_HITS: '50' } });
    try {
      const cfg = quickwitGateConfig(low.registry, 'ssfb');
      expect(cfg && buildLogsQuery(cfg, { service: 'harbor', terms: ['x'], max_hits: 400 })).toMatchObject({ ok: true, maxHits: 50 });
      expect(cfg && buildLogsQuery(cfg, { terms: ['x'] })).toMatchObject({ ok: true, maxHits: 50 });
    } finally {
      low.cleanup();
    }
  });

  test('a blank transport means no gate config', () => {
    const off = makeTestHome({ entities: ['ssfb'], overrides: { SSFB_QUICKWIT_TRANSPORT: '' } });
    try {
      expect(quickwitGateConfig(off.registry, 'ssfb')).toBeUndefined();
    } finally {
      off.cleanup();
    }
  });
});

describe('purity', () => {
  // T02.8 adds a purity test over all of src/gate; this covers the two files
  // from this ticket until it lands.
  const FORBIDDEN = /from\s+['"](node:fs|node:net|node:child_process|node:http|node:https|pg|[^'"]*\/connectors\/[^'"]*)['"]/;
  for (const file of ['quickwit.ts', 'quickwit-window.ts']) {
    test(`${file} imports no I/O module`, () => {
      const src = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
      expect(src).not.toMatch(FORBIDDEN);
      expect(src).not.toMatch(/\bfetch\(|\bBun\.|bun:/);
      const imports = [...src.matchAll(/^import\s+(type\s+)?.*from\s+['"]([^'"]+)['"]/gm)];
      for (const m of imports) {
        // Anything that is not a type-only import must be another pure module.
        if (m[1] === undefined) expect(m[2]).toMatch(/^\.\.?\/(?!connectors)/);
      }
    });
  }
});
