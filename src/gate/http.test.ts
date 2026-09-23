import { describe, expect, test } from 'bun:test';
import {
  buildHeaders,
  buildUrl,
  checkCbsPath,
  decideHttp,
  HTTP_REFUSAL_CODES,
  type HttpDecisionInput,
  type HttpRefusal,
} from './http.ts';
import { validateRules, type ApiRule } from './rules.ts';

const BASE = 'https://harbor.example.test';
const FORM_ID = '3f2b8c1e-9a4d-4e21-b7a0-5c6d7e8f9a01';

function refusal(result: unknown): HttpRefusal {
  const r = result as { ok: boolean };
  expect(r.ok).toBe(false);
  const refused = result as HttpRefusal;
  expect(HTTP_REFUSAL_CODES).toContain(refused.code);
  expect(refused.message.length).toBeGreaterThan(0);
  expect(refused.message.length).toBeLessThan(160);
  return refused;
}

function built(result: ReturnType<typeof buildUrl>) {
  if (!result.ok) throw new Error(`expected a URL, got ${result.code}: ${result.message}`);
  return result;
}

function rules(raw: unknown[]): readonly ApiRule[] {
  const result = validateRules(raw, ['harbor', 'bro', 'rhythm', 'finacle']);
  expect(result.errors).toEqual([]);
  return result.rules;
}

function decide(over: Partial<HttpDecisionInput>) {
  return decideHttp({ tool: 'http_call', service: 'harbor', method: 'GET', path: '/', base: BASE, rules: [], ...over });
}

// ---------------------------------------------------------------- buildUrl

describe('buildUrl path checks', () => {
  const denied: readonly string[] = [
    '../x',
    '/a/../../b',
    '/a/..',
    '/a/%2e%2e/b',
    '/a/%2E%2E/b',
    '/a/%2e/b',
    '/a/%2F/b',
    '/a/%2f/b',
    '/a%5Cb',
    '/a%5cb',
    '/a\\b',
    '/a%00',
    '/a\u0000',
    '/a\r\nHost: x',
    '/a\tb',
    '/a b',
    'http://evil/x',
    'https:x',
    'HTTPS://evil/x',
    'javascript:alert(1)',
    '//evil.com/x',
    '/a//b',
    '/@evil.com',
    '/api/v1#@evil.com',
    '/api/v1%23x',
    '/api/v1?x=1',
    '/api/v1%3Fx=1',
    '/api/v1%40evil.com',
    '/api/v1;jsessionid=x',
    '/api/v1%3bx',
    '/api/v1%252e%252e',
    '/api/v1%0d%0aHost:x',
    '/api/v1%zz',
    '/api/v1%2',
    '/api/v1/',
    'x/relative',
    '',
    `/${'a'.repeat(2048)}`,
  ];

  for (const path of denied) {
    test(`deny: ${JSON.stringify(path)} is refused`, () => {
      const r = refusal(buildUrl(BASE, path));
      expect(r.code).toBe('bad_path');
    });
  }

  test('messages never echo the rejected path', () => {
    const r = refusal(buildUrl(BASE, '/a\r\nHost: evil.example'));
    expect(r.message).not.toContain('evil');
    expect(r.message).not.toContain('\n');
  });

  test('a plain path builds on the base origin', () => {
    const r = built(buildUrl(BASE, `/admin/v1/forms/${FORM_ID}`));
    expect(r.url.href).toBe(`${BASE}/admin/v1/forms/${FORM_ID}`);
    expect(r.pathname).toBe(`/admin/v1/forms/${FORM_ID}`);
  });

  test("single '.' segments are resolved, so the pathname is canonical", () => {
    const r = built(buildUrl(BASE, '/a/./b'));
    expect(r.pathname).toBe('/a/b');
  });

  test("the root path '/' is allowed", () => {
    expect(built(buildUrl(BASE, '/')).pathname).toBe('/');
  });
});

