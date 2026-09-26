// Braintrust tracing with the SDK's in-memory background logger: no request
// leaves the process (the no-io guard would throw on one). All values below
// are synthetic: example.com addresses, made-up names, phones and accounts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type FlueExecutionContext,
  type FlueExecutionOperation,
  type FlueInstrumentation,
  instrument as flueInstrument,
} from '@flue/runtime';
import * as bt from 'braintrust';
import { KEYS } from '../config/keys.ts';
import { checkEgress } from '../gate/redact.ts';
import {
  type BraintrustApi,
  type BraintrustDeps,
  braintrustStatus,
  flushBraintrust,
  installBraintrust,
  logRunFeedback,
  MASK_FAILED,
  onTraceRoot,
  type TraceRoot,
  TRACE_ROOT_CAPTURE_KEY,
  TRACE_SPAN_ID_PATTERN,
  traceModelCall,
  type TracingConfig,
  uninstallBraintrust,
} from './braintrust.ts';

const T = bt._exportsForTestingOnly;

const NAME = 'Asha Verma';
const EMAIL = 'asha.verma@example.com';
const PHONE = '+91 98765 43210';
const ACCOUNT = '918020012345';
const PII = `${NAME} (${EMAIL}, ${PHONE}) says account ${ACCOUNT} was debited twice`;
const CONTENT_MARKERS = ['Asha', 'Verma', EMAIL, '98765', ACCOUNT, 'debited'];

// Ids with 6+ digit runs, which the persisted profile would mask.
const RUN = '01M3EN7034701234ABCDEFGHJK';
const SUBMISSION = 'sub_01M3EN7034703470QRSTVWXYZ0';
const OPERATION = 'op_01M3EN7034701111';
const TURN = 'turn_01M3EN7034702222';
const TOOL_CALL = 'toolu_01234567890123';
const MODEL = 'claude-sonnet-4-5-20250929';

/** Metadata keys that hold ids kept as sent; the egress check covers the rest. */
const ID_KEYS = [
  'flue.instance_id',
  'flue.submission_id',
  'flue.session',
  'flue.operation_id',
  'flue.turn_id',
  'flue.tool_call_id',
  'flue.context_id',
  'model',
  'flue.model',
  'run_id',
];

function tracing(overrides: Partial<TracingConfig> = {}): TracingConfig {
  return { enabled: true, apiKey: 'test-braintrust-key', projectName: 'triage-app', content: 'metadata', ...overrides };
}

// ------------------------------------------------------------------ fake Flue

type FakeFlue = {
  readonly installed: FlueInstrumentation[];
  readonly instrument: (i: FlueInstrumentation) => () => Promise<void>;
  emit(event: Record<string, unknown>): void;
  run<T>(operation: FlueExecutionOperation, ctx: FlueExecutionContext, fn: () => Promise<T>): Promise<T>;
};

/** Stands in for Flue: observers get frozen events, interceptors chain in install order. */
function fakeFlue(): FakeFlue {
  const installed: FlueInstrumentation[] = [];
  let index = 0;
  return {
    installed,
    instrument: (i) => {
      installed.push(i);
      return async () => {
        installed.splice(installed.indexOf(i), 1);
      };
    },
    emit(event) {
      const frozen = Object.freeze({ v: 3, eventIndex: index++, timestamp: new Date().toISOString(), ...event });
      for (const i of installed) void i.observe(frozen as never, { id: RUN } as never);
    },
    run(operation, ctx, fn) {
      const chain = installed.reduceRight<() => Promise<any>>((next, i) => () => i.interceptor(operation, ctx, next), fn);
      return chain();
    },
  };
}

const base = { instanceId: RUN, submissionId: SUBMISSION, agentName: 'triage', session: 'main', harness: 'default' };
const usage = { input: 1200, output: 300, cacheRead: 100, cacheWrite: 0, totalTokens: 1600, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } };

