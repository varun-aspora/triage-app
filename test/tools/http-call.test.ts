import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlueLogger } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { releaseEscalation } from '../../src/agents/escalation.ts';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { loadRegistry, type Registry } from '../../src/config/registry.ts';
import { createHttpConnector, type FetchLike } from '../../src/connectors/http/client.ts';
import { createMemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../../src/gate/budget.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import { keyString, semanticKey, type HttpCallFacts } from '../../src/mock/key.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { createToolDeps, type ToolConnectors } from '../../src/tools/_lib/context.ts';
import type { StagingHarness } from '../../src/tools/_lib/pipeline.ts';
import { apiServices, capBody, HTTP_BODY_MAX_CHARS, toolModule } from '../../src/tools/http-call.tool.ts';
import { allToolNames } from '../../src/tools/index.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import type { AuditLine } from '../../src/types/audit.ts';
import type { Entity } from '../../src/types/core.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { makeToolContext } from '../support/fake-tool-context.ts';
import { makeTestHome, type TestHome } from '../support/home.ts';

// ------------------------------------------------------------------ setup

const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const STRANGER = 'deadbeef-9999-4888-8777-666655554444';
const FIXED_NOW = new Date('2026-09-24T09:30:00.000Z');
const HARBOR_BASE = 'http://harbor.test.invalid/harbor';
const FAKE_TOKEN = 'bro-token-Zq93kLm2';

const OVERRIDES = {
  SSFB_HARBOR_API_URL: HARBOR_BASE,
  SSFB_BRO_API_URL: 'http://bro.test.invalid/bro',
  ATSPL_PULSE_API_URL: 'http://pulse.test.invalid',
  // ATSPL_PACKAGE_API_URL stays blank.
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let seq = 0;

type Fixtures = Map<string, unknown>;

type Setup = {
  readonly ctx: ToolContext;
  readonly tool: ToolDefinition;
  readonly audit: ReturnType<typeof createMemoryAuditSink>;
  readonly home: TestHome;
  readonly storeCalls: () => number;
  readonly fetchCalls: { url: URL; init: RequestInit }[];
};

type SetupOptions = {
  entity?: Entity;
  real?: boolean;
  env?: Record<string, string>;
  chain?: IdChain;
  fixtures?: Fixtures;
  rules?: unknown;
  fetchImpl?: FetchLike;
  noConnector?: boolean;
};

function fixtureKey(facts: HttpCallFacts): string {
  return keyString(semanticKey('http_call', facts));
}

function setup(opts: SetupOptions = {}): Setup {
  seq += 1;
  const runId = `run_http_${seq}_${Math.random().toString(36).slice(2, 8)}`;
  const home = makeTestHome({ overrides: { ...OVERRIDES, ...(opts.env ?? {}) } });
  cleanups.push(() => {
    home.cleanup();
    releaseRunBudget(runId);
    releaseEscalation(runId);
  });
  if (opts.rules !== undefined) {
    const entity = opts.entity ?? 'ssfb';
    writeFileSync(join(home.home, 'resources', `${entity}.api.rules.json`), JSON.stringify(opts.rules));
  }

  let config: Config = home.config;
  let registry: Registry = home.registry;
  if (opts.real === true) {
    config = configFromRecord({ ...home.env, TRIAGE_MOCK_MODE: 'false', TRIAGE_MOCK_STRICT: 'false' }, home.home);
    registry = loadRegistry(config);
  }

  const calls = { store: 0 };
  const fixtures = opts.fixtures ?? new Map();
  const store: FixtureStore = {
    fixturesDir: join(home.home, 'fixtures'),
    async get(kind, _entity, key) {
      calls.store += 1;
      const result = fixtures.get(keyString(key));
      if (result === undefined) return null;
      return {
        scope: 'shared',
        path: join(home.home, 'fixtures', 'x.json'),
        hash: '0123456789abcdef',
        fixture: { kind, result } as never,
      };
    },
    async list() {
      return [];
    },
  };

  const fetchCalls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    fetchCalls.push({ url, init });
    if (opts.fetchImpl !== undefined) return opts.fetchImpl(url, init);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const connectors: ToolConnectors =
    opts.noConnector === true ? {} : { http: createHttpConnector({ registry, config, fetchImpl }) };

  const audit = createMemoryAuditSink();
  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: opts.chain ?? { ids: { customer_id: CUSTOMER }, hops: [], basic_state: [] },
    connectors,
    runStore: {} as RunStore,
    budget: createRunBudget({
      runId,
      maxToolCalls: 50,
      maxTasks: 5,
      maxRowsPerCall: 200,
      maxBytesPerCall: 1_000_000,
      maxBytesPerRun: 10_000_000,
    }),
    audit,
    fixtures: createMockLayer(config, { store }),
    now: () => FIXED_NOW,
  });
  const ctx: ToolContext = Object.freeze({ runId, entity: opts.entity ?? 'ssfb', config, registry, deps });
  const tool = toolModule.create(ctx, 'investigator');
  return { ctx, tool, audit, home, storeCalls: () => calls.store, fetchCalls };
}