describe('buildUrl base prefix', () => {
  test("deny: base 'https://h/api' refuses '/apix/v1' and accepts '/api/v1'", () => {
    expect(refusal(buildUrl('https://h/api', '/apix/v1')).code).toBe('outside_base');
    expect(refusal(buildUrl('https://h/api', '/other/v1')).code).toBe('outside_base');
    expect(refusal(buildUrl('https://h/api', '/')).code).toBe('outside_base');
    expect(built(buildUrl('https://h/api', '/api/v1')).url.href).toBe('https://h/api/v1');
    expect(built(buildUrl('https://h/api', '/api')).pathname).toBe('/api');
  });

  test('a base with a trailing slash means the same prefix', () => {
    expect(refusal(buildUrl('https://h/api/', '/apix/v1')).code).toBe('outside_base');
    expect(built(buildUrl('https://h/api/', '/api/v1')).pathname).toBe('/api/v1');
  });

  test('deny: a path prefix cannot be escaped through a fragment or query in the path', () => {
    for (const path of ['/api/v1#@evil.com', '/api#/../x', '/api?/../x', '/api/v1%23x', '/api/v1?x=1', '/x#/api/v1', '/x?/api']) {
      const r = refusal(buildUrl('https://h/api', path));
      expect(['bad_path', 'outside_base']).toContain(r.code);
    }
  });

  test('deny: base origin with a port is preserved and cannot be changed', () => {
    const base = 'https://h:8443/api';
    const ok = built(buildUrl(base, '/api/v1'));
    expect(ok.url.host).toBe('h:8443');
    expect(ok.url.port).toBe('8443');
    for (const path of ['//h:9999/api/v1', 'https://h:9999/api/v1', '/api/v1@h:9999', '/api:9999/v1@evil']) {
      refusal(buildUrl(base, path));
    }
  });

  test('deny: a base with credentials, a query, a fragment or another scheme is refused', () => {
    expect(refusal(buildUrl('https://user:pw@h/api', '/api/v1')).code).toBe('bad_base');
    expect(refusal(buildUrl('https://h/api?x=1', '/api/v1')).code).toBe('bad_base');
    expect(refusal(buildUrl('https://h/api#x', '/api/v1')).code).toBe('bad_base');
    expect(refusal(buildUrl('file:///etc', '/passwd')).code).toBe('bad_base');
    expect(refusal(buildUrl('not a url', '/x')).code).toBe('bad_base');
  });

  test('bad_base messages do not echo the base', () => {
    const r = refusal(buildUrl('https://user:secret@h/api', '/api/v1'));
    expect(r.message).not.toContain('secret');
    expect(r.message).not.toContain('h/api');
  });

  test('a URL object base works the same as a string', () => {
    expect(built(buildUrl(new URL('https://h/api'), '/api/v1')).url.href).toBe('https://h/api/v1');
  });
});

describe('buildUrl host binding', () => {
  const bases = ['http://[::1]:8080/api', 'https://h:8443/api', 'https://h/api'];
  const attempts: readonly string[] = [
    '/api/v1',
    '/api/v1/x',
    '/api/./v1',
    '/api/v1/../../x',
    '//evil.com/api',
    '/\\evil.com/api',
    '/api/v1@evil.com',
    '/api@evil.com:80/v1',
    '/api/v1#@evil.com',
    '/api/v1%40evil.com',
    'http://evil.com/api',
    'http:/evil.com/api',
    'http:evil.com/api',
    '\\\\evil.com\\api',
    '/api\t/v1',
    '/api/v1\n@evil.com',
    '/[::2]/api',
    '/api/[::2]:9/v1',
    'https://user:pw@h/api',
  ];

  for (const base of bases) {
    test(`deny: every accepted path keeps the host, port and empty userinfo of ${base}`, () => {
      const b = new URL(base);
      let accepted = 0;
      for (const path of attempts) {
        const r = buildUrl(base, path);
        if (!r.ok) continue;
        accepted += 1;
        expect(r.url.origin).toBe(b.origin);
        expect(r.url.host).toBe(b.host);
        expect(r.url.port).toBe(b.port);
        expect(r.url.username).toBe('');
        expect(r.url.password).toBe('');
        expect(r.url.hash).toBe('');
        expect(r.pathname === '/api' || r.pathname.startsWith('/api/')).toBe(true);
      }
      expect(accepted).toBeGreaterThan(0);
    });
  }

  test('an IPv6 base keeps its bracketed host and port', () => {
    const r = built(buildUrl('http://[::1]:8080/api', '/api/v1/x'));
    expect(r.url.href).toBe('http://[::1]:8080/api/v1/x');
    expect(r.url.hostname).toBe('[::1]');
    expect(r.url.port).toBe('8080');
  });
});