/** One submission: a prompt operation with a model turn that calls one tool. */
async function runSubmission(flue: FakeFlue, submissionId = SUBMISSION): Promise<void> {
  const env = { ...base, submissionId };
  const ctx = { instanceId: RUN, submissionId };
  flue.emit({ ...env, type: 'operation_start', operationId: OPERATION, operationKind: 'prompt' });
  await flue.run({ type: 'agent', operationId: OPERATION, operationKind: 'prompt' }, ctx, async () => {
    flue.emit({
      ...env,
      type: 'turn_request',
      operationId: OPERATION,
      turnId: TURN,
      purpose: 'agent',
      request: {
        providerId: 'anthropic',
        providerName: 'anthropic',
        requestedModel: MODEL,
        api: 'anthropic-messages',
        input: { systemPrompt: `You help ${NAME}`, messages: [{ role: 'user', content: PII }], tools: [{ name: 'sql_select', description: 'd', parameters: {} }] },
      },
    });
    await flue.run({ type: 'model', turnId: TURN }, { ...ctx, operationId: OPERATION, turnId: TURN }, async () => undefined);
    flue.emit({
      ...env,
      type: 'turn',
      operationId: OPERATION,
      turnId: TURN,
      purpose: 'agent',
      durationMs: 40,
      isError: false,
      request: { providerId: 'anthropic', providerName: 'anthropic', requestedModel: MODEL, api: 'anthropic-messages' },
      response: { responseModel: MODEL, finishReason: 'toolUse', usage, output: { role: 'assistant', content: [{ type: 'text', text: PII }] } },
    });
    flue.emit({ ...env, type: 'tool_start', operationId: OPERATION, turnId: TURN, toolName: 'sql_select', toolCallId: TOOL_CALL, args: { sql: `where email = '${EMAIL}'` } });
    await flue.run({ type: 'tool', toolCallId: TOOL_CALL, toolName: 'sql_select' }, { ...ctx, operationId: OPERATION, turnId: TURN }, async () => undefined);
    flue.emit({
      ...env,
      type: 'tool',
      operationId: OPERATION,
      turnId: TURN,
      toolName: 'sql_select',
      toolCallId: TOOL_CALL,
      isError: true,
      durationMs: 5,
      result: { rows: [{ name: NAME, account: ACCOUNT }] },
      errorInfo: { type: 'tool_error', name: 'SqlGateError', message: `refused for ${EMAIL}`, stack: 'at /Users/someone/x.ts:1' },
    });
  });
  flue.emit({ ...env, type: 'operation', operationId: OPERATION, operationKind: 'prompt', durationMs: 90, isError: false, agentInput: { text: PII }, agentOutput: { type: 'text', text: PII, finishReason: 'stop' } });
}

type Row = Record<string, any>;
const byName = (rows: Row[], name: string): Row => {
  const row = rows.find((r) => r.span_attributes?.name === name);
  if (row === undefined) throw new Error(`no ${name} row in ${rows.map((r) => r.span_attributes?.name).join(', ')}`);
  return row;
};
const withoutIds = (metadata: Record<string, unknown> | undefined): Record<string, unknown> => {
  const out = { ...metadata };
  for (const key of ID_KEYS) delete out[key];
  return out;
};

// ------------------------------------------------------------------ setup

let memory: ReturnType<typeof T.useTestBackgroundLogger>;
let loads = 0;
let inits = 0;

/** The real SDK with counting wrappers, so tests see how often it is started. */
function deps(flue: FakeFlue, overrides: Partial<BraintrustApi> = {}, extra: Partial<BraintrustDeps> = {}): BraintrustDeps {
  return {
    load: async () => {
      loads++;
      return {
        ...bt,
        initLogger: ((options: Parameters<typeof bt.initLogger>[0]) => {
          inits++;
          return bt.initLogger(options);
        }) as typeof bt.initLogger,
        ...overrides,
      };
    },
    instrument: flue.instrument,
    names: () => [NAME],
    projectId: 'test-project-id',
    ...extra,
  };
}

/**
 * A background logger whose every flush reports a send error through
 * onFlushError, the way the SDK's HTTP logger reports a failed login or
 * log request. The rest of the SDK is the real one.
 */
function failingSends(): { readonly api: Partial<BraintrustApi>; readonly flushes: () => number } {
  const bg: { onFlushError?: (err: unknown) => void } = {};
  let flushes = 0;
  return {
    api: {
      _internalGetGlobalState: (() => ({ bgLogger: () => bg })) as unknown as typeof bt._internalGetGlobalState,
      flush: (async () => {
        flushes++;
        bg.onFlushError?.(new Error('401 unauthorized'));
      }) as typeof bt.flush,
    },
    flushes: () => flushes,
  };
}

beforeAll(async () => {
  await T.simulateLoginForTests();
});

beforeEach(() => {
  // Before install: the masking function binds to the background logger active when it is set.
  memory = T.useTestBackgroundLogger();
  loads = 0;
  inits = 0;
});

