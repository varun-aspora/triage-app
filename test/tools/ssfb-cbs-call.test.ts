import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { CbsCallInput, CbsConnector, CbsResponse } from '../../src/connectors/cbs/client.ts';
import { type ConnectorOutcome, envVarName } from '../../src/connectors/types.ts';
import { FixtureMissError } from '../../src/mock/errors.ts';
import { buildToolIndex } from '../../src/tools/index.ts';
import { cbsGate, renderCbs, toolModule } from '../../src/tools/ssfb/cbs-call.tool.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../support/fake-tool-context.ts';
import { FIXED_NOW, makeSsfbRun, makeSsfbWorld, memoryFixtures, type MemoryFixtures, type SsfbWorld } from '../support/ssfb-tools.ts';

const ACCOUNT = '123456789012';
const FOREIGN_ACCOUNT = '998877665544';
const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const CHAIN: IdChain = { ids: { account_number: ACCOUNT, customer_id: CUSTOMER }, hops: [], basic_state: [] };
// A reserved TLD: never resolves. Real mode here only ever reaches the fake connector.
const GATEWAY = 'https://cbs-gateway.test.invalid';
const BALANCE_PATH = `/fi/v1/accounts/${ACCOUNT}/balance`;

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
    env: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true', SSFB_CBS_GATEWAY_URL: GATEWAY, ...opts.env },
  });
  cleanups.push(w.cleanup);
  return w;
}

function run(w: SsfbWorld, connector: CbsConnector | undefined, fixtures: MemoryFixtures = memoryFixtures()) {
  const r = makeSsfbRun(w, { idChain: CHAIN, fixtures, ...(connector !== undefined ? { connectors: { cbs: connector } } : {}) });
  cleanups.push(r.release);
  const tool = toolModule.create(r.ctx, 'investigator');
  return { ...r, tool, fixtures, cbs: (d: Record<string, unknown>): Promise<ToolEnvelope> => r.call(tool, d) };
}

function expectEnvelope(env: ToolEnvelope, status: string): void {
  expect(v.is(ToolEnvelopeSchema, env)).toBe(true);
  expect(env.output.status).toBe(status as never);
}

const POST_RULES = [
  { service: 'finacle', method: 'POST', api: '/fi/v1/accounts/:account/holds', action: 'allow', reason: 'read holds by POST query' },
];

describe('deny each bad path form', () => {
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
      const env = await r.cbs({ path });
      expectEnvelope(env, 'refused');
      expect(spy.calls).toHaveLength(0);
      expect(r.audit.lines).toHaveLength(1);
      const line = r.audit.lines[0];
      expect(line?.decision).toBe('deny');
      expect(line?.tool).toBe('cbs_call');
      expect(line?.target).toBe('SSFB_CBS_GATEWAY_URL');
      expect(line?.reason).toMatch(/^gate: /);
    });
  }

  test('the refusal text does not echo the rejected path', async () => {
    const r = run(world(), spyConnector());
    const env = await r.cbs({ path: '/fi/v1/../evil-marker' });
    expect(JSON.stringify(env)).not.toContain('evil-marker');
    expect(JSON.stringify(r.audit.lines)).not.toContain('evil-marker');
  });
});

