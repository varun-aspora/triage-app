import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { escalationFor, releaseEscalation } from '../../src/agents/escalation.ts';
import type { Config } from '../../src/config/env.ts';
import type { Capability } from '../../src/config/registry.ts';
import { ConnectorError } from '../../src/connectors/types.ts';
import { createMemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget, type RunBudget } from '../../src/gate/budget.ts';
import { FixtureMissError } from '../../src/mock/errors.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import { semanticKey } from '../../src/mock/key.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { connectorFailuresFor, releaseConnectorFailures } from '../../src/tools/_lib/connector-failures.ts';
import { createToolDeps, widenIdChain } from '../../src/tools/_lib/context.ts';
import {
  type IoRunContext,
  type IoToolSpec,
  runIoTool,
  stagePath,
  stageRows,
  type StagingHarness,
} from '../../src/tools/_lib/pipeline.ts';
import type { ToolContext, ToolDeps } from '../../src/tools/types.ts';
import type { AuditLine } from '../../src/types/audit.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../support/fake-tool-context.ts';

// ------------------------------------------------------------------ fixtures

const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const STRANGER = 'deadbeef-9999-4888-8777-666655554444';
const EMAIL = 'priya.sharma@example.com';
const ACCOUNT_NO = '123456789012';
const FAKE_DSN = 'postgresql://triage_ro:Sup3rS3cretPw@harbor-db.internal.example:5432/harbor_db';
const FAKE_DSN_PARTS = ['Sup3rS3cretPw', 'harbor-db.internal.example', 'triage_ro:'];
const FIXED_NOW = new Date('2026-09-23T10:00:00.000Z');

const CHAIN: IdChain = { ids: { customer_id: CUSTOMER }, hops: [], basic_state: [] };