afterEach(async () => {
  await uninstallBraintrust();
  T.clearTestBackgroundLogger();
});

afterAll(() => {
  T.simulateLogoutForTests();
});

// ------------------------------------------------------------------ tests

describe('off', () => {
  test('tracing is off by default', () => {
    expect(KEYS.find((k) => k.name === 'TRIAGE_BRAINTRUST_ENABLED')?.default).toBe('false');
    expect(KEYS.find((k) => k.name === 'TRIAGE_BRAINTRUST_CONTENT')?.default).toBe('metadata');
  });

  test('with tracing off nothing loads, nothing is instrumented and every helper is a pass-through', async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing({ enabled: false }) }, deps(flue));
    expect(loads).toBe(0);
    expect(flue.installed).toHaveLength(0);
    expect(braintrustStatus().on).toBe(false);
    let calls = 0;
    expect(await traceModelCall('decision', { model: 'typesafe/x' }, async () => ++calls)).toBe(1);
    const roots: TraceRoot[] = [];
    onTraceRoot(SUBMISSION, (r) => roots.push(r));
    await flushBraintrust(10);
    expect(await logRunFeedback(tracing({ enabled: false }), { runId: RUN, spanId: 'aaaaaaaaaaaaaaaa', verdict: 'correct' }, deps(flue))).toEqual({ sent: false, reason: 'off' });
    expect(roots).toEqual([]);
    expect(loads).toBe(0);
    expect(await memory.drain()).toEqual([]);
  });

  test('a load that fails leaves tracing off and is counted, never thrown', async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing() }, { ...deps(flue), load: async () => { throw new Error('no module'); } });
    expect(braintrustStatus()).toMatchObject({ on: false, errors: 1 });
    expect(flue.installed).toHaveLength(0);
  });
});

describe('install', () => {
  test('is idempotent: one load, one logger, two instrumentations, the capture last', async () => {
    const flue = fakeFlue();
    const d = deps(flue);
    await Promise.all([installBraintrust({ tracing: tracing() }, d), installBraintrust({ tracing: tracing() }, d)]);
    await installBraintrust({ tracing: tracing() }, d);
    expect(loads).toBe(1);
    expect(inits).toBe(1);
    expect(flue.installed.map((i) => i.key)).toEqual([Symbol.for('braintrust.flue.instrumentation'), TRACE_ROOT_CAPTURE_KEY]);
    expect(braintrustStatus()).toMatchObject({ on: true, instrumented: true });
  });

  test("works with Flue's own instrument(), and can be installed again after uninstall", async () => {
    const { instrument: _fake, ...rest } = deps(fakeFlue());
    await installBraintrust({ tracing: tracing() }, rest);
    await installBraintrust({ tracing: tracing() }, rest);
    expect(braintrustStatus()).toMatchObject({ on: true, instrumented: true, errors: 0 });
    await uninstallBraintrust();
    await installBraintrust({ tracing: tracing() }, rest);
    expect(braintrustStatus()).toMatchObject({ on: true, instrumented: true, errors: 0 });
    // The keys are free again once disposed.
    await uninstallBraintrust();
    const dispose = flueInstrument({ key: TRACE_ROOT_CAPTURE_KEY, observe: () => undefined, interceptor: (_o, _c, next) => next(), dispose: () => undefined });
    await dispose();
  });
});

