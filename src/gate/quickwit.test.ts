import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeTestHome, SSFB_QW_ENV } from '../../test/support/home.ts';
import {
  EMPTY_MESSAGE_LABEL,
  MAX_TERMS,
  QwArgError,
  assertQwSafe,
  buildLogsQuery,
  escapeTerm,
  normalizeMessage,
  qwSafeProblem,
  quickwitGateConfig,
  type LogsQueryInput,
  type LogsQueryResult,
  type QuickwitGateConfig,
} from './quickwit.ts';

// Synthetic config shaped like the SSFB registry entry.
const CFG: QuickwitGateConfig = {
  entity: 'ssfb',
  fields: ['service', 'level', 'message', 'error', 'raw_message', 'timestamp', 'x-req-id', 'form_id'],
  services: { harbor: 'harbor', workflow: 'workflow-op', finacle: undefined },
  maxHits: 500,
};

const UUID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function build(input: Partial<LogsQueryInput>): LogsQueryResult {
  return buildLogsQuery(CFG, { service: 'harbor', ...input });
}

function query(input: Partial<LogsQueryInput>): string {
  const r = build(input);
  if (!r.ok) throw new Error(`expected a query, got refusal: ${r.reason}`);
  return r.query;
}

function reason(input: Partial<LogsQueryInput>): string {
  const r = build(input);
  if (r.ok) throw new Error(`expected a refusal, got query: ${r.query}`);
  return r.reason;
}

describe('buildLogsQuery: refusals', () => {
  const cases: [string, Partial<LogsQueryInput>, RegExp][] = [
    ['service alone', {}, /selective/],
    ['service and level only', { level: 'error' }, /selective/],
    ['unknown service', { service: 'nope', terms: ['x'] }, /unknown service "nope".*harbor, workflow/],
    ['service without a log name', { service: 'finacle', terms: ['x'] }, /finacle has no log service name/],
    ['unknown field', { fields: { customer_id: 'abc' } }, /unknown field "customer_id"/],
    ['service via fields', { fields: { service: 'rhythm' } }, /use the service input/],
    ['timestamp via fields', { fields: { timestamp: '2026' } }, /from\/to/],
    ['unknown group_by', { terms: ['x'], group_by: 'secret' }, /unknown group_by field "secret"/],
    ['count and group_by together', { terms: ['x'], count: true, group_by: 'message' }, /not both/],
    ['max_hits zero', { terms: ['x'], max_hits: 0 }, /whole number/],
    ['max_hits fractional', { terms: ['x'], max_hits: 2.5 }, /whole number/],
    ['level with spaces', { terms: ['x'], level: 'error OR 1' }, /single word/],
    ['empty term', { terms: ['  '] }, /empty/],
    ['empty message', { message: '' }, /empty/],
    ['message of only punctuation', { message: ';;;' }, /no searchable text/],
    ['error with no words', { error: '!!' }, /no searchable words/],
    ['newline in a term', { terms: ['a\nb'] }, /control character/],
    ['NUL in a field value', { fields: { form_id: 'a\u0000b' } }, /control character/],
    ['too many terms', { terms: Array.from({ length: MAX_TERMS + 1 }, (_, i) => `t${i}`) }, /at most/],
    ['over-long value', { terms: ['x'.repeat(513)] }, /longer than/],
    ['semicolon in a term', { terms: ['a;b'] }, /contains ;/],
    ['pipe in a field value', { fields: { form_id: 'a|b' } }, /contains \|/],
    ['ampersand in a term', { terms: ['a&b'] }, /contains &/],
    ['command substitution in a term', { terms: ['$(id)'] }, /\$\(/],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(reason(input)).toMatch(expected);
    });
  }
});

