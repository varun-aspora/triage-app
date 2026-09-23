import { describe, expect, test } from 'bun:test';
import {
  SemanticKeyError,
  canonicalJson,
  canonicalPath,
  hashKeyString,
  keyHash,
  keyString,
  semanticKey,
  type SemanticKeyFacts,
} from './key.ts';
import { FIXTURE_KINDS, type FixtureKind } from './types.ts';

type Case<K extends FixtureKind> = { kind: K; a: SemanticKeyFacts[K]; b: SemanticKeyFacts[K] };
type AnyCase = { [K in FixtureKind]: Case<K> }[FixtureKind];

// For each kind, two sets of facts that ask the same question in a different order or spelling.
const SAME: readonly AnyCase[] = [
  {
    kind: 'sql_select',
    a: { entity: 'atspl', service: 'package', tables: ['delivery_requests', 'vendors'], params: ['c-1', 7, null] },
    b: { entity: 'atspl', service: ' package ', tables: ['vendors', 'delivery_requests', 'vendors'], params: [null, '7', 'c-1'] },
  },
  {
    kind: 'http_call',
    a: { entity: 'ssfb', service: 'harbor', method: 'get', path: '/admin/v1/users/U-42/', query: { b: '2', a: ['1', '0'] } },
    b: { entity: 'ssfb', service: 'harbor', method: 'GET', path: '//admin//v1/users/U-42', query: [['a', '0'], ['b', 2], ['a', '1']] },
  },
  {
    kind: 'logs_search',
    a: { entity: 'rtl', service: 'workflow', terms: ['form-9', 'ERROR', 'form-9'], mode: 'count', group_by: 'level' },
    b: { entity: 'rtl', service: 'workflow', terms: [' ERROR', 'form-9', ''], mode: 'count', group_by: 'level ' },
  },
  {
    kind: 'resolve_identity',
    a: { ids: { user_id: 'u-1', form_id: 'f-2' } },
    b: { ids: [['form_id', 'f-2 '], ['user_id', 'u-1'], ['form_id', 'f-2'], ['phone', '']] },
  },
  {
    kind: 'get_account_statement',
    a: { entity: 'ssfb', account_id: 'A-1', from: '2026-09-01', to: '2026-09-20', page: 2 },
    b: { page: 2, to: '2026-09-20', from: '2026-09-01', account_id: ' A-1', entity: 'ssfb' },
  },
  {
    kind: 'detect_silent_reversals',
    a: { entity: 'ssfb', account_id: 'A-1', customer_id: 'C-1', since: '2026-09-01', limit: 50 },
    b: { limit: 50, since: '2026-09-01', customer_id: 'C-1', account_id: 'A-1', entity: 'ssfb' },
  },
  {
    kind: 'cbs_call',
    a: { entity: 'ssfb', method: 'post', path: '/finacle/accounts/A-1/', body: { b: 1, a: { y: 2, x: 1 } } },
    b: { entity: 'ssfb', method: 'POST', path: '/finacle//accounts/A-1', body: { a: { x: 1, y: 2 }, b: 1 } },
  },
  {
    kind: 'slack_read',
    a: { channel: 'C0TEST', thread_ts: '1726000000.000100' },
    b: { thread_ts: '1726000000.000100 ', channel: 'C0TEST' },
  },
  {
    kind: 'slack_user',
    a: { email: 'reviewer@example.test' },
    b: { email: ' Reviewer@Example.TEST ' },
  },
  {
    kind: 'doctor_probe',
    a: { entity: 'ssfb', probe: 'db:harbor' },
    b: { probe: 'db:harbor', entity: 'ssfb' },
  },
  {
    kind: 'field_crypto',
    a: { op: 'encrypt', kind: 'phone', values: ['+919000000001'] },
    b: { values: ['+919000000001'], kind: 'phone', op: 'encrypt' },
  },
  {
    kind: 'code_query',
    a: { repo: 'harbor', command: 'callers', query: 'ReverseTransfer' },
    b: { query: ' ReverseTransfer ', command: 'callers', repo: 'harbor' },
  },
];

function build<K extends FixtureKind>(kind: K, facts: SemanticKeyFacts[K]) {
  const key = semanticKey(kind, facts);
  return { key, key_string: keyString(key), hash: keyHash(key) };
}