describe("a submission's trace", () => {
  test("'metadata' mode: nested spans with ids, model and usage, and no content", async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing() }, deps(flue));
    await runSubmission(flue);
    const rows = (await memory.drain()) as Row[];
    const op = byName(rows, 'flue.prompt');
    const turn = byName(rows, 'flue.turn');
    const tool = byName(rows, 'tool:sql_select');
    expect(op.span_parents ?? []).toEqual([]);
    expect(turn.span_parents).toEqual([op.span_id]);
    expect(tool.span_parents).toEqual([op.span_id]);
    expect(turn.span_attributes.type).toBe('llm');
    expect(turn.metrics).toMatchObject({ prompt_tokens: 1200, completion_tokens: 300, prompt_cached_tokens: 100, tokens: 1600, estimated_cost: 0.25 });
    expect(turn.metadata).toMatchObject({ model: MODEL, provider: 'anthropic', 'flue.submission_id': SUBMISSION, 'flue.instance_id': RUN, 'flue.turn_id': TURN, 'flue.stop_reason': 'toolUse' });
    expect(tool.metadata).toMatchObject({ 'flue.tool_call_id': TOOL_CALL, 'flue.tool_name': 'sql_select', 'flue.is_error': true });
    expect(tool.metrics.end).toBeDefined();
    const json = JSON.stringify(rows);
    for (const marker of CONTENT_MARKERS) expect(json).not.toContain(marker);
    expect(json).not.toContain('/Users/someone');
  });

  test("'redacted' mode: checkEgress is ok on every span's input, output and metadata, and the ids are unchanged", async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing({ content: 'redacted' }) }, deps(flue));
    await runSubmission(flue);
    const rows = (await memory.drain()) as Row[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const name = row.span_attributes?.name;
      expect({ name, egress: checkEgress({ input: row.input, output: row.output, metadata: withoutIds(row.metadata), error: row.error }, { names: [NAME] }) }).toEqual({ name, egress: { ok: true } });
    }
    const turn = byName(rows, 'flue.turn');
    expect(turn.metadata).toMatchObject({ model: MODEL, 'flue.submission_id': SUBMISSION, 'flue.instance_id': RUN, 'flue.turn_id': TURN, 'flue.operation_id': OPERATION });
    expect(JSON.stringify(turn.input)).toContain('was debited twice');
    expect(byName(rows, 'tool:sql_select').metadata['flue.tool_call_id']).toBe(TOOL_CALL);
    expect(JSON.stringify(rows)).not.toContain('/Users/someone');
  });

  test('the second layer masks what Braintrust is handed directly, and keeps the ids in metadata', async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing() }, deps(flue));
    const span = bt.startSpan({ name: 'direct', event: { input: `mail ${EMAIL}`, metadata: { 'flue.submission_id': SUBMISSION, model: MODEL, note: `call ${PHONE}`, 'flue.session': `x ${EMAIL}` } } });
    span.end();
    const row = byName((await memory.drain()) as Row[], 'direct');
    expect(row.input).not.toContain(EMAIL);
    expect(row.metadata['flue.submission_id']).toBe(SUBMISSION);
    expect(row.metadata.model).toBe(MODEL);
    expect(row.metadata.note).not.toContain('98765');
    // A restored key whose value is not id-shaped stays masked.
    expect(row.metadata['flue.session']).not.toContain(EMAIL);
    expect(MASK_FAILED).toBe('[redaction failed]');
  });

  test("an OpenAI Responses tool call id ('<call_id>|<item_id>') with a 6+ digit run is kept as sent", async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing({ content: 'redacted' }) }, deps(flue));
    const id = 'call_Ab3kLm9QrStUvWxYz012345|fc_68d2a1b0c3e4f5061728394a';
    const env = { ...base, operationId: OPERATION, turnId: TURN };
    flue.emit({ ...env, type: 'operation_start', operationKind: 'prompt' });
    await flue.run({ type: 'agent', operationId: OPERATION, operationKind: 'prompt' }, { instanceId: RUN, submissionId: SUBMISSION }, async () => {
      flue.emit({ ...env, type: 'tool_start', toolName: 'sql_select', toolCallId: id, args: {} });
      await flue.run({ type: 'tool', toolCallId: id, toolName: 'sql_select' }, { instanceId: RUN, operationId: OPERATION }, async () => undefined);
      flue.emit({ ...env, type: 'tool', toolName: 'sql_select', toolCallId: id, isError: false, durationMs: 1, result: {} });
    });
    flue.emit({ ...env, type: 'operation', operationKind: 'prompt', durationMs: 2, isError: false });
    expect(byName((await memory.drain()) as Row[], 'tool:sql_select').metadata['flue.tool_call_id']).toBe(id);
  });

  test('the second layer drops image data handed to Braintrust directly', async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing({ content: 'redacted' }) }, deps(flue));
    const data = Buffer.from(new Uint8Array(2000).map((_, i) => (i * 131 + 7) % 256)).toString('base64');
    const span = bt.startSpan({ name: 'image', event: { input: [{ type: 'image', data, mimeType: 'image/jpeg' }] } });
    span.end();
    const row = byName((await memory.drain()) as Row[], 'image');
    expect(row.input).toEqual([{ type: 'image', mimeType: 'image/jpeg', omitted: 'image', length: data.length }]);
  });
});