describe('buildLogsQuery: query text', () => {
  const cases: [string, Partial<LogsQueryInput>, string][] = [
    ['service is mapped to its log name', { service: 'workflow', terms: ['abc'] }, 'service:workflow-op AND abc'],
    ['the log name is accepted too', { service: 'workflow-op', terms: ['abc'] }, 'service:workflow-op AND abc'],
    ['level is lowercased', { level: 'ERROR', terms: ['abc'] }, 'service:harbor AND level:error AND abc'],
    ['message is a phrase', { message: 'failed to pull form' }, 'service:harbor AND message:"failed to pull form"'],
    ['quotes and backslashes in message are escaped', { message: 'say "hi" \\ bye' }, 'service:harbor AND message:"say \\"hi\\" \\\\ bye"'],
    ['shell characters in message become spaces', { message: 'failed; retry | later' }, 'service:harbor AND message:"failed retry later"'],
    ['error is a per-word AND', { error: 'foo bar' }, 'service:harbor AND (error:foo AND error:bar)'],
    [
      'error punctuation splits words',
      { error: 'country code: cannot be null' },
      'service:harbor AND (error:country AND error:code AND error:cannot AND error:be AND error:null)',
    ],
    ['a boolean word in error is quoted', { error: 'NOT found' }, 'service:harbor AND (error:"NOT" AND error:found)'],
    ['allowlisted hyphenated field goes bare', { fields: { 'x-req-id': 'r-1' } }, 'service:harbor AND x-req-id:r-1'],
    ['a UUID term is cut to its first segment', { terms: [UUID] }, 'service:harbor AND 3f2b1c4d'],
    ['a UUID field value is kept whole', { fields: { form_id: UUID } }, `service:harbor AND form_id:${UUID}`],
    ['colon in a term is escaped', { terms: ['level:error'] }, 'service:harbor AND level\\:error'],
    ['parentheses in a term are escaped', { terms: ['(a)'] }, 'service:harbor AND \\(a\\)'],
    ['a quote in a term is escaped', { terms: ['a"b'] }, 'service:harbor AND a\\"b'],
    ['a backslash in a term is escaped', { terms: ['a\\b'] }, 'service:harbor AND a\\\\b'],
    ['a space in a term is escaped', { terms: ['a OR b'] }, 'service:harbor AND a\\ OR\\ b'],
    ['a bare OR term is quoted', { terms: ['OR'] }, 'service:harbor AND "OR"'],
    ['a bare AND term is quoted', { terms: ['AND'] }, 'service:harbor AND "AND"'],
    ['a leading dash is quoted, not an exclusion', { terms: ['-secret'] }, 'service:harbor AND "-secret"'],
    ['wildcards are escaped', { terms: ['abc*'] }, 'service:harbor AND abc\\*'],
    ['range brackets are escaped', { terms: ['[a TO b]'] }, 'service:harbor AND \\[a\\ TO\\ b\\]'],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(query(input)).toBe(expected);
    });
  }

  test('parts are ANDed in a fixed order', () => {
    expect(query({ level: 'warn', message: 'm', error: 'e', fields: { form_id: 'f1' }, terms: ['t1'] })).toBe(
      'service:harbor AND level:warn AND message:"m" AND (error:e) AND form_id:f1 AND t1',
    );
  });

  test('the UUID cut adds a note', () => {
    const r = build({ terms: [UUID] });
    expect(r.ok && r.notes.some((n) => n.includes('first segment (3f2b1c4d)'))).toBe(true);
  });

  test('no query ever starts with a dash or holds shell syntax', () => {
    for (const t of ['-x', 'AND', 'a:b', UUID, '(x)', 'a b']) {
      const q = query({ terms: [t] });
      expect(qwSafeProblem(q)).toBeUndefined();
    }
  });
});

describe('buildLogsQuery: mode, max_hits and projection', () => {
  test('default mode is search with the entity cap', () => {
    const r = build({ terms: ['x'] });
    expect(r).toMatchObject({ ok: true, mode: 'search', maxHits: 500, service: 'harbor', notes: [] });
    expect(r.ok && r.fields).toEqual(CFG.fields);
  });

  test('count maps to mode count', () => {
    expect(build({ terms: ['x'], count: true })).toMatchObject({ ok: true, mode: 'count' });
  });

  test('group_by maps to mode histogram on an allowlisted field', () => {
    const r = build({ terms: ['x'], group_by: 'message' });
    expect(r).toMatchObject({ ok: true, mode: 'histogram', groupBy: 'message' });
  });

  test('max_hits under the cap is kept', () => {
    expect(build({ terms: ['x'], max_hits: 20 })).toMatchObject({ ok: true, maxHits: 20, notes: [] });
  });

  test('max_hits above the cap is clamped with a note', () => {
    const r = build({ terms: ['x'], max_hits: 10_000 });
    expect(r).toMatchObject({ ok: true, maxHits: 500 });
    expect(r.ok && r.notes.some((n) => n.includes('clamped to 500'))).toBe(true);
  });

  test('max_hits equal to the cap is not noted', () => {
    expect(build({ terms: ['x'], max_hits: 500 })).toMatchObject({ ok: true, maxHits: 500, notes: [] });
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

  const allowed = ['search', 'logs-v1', '6h', 'ssfb-prod', 'json', 'service:harbor AND message:"a \\"b\\"" AND (error:x AND error:y)', 'a-b', 'x$y'];
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