const log: FlueLogger = { info() {}, warn() {}, error() {} };

async function call(s: Setup, data: Record<string, unknown>, harness?: StagingHarness): Promise<ToolEnvelope> {
  const out = await s.tool.run({ data, toolCallId: 'toolu_http_1', log, ...(harness ? { harness } : {}) } as never);
  return v.parse(ToolEnvelopeSchema, out);
}

function lastAudit(s: Setup): AuditLine {
  const line = s.audit.lines.at(-1);
  if (line === undefined) throw new Error('no audit line');
  return line;
}

function harborFixture(path: string, method = 'GET', result: unknown = { status: 200, body: { state: 'ACTIVE' } }): Fixtures {
  return new Map([[fixtureKey({ entity: 'ssfb', service: 'harbor', method, path }), result]]);
}

// ------------------------------------------------------------------ module

describe('http_call module', () => {
  test('is picked up by the generated tool list and mounted on investigators', () => {
    expect(allToolNames()).toContain('http_call');
    expect(toolModule.mounts).toEqual(['investigator']);
    expect(toolModule.entities).toBe('all');
  });

  test('create() and enabled() do not touch ctx.deps', () => {
    const ctx = makeToolContext({ entity: 'ssfb' });
    expect(toolModule.enabled(ctx, 'investigator')).toEqual({ on: true });
    expect(() => toolModule.create(ctx, 'investigator_deep')).not.toThrow();
  });

  test('deny: off without an entity', () => {
    const ctx = makeToolContext({ entity: null });
    expect(toolModule.enabled(ctx, 'investigator').on).toBe(false);
  });

  test('schema has no headers/entity/run_id field and refuses them', () => {
    const tool = toolModule.create(makeToolContext({ entity: 'ssfb' }), 'investigator');
    const entries = Object.keys((tool.input as unknown as { entries: Record<string, unknown> }).entries).sort();
    expect(entries).toEqual(['body', 'method', 'path', 'query', 'service']);
    for (const extra of [{ headers: { 'x-customer-id': STRANGER } }, { entity: 'atspl' }, { run_id: 'run_x' }]) {
      expect(v.safeParse(tool.input as v.GenericSchema, { service: 'harbor', path: '/x', ...extra }).success).toBe(false);
    }
  });

  test('method defaults to GET and must be a known verb', () => {
    const tool = toolModule.create(makeToolContext({ entity: 'ssfb' }), 'investigator');
    const parsed = v.parse(tool.input as v.GenericSchema, { service: 'harbor', path: '/x' }) as { method: string };
    expect(parsed.method).toBe('GET');
    expect(v.safeParse(tool.input as v.GenericSchema, { service: 'harbor', path: '/x', method: 'TRACE' }).success).toBe(false);
  });

  test('service is a picklist of the entity API services', () => {
    const ssfb = makeToolContext({ entity: 'ssfb' });
    expect(apiServices(ssfb)).toEqual(['bro', 'cohort', 'finacle', 'guardian', 'harbor', 'rhythm']);
    expect(apiServices(makeToolContext({ entity: 'atspl' }))).toEqual(['package', 'pulse']);
    const tool = toolModule.create(ssfb, 'investigator');
    expect(v.safeParse(tool.input as v.GenericSchema, { service: 'comms', path: '/x' }).success).toBe(false);
  });
});