describe('root span capture', () => {
  test('each submission root is reported once, to waiting callbacks, later callbacks and the install listener', async () => {
    const flue = fakeFlue();
    const heard: TraceRoot[] = [];
    await installBraintrust({ tracing: tracing() }, { ...deps(flue), onRootSpan: (r) => heard.push(r) });
    const early: TraceRoot[] = [];
    onTraceRoot(SUBMISSION, (r) => early.push(r));
    await runSubmission(flue);
    // A nested prompt in the same submission (the synthesis) and a prompt inside a task are not roots.
    flue.emit({ ...base, type: 'operation_start', operationId: 'op_nested', operationKind: 'prompt' });
    await flue.run({ type: 'agent', operationId: 'op_nested', operationKind: 'prompt' }, { instanceId: RUN, submissionId: SUBMISSION }, async () => undefined);
    await flue.run({ type: 'agent', operationId: 'op_task', operationKind: 'prompt' }, { instanceId: RUN, submissionId: 'sub_other', taskId: 't1' }, async () => undefined);
    const late: TraceRoot[] = [];
    onTraceRoot(SUBMISSION, (r) => late.push(r));
    expect(heard).toHaveLength(1);
    expect(early).toEqual(heard);
    expect(late).toEqual(heard);
    const root = heard[0]!;
    expect(root).toMatchObject({ runId: RUN, flueSubmissionId: SUBMISSION });
    expect(root.spanId).toMatch(TRACE_SPAN_ID_PATTERN);
    const op = byName((await memory.drain()) as Row[], 'flue.prompt');
    expect(root.spanId).toBe(op.id);
    expect(root.rootSpanId).toBe(op.root_span_id);
  });

  test("Flue 2.0.8's shape: the submission id comes from the prompt's operation_start, not its context", async () => {
    const flue = fakeFlue();
    const heard: TraceRoot[] = [];
    await installBraintrust({ tracing: tracing() }, { ...deps(flue), onRootSpan: (r) => heard.push(r) });
    const env = { ...base, submissionId: SUBMISSION };
    // The outer submission operation carries the id but has no span; the prompt inside it has a span and no id.
    await flue.run({ type: 'agent', operationId: SUBMISSION, operationKind: 'prompt' }, { instanceId: RUN, submissionId: SUBMISSION }, async () => {
      flue.emit({ ...env, type: 'operation_start', operationId: OPERATION, operationKind: 'prompt' });
      await flue.run({ type: 'agent', operationId: OPERATION, operationKind: 'prompt' }, { instanceId: RUN, operationId: OPERATION }, async () => undefined);
      flue.emit({ ...env, type: 'operation', operationId: OPERATION, operationKind: 'prompt', durationMs: 5, isError: false });
    });
    expect(heard).toHaveLength(1);
    const op = byName((await memory.drain()) as Row[], 'flue.prompt');
    expect(heard[0]).toEqual({ runId: RUN, flueSubmissionId: SUBMISSION, spanId: op.id, rootSpanId: op.root_span_id });
  });

  test('a second attempt of the same submission (submission_running again) is captured as its new root', async () => {
    const flue = fakeFlue();
    const heard: TraceRoot[] = [];
    await installBraintrust({ tracing: tracing() }, { ...deps(flue), onRootSpan: (r) => heard.push(r) });
    const env = { ...base, submissionId: SUBMISSION };
    const attempt = async (operationId: string, attemptCount: number): Promise<void> => {
      flue.emit({ ...env, type: 'submission_running', kind: 'dispatch', attemptCount, maxAttempts: 2 });
      flue.emit({ ...env, type: 'operation_start', operationId, operationKind: 'prompt' });
      await flue.run({ type: 'agent', operationId, operationKind: 'prompt' }, { instanceId: RUN, operationId }, async () => {
        // The synthesis inside the attempt is still not a root.
        flue.emit({ ...env, type: 'operation_start', operationId: `${operationId}_nested`, operationKind: 'prompt' });
        await flue.run({ type: 'agent', operationId: `${operationId}_nested`, operationKind: 'prompt' }, { instanceId: RUN, submissionId: SUBMISSION }, async () => undefined);
      });
      flue.emit({ ...env, type: 'operation', operationId, operationKind: 'prompt', durationMs: 5, isError: false });
    };
    await attempt('op_attempt_1', 1);
    await attempt('op_attempt_2', 2);
    expect(heard).toHaveLength(2);
    expect(heard[0]?.spanId).not.toBe(heard[1]?.spanId);
    const late: TraceRoot[] = [];
    onTraceRoot(SUBMISSION, (r) => late.push(r));
    expect(late).toEqual([heard[1]!]);
  });

  test('a callback that throws is counted and does not stop the run', async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing() }, deps(flue));
    onTraceRoot(SUBMISSION, () => {
      throw new Error('store down');
    });
    await runSubmission(flue);
    expect(braintrustStatus().errors).toBe(1);
  });
});

