import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { decideHttp, type HttpDecision } from '../../gate/http.ts';
import type { ApiRule } from '../../gate/rules.ts';
import type { MockPort } from '../mock.ts';
import { createFakeRunner, type FakeCall, type FakeStep } from '../exec-fake.ts';
import { isConnectorError, type ConnectorContext, type ConnectorError } from '../types.ts';
import { createCbsConnector, newRequestUuid, type CbsCallInput } from './client.ts';
import { STATUS_MARKER } from './kubectl.ts';
import { cachePath } from './token-cache.ts';

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

const GATEWAY = 'https://gw.test';
const USER = 'finacle-api-user';
const PASS = 'finacle-api-pass';
const POD = 'eventbus-abc';
const NOW = new Date('2026-09-23T10:00:00.000Z');

const ON: Record<string, string> = {
  SSFB_CBS_VIA_KUBECTL_ENABLED: 'true',
  SSFB_KUBE_CONTEXT: 'test-ctx',
  SSFB_CBS_K8S_NAMESPACE: 'eventbus-service',
  SSFB_CBS_POD_SELECTOR: 'app=eventbus',
  SSFB_CBS_CONTAINER: 'eventbus',
  SSFB_CBS_CREDS_SECRET: 'rhythm-service/rhythm-external-secret',
  SSFB_CBS_GATEWAY_URL: GATEWAY,
  SSFB_CBS_OAUTH_SCOPE: 'urn:test:scope',
  SSFB_CBS_SOURCE: 'TRIAGE',
  SSFB_CBS_SOURCE_IDENTIFIER: 'triage-app',
};

function home(overrides: Record<string, string> = {}): TestHome {
  const h = makeTestHome({ overrides: { ...ON, ...overrides } });
  homes.push(h);
  return h;
}

const RULES: ApiRule[] = [
  { service: 'finacle', method: 'POST', api: '/fin/accounts/:id/inquiry', action: 'allow', reason: 'read-only inquiry' },
];

function decide(method: string, path: string): HttpDecision {
  return decideHttp({ tool: 'cbs_call', service: 'finacle', method, path, base: GATEWAY, rules: RULES });
}

function input(method: string, path: string, extra: Partial<CbsCallInput> = {}): CbsCallInput {
  return {
    path,
    method,
    decision: decide(method, path),
    keyInput: { entity: 'ssfb', service: 'finacle', method, path },
    ...extra,
  };
}

const realPort: MockPort = {
  enabled: false,
  strict: true,
  async lookup() {
    throw new Error('lookup must not run in real mode');
  },
};

function ctx(mock: MockPort = realPort): ConnectorContext {
  return { signal: new AbortController().signal, now: () => NOW, mock, runId: '01JTESTRUN0000000000000000' };
}

const PODS_ARGV = [
  '--context', 'test-ctx', 'get', 'pods', '-n', 'eventbus-service', '-l', 'app=eventbus',
  '--field-selector=status.phase=Running', '-o', 'json',
];
const SECRET_ARGV = ['--context', 'test-ctx', 'get', 'secret', 'rhythm-external-secret', '-n', 'rhythm-service', '-o', 'json'];
const EXEC_ARGV = [
  '--context', 'test-ctx', 'exec', '-i', POD, '-n', 'eventbus-service', '-c', 'eventbus',
  '--', 'curl', '-sS', '--max-time', '30', '-K', '-',
];

const b64 = (s: string) => Buffer.from(s).toString('base64');
const isMint = (c: FakeCall) => c.argv.includes('exec') && (c.stdin ?? '').includes('/security/oauth');
const isApi = (c: FakeCall) => c.argv.includes('exec') && !isMint(c);

type Api = (call: FakeCall) => { status: number; body: string };