// ------------------------------------------------------------------ method rules

describe('http_call method rules', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    test(`deny: ${method} with the shipped empty rules is refused with rule_index 'default'`, async () => {
      const s = setup({ fixtures: harborFixture('/admin/v1/x', method) });
      const env = await call(s, { service: 'harbor', path: '/admin/v1/x', method, ...(method !== 'DELETE' ? { body: { a: 1 } } : {}) });
      expect(env.output.status).toBe('refused');
      expect(env.output.message).toContain('blocked by default');
      const line = lastAudit(s);
      expect(line.decision).toBe('deny');
      expect(line.rule_index).toBe('default');
      expect(line.action).toBe('block');
      expect(line.target).toBe('SSFB_HARBOR_API_URL');
      expect(s.storeCalls()).toBe(0);
    });
  }

  for (const method of ['GET', 'HEAD']) {
    test(`allow: ${method} with the shipped empty rules`, async () => {
      const s = setup({ fixtures: harborFixture('/admin/v1/x', method) });
      const env = await call(s, { service: 'harbor', path: '/admin/v1/x', method });
      expect(env.output.status).toBe('ok');
      const line = lastAudit(s);
      expect(line.decision).toBe('allow');
      expect(line.rule_index).toBe('default');
      expect(line.action).toBe('allow');
    });
  }

  test('rules match the path relative to the service base: an allow rule lets one POST through', async () => {
    const rules = [{ service: 'harbor', method: 'POST', api: '/admin/v1/dry-run', action: 'allow', reason: 'evaluates without writing' }];
    const s = setup({ rules, fixtures: harborFixture('/admin/v1/dry-run', 'POST') });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/dry-run', method: 'POST', body: { a: 1 } });
    expect(env.output.status).toBe('ok');
    expect((env.output.data as { rule_index: unknown }).rule_index).toBe(0);
    expect(lastAudit(s).rule_index).toBe(0);
  });

  test('deny: a block rule refuses a GET and names the rule', async () => {
    const rules = [{ service: 'harbor', method: 'GET', api: '/admin/v1/forms/:form_id/trigger-customer-creation', action: 'block', reason: 'mutating trigger' }];
    const s = setup({ rules });
    const env = await call(s, { service: 'harbor', path: `/admin/v1/forms/${CUSTOMER}/trigger-customer-creation` });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('by rule 0');
    expect(lastAudit(s).rule_index).toBe(0);
    expect(s.storeCalls()).toBe(0);
  });

  test('deny: a rule template that includes the service base path refuses every call to that service', async () => {
    const rules = [{ service: 'harbor', method: 'GET', api: '/harbor/admin/v1/forms/:form_id/trigger-customer-creation', action: 'block' }];
    const s = setup({ rules, fixtures: harborFixture(`/admin/v1/forms/${CUSTOMER}/trigger-customer-creation`) });
    const env = await call(s, { service: 'harbor', path: `/admin/v1/forms/${CUSTOMER}/trigger-customer-creation` });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('relative to the service base');
    expect(lastAudit(s).decision).toBe('deny');
    expect(s.storeCalls()).toBe(0);
  });

  test('a full-path template on another service does not block harbor', async () => {
    const rules = [{ service: 'bro', method: 'GET', api: '/bro/x', action: 'block' }];
    const s = setup({ rules, fixtures: harborFixture('/admin/v1/x') });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/x' });
    expect(env.output.status).toBe('ok');
  });

  test('deny: a broken rules file refuses every call', async () => {
    const s = setup({ rules: { not: 'a list' }, fixtures: harborFixture('/admin/v1/x') });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/x' });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('ssfb.api.rules.json');
    expect(lastAudit(s).decision).toBe('deny');
    expect(s.storeCalls()).toBe(0);
  });

  test('deny: a body on GET is refused', async () => {
    const s = setup({ fixtures: harborFixture('/admin/v1/x') });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/x', body: { a: 1 } });
    expect(env.output.status).toBe('refused');
    expect(s.storeCalls()).toBe(0);
  });
});