describe('flushBraintrust', () => {
  test('returns within the timeout when the flush hangs', async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing() }, deps(flue, { flush: () => new Promise<void>(() => undefined) }));
    const started = Date.now();
    await flushBraintrust(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(braintrustStatus().flushTimeouts).toBe(1);
  });

  test('never throws when the flush rejects or throws', async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing() }, deps(flue, { flush: async () => { throw new Error('network'); } }));
    await flushBraintrust(1000);
    expect(braintrustStatus().errors).toBe(1);
    await uninstallBraintrust();
    await installBraintrust({ tracing: tracing() }, deps(flue, { flush: (() => { throw new Error('sync'); }) as typeof bt.flush }));
    await flushBraintrust(1000);
    expect(braintrustStatus().errors).toBe(1);
  });

  test('flushes the in-memory logger when it works', async () => {
    const flue = fakeFlue();
    expect(await flushBraintrust()).toBe('off');
    await installBraintrust({ tracing: tracing() }, deps(flue));
    expect(await flushBraintrust()).toBe('done');
    expect(braintrustStatus()).toMatchObject({ errors: 0, flushTimeouts: 0, flushErrors: 0 });
  });

  test("says how it ended: 'timeout', or 'failed' when the SDK reports a send error", async () => {
    const flue = fakeFlue();
    const failing = failingSends();
    await installBraintrust({ tracing: tracing() }, deps(flue, failing.api));
    expect(await flushBraintrust(1000)).toBe('failed');
    expect(braintrustStatus()).toMatchObject({ errors: 1, flushErrors: 1 });
    await uninstallBraintrust();
    await installBraintrust({ tracing: tracing() }, deps(flue, { flush: () => new Promise<void>(() => undefined) }));
    expect(await flushBraintrust(20)).toBe('timeout');
  });
});

