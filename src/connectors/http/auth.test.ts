import { describe, expect, test } from 'bun:test';
import type { AuthCapability } from '../../config/registry.ts';
import { ACCEPT_JSON, connectorHeaders, isValidCustomerId, resolveAuth } from './auth.ts';

const TOKEN = 'fake-token-SEEDED-7f3a';

// Same shape the registry builds: the value is a non-enumerable property.
function authCap(scheme: 'Bearer' | 'Basic', value: string | undefined): AuthCapability {
  const envName = 'SSFB_BRO_ADMIN_TOKEN';
  if (value === undefined) {
    return Object.freeze({ status: 'disabled', envName, reason: 'blank', header: 'Authorization', scheme }) as AuthCapability;
  }
  const out = { status: 'ok', envName, header: 'Authorization', scheme };
  Object.defineProperty(out, 'value', { value, enumerable: false });
  return Object.freeze(out) as AuthCapability;
}

describe('resolveAuth', () => {
  test('no auth capability means no auth header', () => {
    expect(resolveAuth(undefined)).toEqual({ ok: true });
  });

  test('Bearer sends the env value as is', () => {
    const r = resolveAuth(authCap('Bearer', TOKEN));
    expect(r).toEqual({ ok: true, auth: { header: 'Authorization', scheme: 'Bearer', token: TOKEN } });
    const h = connectorHeaders({ ...(r.ok && r.auth ? { auth: r.auth } : {}) });
    expect(h.ok && h.headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: ACCEPT_JSON });
  });

  test('Basic sends base64 of the env value', () => {
    const r = resolveAuth(authCap('Basic', 'svc-user:pa55'));
    const expected = Buffer.from('svc-user:pa55', 'utf8').toString('base64');
    expect(r).toEqual({ ok: true, auth: { header: 'Authorization', scheme: 'Basic', token: expected } });
    const h = connectorHeaders({ ...(r.ok && r.auth ? { auth: r.auth } : {}) });
    expect(h.ok && h.headers.authorization).toBe(`Basic ${expected}`);
  });

  test('Basic with non-ASCII in the env value still gives a header-safe value', () => {
    const r = resolveAuth(authCap('Basic', 'user:pässword'));
    const h = connectorHeaders({ ...(r.ok && r.auth ? { auth: r.auth } : {}) });
    expect(h.ok).toBe(true);
  });

  test('a blank token_env is not_configured and names the env var only', () => {
    for (const cap of [authCap('Bearer', undefined), authCap('Bearer', '   '), authCap('Basic', undefined)]) {
      const r = resolveAuth(cap);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.code).toBe('not_configured');
      expect(r.message).toContain('SSFB_BRO_ADMIN_TOKEN');
    }
  });

  test('a Bearer token with a newline is refused without echoing it', () => {
    const r = resolveAuth(authCap('Bearer', `${TOKEN}\r\nx-evil: 1`));
    const h = connectorHeaders({ ...(r.ok && r.auth ? { auth: r.auth } : {}) });
    expect(h.ok).toBe(false);
    if (h.ok) return;
    expect(h.code).toBe('refused');
    expect(h.message).not.toContain(TOKEN);
  });

  test('the capability value does not show in JSON of the resolved refusal', () => {
    const r = resolveAuth(authCap('Bearer', undefined));
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe('customer id charset', () => {
  const cases: readonly [string, boolean][] = [
    ['cust-1', true],
    ['ABC123', true],
    ['0f6c1a2e-9d7b-4c1e-8f00-1234567890ab', true],
    ['-', true],
    ['', false],
    ['a b', false],
    ['a\nb', false],
    ['a\r\nx-evil: 1', false],
    ['a:b', false],
    ['a\tb', false],
    ['a_b', false],
    ['a/b', false],
    ['a;b', false],
    ['café', false],
    ['１２３', false],
    ['abc\u0000', false],
  ];

  for (const [id, valid] of cases) {
    test(`${JSON.stringify(id)} is ${valid ? 'accepted' : 'refused'}`, () => {
      expect(isValidCustomerId(id)).toBe(valid);
      const h = connectorHeaders({ customerHeader: 'x-customer-id', customerId: id });
      expect(h.ok).toBe(valid);
      if (h.ok) {
        expect(h.headers).toEqual({ 'x-customer-id': id, accept: ACCEPT_JSON });
      } else {
        expect(h.code).toBe('refused');
      }
    });
  }

  test('a bad id is refused even when the service has no customer header', () => {
    const h = connectorHeaders({ customerId: 'a b' });
    expect(h.ok).toBe(false);
  });

  test('a good id is not sent when the service has no customer header', () => {
    const h = connectorHeaders({ customerId: 'cust-1' });
    expect(h.ok && h.headers).toEqual({ accept: ACCEPT_JSON });
  });

  test('a non-string id is refused', () => {
    expect(isValidCustomerId(42)).toBe(false);
    expect(isValidCustomerId(undefined)).toBe(false);
  });
});

describe('connectorHeaders', () => {
  test('json body adds content-type', () => {
    const h = connectorHeaders({ jsonBody: true });
    expect(h.ok && h.headers).toEqual({ accept: ACCEPT_JSON, 'content-type': 'application/json' });
  });

  test('a customer header that clashes with the auth header is refused', () => {
    const h = connectorHeaders({
      auth: { header: 'Authorization', scheme: 'Bearer', token: TOKEN },
      customerHeader: 'authorization',
      customerId: 'cust-1',
    });
    expect(h.ok).toBe(false);
  });
});