// ------------------------------------------------------------------ path checks

describe('http_call path checks', () => {
  const variants = [
    '/admin/../secret',
    '/admin/v1/..',
    '/admin%2Fv1',
    '/admin%2fv1',
    '/admin/%2e%2e/x',
    '/admin/%00',
    '/admin/x%0d%0aHost:evil',
    '//evil.test.invalid/x',
    'http://x',
    'https://evil.test.invalid/admin',
    'admin/v1',
    '/admin\\v1',
    '/admin/@evil',
    '/admin?x=1',
    '/admin#frag',
  ];
  for (const path of variants) {
    test(`deny: ${JSON.stringify(path)} is refused before any connector call`, async () => {
      const s = setup({ real: true });
      const env = await call(s, { service: 'harbor', path });
      expect(env.output.status).toBe('refused');
      expect(s.fetchCalls.length).toBe(0);
      expect(lastAudit(s).decision).toBe('deny');
    });
  }

  test('deny: traversal is refused in mock mode without a fixture lookup', async () => {
    const s = setup();
    const env = await call(s, { service: 'harbor', path: '/admin/../x' });
    expect(env.output.status).toBe('refused');
    expect(s.storeCalls()).toBe(0);
  });

  test('deny: traversal is refused even when the base URL is blank', async () => {
    const s = setup({ entity: 'atspl' });
    const env = await call(s, { service: 'package', path: '/a/../b' });
    expect(env.output.status).toBe('refused');
  });
});

// ------------------------------------------------------------------ services

describe('http_call services', () => {
  test('deny: finacle is refused and the message names cbs_call', async () => {
    const s = setup({ real: true });
    const env = await call(s, { service: 'finacle', path: '/custom/api/x' });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('cbs_call');
    expect(s.fetchCalls.length).toBe(0);
    expect(lastAudit(s).decision).toBe('deny');
  });

  test('deny: finacle on an entity without it still points to cbs_call', async () => {
    const s = setup({ entity: 'atspl' });
    const env = await call(s, { service: 'finacle', path: '/custom/api/x' });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('cbs_call');
  });

  test('deny: a service without an API is refused', async () => {
    const s = setup();
    const env = await call(s, { service: 'comms', path: '/x' });
    expect(env.output.status).toBe('refused');
    expect(s.storeCalls()).toBe(0);
  });

  test("not configured on blank base: answers 'not configured for atspl:package'", async () => {
    const s = setup({ entity: 'atspl' });
    const env = await call(s, { service: 'package', path: '/admin/v1/x' });
    expect(env.output.status).toBe('not_configured');
    expect(env.output.message).toBe('not configured for atspl:package');
    const line = lastAudit(s);
    expect(line.exit).toBe('not_configured');
    expect(line.target).toBe('ATSPL_PACKAGE_API_URL');
    expect(s.storeCalls()).toBe(0);
  });

  test('not configured: a blank auth token in real mode names the service', async () => {
    const s = setup({ real: true });
    const env = await call(s, { service: 'bro', path: '/health' });
    expect(env.output.status).toBe('not_configured');
    expect(env.output.message).toBe('not configured for ssfb:bro');
    expect(lastAudit(s).target).toBe('SSFB_BRO_ADMIN_TOKEN');
    expect(s.fetchCalls.length).toBe(0);
  });

  test('not configured: real mode without an HTTP connector', async () => {
    const s = setup({ real: true, noConnector: true });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/x' });
    expect(env.output.status).toBe('not_configured');
  });
});

// ------------------------------------------------------------------ scope