describe('semanticKey order-insensitivity', () => {
  test('the table covers every kind', () => {
    expect(SAME.map((c) => c.kind).sort()).toEqual([...FIXTURE_KINDS].sort());
  });

  for (const c of SAME) {
    test(`${c.kind}: same facts in a different order give the same key_string and hash`, () => {
      const a = build(c.kind, c.a as never);
      const b = build(c.kind, c.b as never);
      expect(b.key_string).toBe(a.key_string);
      expect(b.hash).toBe(a.hash);
      expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    });

    test(`${c.kind}: a normalised key passed back in gives itself`, () => {
      const a = build(c.kind, c.a as never);
      expect(keyString(semanticKey(c.kind, a.key as never))).toBe(a.key_string);
    });

    test(`${c.kind}: building does not change the facts`, () => {
      const before = JSON.stringify(c.a);
      build(c.kind, c.a as never);
      expect(JSON.stringify(c.a)).toBe(before);
    });
  }
});

const sqlBase = { entity: 'atspl', service: 'package', tables: ['delivery_requests'], params: ['c-1'] } as const;
const httpBase = { entity: 'ssfb', service: 'harbor', method: 'GET', path: '/admin/v1/users/U-42', query: { a: '1' } } as const;
const logsBase = { entity: 'ssfb', service: 'harbor', terms: ['form-9'], mode: 'search' } as const;

describe('semanticKey differences', () => {
  const variants: [string, () => string, () => string][] = [
    ['sql tables', () => keyHash(semanticKey('sql_select', sqlBase)), () =>
      keyHash(semanticKey('sql_select', { ...sqlBase, tables: ['delivery_requests', 'vendors'] }))],
    ['sql param value', () => keyHash(semanticKey('sql_select', sqlBase)), () =>
      keyHash(semanticKey('sql_select', { ...sqlBase, params: ['c-2'] }))],
    ['sql extra param', () => keyHash(semanticKey('sql_select', sqlBase)), () =>
      keyHash(semanticKey('sql_select', { ...sqlBase, params: ['c-1', 'c-1'] }))],
    ['sql service', () => keyHash(semanticKey('sql_select', sqlBase)), () =>
      keyHash(semanticKey('sql_select', { ...sqlBase, service: 'kyc' }))],
    ['sql entity', () => keyHash(semanticKey('sql_select', sqlBase)), () =>
      keyHash(semanticKey('sql_select', { ...sqlBase, entity: 'rtl' }))],
    ['sql null param vs empty text', () => keyHash(semanticKey('sql_select', { ...sqlBase, params: [null] })), () =>
      keyHash(semanticKey('sql_select', { ...sqlBase, params: [''] }))],
    ['http method', () => keyHash(semanticKey('http_call', httpBase)), () =>
      keyHash(semanticKey('http_call', { ...httpBase, method: 'POST' }))],
    ['http path id', () => keyHash(semanticKey('http_call', httpBase)), () =>
      keyHash(semanticKey('http_call', { ...httpBase, path: '/admin/v1/users/U-43' }))],
    ['http path case', () => keyHash(semanticKey('http_call', httpBase)), () =>
      keyHash(semanticKey('http_call', { ...httpBase, path: '/admin/v1/users/u-42' }))],
    ['http query value', () => keyHash(semanticKey('http_call', httpBase)), () =>
      keyHash(semanticKey('http_call', { ...httpBase, query: { a: '2' } }))],
    ['http query key', () => keyHash(semanticKey('http_call', httpBase)), () =>
      keyHash(semanticKey('http_call', { ...httpBase, query: { b: '1' } }))],
    ['http no query', () => keyHash(semanticKey('http_call', httpBase)), () =>
      keyHash(semanticKey('http_call', { ...httpBase, query: undefined }))],
    ['logs terms', () => keyHash(semanticKey('logs_search', logsBase)), () =>
      keyHash(semanticKey('logs_search', { ...logsBase, terms: ['form-9', 'ERROR'] }))],
    ['logs mode', () => keyHash(semanticKey('logs_search', logsBase)), () =>
      keyHash(semanticKey('logs_search', { ...logsBase, mode: 'count' }))],
    ['logs group_by', () => keyHash(semanticKey('logs_search', logsBase)), () =>
      keyHash(semanticKey('logs_search', { ...logsBase, mode: 'count', group_by: 'level' }))],
    ['identity value', () => keyHash(semanticKey('resolve_identity', { ids: { user_id: 'u-1' } })), () =>
      keyHash(semanticKey('resolve_identity', { ids: { user_id: 'u-2' } }))],
    ['identity hop', () => keyHash(semanticKey('resolve_identity', { ids: { user_id: 'u-1' } })), () =>
      keyHash(semanticKey('resolve_identity', { hop: 'harbor_customer', ids: { user_id: 'u-1' } }))],
    ['statement page', () => keyHash(semanticKey('get_account_statement', { entity: 'ssfb', account_id: 'A-1' })), () =>
      keyHash(semanticKey('get_account_statement', { entity: 'ssfb', account_id: 'A-1', page: 1 }))],
    ['reversals customer', () =>
      keyHash(semanticKey('detect_silent_reversals', { entity: 'ssfb', account_id: 'A-1', customer_id: 'C-1' })), () =>
      keyHash(semanticKey('detect_silent_reversals', { entity: 'ssfb', account_id: 'A-1', customer_id: 'C-2' }))],
    ['cbs body', () => keyHash(semanticKey('cbs_call', { entity: 'ssfb', method: 'POST', path: '/x', body: { a: 1 } })), () =>
      keyHash(semanticKey('cbs_call', { entity: 'ssfb', method: 'POST', path: '/x', body: { a: 2 } }))],
    ['slack thread', () => keyHash(semanticKey('slack_read', { channel: 'C1', thread_ts: '1.1' })), () =>
      keyHash(semanticKey('slack_read', { channel: 'C1', thread_ts: '1.2' }))],
    ['doctor probe', () => keyHash(semanticKey('doctor_probe', { entity: 'ssfb', probe: 'db:harbor' })), () =>
      keyHash(semanticKey('doctor_probe', { entity: 'ssfb', probe: 'db:rhythm' }))],
  ];

  for (const [name, a, b] of variants) {
    test(`${name} changes the hash`, () => {
      expect(b()).not.toBe(a());
    });
  }

  test('sql table order and param order alone do not change the hash', () => {
    const a = semanticKey('sql_select', { ...sqlBase, tables: ['a', 'b'], params: ['1', '2'] });
    const b = semanticKey('sql_select', { ...sqlBase, tables: ['b', 'a'], params: ['2', '1'] });
    expect(keyHash(b)).toBe(keyHash(a));
  });
});