describe('buildUrl query', () => {
  test('deny: a query key with & or = is refused', () => {
    expect(refusal(buildUrl(BASE, '/x', { 'a&b': '1' })).code).toBe('bad_query');
    expect(refusal(buildUrl(BASE, '/x', { 'a=b': '1' })).code).toBe('bad_query');
    expect(refusal(buildUrl(BASE, '/x', { 'a b': '1' })).code).toBe('bad_query');
    expect(refusal(buildUrl(BASE, '/x', { '': '1' })).code).toBe('bad_query');
    expect(refusal(buildUrl(BASE, '/x', { 'a#': '1' })).code).toBe('bad_query');
  });

  test('deny: a query value with & is encoded, not split', () => {
    const r = built(buildUrl(BASE, '/x', { q: 'a&admin=true' }));
    expect(r.url.search).toBe('?q=a%26admin%3Dtrue');
    expect([...r.url.searchParams.keys()]).toEqual(['q']);
    expect(r.url.searchParams.get('q')).toBe('a&admin=true');
  });

  test('values with # or newlines stay inside the value', () => {
    const r = built(buildUrl(BASE, '/x', { q: '#frag\r\nHost: x' }));
    expect(r.url.hash).toBe('');
    expect(r.url.searchParams.get('q')).toBe('#frag\r\nHost: x');
  });

  test('allowed keys, numbers, booleans and repeated values', () => {
    const r = built(buildUrl(BASE, '/x', { 'ids[]': ['a', 'b'], page_no: 2, 'x.y-z': true }));
    expect(r.url.search).toBe('?ids%5B%5D=a&ids%5B%5D=b&page_no=2&x.y-z=true');
    expect(r.pathname).toBe('/x');
  });

  test('deny: non-scalar or non-finite values, too many params or an overlong value are refused', () => {
    expect(refusal(buildUrl(BASE, '/x', { a: { b: 1 } as never })).code).toBe('bad_query');
    expect(refusal(buildUrl(BASE, '/x', { a: Number.NaN })).code).toBe('bad_query');
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, '1']));
    expect(refusal(buildUrl(BASE, '/x', many)).code).toBe('bad_query');
    expect(refusal(buildUrl(BASE, '/x', { a: 'x'.repeat(2049) })).code).toBe('bad_query');
  });

  test('an empty query adds no ?', () => {
    expect(built(buildUrl(BASE, '/x', {})).url.href).toBe(`${BASE}/x`);
  });
});

// ------------------------------------------------------------ buildHeaders