describe('http_call scope', () => {
  test('deny: an out-of-scope id in a path segment', async () => {
    const s = setup({ real: true });
    const env = await call(s, { service: 'harbor', path: `/admin/v1/customers/${STRANGER}` });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('ID chain');
    expect(lastAudit(s).decision).toBe('deny');
    expect(s.fetchCalls.length).toBe(0);
  });

  test('deny: an out-of-scope id in a query value', async () => {
    const s = setup();
    const env = await call(s, { service: 'harbor', path: '/admin/v1/customers', query: { customer_id: STRANGER } });
    expect(env.output.status).toBe('refused');
    expect(lastAudit(s).decision).toBe('deny');
    expect(s.storeCalls()).toBe(0);
  });

  test('deny: an out-of-scope id percent-encoded in a path segment', async () => {
    const s = setup();
    const encoded = STRANGER.replace('-', '%2D');
    const env = await call(s, { service: 'harbor', path: `/admin/v1/customers/${encoded}` });
    expect(env.output.status).toBe('refused');
    expect(s.storeCalls()).toBe(0);
  });

  test('deny: an IdChain customer id that cannot go into a header', async () => {
    const s = setup({ real: true, chain: { ids: { customer_id: 'bad id;x' }, hops: [], basic_state: [] } });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/health' });
    expect(env.output.status).toBe('refused');
    expect(s.fetchCalls.length).toBe(0);
  });
});

// ------------------------------------------------------------------ allowed calls