describe('http_call normalisation', () => {
  test('method is upper-cased, trailing and duplicate slashes go, ids stay', () => {
    const key = semanticKey('http_call', { ...httpBase, method: 'get', path: 'admin//v1/users/U-42/' });
    expect(key.method).toBe('GET');
    expect(key.path).toBe('/admin/v1/users/U-42');
    expect(key.query).toEqual([['a', '1']]);
  });

  test('canonicalPath keeps the root and case', () => {
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath('//')).toBe('/');
    expect(canonicalPath('/A/b//C/')).toBe('/A/b/C');
  });

  test('an unknown method is refused', () => {
    expect(() => semanticKey('http_call', { ...httpBase, method: 'TRACE' })).toThrow(SemanticKeyError);
  });
});

describe('logs_search key', () => {
  test('carries no transport field, so qw and http resolve to one fixture', () => {
    const facts = { entity: 'ssfb', service: 'harbor', terms: ['form-9', 'ERROR'], mode: 'search' } as const;
    const key = semanticKey('logs_search', facts);
    expect('transport' in key).toBe(false);
    expect(keyString(key)).toBe('{"entity":"ssfb","mode":"search","service":"harbor","terms":["ERROR","form-9"]}');
    // A transport the caller leaves on its facts object is not part of the key.
    const withTransport = semanticKey('logs_search', { ...facts, transport: 'qw' } as never);
    expect('transport' in withTransport).toBe(false);
    expect(keyHash(withTransport)).toBe(keyHash(key));
  });
});

describe('errors and canonical JSON', () => {
  test('invalid facts raise SemanticKeyError naming the field, not the value', () => {
    let err: unknown;
    try {
      semanticKey('sql_select', { ...sqlBase, tables: [], service: 'SECRET-SERVICE-XYZ' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SemanticKeyError);
    expect((err as Error).message).toContain('tables');
    expect((err as Error).message).not.toContain('SECRET-SERVICE-XYZ');
  });

  test('an unknown kind is refused', () => {
    expect(() => semanticKey('shell' as never, {} as never)).toThrow(SemanticKeyError);
  });

  test('canonicalJson sorts keys at every depth and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
  });

  test('canonicalJson refuses values JSON cannot round-trip', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
  });

  test('the hash is sha256 of key_string cut to 16 hex characters', () => {
    // sha256("{}") = 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
    expect(hashKeyString('{}')).toBe('44136fa355b3678a');
    expect(keyHash({})).toBe('44136fa355b3678a');
  });
});
