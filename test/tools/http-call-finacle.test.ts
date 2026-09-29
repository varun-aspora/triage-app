// http_call's finacle route to the CBS gateway (D111): the guards cbs_call
// had, GET only, and mock fixtures under the 'cbs_call' kind. Real mode here
// only ever reaches a fake connector.
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { CbsCallInput, CbsConnector, CbsResponse } from '../../src/connectors/cbs/client.ts';
import { type ConnectorOutcome, envVarName } from '../../src/connectors/types.ts';
import { FixtureMissError } from '../../src/mock/errors.ts';
import { offeredServices, toolModule } from '../../src/tools/http-call.tool.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { FIXED_NOW, makeSsfbRun, makeSsfbWorld, memoryFixtures, type MemoryFixtures, type SsfbWorld } from '../support/ssfb-tools.ts';

const ACCOUNT = '123456789012';
const FOREIGN_ACCOUNT = '998877665544';
const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const CHAIN: IdChain = { ids: { account_number: ACCOUNT, customer_id: CUSTOMER }, hops: [], basic_state: [] };
// A reserved TLD: never resolves.
const GATEWAY = 'https://cbs-gateway.test.invalid';
const BALANCE_PATH = `/fi/v1/accounts/${ACCOUNT}/balance`;
const FLAG = 'SSFB_CBS_VIA_KUBECTL_ENABLED';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

type Spy = CbsConnector & { readonly calls: CbsCallInput[] };

function spyConnector(response: CbsResponse = { status: 200, body: { balance: '1520.00', currency: 'INR' } }): Spy {
  const calls: CbsCallInput[] = [];
  return {
    calls,
    enabled: () => true,
    async call(_ctx, input): Promise<ConnectorOutcome<CbsResponse>> {
      calls.push(input);
      return {
        data: response,
        transport: 'real',
        target_env: envVarName('SSFB_CBS_GATEWAY_URL'),
        taken_at: FIXED_NOW.toISOString(),
        duration_ms: 0,
      };
    },
  };
}

type WorldOptions = { mock?: boolean; rules?: unknown; env?: Record<string, string> };

function world(opts: WorldOptions = {}): SsfbWorld {
  const w = makeSsfbWorld({
    mock: opts.mock ?? false,
    ...(opts.rules !== undefined ? { rules: opts.rules } : {}),
    env: { [FLAG]: 'true', SSFB_CBS_GATEWAY_URL: GATEWAY, ...opts.env },
  });
  cleanups.push(w.cleanup);
  return w;
}

function run(w: SsfbWorld, connector: CbsConnector | undefined, fixtures: MemoryFixtures = memoryFixtures()) {
  const r = makeSsfbRun(w, { idChain: CHAIN, fixtures, ...(connector !== undefined ? { connectors: { cbs: connector } } : {}) });
  cleanups.push(r.release);
  const tool = toolModule.create(r.ctx, 'investigator');
  return {
    ...r,
    tool,
    fixtures,
    finacle: (d: Record<string, unknown>): Promise<ToolEnvelope> => r.call(tool, { service: 'finacle', ...d }),
  };
}

function expectEnvelope(env: ToolEnvelope, status: string): void {
  expect(v.is(ToolEnvelopeSchema, env)).toBe(true);
  expect(env.output.status).toBe(status as never);
}

describe('finacle GET reaches the CBS connector', () => {
  test('an id from the IdChain passes and the connector gets the gate decision', async () => {
    const spy = spyConnector();
    const r = run(world(), spy);
    const env = await r.finacle({ path: BALANCE_PATH });
    expectEnvelope(env, 'ok');
    expect(env.output.data).toMatchObject({
      service: 'finacle',
      method: 'GET',
      path: BALANCE_PATH,
      status: 200,
      body: { balance: '1520.00', currency: 'INR' },
      truncated: false,
      rule_index: 'default',
    });
    expect(spy.calls).toHaveLength(1);
    const call = spy.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.path).toBe(BALANCE_PATH);
    expect(call?.body).toBeUndefined();
    expect(call?.decision).toMatchObject({ ok: true, action: 'allow', method: 'GET', pathname: BALANCE_PATH, rule_index: 'default' });
    expect(call?.keyInput).toEqual({ entity: 'ssfb', service: 'finacle', method: 'GET', path: BALANCE_PATH });
    expect(r.audit.lines).toHaveLength(1);
    expect(r.audit.lines[0]).toMatchObject({
      tool: 'http_call',
      service: 'finacle',
      decision: 'allow',
      rule_index: 'default',
      action: 'allow',
      transport: 'real',
      target: 'SSFB_CBS_GATEWAY_URL',
    });
  });

  test('a block rule for finacle still refuses a GET', async () => {
    const spy = spyConnector();
    const rules = [{ service: 'finacle', method: 'GET', api: '/fi/v1/accounts/:account/balance', action: 'block', reason: 'not this one' }];
    const r = run(world({ rules }), spy);
    const env = await r.finacle({ path: BALANCE_PATH });
    expectEnvelope(env, 'refused');
    expect(env.output.message).toContain('not this one');
    expect(spy.calls).toHaveLength(0);
    expect(r.audit.lines[0]).toMatchObject({ decision: 'deny', rule_index: 0, action: 'block' });
  });
});