describe('deny: POST with empty rules', () => {
  test('the shipped empty rules file blocks POST with rule_index default', async () => {
    const spy = spyConnector();
    const r = run(world(), spy);
    const env = await r.cbs({ path: `/fi/v1/accounts/${ACCOUNT}/holds`, method: 'POST', body: { account: ACCOUNT } });
    expectEnvelope(env, 'refused');
    expect(env.output.message).toContain('blocked by default');
    expect(spy.calls).toHaveLength(0);
    const line = r.audit.lines[0];
    expect(line?.decision).toBe('deny');
    expect(line?.rule_index).toBe('default');
    expect(line?.action).toBe('block');
    expect(line?.reason).toBe('gate: blocked_by_rule');
  });

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    test(`${method} is blocked by default too`, async () => {
      const spy = spyConnector();
      const r = run(world(), spy);
      expectEnvelope(await r.cbs({ path: BALANCE_PATH, method }), 'refused');
      expect(r.audit.lines[0]?.rule_index).toBe('default');
      expect(spy.calls).toHaveLength(0);
    });
  }

  test('a POST that a rule allows reaches the connector with the gate decision and body', async () => {
    const spy = spyConnector({ status: 200, body: { holds: [] } });
    const r = run(world({ rules: POST_RULES }), spy);
    const path = `/fi/v1/accounts/${ACCOUNT}/holds`;
    const env = await r.cbs({ path, method: 'POST', body: { account: ACCOUNT } });
    expectEnvelope(env, 'ok');
    expect(env.output.data).toEqual({ status: 200, body: { holds: [] }, truncated: false });
    expect(spy.calls).toHaveLength(1);
    const call = spy.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe(path);
    expect(call?.body).toEqual({ account: ACCOUNT });
    expect(call?.decision).toMatchObject({ ok: true, action: 'allow', method: 'POST', pathname: path, rule_index: 0 });
    expect(call?.keyInput).toEqual({ entity: 'ssfb', service: 'finacle', method: 'POST', path, body: { account: ACCOUNT } });
    const line = r.audit.lines[0];
    expect(line?.decision).toBe('allow');
    expect(line?.rule_index).toBe(0);
    expect(line?.action).toBe('allow');
    expect(line?.transport).toBe('real');
  });

  test('GET with a body is refused', async () => {
    const spy = spyConnector();
    const r = run(world(), spy);
    expectEnvelope(await r.cbs({ path: BALANCE_PATH, body: { x: 1 } }), 'refused');
    expect(spy.calls).toHaveLength(0);
  });

  test('a rules file that fails to load blocks every call', async () => {
    const spy = spyConnector();
    const r = run(world({ rules: { not: 'a list' } }), spy);
    const env = await r.cbs({ path: BALANCE_PATH });
    expectEnvelope(env, 'refused');
    expect(env.output.message).toContain('rules file could not be loaded');
    expect(r.audit.lines[0]?.reason).toBe('rules file failed to load');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('deny: out-of-scope id', () => {
  test('an account number in the path that is not in the IdChain is denied', async () => {
    const spy = spyConnector();
    const r = run(world(), spy);
    const env = await r.cbs({ path: `/fi/v1/accounts/${FOREIGN_ACCOUNT}/balance` });
    expectEnvelope(env, 'refused');
    expect(env.output.message).toContain('ID chain');
    expect(spy.calls).toHaveLength(0);
    const line = r.audit.lines[0];
    expect(line?.decision).toBe('deny');
    expect(line?.reason).toMatch(/^scope: /);
    // Masked to the last 4 characters.
    expect(JSON.stringify(r.audit.lines)).not.toContain(FOREIGN_ACCOUNT);
  });

  test('an out-of-scope id in a POST body is denied even when a rule allows the POST', async () => {
    const spy = spyConnector();
    const r = run(world({ rules: POST_RULES }), spy);
    const env = await r.cbs({ path: `/fi/v1/accounts/${ACCOUNT}/holds`, method: 'POST', body: { other: FOREIGN_ACCOUNT } });
    expectEnvelope(env, 'refused');
    expect(r.audit.lines[0]?.reason).toMatch(/^scope: /);
    expect(spy.calls).toHaveLength(0);
  });

  test('an id from the IdChain passes and the GET reaches the connector', async () => {
    const spy = spyConnector();
    const r = run(world(), spy);
    const env = await r.cbs({ path: BALANCE_PATH });
    expectEnvelope(env, 'ok');
    expect(env.output.data).toEqual({ status: 200, body: { balance: '1520.00', currency: 'INR' }, truncated: false });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.method).toBe('GET');
    expect(r.audit.lines[0]).toMatchObject({ decision: 'allow', rule_index: 'default', action: 'allow', transport: 'real' });
  });
});

describe('isEnabled flag handling', () => {
  // The registry itself refuses values other than true or false, so it is
  // built from a valid .env and the flag is varied in the config only.
  const registry = makeToolContext().registry;

  for (const [value, on] of [
    ['true', true],
    ['false', false],
    ['', false],
    ['TRUE', false],
    ['True', false],
    ['1', false],
    ['yes', false],
    [undefined, false],
  ] as const) {
    test(`SSFB_CBS_VIA_KUBECTL_ENABLED=${JSON.stringify(value)} gives on=${on}`, () => {
      const ctx = makeToolContext({
        entity: 'ssfb',
        config: makeTestConfig({ SSFB_CBS_VIA_KUBECTL_ENABLED: value }),
        registry,
      });
      const state = toolModule.enabled(ctx, 'investigator');
      expect(state.on).toBe(on);
      if (!state.on) expect(state.reason).toBe('SSFB_CBS_VIA_KUBECTL_ENABLED is not true');
      const tools = buildToolIndex([toolModule]).toolsFor('investigator', ctx);
      expect(tools.map((t) => t.name)).toEqual(on ? ['cbs_call'] : []);
    });
  }

  test('only the SSFB investigator gets it', () => {
    const config = makeTestConfig({ SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' });
    expect(toolModule.entities).toEqual(['ssfb']);
    expect(buildToolIndex([toolModule]).toolsFor('investigator', makeToolContext({ entity: 'rtl', config }))).toEqual([]);
    expect(buildToolIndex([toolModule]).toolsFor('investigator_deep', makeToolContext({ entity: 'ssfb', config })).map((t) => t.name)).toEqual([
      'cbs_call',
    ]);
  });

  test('the input schema has no entity or run id and defaults the method to GET', () => {
    const ctx = makeToolContext({ entity: 'ssfb', config: makeTestConfig({ SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' }) });
    const tool = toolModule.create(ctx, 'investigator');
    const parsed = v.safeParse(tool.input as v.GenericSchema, { path: BALANCE_PATH });
    expect(parsed.success).toBe(true);
    expect((parsed.output as { method?: string }).method).toBe('GET');
    expect(v.safeParse(tool.input as v.GenericSchema, { path: BALANCE_PATH, method: 'OPTIONS' }).success).toBe(false);
  });
});

describe('mock hit, connector untouched', () => {
  test('mock mode answers from the cbs_call fixture and audits transport mock', async () => {
    const fixtures = memoryFixtures();
    fixtures.add('cbs_call', { entity: 'ssfb', method: 'GET', path: BALANCE_PATH }, { status: 200, body: { balance: '99.00' } });
    const spy = spyConnector();
    // No gateway URL: mock mode needs none.
    const r = run(world({ mock: true, env: { SSFB_CBS_GATEWAY_URL: '' } }), spy, fixtures);
    const env = await r.cbs({ path: BALANCE_PATH });
    expectEnvelope(env, 'ok');
    expect(env.output.data).toEqual({ status: 200, body: { balance: '99.00' }, truncated: false });
    expect(spy.calls).toHaveLength(0);
    expect(r.audit.lines).toHaveLength(1);
    expect(r.audit.lines[0]).toMatchObject({ decision: 'allow', transport: 'mock', target: 'SSFB_CBS_GATEWAY_URL' });
  });

  test('mock mode without a connector in deps builds none and still answers', async () => {
    const fixtures = memoryFixtures();
    fixtures.add('cbs_call', { entity: 'ssfb', method: 'GET', path: BALANCE_PATH }, { status: 404, body: 'not found' });
    const r = run(world({ mock: true }), undefined, fixtures);
    const env = await r.cbs({ path: BALANCE_PATH });
    expectEnvelope(env, 'ok');
    expect(env.output.data).toEqual({ status: 404, body: 'not found', truncated: false });
    expect(r.audit.lines[0]?.transport).toBe('mock');
  });

  test('a strict mock miss throws, and the connector is not called', async () => {
    const spy = spyConnector();
    const r = run(world({ mock: true }), spy);
    await expect(r.cbs({ path: BALANCE_PATH })).rejects.toBeInstanceOf(FixtureMissError);
    expect(spy.calls).toHaveLength(0);
    expect(r.audit.lines[0]).toMatchObject({ exit: 'fixture_miss', transport: 'mock' });
  });

  test('mock mode still gates: a blocked POST never looks up a fixture', async () => {
    const fixtures = memoryFixtures();
    const r = run(world({ mock: true }), spyConnector(), fixtures);
    expectEnvelope(await r.cbs({ path: BALANCE_PATH, method: 'POST', body: {} }), 'refused');
    expect(fixtures.gets).toBe(0);
    expect(r.audit.lines[0]).toMatchObject({ decision: 'deny', transport: 'mock', rule_index: 'default' });
  });
});

describe('real mode without a gateway', () => {
  test('answers not configured before the connector is touched', async () => {
    const spy = spyConnector();
    const r = run(world({ env: { SSFB_CBS_GATEWAY_URL: '' } }), spy);
    const env = await r.cbs({ path: BALANCE_PATH });
    expectEnvelope(env, 'not_configured');
    expect(env.output.message).toBe('not configured for ssfb:finacle');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('pure helpers', () => {
  test('cbsGate decides on the path alone, with the rules given', () => {
    expect(cbsGate([], { path: BALANCE_PATH, method: 'GET' }).gate).toEqual({ ok: true, rule_index: 'default', action: 'allow' });
    expect(cbsGate([], { path: BALANCE_PATH, method: 'HEAD' }).gate.ok).toBe(true);
    expect(cbsGate(null, { path: BALANCE_PATH, method: 'GET' }).gate.ok).toBe(false);
    expect(cbsGate([], { path: 42, method: 'GET' }).gate.ok).toBe(false);
  });

  test('renderCbs caps a long body and keeps the status', () => {
    const long = { rows: 'x'.repeat(200) };
    const out = renderCbs({ status: 200, body: long }, 50);
    expect(out['status']).toBe(200);
    expect(out['truncated']).toBe(true);
    expect(String(out['body'])).toHaveLength(50);
    expect(renderCbs({ status: 500, body: 'short' }, 50)).toEqual({ status: 500, body: 'short', truncated: false });
  });
});
