import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getToken, saveToken } from '../auth/token.ts';
import { ApiError, onUnauthorized, request, setFetch } from './client.ts';
import { getDoctor, getSession, getUiConfig, listRuns, startRun } from './endpoints.ts';

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const g = globalThis as Record<string, unknown>;
let saved: { session: unknown; local: unknown };
let restoreFetch: () => void;
type Call = { url: string; init: RequestInit };
let calls: Call[];

// Test token; not a real credential.
const TOKEN = 'tok-123';

function answer(status: number, body: unknown): void {
  restoreFetch();
  restoreFetch = setFetch(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function header(call: Call | undefined, name: string): string | undefined {
  const h = (call?.init.headers ?? {}) as Record<string, string>;
  return h[name];
}

beforeEach(() => {
  saved = { session: g.sessionStorage, local: g.localStorage };
  for (const [k, v] of [
    ['sessionStorage', new MemoryStorage()],
    ['localStorage', new MemoryStorage()],
  ] as const) {
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  }
  calls = [];
  restoreFetch = () => undefined;
});

afterEach(() => {
  restoreFetch();
  Object.defineProperty(g, 'sessionStorage', { value: saved.session, configurable: true, writable: true });
  Object.defineProperty(g, 'localStorage', { value: saved.local, configurable: true, writable: true });
});

describe('request', () => {
  test('sends the stored token in the Authorization header and never in the URL', async () => {
    saveToken(TOKEN, false);
    answer(200, { runs: [], next_cursor: null });
    await listRuns({ status: 'running', limit: 20 });
    expect(calls[0]?.url).toBe('/triage?status=running&limit=20');
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(header(calls[0], 'Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  test('the public config call sends no token', async () => {
    saveToken(TOKEN, false);
    answer(200, { env: 'production' });
    expect(await getUiConfig()).toEqual({ env: 'production' });
    expect(header(calls[0], 'Authorization')).toBeUndefined();
  });

  test('a 401 clears the token and tells the listeners', async () => {
    saveToken(TOKEN, true);
    answer(401, { error: 'unauthorized' });
    let told = 0;
    const off = onUnauthorized(() => told++);
    const err = await request('GET', '/services').catch((e: unknown) => e);
    off();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(getToken()).toBeNull();
    expect(told).toBe(1);
  });

  test('no stored token fails without a request and tells the listeners', async () => {
    let told = 0;
    const off = onUnauthorized(() => told++);
    const err = await request('GET', '/services').catch((e: unknown) => e);
    off();
    expect((err as ApiError).status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(told).toBe(1);
  });

  test('checking a typed token uses it, and a 401 leaves storage and listeners alone', async () => {
    saveToken('stored', false);
    answer(401, { error: 'unauthorized' });
    let told = 0;
    const off = onUnauthorized(() => told++);
    await getSession('typed').catch(() => undefined);
    off();
    expect(header(calls[0], 'Authorization')).toBe('Bearer typed');
    expect(getToken()).toBe('stored');
    expect(told).toBe(0);
  });

  test('other errors keep the token and carry the body', async () => {
    saveToken(TOKEN, false);
    answer(400, { error: 'invalid request', fields: ['limit'] });
    const err = (await listRuns({ limit: 999 }).catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: 'invalid request', fields: ['limit'] });
    expect(getToken()).toBe(TOKEN);
  });

  test('POST sends JSON and the Idempotency-Key header', async () => {
    saveToken(TOKEN, false);
    answer(202, { run_id: 'r1' });
    const res = await startRun({ slack_url: 'https://example.test/archives/C1/p1', requested_by: 'me' }, 'key-1');
    expect(res).toEqual({ run_id: 'r1' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(header(calls[0], 'Idempotency-Key')).toBe('key-1');
    expect(header(calls[0], 'Content-Type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ slack_url: 'https://example.test/archives/C1/p1', requested_by: 'me' });
  });

  test('repeated query params for doctor checks', async () => {
    saveToken(TOKEN, false);
    answer(200, { checks: [], counts: {} });
    await getDoctor({ check: ['env', 'models'], errorsOnly: true, sortBy: 'check' });
    expect(calls[0]?.url).toBe('/doctor?check=env&check=models&errors_only=true&sort_by=check');
  });

  test('a network failure becomes ApiError status 0', async () => {
    saveToken(TOKEN, false);
    restoreFetch = setFetch(async () => {
      throw new TypeError('failed to fetch');
    });
    const err = (await listRuns().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(getToken()).toBe(TOKEN);
  });
});