/** Pods, secret and one exec step that answers mints with fresh tokens and API calls with api(). */
function script(api: Api, pods: unknown[] = [{ metadata: { name: POD }, status: { phase: 'Running' } }]): FakeStep[] {
  let minted = 0;
  return [
    { bin: 'kubectl', argv: PODS_ARGV, result: { stdout: JSON.stringify({ items: pods }) } },
    {
      bin: 'kubectl',
      argv: SECRET_ARGV,
      result: { stdout: JSON.stringify({ data: { FINACLE_API_USERNAME: b64(USER), FINACLE_API_PASSWORD: b64(PASS) } }) },
    },
    {
      bin: 'kubectl',
      argv: EXEC_ARGV,
      result: (call) => {
        if (isMint(call)) {
          minted++;
          return { stdout: `${JSON.stringify({ access_token: `minted-${minted}`, expires_in: 3600 })}${STATUS_MARKER}200` };
        }
        const r = api(call);
        return { stdout: `${r.body}${STATUS_MARKER}${r.status}` };
      },
    },
  ];
}

function seedToken(h: TestHome, token: string): void {
  const path = cachePath(h.config.paths.dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ access_token: token, expires_at: NOW.getTime() + 3_600_000 }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function rejectsWith(p: Promise<unknown>, code: ConnectorError['code']): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    if (!isConnectorError(err, code)) throw err;
    return err;
  }
  throw new Error(`expected ConnectorError ${code}`);
}

const ok: Api = () => ({ status: 200, body: '{"balance":"100.00"}' });

describe('flag', () => {
  for (const flag of ['false', '']) {
    test(`SSFB_CBS_VIA_KUBECTL_ENABLED=${JSON.stringify(flag)} gives not_configured and runs nothing`, async () => {
      const h = home({ SSFB_CBS_VIA_KUBECTL_ENABLED: flag });
      const runner = createFakeRunner([]);
      const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
      expect(cbs.enabled()).toBe(false);
      const err = await rejectsWith(cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance')), 'not_configured');
      expect(err.message).toContain('SSFB_CBS_VIA_KUBECTL_ENABLED');
      expect(runner.calls).toHaveLength(0);
      expect(runner.unscripted).toHaveLength(0);
      expect(existsSync(cachePath(h.config.paths.dataDir))).toBe(false);
    });
  }

  test('ssfb not enabled gives not_configured', async () => {
    const h = makeTestHome({ overrides: ON, entities: ['atspl'] });
    homes.push(h);
    const runner = createFakeRunner([]);
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    await rejectsWith(cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance')), 'not_configured');
    expect(runner.calls).toHaveLength(0);
  });
});

describe('refused before any exec', () => {
  const PATH = '/fin/accounts/A1/balance';
  const cases: [string, () => CbsCallInput][] = [
    ['decision missing', () => ({ ...input('GET', PATH), decision: undefined })],
    ['decision is a gate refusal', () => ({ ...input('GET', PATH), decision: decide('POST', PATH) })],
    ['decision is a hand-built block', () => ({ ...input('GET', PATH), decision: { ...(decide('GET', PATH) as object), action: 'block' } as unknown as HttpDecision })],
    ['decision for another method', () => ({ ...input('POST', '/fin/accounts/A1/inquiry'), decision: decide('GET', '/fin/accounts/A1/inquiry') })],
    ['method defaults to GET but the decision was POST', () => ({ path: '/fin/accounts/A1/inquiry', decision: decide('POST', '/fin/accounts/A1/inquiry'), keyInput: { entity: 'ssfb', path: '/fin/accounts/A1/inquiry' } })],
    ['decision for another path', () => ({ ...input('GET', PATH), decision: decide('GET', '/fin/accounts/A2/balance') })],
    ['method outside the callable list', () => input('OPTIONS', PATH, { decision: decide('GET', PATH) })],
    ['lower-case method', () => input('get', PATH, { decision: decide('GET', PATH) })],
    ['body on a GET', () => ({ ...input('GET', PATH), body: { a: 1 } })],
    ['keyInput for another path', () => ({ ...input('GET', PATH), keyInput: { entity: 'ssfb', method: 'GET', path: '/fin/other' } })],
    ['keyInput for another method', () => ({ ...input('GET', PATH), keyInput: { entity: 'ssfb', method: 'POST', path: PATH } })],
    ['keyInput for another entity', () => ({ ...input('GET', PATH), keyInput: { entity: 'rtl', method: 'GET', path: PATH } })],
    ['keyInput for another service', () => ({ ...input('GET', PATH), keyInput: { entity: 'ssfb', service: 'harbor', method: 'GET', path: PATH } })],
  ];

  const BAD_PATHS = [
    '/fin/accounts?id=1',
    '/fin/accounts/?',
    '/fin/../admin',
    '/..',
    '/fin/..',
    '//evil.test/fin',
    '/fin//accounts',
    '/fin/acc ounts',
    '/fin/%2e%2e/admin',
    '/fin/acc%20ounts',
    '/fin/accounts\n',
    '/fin/acc\nounts',
    '/fin/acc\rounts',
    '/fin/acc\tounts',
    'fin/accounts',
    'https://evil.test/fin',
    '',
    '/',
    '/fin/accounts#x',
    '/fin/accounts;x',
    '/fin/acc\\ounts',
    '/fin/acc@ounts',
    '/fin/ac\u0000c',
    '/fin/café',
    `/${'a'.repeat(2048)}`,
  ];
  for (const path of BAD_PATHS) {
    // The decision is forged as an allow for this exact path, so only the path check stands in the way.
    const forged = { ok: true, url: new URL(GATEWAY), pathname: path, method: 'GET', rule_index: 'default', action: 'allow' } as unknown as HttpDecision;
    cases.push([`path ${JSON.stringify(path.slice(0, 40))}`, () => ({ path, method: 'GET', decision: forged, keyInput: { entity: 'ssfb', method: 'GET', path } })]);
  }

  for (const [name, build] of cases) {
    test(name, async () => {
      const h = home();
      const runner = createFakeRunner(script(ok));
      const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
      await rejectsWith(cbs.call(ctx(), build()), 'refused');
      expect(runner.calls).toHaveLength(0);
      expect(runner.unscripted).toHaveLength(0);
    });
  }

  test('the same refusals hold in mock mode, before any fixture lookup', async () => {
    const h = home();
    let lookups = 0;
    const port: MockPort = { enabled: true, strict: true, lookup: async () => (lookups++, { hit: true, value: {}, hash: 'h' }) };
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: createFakeRunner([]) });
    for (const [, build] of cases) await rejectsWith(cbs.call(ctx(port), build()), 'refused');
    expect(lookups).toBe(0);
  });
});