describe('http_call allowed calls', () => {
  test('allow: GET mock hit returns status, body, rule_index, taken_at', async () => {
    const path = `/admin/v1/customers/${CUSTOMER}`;
    const s = setup({ fixtures: harborFixture(path, 'GET', { status: 200, body: { id: CUSTOMER, state: 'ACTIVE' }, truncated: false, rule_index: 'default' }) });
    const env = await call(s, { service: 'harbor', path });
    expect(env.output.status).toBe('ok');
    expect(env.output.taken_at).toBe(FIXED_NOW.toISOString());
    expect(env.output.data).toEqual({
      service: 'harbor',
      method: 'GET',
      path,
      status: 200,
      body: { id: CUSTOMER, state: 'ACTIVE' },
      truncated: false,
      body_bytes: JSON.stringify({ id: CUSTOMER, state: 'ACTIVE' }).length,
      rule_index: 'default',
    });
    const line = lastAudit(s);
    expect(line.decision).toBe('allow');
    expect(line.transport).toBe('mock');
    expect(line.target).toBe('SSFB_HARBOR_API_URL');
    expect(s.fetchCalls.length).toBe(0);
  });

  test('the fixture key uses the path relative to the base and the query', async () => {
    const path = '/admin/v1/customers';
    const fixtures = new Map([
      [fixtureKey({ entity: 'ssfb', service: 'harbor', method: 'GET', path, query: { customer_id: CUSTOMER } }), { status: 204, body: '' }],
    ]);
    const s = setup({ fixtures });
    const env = await call(s, { service: 'harbor', path, query: { customer_id: CUSTOMER } });
    expect(env.output.status).toBe('ok');
    expect((env.output.data as { status: number }).status).toBe(204);
  });

  test('a strict mock miss throws loudly', async () => {
    const s = setup();
    await expect(call(s, { service: 'harbor', path: '/admin/v1/none' })).rejects.toThrow();
  });

  test('real GET: URL on the registry base, x-customer-id from the IdChain, model headers ignored', async () => {
    const s = setup({
      real: true,
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: CUSTOMER }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const env = await call(s, {
      service: 'harbor',
      path: `/admin/v1/customers/${CUSTOMER}`,
      query: { view: 'full' },
      headers: { 'x-customer-id': STRANGER, authorization: 'Bearer x' },
    });
    expect(env.output.status).toBe('ok');
    expect(s.fetchCalls.length).toBe(1);
    const sent = s.fetchCalls[0]!;
    expect(sent.url.href).toBe(`${HARBOR_BASE}/admin/v1/customers/${CUSTOMER}?view=full`);
    expect(sent.init.method).toBe('GET');
    const headers = sent.init.headers as Record<string, string>;
    expect(headers['x-customer-id']).toBe(CUSTOMER);
    expect(headers['authorization']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(STRANGER);
    expect(lastAudit(s).transport).toBe('real');
    expect(env.output.data).toMatchObject({ status: 200, body: { id: CUSTOMER }, rule_index: 'default' });
  });

  test('real GET: the registry auth token is sent and never shows in the result or audit', async () => {
    const s = setup({ real: true, env: { SSFB_BRO_ADMIN_TOKEN: FAKE_TOKEN } });
    const env = await call(s, { service: 'bro', path: '/health' });
    expect(env.output.status).toBe('ok');
    const headers = s.fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(env)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(s.audit.lines)).not.toContain(FAKE_TOKEN);
  });

  test('path / maps to the base path itself', async () => {
    const s = setup({ real: true });
    const env = await call(s, { service: 'harbor', path: '/' });
    expect(env.output.status).toBe('ok');
    expect(s.fetchCalls[0]!.url.href).toBe(HARBOR_BASE);
  });

  test('an unreachable service answers unreachable with its reason but without the base URL', async () => {
    const s = setup({
      real: true,
      fetchImpl: async () => {
        throw new Error(`connect ECONNREFUSED ${HARBOR_BASE}`);
      },
    });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/x' });
    expect(env.output.status).toBe('unreachable');
    const message = env.output.status === 'unreachable' ? env.output.message : '';
    expect(message).toContain('the request failed: connect ECONNREFUSED');
    expect(message).toContain('try another source');
    expect(JSON.stringify(env)).not.toContain('harbor.test.invalid');
  });
});

// ------------------------------------------------------------------ body cap

describe('http_call body cap', () => {
  test('body cap enforced: a long body is cut, marked truncated and the full body is staged', async () => {
    const big = 'x'.repeat(HTTP_BODY_MAX_CHARS * 3);
    const s = setup({ fixtures: harborFixture('/admin/v1/big', 'GET', { status: 200, body: big }) });
    const written: { path: string; content: string }[] = [];
    const harness: StagingHarness = {
      sandbox: {
        async writeFile(path: string, content: string | Uint8Array) {
          written.push({ path, content: String(content) });
        },
      },
    };
    const env = await call(s, { service: 'harbor', path: '/admin/v1/big' }, harness);
    const data = env.output.data as { body: string; truncated: boolean; body_bytes: number; staged_file: string };
    expect(data.body.length).toBe(HTTP_BODY_MAX_CHARS);
    expect(data.truncated).toBe(true);
    expect(data.body_bytes).toBe(big.length);
    expect(data.staged_file).toBe('/data/toolu_http_1.json');
    expect(written.length).toBe(1);
    expect(JSON.parse(written[0]!.content).body.length).toBe(big.length);
  });

  test('body cap follows TRIAGE_MAX_RESPONSE_BYTES_PER_CALL when it is lower', async () => {
    const body = { rows: Array.from({ length: 50 }, (_, i) => ({ i, note: 'row' })) };
    const s = setup({ env: { TRIAGE_MAX_RESPONSE_BYTES_PER_CALL: '100' }, fixtures: harborFixture('/admin/v1/rows', 'GET', { status: 200, body }) });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/rows' });
    const data = env.output.data as { body: unknown; truncated: boolean };
    expect(typeof data.body).toBe('string');
    expect((data.body as string).length).toBe(100);
    expect(data.truncated).toBe(true);
  });

  test('a truncated flag from the connector is kept', async () => {
    const s = setup({ fixtures: harborFixture('/admin/v1/cut', 'GET', { status: 200, body: 'abc', truncated: true }) });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/cut' });
    expect((env.output.data as { truncated: boolean }).truncated).toBe(true);
  });

  test('the body passes the model-facing redaction profile', async () => {
    const card = '4111111111111111';
    const s = setup({ fixtures: harborFixture('/admin/v1/card', 'GET', { status: 200, body: { card } }) });
    const env = await call(s, { service: 'harbor', path: '/admin/v1/card' });
    expect(env.output.status).toBe('ok');
    expect(JSON.stringify(env)).not.toContain(card);
  });

  test('deny: a fixture with the wrong shape is a loud error', async () => {
    const s = setup({ fixtures: harborFixture('/admin/v1/odd', 'GET', { nope: true }) });
    await expect(call(s, { service: 'harbor', path: '/admin/v1/odd' })).rejects.toThrow('wrong shape');
  });

  test('capBody keeps a short body as is', () => {
    expect(capBody({ a: 1 }, 100)).toEqual({ body: { a: 1 }, truncated: false, body_bytes: 7 });
    expect(capBody(undefined, 100)).toEqual({ body: null, truncated: false, body_bytes: 4 });
  });
});