describe('traceModelCall', () => {
  let now = 1_790_000_000_000;
  const clock = () => (now += 250);

  test("records an llm span with run id, usage and cost; 'metadata' mode sends no content", async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing() }, deps(flue, {}, { now: clock }));
    const result = await traceModelCall(
      'decision',
      { runId: RUN, model: 'typesafe/decide-1', input: { text: PII }, metadata: { purpose: 'classify', bad: `x ${EMAIL}` } },
      async () => ({ answer: PII, usage: { inputTokens: 90, outputTokens: 10, costUsd: 0.002 } }),
      (r) => ({ output: r.answer, usage: { input: r.usage.inputTokens, output: r.usage.outputTokens }, costUsd: r.usage.costUsd, responseModel: 'decide-1-20250929' }),
    );
    expect(result.answer).toBe(PII);
    const row = byName((await memory.drain()) as Row[], 'decision:typesafe/decide-1');
    expect(row.span_attributes.type).toBe('llm');
    expect(row.metadata).toMatchObject({ run_id: RUN, model: 'typesafe/decide-1', kind: 'decision', purpose: 'classify', response_model: 'decide-1-20250929' });
    expect(row.metadata.bad).toBeUndefined();
    expect(row.metrics).toMatchObject({ prompt_tokens: 90, completion_tokens: 10, tokens: 100, estimated_cost: 0.002 });
    expect(row.metrics.end - row.metrics.start).toBeCloseTo(0.25, 5);
    const json = JSON.stringify(row);
    for (const marker of CONTENT_MARKERS) expect(json).not.toContain(marker);
  });

  test("'redacted' mode sends the input and output redacted with the run names", async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing({ content: 'redacted' }) }, deps(flue));
    await traceModelCall('embed', { runId: RUN, model: 'openai/text-embedding-3-small', input: [PII] }, async () => [[0.1, 0.2]], (v) => ({ output: { vectors: v.length }, usage: { input: 12 }, costUsd: null }));
    const row = byName((await memory.drain()) as Row[], 'embed:openai/text-embedding-3-small');
    expect(JSON.stringify(row.input)).toContain('was debited twice');
    expect(checkEgress({ input: row.input, output: row.output, metadata: withoutIds(row.metadata) }, { names: [NAME] })).toEqual({ ok: true });
    expect(row.output).toEqual({ vectors: 1 });
    expect(row.metrics.estimated_cost).toBeUndefined();
    expect(row.metrics.tokens).toBe(12);
  });

  test('a failed call is rethrown as it was, and the span holds only a redacted error', async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing() }, deps(flue));
    const boom = new TypeError(`bad answer for ${EMAIL}`);
    await expect(traceModelCall('decision', { runId: RUN, model: 'typesafe/x' }, async () => { throw boom; })).rejects.toBe(boom);
    const row = byName((await memory.drain()) as Row[], 'decision:typesafe/x');
    expect(row.error).toBe('TypeError');
    expect(row.metadata.is_error).toBe(true);
    await uninstallBraintrust();
    memory = T.useTestBackgroundLogger();
    await installBraintrust({ tracing: tracing({ content: 'redacted' }) }, deps(flue));
    await expect(traceModelCall('decision', { runId: RUN, model: 'typesafe/x' }, async () => { throw boom; })).rejects.toBe(boom);
    const redacted = byName((await memory.drain()) as Row[], 'decision:typesafe/x');
    expect(redacted.error).toStartWith('TypeError: bad answer for');
    expect(redacted.error).not.toContain(EMAIL);
  });

  test("'redacted' mode masks the names the caller passes, with or without a run id", async () => {
    const flue = fakeFlue();
    const OTHER = 'Ravi Kumar';
    await installBraintrust({ tracing: tracing({ content: 'redacted' }) }, deps(flue, {}, { names: () => [] }));
    const text = `${OTHER} asked about a refund`;
    await traceModelCall('decision', { model: 'anthropic/a', names: [OTHER], input: { user: text } }, async () => text, (out) => ({ output: out }));
    await traceModelCall('decision', { runId: RUN, model: 'anthropic/b', names: [OTHER], input: { user: text } }, async () => {
      throw new Error(`no answer for ${OTHER}`);
    }).catch(() => undefined);
    const rows = (await memory.drain()) as Row[];
    for (const name of ['decision:anthropic/a', 'decision:anthropic/b']) {
      const row = byName(rows, name);
      const json = JSON.stringify({ input: row.input, output: row.output, error: row.error });
      expect(json).not.toContain('Ravi');
      expect(json).toContain('asked about a refund');
      expect(checkEgress({ input: row.input, output: row.output, error: row.error }, { names: [OTHER] })).toEqual({ ok: true });
    }
  });

  test("'redacted' mode with neither a run id nor names sends only type and size", async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing({ content: 'redacted' }) }, deps(flue));
    await traceModelCall('decision', { model: 'anthropic/c', input: { user: PII } }, async () => PII, (out) => ({ output: out }));
    await traceModelCall('decision', { model: 'anthropic/d' }, async () => {
      throw new Error(`no answer for ${NAME}`);
    }).catch(() => undefined);
    const rows = (await memory.drain()) as Row[];
    const c = byName(rows, 'decision:anthropic/c');
    expect(c.input).toEqual({ omitted: 'object', keys: 1 });
    expect(c.output).toEqual({ omitted: 'string', length: PII.length });
    expect(byName(rows, 'decision:anthropic/d').error).toBe('Error');
  });

  test('an extract that throws does not change the result', async () => {
    const flue = fakeFlue();
    await installBraintrust({ tracing: tracing() }, deps(flue));
    const out = await traceModelCall('decision', { model: 'typesafe/x' }, async () => 7, () => { throw new Error('bad extract'); });
    expect(out).toBe(7);
    expect(braintrustStatus().errors).toBe(1);
  });
});