describe('env values', () => {
  const denials: [string, string][] = [
    ['SSFB_KUBE_CONTEXT', 'ctx;rm'],
    ['SSFB_KUBE_CONTEXT', '--kubeconfig=/tmp/x'],
    ['SSFB_CBS_K8S_NAMESPACE', 'eventbus service'],
    ['SSFB_CBS_K8S_NAMESPACE', '-n'],
    ['SSFB_CBS_POD_SELECTOR', 'app=$(id)'],
    ['SSFB_CBS_POD_SELECTOR', '-lapp'],
    ['SSFB_CBS_CONTAINER', 'eventbus|x'],
    ['SSFB_CBS_CREDS_SECRET', 'ns/name&x'],
    ['SSFB_CBS_CREDS_SECRET', '-ns/name'],
    ['SSFB_CBS_GATEWAY_URL', 'https://user:pw@gw.test'],
    ['SSFB_CBS_GATEWAY_URL', 'https://gw.test/?q=1'],
    ['SSFB_CBS_GATEWAY_URL', 'file:///etc/passwd'],
  ];
  for (const [key, value] of denials) {
    test(`${key} with ${JSON.stringify(value)} is refused before any exec`, async () => {
      const h = home({ [key]: value });
      const runner = createFakeRunner(script(ok));
      const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
      const err = await rejectsWith(cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance')), 'refused');
      expect(err.message).toContain(key);
      expect(err.message).not.toContain(value);
      expect(runner.calls).toHaveLength(0);
    });
  }

  for (const key of ['SSFB_KUBE_CONTEXT', 'SSFB_CBS_K8S_NAMESPACE', 'SSFB_CBS_CREDS_SECRET', 'SSFB_CBS_GATEWAY_URL', 'SSFB_CBS_OAUTH_SCOPE']) {
    test(`${key} blank gives not_configured naming it`, async () => {
      const h = home({ [key]: '' });
      const runner = createFakeRunner(script(ok));
      const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
      const err = await rejectsWith(cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance')), 'not_configured');
      expect(err.message).toContain(key);
      expect(runner.calls).toHaveLength(0);
    });
  }

  for (const key of ['SSFB_CBS_SOURCE', 'SSFB_CBS_SOURCE_IDENTIFIER']) {
    test(`${key} outside printable ASCII is refused before any exec`, async () => {
      const h = home({ [key]: 'TRIAG\u00c9' });
      const runner = createFakeRunner(script(ok));
      const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
      const err = await rejectsWith(cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance')), 'refused');
      expect(err.message).toContain(key);
      expect(runner.calls).toHaveLength(0);
    });
  }
});

describe('real call', () => {
  test('GET: headers, stdin-only data and the result', async () => {
    const h = home();
    const runner = createFakeRunner(script(ok));
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    const res = await cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance'));
    expect(res).toMatchObject({ data: { status: 200, body: { balance: '100.00' } }, transport: 'real', target_env: 'SSFB_CBS_GATEWAY_URL' });

    const api = runner.calls.find(isApi);
    const stdin = api?.stdin ?? '';
    expect(stdin).toContain('url = "https://gw.test/fin/accounts/A1/balance"');
    expect(stdin).toContain('request = "GET"');
    expect(stdin).toContain('header = "Authorization: Bearer minted-1"');
    expect(stdin).toContain('header = "Source: TRIAGE"');
    expect(stdin).toContain('header = "SourceIdentifier: triage-app"');
    expect(stdin).toMatch(/header = "RequestUUID: asp[A-Za-z0-9]{7}"/);
    expect(stdin).not.toContain('data-raw');
    expect(stdin).not.toContain('Content-Type');

    // The OAuth mint carries no RequestUUID.
    expect(runner.calls.find(isMint)?.stdin ?? '').not.toContain('RequestUUID');

    for (const call of runner.calls) {
      const argv = call.argv.join(' ');
      expect(argv).not.toContain('RequestUUID');
      for (const secret of ['/fin/accounts', 'A1', 'minted-1', USER, PASS, 'gw.test', 'urn:test:scope']) {
        expect(argv).not.toContain(secret);
      }
    }
    // The minted token is cached for the next call.
    expect(existsSync(cachePath(h.config.paths.dataDir))).toBe(true);
  });

  test('POST with a body sends JSON through data-raw', async () => {
    const h = home();
    seedToken(h, 'cached-token');
    const runner = createFakeRunner(script(() => ({ status: 200, body: 'plain text' })));
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    const path = '/fin/accounts/A1/inquiry';
    const body = { accountId: 'A1', note: 'say "hi"\n' };
    const res = await cbs.call(ctx(), input('POST', path, { body, keyInput: { entity: 'ssfb', service: 'finacle', method: 'POST', path, body } }));
    expect(res.data).toEqual({ status: 200, body: 'plain text' });
    expect(runner.calls.filter(isMint)).toHaveLength(0);
    const stdin = runner.calls.find(isApi)?.stdin ?? '';
    expect(stdin).toContain('request = "POST"');
    expect(stdin).toContain('header = "Authorization: Bearer cached-token"');
    expect(stdin).toContain('header = "Content-Type: application/json"');
    expect(stdin).toContain(`data-raw = ${JSON.stringify(JSON.stringify(body)).replace(/\\n/g, '\\n')}`);
    for (const call of runner.calls) expect(call.argv.join(' ')).not.toContain('accountId');
  });

  test('newRequestUuid is asp plus 7 alphanumerics and differs per call', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = newRequestUuid();
      expect(id).toMatch(/^asp[A-Za-z0-9]{7}$/);
      ids.add(id);
    }
    expect(ids.size).toBeGreaterThan(1);
  });

  test('blank Source headers are left out', async () => {
    const h = home({ SSFB_CBS_SOURCE: '', SSFB_CBS_SOURCE_IDENTIFIER: '' });
    const runner = createFakeRunner(script(ok));
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    await cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance'));
    const stdin = runner.calls.find(isApi)?.stdin ?? '';
    expect(stdin).not.toContain('Source');
  });

  test('CBS errors other than 401 come back as data', async () => {
    const h = home();
    const runner = createFakeRunner(script(() => ({ status: 500, body: '{"error":"down"}' })));
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    const res = await cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance'));
    expect(res.data).toEqual({ status: 500, body: { error: 'down' } });
    expect(runner.calls.filter(isApi)).toHaveLength(1);
  });

  test('no Running pod gives unreachable with the namespace and selector key names', async () => {
    const h = home();
    const runner = createFakeRunner(script(ok, [{ metadata: { name: 'eventbus-x' }, status: { phase: 'Pending' } }]));
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    const err = await rejectsWith(cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance')), 'unreachable');
    expect(err.message).toContain('SSFB_CBS_K8S_NAMESPACE');
    expect(err.message).toContain('SSFB_CBS_POD_SELECTOR');
    expect(err.message).not.toContain('eventbus-service');
    expect(runner.calls).toHaveLength(1);
  });
});

describe('401', () => {
  test('clears the cache, mints once, retries once and succeeds', async () => {
    const h = home();
    seedToken(h, 'stale-token');
    const runner = createFakeRunner(
      script((call) => ((call.stdin ?? '').includes('Bearer stale-token') ? { status: 401, body: '' } : ok(call))),
    );
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    const res = await cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance'));
    expect(res.data).toEqual({ status: 200, body: { balance: '100.00' } });
    expect(runner.calls.filter(isMint)).toHaveLength(1);
    expect(runner.calls.filter(isApi)).toHaveLength(2);
  });

  test('a second 401 is returned after one mint and one retry', async () => {
    const h = home();
    seedToken(h, 'stale-token');
    const runner = createFakeRunner(script(() => ({ status: 401, body: '{"error":"unauthorized"}' })));
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    const res = await cbs.call(ctx(), input('GET', '/fin/accounts/A1/balance'));
    expect(res.data).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(runner.calls.filter(isMint)).toHaveLength(1);
    expect(runner.calls.filter(isApi)).toHaveLength(2);
    expect(runner.calls.filter((c) => c.argv.includes('secret'))).toHaveLength(1);
  });
});

describe('mock mode', () => {
  test('answers from the fixture with no kubectl and no cache read or write', async () => {
    const h = home();
    const seen: unknown[] = [];
    const port: MockPort = {
      enabled: true,
      strict: true,
      async lookup(tool, keyInput) {
        seen.push([tool, keyInput]);
        return { hit: true, value: { status: 200, body: { balance: '1.00' } }, hash: 'abc' };
      },
    };
    const runner = createFakeRunner([]);
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    const res = await cbs.call(ctx(port), input('GET', '/fin/accounts/A1/balance'));
    expect(res).toMatchObject({ data: { status: 200, body: { balance: '1.00' } }, transport: 'mock', target_env: 'SSFB_CBS_GATEWAY_URL' });
    expect(seen).toEqual([['cbs_call', { entity: 'ssfb', method: 'GET', path: '/fin/accounts/A1/balance' }]]);
    expect(runner.calls).toHaveLength(0);
    expect(runner.unscripted).toHaveLength(0);
    expect(existsSync(dirname(cachePath(h.config.paths.dataDir)))).toBe(false);
  });

  test('mock mode needs none of the kube or gateway values', async () => {
    const h = home({ SSFB_KUBE_CONTEXT: '', SSFB_CBS_GATEWAY_URL: '', SSFB_CBS_OAUTH_SCOPE: '', SSFB_CBS_CREDS_SECRET: '' });
    const port: MockPort = { enabled: true, strict: true, lookup: async () => ({ hit: true, value: { status: 204, body: '' }, hash: 'h' }) };
    const runner = createFakeRunner([]);
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    const res = await cbs.call(ctx(port), input('GET', '/fin/accounts/A1/balance'));
    expect(res.data).toEqual({ status: 204, body: '' });
    expect(runner.calls).toHaveLength(0);
  });

  test('a strict miss throws strict_miss without running anything', async () => {
    const h = home();
    const port: MockPort = { enabled: true, strict: true, lookup: async () => ({ hit: false, key_string: '{}', hash: 'h' }) };
    const runner = createFakeRunner([]);
    const cbs = createCbsConnector({ registry: h.registry, config: h.config, exec: runner });
    await rejectsWith(cbs.call(ctx(port), input('GET', '/fin/accounts/A1/balance')), 'strict_miss');
    expect(runner.calls).toHaveLength(0);
  });
});