type Row = { id: string; email: string; account_number: string };
const ROWS: Row[] = [
  { id: CUSTOMER, email: EMAIL, account_number: ACCOUNT_NO },
  { id: CUSTOMER, email: EMAIL, account_number: ACCOUNT_NO },
  { id: CUSTOMER, email: EMAIL, account_number: ACCOUNT_NO },
];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let runSeq = 0;
function nextRunId(): string {
  runSeq += 1;
  return `run_pipe_${runSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

type Order = string[];

type Harness = {
  ctx: ToolContext;
  deps: ToolDeps;
  config: Config;
  audit: ReturnType<typeof createMemoryAuditSink>;
  budget: RunBudget;
  order: Order;
  storeCalls: number;
  runId: string;
  logs: string[];
};

type SetupOptions = {
  env?: Record<string, string | undefined>;
  maxToolCalls?: number;
  fixtureResult?: unknown;
  withDepsSpies?: boolean;
};

function setup(opts: SetupOptions = {}): Harness {
  const order: Order = [];
  const runId = nextRunId();
  const config = makeTestConfig(opts.env ?? {});
  const base = makeToolContext({ config, runId, entity: 'ssfb' });

  const budget = createRunBudget({
    runId,
    maxToolCalls: opts.maxToolCalls ?? 10,
    maxTasks: 5,
    maxRowsPerCall: 200,
    maxBytesPerCall: 100_000,
    maxBytesPerRun: 1_000_000,
  });
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
    releaseConnectorFailures(runId);
  });
  const spyBudget: RunBudget = {
    ...budget,
    runId: budget.runId,
    consumeToolCall(tool, entity) {
      order.push('spy:budget');
      return budget.consumeToolCall(tool, entity);
    },
  };

  const audit = createMemoryAuditSink();
  const spyAudit = {
    write(line: AuditLine) {
      order.push('spy:audit');
      audit.write(line);
    },
  };

  const h = { storeCalls: 0 };
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get(kind, _entity, _key) {
      order.push('spy:store');
      h.storeCalls += 1;
      if (opts.fixtureResult === undefined) return null;
      return {
        scope: 'shared',
        path: '/triage-test/fixtures/x.json',
        hash: '0123456789abcdef',
        fixture: { kind, result: opts.fixtureResult } as never,
      };
    },
    async list() {
      return [];
    },
  };

  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: CHAIN,
    connectors: {},
    runStore: {} as RunStore,
    redactionNames: ['Priya Sharma'],
    budget: spyBudget,
    audit: spyAudit,
    fixtures: createMockLayer(config, { store }),
    now: () => FIXED_NOW,
  });

  const withSpies: ToolDeps = opts.withDepsSpies
    ? Object.freeze({
        ...deps,
        idChain: () => {
          order.push('spy:idChain');
          return deps.idChain();
        },
      })
    : deps;

  const ctx: ToolContext = Object.freeze({ ...base, deps: withSpies });
  const result: Harness = {
    ctx,
    deps,
    config,
    audit,
    budget,
    order,
    get storeCalls() {
      return h.storeCalls;
    },
    runId,
    logs: [],
  } as Harness;
  return result;
}

function harbor(ctx: ToolContext): Capability {
  const cap = ctx.registry.serviceDb('ssfb', 'harbor');
  if (cap === undefined) throw new Error('ssfb harbor has no db in resources/');
  return cap;
}

type Spies = { gate: number; real: number; render: number };

function sqlSpec(
  h: Harness,
  overrides: Partial<IoToolSpec<'sql_select', Row[]>> = {},
  spies: Spies = { gate: 0, real: 0, render: 0 },
): IoToolSpec<'sql_select', Row[]> {
  const cap = harbor(h.ctx);
  const backing = {
    envName: cap.envName,
    get status() {
      h.order.push('spy:backing');
      return cap.status;
    },
  };
  return {
    tool: 'sql_select',
    service: 'harbor',
    input: { service: 'harbor', sql: 'SELECT id, email FROM account_forms WHERE customer_id = $1', params: [CUSTOMER] },
    backing,
    scope: {},
    gate: () => {
      h.order.push('spy:gate');
      spies.gate += 1;
      return { ok: true };
    },
    fixture: () => ({
      kind: 'sql_select',
      key: semanticKey('sql_select', { entity: 'ssfb', service: 'harbor', tables: ['account_forms'], params: [CUSTOMER] }),
    }),
    real: async () => {
      h.order.push('spy:real');
      spies.real += 1;
      return ROWS;
    },
    render: (rows) => {
      h.order.push('spy:render');
      spies.render += 1;
      return { rows: rows.slice(0, 2), row_count: rows.length, truncated: rows.length > 2 };
    },
    stage: (rows) => rows,
    ...overrides,
  };
}

type Written = { path: string; text: string };

function fakeHarness(h: Harness, fail = false): { harness: StagingHarness; written: Written[] } {
  const written: Written[] = [];
  return {
    written,
    harness: {
      sandbox: {
        async writeFile(path: string, content: string | Uint8Array) {
          h.order.push('spy:writeFile');
          if (fail) throw new Error(`disk full while writing ${String(content)}`);
          written.push({ path, text: String(content) });
        },
      },
    },
  };
}

function runCtx(h: Harness, extra: Partial<IoRunContext> = {}): IoRunContext {
  const signal = extra.signal ?? new AbortController().signal;
  const original = signal.throwIfAborted.bind(signal);
  Object.defineProperty(signal, 'throwIfAborted', {
    value: () => {
      h.order.push('spy:signal');
      original();
    },
  });
  return {
    toolContext: h.ctx,
    toolCallId: 'toolu_01ABCdef',
    signal,
    log: {
      info: (m) => h.logs.push(`info ${m}`),
      warn: (m) => h.logs.push(`warn ${m}`),
      error: (m) => h.logs.push(`error ${m}`),
    },
    onStep: (s) => h.order.push(s),
    ...extra,
  };
}

function expectEnvelope(env: ToolEnvelope): void {
  expect(v.is(ToolEnvelopeSchema, env)).toBe(true);
  expect(typeof env.output.taken_at).toBe('string');
  expect(new Date(env.output.taken_at).toISOString()).toBe(env.output.taken_at);
  expect(JSON.parse(JSON.stringify(env))).toEqual(env);
}

const REAL = { TRIAGE_MOCK_MODE: 'false' };

// ------------------------------------------------------------------ allow path

describe('call order', () => {
  test('allow path, real mode: signal, budget, scope, gate, not-configured, real, audit, stage, redact, envelope', async () => {
    const h = setup({ env: REAL, withDepsSpies: true });
    const { harness } = fakeHarness(h);
    const spies = { gate: 0, real: 0, render: 0 };
    const env = await runIoTool(sqlSpec(h, {}, spies), runCtx(h, { harness }));

    expect(h.order).toEqual([
      'signal',
      'spy:signal',
      'budget',
      'spy:budget',
      'scope',
      'spy:idChain',
      'gate',
      'spy:gate',
      'not_configured',
      'spy:backing',
      'io',
      'spy:signal', // resolveIo checks the signal before the real call
      'spy:real',
      'audit',
      'spy:audit',
      'stage',
      'spy:writeFile',
      'spy:render',
      'redact',
      'envelope',
    ]);
    expect(env.output.status).toBe('ok');
    expectEnvelope(env);
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]).toMatchObject({ decision: 'allow', transport: 'real', target: 'SSFB_HARBOR_DB_URL', exit: 'ok' });
    expect(h.storeCalls).toBe(0);
  });

  test('allow path, mock mode: the store answers in place of the connector', async () => {
    const h = setup({ fixtureResult: ROWS, withDepsSpies: true });
    const { harness } = fakeHarness(h);
    const spies = { gate: 0, real: 0, render: 0 };
    await runIoTool(sqlSpec(h, {}, spies), runCtx(h, { harness }));
    expect(h.order).toEqual([
      'signal',
      'spy:signal',
      'budget',
      'spy:budget',
      'scope',
      'spy:idChain',
      'gate',
      'spy:gate',
      'not_configured',
      'spy:backing',
      'io',
      'spy:signal',
      'spy:store',
      'spy:signal', // and again after the store read
      'audit',
      'spy:audit',
      'stage',
      'spy:writeFile',
      'spy:render',
      'redact',
      'envelope',
    ]);
    expect(spies.real).toBe(0);
  });

  test('ok envelope carries the capped render, the staged path and model-facing redaction', async () => {
    const h = setup({ env: REAL });
    const { harness, written } = fakeHarness(h);
    const env = await runIoTool(sqlSpec(h), runCtx(h, { harness }));
    const data = env.output.data as { rows: Row[]; row_count: number; staged_file: string };
    expect(data.row_count).toBe(3);
    expect(data.rows).toHaveLength(2);
    expect(data.staged_file).toBe('/data/toolu_01ABCdef.json');
    // Model-facing: the email local part is masked, search keys stay.
    expect(JSON.stringify(data)).not.toContain('priya.sharma@');
    expect(data.rows[0]?.account_number).toBe(ACCOUNT_NO);
    expect(data.rows[0]?.id).toBe(CUSTOMER);
    expect(written).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ deny paths

describe('deny paths', () => {
  test('budget exhausted: refusal text, one deny line, no gate, mock or connector', async () => {
    const h = setup({ env: REAL, maxToolCalls: 1 });
    h.budget.consumeToolCall('sql_select', 'ssfb');
    const spies = { gate: 0, real: 0, render: 0 };
    const env = await runIoTool(sqlSpec(h, {}, spies), runCtx(h));

    expect(env.output).toMatchObject({ status: 'refused', message: 'budget exhausted, finish with what you have' });
    expectEnvelope(env);
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]).toMatchObject({ decision: 'deny', reason: 'budget: tool_calls', target: 'SSFB_HARBOR_DB_URL' });
    expect(spies).toEqual({ gate: 0, real: 0, render: 0 });
    expect(h.storeCalls).toBe(0);
    expect(h.order).toEqual(['signal', 'spy:signal', 'budget', 'spy:budget', 'audit', 'spy:audit', 'redact', 'envelope']);
    expect(escalationFor(h.runId).snapshot().budgetExhausted).toBe(true);
  });

  test('scope: an id outside the chain is refused, audited once and never reaches a connector', async () => {
    const h = setup({ env: REAL, fixtureResult: ROWS });
    const spies = { gate: 0, real: 0, render: 0 };
    const spec = sqlSpec(h, { input: { service: 'harbor', sql: 'SELECT 1 FROM t WHERE id = $1', params: [STRANGER] } }, spies);
    const env = await runIoTool(spec, runCtx(h));

    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('not in the run');
    expect(env.output.message).not.toContain(STRANGER);
    expectEnvelope(env);
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]?.decision).toBe('deny');
    expect(h.audit.lines[0]?.reason).toContain('scope');
    expect(JSON.stringify(h.audit.lines)).not.toContain(STRANGER);
    expect(spies).toEqual({ gate: 0, real: 0, render: 0 });
    expect(h.storeCalls).toBe(0);
  });

  test('scope: systemic sql without an aggregate-only select is refused', async () => {
    const h = setup({ env: REAL });
    const spies = { gate: 0, real: 0, render: 0 };
    const env = await runIoTool(sqlSpec(h, { scope: { systemic: true, sqlAggregateOnly: false } }, spies), runCtx(h));
    expect(env.output.status).toBe('refused');
    expect(h.audit.lines[0]).toMatchObject({ decision: 'deny' });
    expect(spies.real).toBe(0);
  });

  test('scope: widenIdChain lets a later call use the new id', async () => {
    const h = setup({ env: REAL });
    const spec = sqlSpec(h, { input: { service: 'harbor', sql: 'SELECT 1', params: [STRANGER] } });
    expect((await runIoTool(spec, runCtx(h))).output.status).toBe('refused');

    widenIdChain(h.deps, { ids: { customer_id: CUSTOMER, account_id: STRANGER }, hops: [], basic_state: [] });
    expect((await runIoTool(spec, runCtx(h))).output.status).toBe('ok');
    // The earlier id stays in scope even when a later chain drops it.
    widenIdChain(h.deps, { ids: { account_id: STRANGER }, hops: [], basic_state: [] });
    expect((await runIoTool(sqlSpec(h), runCtx(h))).output.status).toBe('ok');
  });

  test('gate refusal: model text returned, one deny line with the reason, no connector', async () => {
    const h = setup({ env: REAL, fixtureResult: ROWS });
    let realCalls = 0;
    const spec = sqlSpec(h, {
      gate: () => ({
        ok: false,
        message: 'Refused: only SELECT is allowed. Recommend writes under actions.ops_bank in the report.',
        reason: 'not a SELECT',
      }),
      real: async () => {
        realCalls += 1;
        return ROWS;
      },
    });
    const env = await runIoTool(spec, runCtx(h));
    expect(env.output).toMatchObject({ status: 'refused' });
    expect(env.output.message).toContain('only SELECT');
    expectEnvelope(env);
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]).toMatchObject({ decision: 'deny', reason: 'not a SELECT', exit: 'refused' });
    expect(realCalls).toBe(0);
    expect(h.storeCalls).toBe(0);
  });

  test('gate rule_index and action reach the audit line of an allowed http_call', async () => {
    const h = setup({ env: REAL });
    const spec = sqlSpec(h, { tool: 'http_call', scope: 'skip', gate: () => ({ ok: true, rule_index: 'default', action: 'allow' }) });
    await runIoTool(spec as never, runCtx(h));
    expect(h.audit.lines[0]).toMatchObject({ tool: 'http_call', rule_index: 'default', action: 'allow' });
  });

  test('blank env var: not configured for ssfb:harbor, one deny line, no connector', async () => {
    const h = setup({ env: { ...REAL, SSFB_HARBOR_DB_URL: '' } });
    const spies = { gate: 0, real: 0, render: 0 };
    const env = await runIoTool(sqlSpec(h, {}, spies), runCtx(h));
    expect(env.output).toMatchObject({ status: 'not_configured', message: 'not configured for ssfb:harbor' });
    expectEnvelope(env);
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]).toMatchObject({
      decision: 'deny',
      exit: 'not_configured',
      target: 'SSFB_HARBOR_DB_URL',
      reason: 'not configured: SSFB_HARBOR_DB_URL is blank',
    });
    expect(spies.real).toBe(0);
    expect(h.storeCalls).toBe(0);
  });

  test('blank env var in mock mode: still not configured, store not read', async () => {
    const h = setup({ env: { SSFB_HARBOR_DB_URL: '' }, fixtureResult: ROWS });
    const env = await runIoTool(sqlSpec(h), runCtx(h));
    expect(env.output.status).toBe('not_configured');
    expect(h.audit.lines[0]?.transport).toBe('mock');
    expect(h.storeCalls).toBe(0);
  });

  test('strict mock miss throws an error naming the semantic key', async () => {
    const h = setup();
    const spies = { gate: 0, real: 0, render: 0 };
    const run = runIoTool(sqlSpec(h, {}, spies), runCtx(h));
    await expect(run).rejects.toBeInstanceOf(FixtureMissError);
    await run.catch((err: FixtureMissError) => {
      expect(err.message).toContain('sql_select');
      expect(err.message).toContain('account_forms');
      expect(err.message).toContain(err.key_string);
    });
    expect(spies.real).toBe(0);
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]).toMatchObject({ transport: 'mock', exit: 'fixture_miss' });
  });

  test('non-strict mock miss returns a refused envelope', async () => {
    const h = setup({ env: { TRIAGE_MOCK_STRICT: 'false' } });
    const spies = { gate: 0, real: 0, render: 0 };
    const env = await runIoTool(sqlSpec(h, {}, spies), runCtx(h));
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('No sql_select fixture');
    expectEnvelope(env);
    expect(spies).toMatchObject({ real: 0, render: 0 });
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]).toMatchObject({ transport: 'mock', exit: 'fixture_miss' });
  });

  test('an aborted signal throws before the budget is consumed', async () => {
    const h = setup({ env: REAL });
    const controller = new AbortController();
    controller.abort();
    const spies = { gate: 0, real: 0, render: 0 };
    await expect(runIoTool(sqlSpec(h, {}, spies), runCtx(h, { signal: controller.signal }))).rejects.toThrow();
    expect(h.budget.state().calls).toBe(0);
    expect(h.order).toEqual(['signal', 'spy:signal']);
    expect(h.audit.lines).toHaveLength(0);
    expect(spies).toEqual({ gate: 0, real: 0, render: 0 });
  });

  test('an abort during the real call throws and audits the call as aborted', async () => {
    const h = setup({ env: REAL });
    const controller = new AbortController();
    const spec = sqlSpec(h, {
      real: async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    });
    await expect(runIoTool(spec, runCtx(h, { signal: controller.signal }))).rejects.toThrow();
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]?.exit).toBe('aborted');
  });
});

// ------------------------------------------------------------------ mock mode

describe('mock mode', () => {
  test('never touches the connector and audits transport mock', async () => {
    const h = setup({ fixtureResult: ROWS });
    const spies = { gate: 0, real: 0, render: 0 };
    const env = await runIoTool(sqlSpec(h, {}, spies), runCtx(h));
    expect(spies.real).toBe(0);
    expect(h.storeCalls).toBe(1);
    expect(env.output.status).toBe('ok');
    expect((env.output.data as { row_count: number }).row_count).toBe(3);
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]).toMatchObject({ decision: 'allow', transport: 'mock' });
  });
});

// ------------------------------------------------------------------ staging

describe('staging', () => {
  const cases = [
    { provider: 'virtual', profile: 'model_facing' },
    { provider: 'e2b', profile: 'persisted' },
    { provider: 'daytona', profile: 'persisted' },
  ] as const;

  for (const { provider, profile } of cases) {
    test(`${provider} stages ${profile} text at /data/<toolCallId>.json`, async () => {
      const h = setup({ env: { ...REAL, TRIAGE_SANDBOX_PROVIDER: provider } });
      const { harness, written } = fakeHarness(h);
      const env = await runIoTool(sqlSpec(h), runCtx(h, { harness }));
      expect(env.output.status).toBe('ok');
      expect(written).toHaveLength(1);
      const [file] = written;
      expect(file?.path).toBe('/data/toolu_01ABCdef.json');
      const staged = JSON.parse(file?.text ?? 'null') as Row[];
      expect(staged).toHaveLength(3);
      expect(file?.text).not.toContain('priya.sharma@');
      if (profile === 'model_facing') {
        // Search keys stay usable for joins on the local emulator.
        expect(staged[0]?.account_number).toBe(ACCOUNT_NO);
      } else {
        // Remote sandboxes get the persisted profile: 6+ digit runs masked.
        expect(file?.text).not.toContain(ACCOUNT_NO);
        expect(staged[0]?.account_number).toContain('9012');
      }
      // UUIDs pass both profiles.
      expect(staged[0]?.id).toBe(CUSTOMER);
    });
  }

  test('persisted staging masks the ingress names', async () => {
    const h = setup({ env: { TRIAGE_SANDBOX_PROVIDER: 'e2b' } });
    const { harness, written } = fakeHarness(h);
    const result = await stageRows(harness, 'toolu_x', [{ note: 'called Priya Sharma' }], h.config, { names: ['Priya Sharma'] });
    expect(result).toMatchObject({ staged: true, profile: 'persisted' });
    expect(written[0]?.text).not.toContain('Priya Sharma');
  });

  test('a staging failure is logged and does not fail the call', async () => {
    const h = setup({ env: REAL });
    const { harness } = fakeHarness(h, true);
    const env = await runIoTool(sqlSpec(h), runCtx(h, { harness }));
    expect(env.output.status).toBe('ok');
    expect((env.output.data as Record<string, unknown>).staged_file).toBeUndefined();
    expect(h.logs.some((l) => l.startsWith('warn staging /data/toolu_01ABCdef.json failed'))).toBe(true);
    // The log names the error only, never the data being staged.
    expect(h.logs.join('\n')).not.toContain(EMAIL);
  });

  test('a harness without a sandbox is a logged staging failure too', async () => {
    const h = setup({ env: REAL });
    const harness = {
      get sandbox(): never {
        throw new Error('no sandbox declared');
      },
    } as StagingHarness;
    const env = await runIoTool(sqlSpec(h), runCtx(h, { harness }));
    expect(env.output.status).toBe('ok');
    expect(h.logs.some((l) => l.includes('failed'))).toBe(true);
  });

  test('no harness: nothing staged, call still ok', async () => {
    const h = setup({ env: REAL });
    const env = await runIoTool(sqlSpec(h), runCtx(h));
    expect(env.output.status).toBe('ok');
    expect(await stageRows(undefined, 'x', [], h.config)).toEqual({ staged: false, reason: 'no harness' });
  });

  test('local is never staged into', async () => {
    const written: string[] = [];
    const harness: StagingHarness = {
      sandbox: {
        async writeFile(p: string) {
          written.push(p);
        },
      },
    };
    const result = await stageRows(harness, 'toolu_x', [1], { sandbox: { provider: 'local' } } as Config);
    expect(result.staged).toBe(false);
    expect(written).toHaveLength(0);
  });

  test('tool call ids cannot escape /data', () => {
    expect(stagePath('../../etc/passwd')).toBe('/data/______etc_passwd.json');
    expect(stagePath('a/b')).toBe('/data/a_b.json');
    expect(stagePath('../')).toBeNull();
    expect(stagePath('')).toBeNull();
  });
});

// ------------------------------------------------------------------ envelopes

describe('envelopes', () => {
  test('every path returns a JSON-serialisable envelope with taken_at', async () => {
    const envelopes: ToolEnvelope[] = [];
    const exhausted = setup({ env: REAL, maxToolCalls: 1 });
    exhausted.budget.consumeToolCall('sql_select', 'ssfb');
    envelopes.push(await runIoTool(sqlSpec(exhausted), runCtx(exhausted)));

    const h = setup({ env: REAL });
    envelopes.push(await runIoTool(sqlSpec(h), runCtx(h)));
    envelopes.push(await runIoTool(sqlSpec(h, { input: { params: [STRANGER] } }), runCtx(h)));
    envelopes.push(await runIoTool(sqlSpec(h, { gate: () => ({ ok: false, message: 'no', reason: 'no' }) }), runCtx(h)));
    envelopes.push(await runIoTool(sqlSpec(h, { backing: { envName: 'SSFB_HARBOR_DB_URL', status: 'disabled' } }), runCtx(h)));
    envelopes.push(
      await runIoTool(
        sqlSpec(h, {
          real: async () => {
            throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'unreachable' });
          },
        }),
        runCtx(h),
      ),
    );
    // A render with a Date and an undefined field still gives plain JSON.
    envelopes.push(await runIoTool(sqlSpec(h, { render: () => ({ at: new Date(0), gone: undefined }) }), runCtx(h)));

    const nonStrict = setup({ env: { TRIAGE_MOCK_STRICT: 'false' } });
    envelopes.push(await runIoTool(sqlSpec(nonStrict), runCtx(nonStrict)));

    expect(envelopes.map((e) => e.output.status)).toEqual([
      'refused',
      'ok',
      'refused',
      'refused',
      'not_configured',
      'unreachable',
      'ok',
      'refused',
    ]);
    for (const env of envelopes) {
      expectEnvelope(env);
      expect(env.output.taken_at).toBe(FIXED_NOW.toISOString());
    }
    expect(envelopes[6]?.output.data).toEqual({ at: '1970-01-01T00:00:00.000Z' });
  });

  test('connector refusal codes come back as refused, other failures as unreachable', async () => {
    const h = setup({ env: REAL });
    const fail = (code: string) =>
      sqlSpec(h, {
        real: async () => {
          throw Object.assign(new Error('boom'), { code });
        },
      });
    expect((await runIoTool(fail('readonly_role_required'), runCtx(h))).output.status).toBe('refused');
    expect((await runIoTool(fail('not_configured'), runCtx(h))).output.status).toBe('not_configured');
    expect((await runIoTool(fail('timeout'), runCtx(h))).output.status).toBe('unreachable');
    await expect(runIoTool(fail('strict_miss'), runCtx(h))).rejects.toThrow('boom');
    expect(h.audit.lines.map((l) => l.decision)).toEqual(['deny', 'deny', 'allow', 'allow']);
  });

  test('count-only tools carry the count on every line', async () => {
    const h = setup({ env: REAL });
    await runIoTool(sqlSpec(h, { tool: 'decrypt_fields', scope: 'skip', count: 2 }), runCtx(h));
    await runIoTool(
      sqlSpec(h, { tool: 'decrypt_fields', scope: 'skip', count: 2, gate: () => ({ ok: false, message: 'no', reason: 'no' }) }),
      runCtx(h),
    );
    expect(h.audit.lines.map((l) => [l.count, l.summary_redacted])).toEqual([
      [2, 'decrypt_fields: 2 value(s)'],
      [2, 'decrypt_fields: 2 value(s)'],
    ]);
  });

  test('there is no second envelope module', () => {
    const root = join(import.meta.dir, '../..');
    expect(existsSync(join(root, 'src/tools/_lib/envelope.ts'))).toBe(false);
  });
});

// ------------------------------------------------------------------ secrets

describe('secrets', () => {
  test('a seeded fake DSN never appears in an audit line, envelope or log', async () => {
    const h = setup({ env: { ...REAL, SSFB_HARBOR_DB_URL: FAKE_DSN } });
    const cap = harbor(h.ctx);
    expect(cap.status).toBe('ok');
    const envelopes: ToolEnvelope[] = [];

    // The real call can read the DSN, as a connector would, and fail with it
    // in the message.
    const leaky = sqlSpec(h, {
      real: async () => {
        const dsn = cap.status === 'ok' ? cap.value : '';
        throw Object.assign(new Error(`could not connect to ${dsn}`), { code: 'unreachable' });
      },
    });
    envelopes.push(await runIoTool(leaky, runCtx(h)));
    envelopes.push(await runIoTool(sqlSpec(h), runCtx(h)));
    envelopes.push(await runIoTool(sqlSpec(h, { input: { params: [STRANGER] } }), runCtx(h)));
    envelopes.push(await runIoTool(sqlSpec(h, { gate: () => ({ ok: false, message: 'no', reason: 'no' }) }), runCtx(h)));
    const connectFailure = sqlSpec(h, {
      real: async () => {
        throw new Error(`password authentication failed for ${FAKE_DSN}`);
      },
    });
    envelopes.push(await runIoTool(connectFailure, runCtx(h)));

    const everything = [
      ...h.audit.lines.map((l) => JSON.stringify(l)),
      ...envelopes.map((e) => JSON.stringify(e)),
      ...h.logs,
    ].join('\n');
    expect(everything).not.toContain(FAKE_DSN);
    for (const part of FAKE_DSN_PARTS) expect(everything).not.toContain(part);
    for (const line of h.audit.lines) expect(line.target).toBe('SSFB_HARBOR_DB_URL');
  });

  test('a DSN passed as the target is refused before anything is written', async () => {
    const h = setup({ env: REAL });
    const spec = sqlSpec(h, { backing: { envName: FAKE_DSN, status: 'disabled' } });
    await expect(runIoTool(spec, runCtx(h))).rejects.toThrow();
    expect(h.audit.lines).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ deps

describe('createToolDeps', () => {
  test('builds the budget from config, shares an existing one and validates the chain', () => {
    const runId = nextRunId();
    const config = makeTestConfig({});
    cleanups.push(() => {
      releaseRunBudget(runId);
      releaseEscalation(runId);
    });
    const base = {
      runId,
      config,
      interface: 'cli' as const,
      idChain: CHAIN,
      connectors: {},
      runStore: {} as RunStore,
      audit: createMemoryAuditSink(),
      fixtures: createMockLayer(config, { store: { fixturesDir: '/x', get: async () => null, list: async () => [] } }),
    };
    const deps = createToolDeps(base);
    expect(deps.budget.runId).toBe(runId);
    expect(deps.run).toEqual({ interface: 'cli', redactionNames: [] });
    expect(deps.idChain()).toEqual(CHAIN);
    expect(Object.isFrozen(deps)).toBe(true);
    // A second call for the same run shares the registered budget.
    expect(createToolDeps(base).budget).toBe(deps.budget);
    expect(() => createToolDeps({ ...base, idChain: { ids: {}, hops: 'x' } as never })).toThrow('invalid IdChain');
  });

  test('widenIdChain refuses deps it did not build', () => {
    const fake = { idChain: () => CHAIN } as unknown as ToolDeps;
    expect(() => widenIdChain(fake, CHAIN)).toThrow('createToolDeps');
  });
});

// ------------------------------------------------------------------ connector failures (D55)

describe('connector failures', () => {
  const coded = (code: string): Error => Object.assign(new Error('boom'), { code });
  const failing = (h: Harness, err: unknown, extra: Partial<IoToolSpec<'sql_select', Row[]>> = {}) =>
    sqlSpec(h, {
      real: async () => {
        throw err;
      },
      ...extra,
    });

  test('a "did not answer" outcome is recorded with the system, the tool, the code and the time', async () => {
    const h = setup({ env: REAL });
    expect((await runIoTool(failing(h, coded('unreachable')), runCtx(h))).output.status).toBe('unreachable');
    expect((await runIoTool(failing(h, coded('timeout')), runCtx(h))).output.status).toBe('unreachable');
    expect(connectorFailuresFor(h.runId)).toEqual([
      { system: 'ssfb:harbor', tool: 'sql_select', code: 'unreachable', at: FIXED_NOW.toISOString() },
      { system: 'ssfb:harbor', tool: 'sql_select', code: 'timeout', at: FIXED_NOW.toISOString() },
    ]);
  });

  test('any other connector error is recorded as error, and a tool without an entity names global', async () => {
    const h = setup({ env: REAL });
    await runIoTool(failing(h, new Error('socket hang up')), runCtx(h));
    await runIoTool(failing(h, coded('econnreset')), runCtx(h));
    await runIoTool(failing(h, coded('unreachable'), { entity: null }), runCtx(h));
    expect(connectorFailuresFor(h.runId).map((f) => [f.system, f.tool, f.code])).toEqual([
      ['ssfb:harbor', 'sql_select', 'error'],
      ['ssfb:harbor', 'sql_select', 'error'],
      ['global:harbor', 'sql_select', 'unreachable'],
    ]);
  });

  test('nothing is recorded for a refusal, blank config, a gate or scope refusal, an exhausted budget, a fixture miss or an abort', async () => {
    const h = setup({ env: REAL, maxToolCalls: 20 });
    for (const code of ['readonly_role_required', 'refused', 'cap_exceeded', 'not_configured']) {
      await runIoTool(failing(h, coded(code)), runCtx(h));
    }
    await runIoTool(sqlSpec(h, { backing: { envName: 'SSFB_HARBOR_DB_URL', status: 'disabled' } }), runCtx(h));
    await runIoTool(sqlSpec(h, { gate: () => ({ ok: false, message: 'no', reason: 'no' }) }), runCtx(h));
    await runIoTool(sqlSpec(h, { input: { params: [STRANGER] } }), runCtx(h));
    const controller = new AbortController();
    const aborting = sqlSpec(h, {
      real: async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    });
    await expect(runIoTool(aborting, runCtx(h, { signal: controller.signal }))).rejects.toThrow();
    expect(h.audit.lines).toHaveLength(8);
    expect(connectorFailuresFor(h.runId)).toEqual([]);

    const exhausted = setup({ env: REAL, maxToolCalls: 1 });
    exhausted.budget.consumeToolCall('sql_select', 'ssfb');
    expect((await runIoTool(failing(exhausted, coded('unreachable')), runCtx(exhausted))).output.status).toBe('refused');
    expect(connectorFailuresFor(exhausted.runId)).toEqual([]);

    const strict = setup({});
    await expect(runIoTool(sqlSpec(strict), runCtx(strict))).rejects.toThrow();
    expect(connectorFailuresFor(strict.runId)).toEqual([]);
    const lenient = setup({ env: { TRIAGE_MOCK_STRICT: 'false' } });
    expect((await runIoTool(sqlSpec(lenient), runCtx(lenient))).output.status).toBe('refused');
    expect(connectorFailuresFor(lenient.runId)).toEqual([]);
  });

  test('the record never carries the connector message', async () => {
    const h = setup({ env: { ...REAL, SSFB_HARBOR_DB_URL: FAKE_DSN } });
    const leaky = Object.assign(new Error(`could not connect to ${FAKE_DSN}`), { code: 'unreachable' });
    await runIoTool(failing(h, leaky), runCtx(h));
    const recorded = connectorFailuresFor(h.runId);
    expect(recorded).toHaveLength(1);
    const text = JSON.stringify(recorded);
    expect(text).not.toContain(FAKE_DSN);
    for (const part of FAKE_DSN_PARTS) expect(text).not.toContain(part);
  });

  test('a retryable SQL condition (deadlock, serialization, memory) is not recorded; a real outage still is', async () => {
    const h = setup({ env: REAL, maxToolCalls: 20 });
    for (const sqlstate of ['40P01', '40001', '53200']) {
      const err = Object.assign(new Error('deadlock detected'), { code: 'unreachable', sqlstate, serverMessage: 'deadlock detected' });
      const env = await runIoTool(failing(h, err), runCtx(h));
      expect(env.output.status).toBe('unreachable');
      expect(env.output.message).toContain('Retry the same query once');
    }
    expect(connectorFailuresFor(h.runId)).toEqual([]);
    await runIoTool(failing(h, Object.assign(new Error('connection failure'), { code: 'unreachable', sqlstate: '08006' })), runCtx(h));
    await runIoTool(failing(h, coded('timeout')), runCtx(h));
    expect(connectorFailuresFor(h.runId).map((f) => f.code)).toEqual(['unreachable', 'timeout']);
  });

  test('the record is released with the run', async () => {
    const h = setup({ env: REAL });
    await runIoTool(failing(h, coded('unreachable')), runCtx(h));
    expect(releaseConnectorFailures(h.runId)).toBe(true);
    expect(connectorFailuresFor(h.runId)).toEqual([]);
  });
});

// ------------------------------------------------------------------ SQL errors

describe('SQL errors', () => {
  const sqlError = (code: string, sqlstate: unknown, message = 'boom', serverMessage?: string): Error =>
    Object.assign(new Error(message), { code, sqlstate, ...(serverMessage !== undefined ? { serverMessage } : {}) });
  const failing = (h: Harness, err: unknown) =>
    sqlSpec(h, {
      real: async () => {
        throw err;
      },
    });

  test('a query error gives the model the Postgres text, the SQLSTATE and its description; the DSN never shows', async () => {
    const h = setup({ env: { ...REAL, SSFB_HARBOR_DB_URL: FAKE_DSN } });
    // The quoted value may be a stored row value, not the model's input, so
    // it is masked (pg-client masks at the source; this is the second pass).
    const server = `invalid input syntax for type uuid: "${ACCOUNT_NO}" at ${FAKE_DSN}`;
    const leaky = sqlError('refused', '22P02', `ssfb:harbor: query failed (SQLSTATE 22P02): ${server}`, server);
    const env = await runIoTool(failing(h, leaky), runCtx(h));
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toStartWith(
      'Query failed on ssfb:harbor: invalid input syntax for type uuid: "<value>" at <url> (SQLSTATE 22P02, invalid text representation).',
    );
    expect(JSON.stringify(env)).not.toContain(ACCOUNT_NO);
    const text = JSON.stringify(env) + JSON.stringify(h.audit.lines) + h.logs.join('\n');
    for (const part of FAKE_DSN_PARTS) expect(text).not.toContain(part);
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'allow', exit: 'query_error', sqlstate: '22P02' });
    // The audit reason passes the persisted profile, which masks the digits.
    expect(h.audit.lines.at(-1)!.reason).toStartWith('sqlstate 22P02: invalid text representation: invalid input syntax');
    expect(h.audit.lines.at(-1)!.reason).not.toContain(ACCOUNT_NO);
    // The log line keeps codes only.
    expect(h.logs.some((l) => l.startsWith('warn') && l.includes('22P02'))).toBe(true);
    expect(h.logs.join('\n')).not.toContain('invalid input syntax');
    // A query the model can fix is not a system failure stop_blocked may cite.
    expect(connectorFailuresFor(h.runId)).toEqual([]);
  });

  test('without the Postgres text, the description stands in for it', async () => {
    const h = setup({ env: REAL, maxToolCalls: 20 });
    const want: [string, string][] = [
      ['42703', 'undefined column (SQLSTATE 42703, undefined column)'],
      ['42P01', 'undefined table (SQLSTATE 42P01, undefined table)'],
      ['42883', 'undefined function (SQLSTATE 42883, undefined function)'],
      ['42601', 'syntax error (SQLSTATE 42601, syntax error)'],
      ['22003', 'numeric value out of range (SQLSTATE 22003, numeric value out of range)'],
      ['54000', 'program limit exceeded (SQLSTATE 54000, program limit exceeded)'],
    ];
    for (const [sqlstate, description] of want) {
      const env = await runIoTool(failing(h, sqlError('refused', sqlstate)), runCtx(h));
      expect(env.output.message).toContain(description);
      expect(env.output.message).toContain('retry');
    }
  });

  test('an access error keeps its reason and points at another source first', async () => {
    const h = setup({ env: REAL });
    const env = await runIoTool(
      failing(h, sqlError('refused', '28P01', 'x', 'password authentication failed for user "<redacted>"')),
      runCtx(h),
    );
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('password authentication failed for user "<redacted>" (SQLSTATE 28P01, invalid authorization).');
    expect(env.output.message).toContain('Try another source for the same facts; record the gap if none has them.');
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', exit: 'refused', sqlstate: '28P01' });
  });

  test('serialization, deadlock, disk and memory errors are retryable, not access problems', async () => {
    const h = setup({ env: REAL, maxToolCalls: 20 });
    for (const sqlstate of ['40001', '40P01', '53100', '53200']) {
      const env = await runIoTool(failing(h, sqlError('unreachable', sqlstate, 'x', 'canceling statement due to conflict with recovery')), runCtx(h));
      expect(env.output.status).toBe('unreachable');
      expect(env.output.message).toContain('canceling statement due to conflict with recovery');
      expect(env.output.message).toContain('Retry the same query once');
      expect(env.output.message).not.toContain('access or configuration');
    }
  });

  test('a malformed sqlstate is ignored and the connector message is used', async () => {
    const h = setup({ env: REAL });
    const env = await runIoTool(failing(h, sqlError('refused', 'not a code')), runCtx(h));
    expect(env.output.message).toStartWith('sql_select on ssfb:harbor was refused (refused): boom.');
    expect(h.audit.lines.at(-1)!.sqlstate).toBeUndefined();
  });
});

// ------------------------------------------------------------------ tool errors reach the model

describe('tool errors reach the model', () => {
  const failing = (h: Harness, err: unknown) =>
    sqlSpec(h, {
      real: async () => {
        throw err;
      },
    });
  const coded = (code: string, message: string, cause?: unknown): Error =>
    Object.assign(new Error(message, cause !== undefined ? { cause } : undefined), { code });

  test('each connector code carries the real message and a hint that is not only "record the gap"', async () => {
    const h = setup({ env: REAL, maxToolCalls: 20 });
    const cases: [Error, string, string, string][] = [
      [coded('refused', 'ssfb:harbor: Quickwit rejected the query (HTTP 400): failed to parse query: unknown field "lvl"'), 'refused',
        'sql_select on ssfb:harbor was refused (refused): Quickwit rejected the query (HTTP 400): failed to parse query: unknown field "lvl".', 'retry'],
      [coded('cap_exceeded', 'the response passed the 4194304 byte cap'), 'refused',
        'sql_select on ssfb:harbor was refused (cap_exceeded): the response passed the 4194304 byte cap.', 'Narrow the call'],
      [coded('readonly_role_required', 'the role behind SSFB_HARBOR_DB_URL can write'), 'refused',
        'sql_select on ssfb:harbor was refused (readonly_role_required): the role behind SSFB_HARBOR_DB_URL can write.', 'Try another source'],
      [coded('timeout', 'ssfb:harbor: no answer within 10000 ms'), 'unreachable',
        'ssfb:harbor did not answer (timeout): no answer within 10000 ms.', 'Retry once, or narrow the call'],
      [coded('unreachable', 'qw search failed with exit code 2: error: index "logs-v9" not found'), 'unreachable',
        'ssfb:harbor did not answer (unreachable): qw search failed with exit code 2: error: index "logs-v9" not found.', 'Retry once later or try another source'],
      [new Error('socket hang up', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }), 'unreachable',
        'ssfb:harbor did not answer (error): socket hang up: read ECONNRESET.', 'try another source'],
    ];
    for (const [err, status, start, hint] of cases) {
      const env = await runIoTool(failing(h, err), runCtx(h));
      expect(env.output.status).toBe(status as 'refused');
      expect(env.output.message).toStartWith(start);
      expect(env.output.message).toContain(hint);
      expect(String(env.output.message).toLowerCase()).not.toMatch(/^[^.]*\. record the gap\.?$/);
    }
  });

  test('secrets and other records are scrubbed or redacted from the text, the audit line and the log', async () => {
    const h = setup({ env: REAL });
    const other = 'meera.iyer@example.com';
    const pan = '5500005555555559';
    const message = [
      `could not connect to ${FAKE_DSN}`,
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXRva2Vu.sig-SEEDED',
      'Cookie: session=cookie-SEEDED-77; theme=dark',
      'x-api-key=apikey-SEEDED-99',
      `row for ${other} with card ${pan} and card 4111 1111 1111 1111`,
    ].join('\n');
    const env = await runIoTool(failing(h, coded('unreachable', message)), runCtx(h));
    const text = JSON.stringify(env);
    const everything = text + JSON.stringify(h.audit.lines) + h.logs.join('\n');
    for (const part of FAKE_DSN_PARTS) expect(everything).not.toContain(part);
    for (const seed of ['eyJhbGciOiJIUzI1NiJ9', 'cookie-SEEDED-77', 'apikey-SEEDED-99', 'meera.iyer', pan, '4111 1111 1111 1111']) {
      expect(everything).not.toContain(seed);
    }
    expect(env.output.message).toContain('could not connect to <url>');
    expect(env.output.message).toContain('Authorization: <redacted>');
    expect(env.output.message).toContain('@example.com');
  });

  test('a ConnectorError reaches the model with its own message, not the raw cause it attached', async () => {
    const h = setup({ env: REAL });
    const raw = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND qw-raw-host'), { code: 'ENOTFOUND' }) });
    const err = new ConnectorError('unreachable', 'Quickwit at SSFB_QW_URL could not be reached: fetch failed', { cause: raw });
    const env = await runIoTool(failing(h, err), runCtx(h));
    expect(env.output.message).toStartWith('ssfb:harbor did not answer (unreachable): Quickwit at SSFB_QW_URL could not be reached: fetch failed.');
    const everything = JSON.stringify(env) + JSON.stringify(h.audit.lines) + h.logs.join('\n');
    expect(everything).not.toContain('qw-raw-host');
    expect(everything).not.toContain('ENOTFOUND');
  });

  test('the causes of a plain error are scrubbed before they reach the model', async () => {
    const h = setup({ env: REAL });
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND raw-db-host.internal'), { code: 'ENOTFOUND' });
    const env = await runIoTool(failing(h, new Error('socket failed', { cause })), runCtx(h));
    expect(env.output.message).toContain('socket failed: getaddrinfo ENOTFOUND <host>');
    expect(JSON.stringify(env) + JSON.stringify(h.audit.lines)).not.toContain('raw-db-host');
  });

  test('the text is capped', async () => {
    const h = setup({ env: REAL });
    const env = await runIoTool(failing(h, coded('unreachable', `boom ${'y'.repeat(10_000)}`)), runCtx(h));
    const message = String(env.output.message ?? '');
    expect(message.length).toBeLessThan(1800);
    expect(message).toContain('...');
    expect(h.audit.lines.at(-1)!.reason!.length).toBeLessThan(400);
  });

  test('audit lines keep their shape: the same fields, with the excerpt in reason', async () => {
    const h = setup({ env: REAL, maxToolCalls: 20 });
    await runIoTool(failing(h, coded('unreachable', 'connect ECONNREFUSED')), runCtx(h));
    await runIoTool(failing(h, coded('refused', 'no')), runCtx(h));
    await runIoTool(failing(h, Object.assign(new Error('x'), { code: 'refused', sqlstate: '42703', serverMessage: 'column "a" does not exist' })), runCtx(h));
    const [unreachableLine, refusedLine, queryLine] = h.audit.lines;
    const base = ['decision', 'duration_ms', 'entity', 'exit', 'interface', 'run_id', 'service', 'summary_redacted', 'target', 'tool', 'transport', 'ts'];
    expect(Object.keys(unreachableLine!).sort()).toEqual([...base, 'reason'].sort());
    expect(unreachableLine!.reason).toBe('connector: unreachable: connect ECONNREFUSED');
    expect(Object.keys(refusedLine!).sort()).toEqual([...base, 'reason'].sort());
    expect(refusedLine!.reason).toBe('connector: refused: no');
    expect(Object.keys(queryLine!).sort()).toEqual([...base, 'reason', 'sqlstate'].sort());
    expect(queryLine!.reason).toBe('sqlstate 42703: undefined column: column "a" does not exist');
    // The failure record for stop_blocked is unchanged: codes only.
    expect(connectorFailuresFor(h.runId)).toEqual([
      { system: 'ssfb:harbor', tool: 'sql_select', code: 'unreachable', at: FIXED_NOW.toISOString() },
    ]);
  });
});