describe('buildHeaders', () => {
  const chain = (customer_id?: string) => ({ ids: customer_id === undefined ? {} : { customer_id } });

  test('sets the customer header from the IdChain customer_id', () => {
    const r = buildHeaders({ customerHeader: 'x-customer-id', idChain: chain('CUST-123abc') });
    if (!r.ok) throw new Error(r.message);
    expect(r.headers).toEqual({ 'x-customer-id': 'CUST-123abc' });
  });

  test('sets registry auth', () => {
    const r = buildHeaders({
      auth: { header: 'Authorization', scheme: 'Bearer', token: 'tok.en-1_2' },
      idChain: chain(),
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.headers).toEqual({ authorization: 'Bearer tok.en-1_2' });
  });

  test('no customer header without a registry customer_header or without a customer_id', () => {
    const noHeader = buildHeaders({ idChain: chain('CUST-1') });
    const noId = buildHeaders({ customerHeader: 'x-customer-id', idChain: chain() });
    if (!noHeader.ok || !noId.ok) throw new Error('expected headers');
    expect(noHeader.headers).toEqual({});
    expect(noId.headers).toEqual({});
  });

  for (const bad of ['CUST 1', 'CUST\n1', 'CUST;1', 'CUST\r\nHost: x', 'a,b', 'a:b', 'ü']) {
    test(`deny: IdChain customer_id ${JSON.stringify(bad)} -> header refused`, () => {
      const r = refusal(buildHeaders({ customerHeader: 'x-customer-id', idChain: chain(bad) }));
      expect(r.code).toBe('bad_customer_id');
      expect(r.message).not.toContain(bad);
    });
  }

  test('deny: a token with a newline or space is refused and not echoed', () => {
    for (const token of ['abc\r\nX-Evil: 1', 'abc def', '']) {
      const r = refusal(buildHeaders({ auth: { header: 'Authorization', scheme: 'Bearer', token }, idChain: chain() }));
      expect(r.code).toBe('bad_auth');
      if (token !== '') expect(r.message).not.toContain('abc');
    }
  });

  test('deny: bad header names and a clash between auth and customer headers are refused', () => {
    expect(refusal(buildHeaders({ customerHeader: 'x customer', idChain: chain('C1') })).code).toBe('bad_customer_id');
    expect(
      refusal(buildHeaders({ auth: { header: 'Auth:x', scheme: 'Bearer', token: 't' }, idChain: chain() })).code,
    ).toBe('bad_auth');
    expect(
      refusal(
        buildHeaders({
          auth: { header: 'X-Customer-Id', scheme: 'Bearer', token: 't' },
          customerHeader: 'x-customer-id',
          idChain: chain('C1'),
        }),
      ).code,
    ).toBe('bad_customer_id');
  });

  test('deny: extra fields such as model-supplied headers are ignored', () => {
    const input = { idChain: chain(), headers: { 'x-customer-id': 'OTHER', host: 'evil' } } as never;
    const r = buildHeaders(input);
    if (!r.ok) throw new Error(r.message);
    expect(r.headers).toEqual({});
  });
});

// ------------------------------------------------------------ checkCbsPath

describe('checkCbsPath', () => {
  test('accepts a plain custom path', () => {
    expect(checkCbsPath('/custom/api/getAccountDetails')).toEqual({ ok: true, path: '/custom/api/getAccountDetails' });
    expect(checkCbsPath('/api/channel/v1/custom/acct_bal.v2').ok).toBe(true);
  });

  for (const bad of ['/custom/api?x=1', '/custom/../api', '/custom/a..b', '/custom api', '/custom/%2e', 'custom/api', '/', '', '/a\nb', '/a#b', '/a@b']) {
    test(`deny: cbs path ${JSON.stringify(bad)} is refused`, () => {
      expect(refusal(checkCbsPath(bad)).code).toBe('bad_cbs_path');
    });
  }
});

// -------------------------------------------------------------- decideHttp

describe('decideHttp', () => {
  test("allow: GET '/admin/v1/forms/<uuid>' against a registry base builds the expected URL with rule_index 'default'", () => {
    const r = decide({ path: `/admin/v1/forms/${FORM_ID}` });
    if (!r.ok) throw new Error(r.message);
    expect(r.url.href).toBe(`${BASE}/admin/v1/forms/${FORM_ID}`);
    expect(r.pathname).toBe(`/admin/v1/forms/${FORM_ID}`);
    expect(r.method).toBe('GET');
    expect(r.rule_index).toBe('default');
    expect(r.action).toBe('allow');
  });

  test('method defaults to GET and HEAD is allowed by default', () => {
    const noMethod = decideHttp({ tool: 'http_call', service: 'harbor', path: '/x', base: BASE, rules: [] });
    const head = decide({ method: 'HEAD', path: '/x' });
    expect(noMethod.ok && noMethod.method).toBe('GET');
    expect(head.ok && head.method).toBe('HEAD');
  });

  test('query is carried onto the URL and not seen by the rules', () => {
    const blockAll = rules([{ service: 'harbor', method: 'GET', api: '/x', action: 'block' }]);
    const r = decide({ path: '/x', query: { a: '1' }, rules: blockAll });
    expect(refusal(r).rule_index).toBe(0);
    const ok = decide({ path: '/y', query: { a: '1' }, rules: blockAll });
    expect(ok.ok && ok.url.search).toBe('?a=1');
  });

  test("deny: service 'finacle' via http_call is refused with a cbs_call hint", () => {
    const r = refusal(decide({ service: 'finacle', path: '/custom/api/x' }));
    expect(r.code).toBe('finacle_via_http');
    expect(r.message).toContain('cbs_call');
  });

  for (const method of ['CONNECT', 'TRACE', 'get ', 'get', 'OPTIONS', ' GET', 'G\nET', '']) {
    test(`deny: method ${JSON.stringify(method)} is refused`, () => {
      expect(refusal(decide({ method, path: '/x' })).code).toBe('bad_method');
    });
  }

  test("deny: POST with [] rules is blocked with rule_index 'default'", () => {
    const r = refusal(decide({ method: 'POST', path: '/admin/v1/forms' }));
    expect(r.code).toBe('blocked_by_rule');
    expect(r.rule_index).toBe('default');
  });

  const mutating: readonly [string, string, string][] = [
    ['harbor', 'POST', '/admin/v1/customers/CUST-1/trigger-delivery'],
    ['harbor', 'PUT', '/admin/v1/customers/CUST-1/trigger-delivery'],
    ['harbor', 'POST', '/admin/v1/customers/CUST-1/sync-address'],
    ['harbor', 'POST', `/admin/v1/digital-forms/${FORM_ID}/force-sign`],
    ['harbor', 'POST', `/admin/v1/forms/${FORM_ID}/trigger-customer-creation`],
    ['harbor', 'POST', '/admin/v1/accounts/ACC-1/debit-unfreeze'],
    ['bro', 'PUT', '/admin/api/v1/stp-engine/rules/check_1'],
    ['bro', 'POST', '/admin/api/v1/stp-engine/rules/check_1'],
    ['rhythm', 'POST', '/api/v1/td-calculate'],
    ['harbor', 'PATCH', '/admin/v1/forms/x'],
    ['harbor', 'DELETE', '/admin/v1/forms/x'],
  ];
  for (const [service, method, path] of mutating) {
    test(`deny: ${service} ${method} ${path} is blocked by default`, () => {
      const r = refusal(decide({ service, method, path, rules: [] }));
      expect(r.code).toBe('blocked_by_rule');
      expect(r.rule_index).toBe('default');
    });
  }

  test('rules are evaluated on the built pathname, not the raw string', () => {
    const block = rules([
      {
        service: 'harbor',
        method: 'GET',
        api: '/admin/v1/forms/:form_id/trigger-customer-creation',
        action: 'block',
        reason: 'mutating trigger',
      },
    ]);
    const r = refusal(decide({ path: `/admin/v1/forms/${FORM_ID}/./trigger-customer-creation`, rules: block }));
    expect(r.code).toBe('blocked_by_rule');
    expect(r.rule_index).toBe(0);
    expect(r.message).toContain('mutating trigger');
    // The evasions a lenient server might normalise away are refused before the rules.
    for (const path of [
      `/admin/v1/forms/${FORM_ID}/trigger-customer-creation/`,
      `/admin/v1/forms/${FORM_ID}/trigger-customer-creation;x`,
      `/admin/v1/forms/${FORM_ID}//trigger-customer-creation`,
      `/admin/v1/forms/${FORM_ID}/trigger-customer-creation%2F`,
    ]) {
      expect(refusal(decide({ path, rules: block })).code).toBe('bad_path');
    }
  });

  test('an allow rule for POST lets that exact path through with its index and reason', () => {
    const allow = rules([
      { service: 'bro', method: 'POST', api: '/dashboard/api/v1/dry-run', action: 'allow', reason: 'no persist' },
    ]);
    const r = decide({ service: 'bro', method: 'POST', path: '/dashboard/api/v1/dry-run', rules: allow });
    if (!r.ok) throw new Error(r.message);
    expect(r.rule_index).toBe(0);
    expect(r.reason).toBe('no persist');
    expect(refusal(decide({ service: 'bro', method: 'POST', path: '/dashboard/api/v1/dry-runx', rules: allow })).code).toBe(
      'blocked_by_rule',
    );
  });

  test('path refusals come back from decideHttp unchanged', () => {
    expect(refusal(decide({ path: 'http://evil/x' })).code).toBe('bad_path');
    expect(refusal(decide({ path: '/apix/v1', base: 'https://h/api' })).code).toBe('outside_base');
    expect(refusal(decide({ path: '/x', query: { 'a&b': '1' } })).code).toBe('bad_query');
  });
});

describe('decideHttp for cbs_call', () => {
  const CBS = 'https://cbs-gateway.example.test';
  const cbs = (over: Partial<HttpDecisionInput>) =>
    decideHttp({ tool: 'cbs_call', service: 'finacle', path: '/custom/api/x', base: CBS, rules: [], ...over });

  test('GET on a clean path is allowed by default under service finacle', () => {
    const r = cbs({});
    if (!r.ok) throw new Error(r.message);
    expect(r.url.href).toBe(`${CBS}/custom/api/x`);
    expect(r.rule_index).toBe('default');
  });

  test('POST is blocked by default and allowed only by a finacle rule', () => {
    expect(refusal(cbs({ method: 'POST' })).rule_index).toBe('default');
    const allow = rules([{ service: 'finacle', method: 'POST', api: '/custom/api/*', action: 'allow', reason: 'reads' }]);
    const r = cbs({ method: 'POST', rules: allow });
    expect(r.ok && r.rule_index).toBe(0);
    // A harbor rule on the same path does not apply to cbs_call.
    const harborAllow = rules([{ service: 'harbor', method: 'POST', api: '/custom/api/*', action: 'allow', reason: 'x' }]);
    expect(refusal(cbs({ method: 'POST', rules: harborAllow })).rule_index).toBe('default');
  });

  for (const path of ['/custom/api?x=1', '/custom/../x', '/custom api', '/custom/%41']) {
    test(`deny: cbs path ${JSON.stringify(path)} is refused`, () => {
      expect(refusal(cbs({ path })).code).toBe('bad_cbs_path');
    });
  }

  test('deny: a cbs path that passes the charset but not the URL checks is still refused', () => {
    expect(refusal(cbs({ path: '//evil/x' })).code).toBe('bad_path');
    expect(refusal(cbs({ path: '/custom/api/' })).code).toBe('bad_path');
  });

  test('deny: cbs_call takes no query and only service finacle', () => {
    expect(refusal(cbs({ query: { a: '1' } })).code).toBe('bad_query');
    expect(refusal(cbs({ service: 'harbor' })).code).toBe('bad_service');
  });

  test('deny: bad methods are refused on cbs_call too', () => {
    expect(refusal(cbs({ method: 'TRACE' })).code).toBe('bad_method');
  });
});