describe('logRunFeedback', () => {
  const SPAN = 'ec025e77d7ac0536';

  test("'metadata' mode sends scores and run metadata, and no comment", async () => {
    const flue = fakeFlue();
    // Feedback runs in processes that never boot the runtime: it starts the logger, without instrument().
    const result = await logRunFeedback(
      tracing(),
      { runId: RUN, spanId: SPAN, verdict: 'correct', findings: [{ id: 'f1', verdict: 'wrong', note: PII }, { id: 'f2', verdict: 'partial' }], notes: [PII] },
      deps(flue),
    );
    expect(result).toEqual({ sent: true });
    expect(flue.installed).toHaveLength(0);
    const rows = (await memory.drain()) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: SPAN, scores: { accepted: 1, 'finding:f1': 0, 'finding:f2': 0.5 }, _audit_metadata: { run_id: RUN, verdict: 'correct' } });
    const json = JSON.stringify(rows);
    for (const marker of CONTENT_MARKERS) expect(json).not.toContain(marker);
  });

  test("'redacted' mode adds the notes as a comment, redacted with the run names", async () => {
    const flue = fakeFlue();
    const result = await logRunFeedback(
      tracing({ content: 'redacted' }),
      { runId: RUN, spanId: SPAN, verdict: 'wrong', findings: [{ id: 'f1', verdict: 'wrong', note: `see ${PHONE}` }], notes: [PII, undefined, ' '], names: ['Ravi Kumar'], cancelled: true },
      { ...deps(flue), names: () => [NAME] },
    );
    expect(result).toEqual({ sent: true });
    const rows = (await memory.drain()) as Row[];
    const comment = rows.find((r) => r.comment !== undefined);
    expect(comment?.origin).toEqual({ id: SPAN });
    const text: string = comment?.comment.text;
    expect(text).toContain('was debited twice');
    expect(text).toContain('finding f1: see');
    expect(checkEgress(text, { names: [NAME] })).toEqual({ ok: true });
    expect(rows.find((r) => r.scores !== undefined)).toMatchObject({ scores: { accepted: 0, 'finding:f1': 0 }, _audit_metadata: { cancelled: true } });
  });

  test("'redacted' mode sends no comment when the run's names are not known, only the scores", async () => {
    const flue = fakeFlue();
    const result = await logRunFeedback(
      tracing({ content: 'redacted' }),
      { runId: RUN, spanId: SPAN, verdict: 'wrong', notes: [`${NAME}'s transfer was the duplicate`] },
      { ...deps(flue), names: () => [] },
    );
    expect(result).toEqual({ sent: true });
    const rows = (await memory.drain()) as Row[];
    expect(rows.find((r) => r.comment !== undefined)).toBeUndefined();
    expect(rows.find((r) => r.scores !== undefined)?.scores).toEqual({ accepted: 0 });
    expect(JSON.stringify(rows)).not.toContain('Asha');
  });

  test('in a process without the instrumentation it waits for the send, and a failed or slow send is a failure', async () => {
    const flue = fakeFlue();
    const failing = failingSends();
    expect(await logRunFeedback(tracing(), { runId: RUN, spanId: SPAN, verdict: 'correct' }, deps(flue, failing.api))).toEqual({ sent: false, reason: 'failed', error: 'FlushFailed' });
    expect(failing.flushes()).toBe(1);
    await uninstallBraintrust();
    const hanging = deps(flue, { flush: () => new Promise<void>(() => undefined) }, { feedbackFlushMs: 20 });
    expect(await logRunFeedback(tracing(), { runId: RUN, spanId: SPAN, verdict: 'correct' }, hanging)).toEqual({ sent: false, reason: 'failed', error: 'FlushTimeout' });
  });

  test('in a process with the instrumentation it does not wait for the send', async () => {
    const flue = fakeFlue();
    const failing = failingSends();
    await installBraintrust({ tracing: tracing() }, deps(flue, failing.api));
    expect(await logRunFeedback(tracing(), { runId: RUN, spanId: SPAN, verdict: 'correct' }, deps(flue, failing.api))).toEqual({ sent: true });
    expect(failing.flushes()).toBe(0);
  });

  test('no span, nothing to send, or a logger that throws: a result, never a throw', async () => {
    const flue = fakeFlue();
    expect(await logRunFeedback(tracing(), { runId: RUN, spanId: undefined, verdict: 'correct' }, deps(flue))).toEqual({ sent: false, reason: 'no_span' });
    expect(await logRunFeedback(tracing(), { runId: RUN, spanId: 'not a span id', verdict: 'correct' }, deps(flue))).toEqual({ sent: false, reason: 'no_span' });
    expect(await logRunFeedback(tracing(), { runId: RUN, spanId: SPAN, verdict: 'pending', notes: [PII] }, deps(flue))).toEqual({ sent: false, reason: 'nothing_to_send' });
    await uninstallBraintrust();
    const throwing = deps(flue, {
      initLogger: ((options: Parameters<typeof bt.initLogger>[0]) => {
        const logger = bt.initLogger(options);
        logger.logFeedback = () => {
          throw new RangeError('bad score');
        };
        return logger;
      }) as typeof bt.initLogger,
    });
    expect(await logRunFeedback(tracing(), { runId: RUN, spanId: SPAN, verdict: 'correct' }, throwing)).toEqual({ sent: false, reason: 'failed', error: 'RangeError' });
  });
});