describe('finacle takes GET only', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    test(`${method} is refused before the connector, even when a rule allows it`, async () => {
      const spy = spyConnector();
      const rules = [{ service: 'finacle', method, api: '/fi/v1/accounts/:account/holds', action: 'allow', reason: 'x' }];
      const r = run(world({ rules }), spy);
      const body = method === 'HEAD' ? {} : { body: { account: ACCOUNT } };
      const env = await r.finacle({ path: `/fi/v1/accounts/${ACCOUNT}/holds`, method, ...body });
      expectEnvelope(env, 'refused');
      expect(env.output.message).toContain('GET only');
      expect(spy.calls).toHaveLength(0);
      expect(r.audit.lines[0]).toMatchObject({ decision: 'deny', reason: 'cbs_get_only' });
    });
  }

  test('GET with a body is refused', async () => {
    const spy = spyConnector();
    const r = run(world(), spy);
    expectEnvelope(await r.finacle({ path: BALANCE_PATH, body: { x: 1 } }), 'refused');
    expect(spy.calls).toHaveLength(0);
  });

  test('a query is refused', async () => {
    const spy = spyConnector();
    const r = run(world(), spy);
    const env = await r.finacle({ path: BALANCE_PATH, query: { full: '1' } });
    expectEnvelope(env, 'refused');
    expect(env.output.message).toContain('no query');
    expect(spy.calls).toHaveLength(0);
  });

  test('a rules file that fails to load blocks every call', async () => {
    const spy = spyConnector();
    const r = run(world({ rules: { not: 'a list' } }), spy);
    const env = await r.finacle({ path: BALANCE_PATH });
    expectEnvelope(env, 'refused');
    expect(env.output.message).toContain('could not be loaded');
    expect(r.audit.lines[0]?.reason).toBe('rules_file: failed to load');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('each bad path form is refused', () => {
  const BAD_PATHS: readonly [string, string][] = [
    ['a query string', `/fi/v1/accounts/${ACCOUNT}/balance?full=1`],
    ["'..'", '/fi/v1/../admin'],
    ["'..' inside a segment", '/fi/v1/a..b'],
    ['a space', '/fi/v1/accounts/ balance'],
    ['a scheme', 'https://evil.example/fi/v1'],
    ['a scheme without a leading slash', 'file:/etc/passwd'],
    ['a protocol-relative host', '//evil.example/fi'],
    ['no leading slash', 'fi/v1/accounts'],
    ['a percent escape', '/fi/v1/%2e%2e/admin'],
    ['a fragment', '/fi/v1/accounts#x'],
    ['a semicolon', '/fi/v1/accounts;x'],
    ['a backslash', '/fi/v1\\admin'],
    ['a newline', '/fi/v1/accounts\nHost: x'],
    ["a '.' segment", '/fi/./v1/accounts'],
    ['a trailing slash', '/fi/v1/accounts/'],
    ['an empty path', ''],
  ];

  for (const [label, path] of BAD_PATHS) {
    test(`refuses ${label} before any connector call`, async () => {
      const spy = spyConnector();
      const r = run(world(), spy);
      const env = await r.finacle({ path });
      expectEnvelope(env, 'refused');
      expect(spy.calls).toHaveLength(0);
      expect(r.audit.lines).toHaveLength(1);
      expect(r.audit.lines[0]).toMatchObject({ decision: 'deny', tool: 'http_call', target: 'SSFB_CBS_GATEWAY_URL' });
    });
  }

  test('the refusal text does not echo the rejected path', async () => {
    const r = run(world(), spyConnector());
    const env = await r.finacle({ path: '/fi/v1/../evil-marker' });
    expect(JSON.stringify(env)).not.toContain('evil-marker');
    expect(JSON.stringify(r.audit.lines)).not.toContain('evil-marker');
  });
});

describe('scope', () => {
  test('an account number in the path that is not in the IdChain is denied', async () => {
    const spy = spyConnector();
    const r = run(world(), spy);
    const env = await r.finacle({ path: `/fi/v1/accounts/${FOREIGN_ACCOUNT}/balance` });
    expectEnvelope(env, 'refused');
    expect(env.output.message).toContain('ID chain');
    expect(spy.calls).toHaveLength(0);
    expect(r.audit.lines[0]?.reason).toMatch(/^scope: /);
    expect(JSON.stringify(r.audit.lines)).not.toContain(FOREIGN_ACCOUNT);
  });
});

describe('mock mode answers from the cbs_call fixture kind', () => {
  test('a fixture recorded for cbs_call still resolves, and the connector is untouched', async () => {
    const fixtures = memoryFixtures();
    fixtures.add('cbs_call', { entity: 'ssfb', method: 'GET', path: BALANCE_PATH }, { status: 200, body: { balance: '99.00' } });
    const spy = spyConnector();
    // No gateway URL: mock mode needs none.
    const r = run(world({ mock: true, env: { SSFB_CBS_GATEWAY_URL: '' } }), spy, fixtures);
    const env = await r.finacle({ path: BALANCE_PATH });
    expectEnvelope(env, 'ok');
    expect(env.output.data).toMatchObject({ status: 200, body: { balance: '99.00' }, truncated: false });
    expect(spy.calls).toHaveLength(0);
    expect(r.audit.lines).toHaveLength(1);
    expect(r.audit.lines[0]).toMatchObject({ decision: 'allow', transport: 'mock', target: 'SSFB_CBS_GATEWAY_URL' });
  });

  test('without a connector in deps, none is needed', async () => {
    const fixtures = memoryFixtures();
    fixtures.add('cbs_call', { entity: 'ssfb', method: 'GET', path: BALANCE_PATH }, { status: 404, body: 'not found' });
    const r = run(world({ mock: true }), undefined, fixtures);
    const env = await r.finacle({ path: BALANCE_PATH });
    expectEnvelope(env, 'ok');
    expect(env.output.data).toMatchObject({ status: 404, body: 'not found' });
  });

  test('a strict mock miss throws, and the connector is not called', async () => {
    const spy = spyConnector();
    const r = run(world({ mock: true }), spy);
    await expect(r.finacle({ path: BALANCE_PATH })).rejects.toBeInstanceOf(FixtureMissError);
    expect(spy.calls).toHaveLength(0);
    expect(r.audit.lines[0]).toMatchObject({ exit: 'fixture_miss', transport: 'mock' });
  });

  test('a POST never looks up a fixture', async () => {
    const fixtures = memoryFixtures();
    const r = run(world({ mock: true }), spyConnector(), fixtures);
    expectEnvelope(await r.finacle({ path: BALANCE_PATH, method: 'POST', body: {} }), 'refused');
    expect(fixtures.gets).toBe(0);
  });
});

describe('not configured', () => {
  test('with the flag off, the call answers with the reason and never looks up a fixture', async () => {
    const fixtures = memoryFixtures();
    fixtures.add('cbs_call', { entity: 'ssfb', method: 'GET', path: BALANCE_PATH }, { status: 200, body: {} });
    const spy = spyConnector();
    const r = run(world({ mock: true, env: { [FLAG]: 'false' } }), spy, fixtures);
    const env = await r.finacle({ path: BALANCE_PATH });
    expectEnvelope(env, 'not_configured');
    expect(env.output.message).toBe(`not configured for ssfb:finacle: ${FLAG} is not true`);
    expect(fixtures.gets).toBe(0);
    expect(spy.calls).toHaveLength(0);
    expect(r.audit.lines[0]).toMatchObject({ exit: 'not_configured', target: FLAG, reason: `not configured: ${FLAG} is not true` });
  });

  test('real mode without a gateway answers not configured before the connector is touched', async () => {
    const spy = spyConnector();
    const r = run(world({ env: { SSFB_CBS_GATEWAY_URL: '' } }), spy);
    const env = await r.finacle({ path: BALANCE_PATH });
    expectEnvelope(env, 'not_configured');
    expect(env.output.message).toBe('not configured for ssfb:finacle');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('the service list', () => {
  // The service field's description sits in the input schema's pipe.
  const schemaText = (w: SsfbWorld): string => JSON.stringify(run(w, undefined).tool.input);

  test('real mode offers and describes finacle only when the gateway is on', () => {
    const on = world();
    const off = world({ env: { [FLAG]: 'false' } });
    expect(offeredServices(run(on, undefined).ctx)).toContain('finacle');
    expect(offeredServices(run(off, undefined).ctx)).not.toContain('finacle');
    expect(schemaText(on)).toContain('Finacle CBS gateway');
    expect(schemaText(off)).not.toContain('Finacle');
    for (const w of [on, off]) expect(schemaText(w)).not.toContain('cbs_call');
  });
});
