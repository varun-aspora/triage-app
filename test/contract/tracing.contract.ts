// Contract: Braintrust tracing on the real Triage agent (D82).
//
// Runs Triage on the fake model in strict mock mode (the agent harness in
// ./agents/harness.ts) with tracing turned on in the home's .env and
// Braintrust's in-memory test logger, so no row leaves the process. It
// checks what the wrapped Flue bridge (src/tracing/braintrust.ts) exports:
// - one trace per submission, rooted at the prompt operation; the model
//   turns and the tool calls are children of the operation (the bridge does
//   not put a tool under the turn that asked for it), and a delegation is a
//   task span under the operation with the delegate's turns and tools under
//   it;
// - every tool span is closed, every llm span has token metrics;
// - the run id and the Flue submission id are in every span's metadata as
//   sent, and so are the operation, turn, task and tool call ids (compared
//   with the raw observe() events);
// - 'metadata' mode sends no content; 'redacted' mode sends content that
//   passes checkEgress with the run's ingress names;
// - the root span's row id is written to the run store for its submission,
//   and a feedback score sent to it lands on that row;
// - the tripwire still denies a delegation past the task budget with both
//   Braintrust instrumentations installed ahead of it.
//
// The strong synthesis inside finish_report is a nested harness.prompt()
// with no parent the bridge can see, so Braintrust starts a second trace
// for it with the same submission id. The first root is the one stored.
// A test below pins that, so a Flue or Braintrust upgrade that changes it
// shows up here.

import http from 'node:http';
import https from 'node:https';
import { type FlueObservation, init, observe } from '@flue/runtime';
import * as bt from 'braintrust';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { checkEgress, redactPersisted } from '../../src/gate/redact.ts';
import { createFakeModel, finish, text, toolCall } from '../../src/mock/fake-model.ts';
import { setRunRedactionNames } from '../../src/runlog/event-log.ts';
import { latestTraceSpanId } from '../../src/runstore/types.ts';
import {
  type BraintrustApi,
  braintrustStatus,
  installBraintrust,
  logRunFeedback,
  type TraceRoot,
  TRACE_SPAN_ID_PATTERN,
  uninstallBraintrust,
} from '../../src/tracing/braintrust.ts';
import {
  auditLines,
  bootTriage,
  type Booted,
  contractHome,
  createRun,
  nextRunId,
  reportDraft,
  scriptAgents,
  triageInit,
} from './agents/harness.ts';

const T = bt._exportsForTestingOnly;

const fake = createFakeModel();
const home = contractHome(fake, {
  overrides: {
    TRIAGE_BRAINTRUST_ENABLED: 'true',
    BRAINTRUST_API_KEY: 'test-braintrust-key',
    // The second delegation in a run is the tripwire's budget deny case.
    TRIAGE_MAX_TASKS_PER_RUN: '1',
  },
});
const fetchSpy = vi.spyOn(globalThis, 'fetch');
const httpSpy = vi.spyOn(http, 'request');
const httpsSpy = vi.spyOn(https, 'request');
// The SDK keeps its own copy of fetch, taken when it loads, so the spy above
// cannot see its requests. This one is handed to the SDK in beforeAll.
const sdkFetch = vi.fn(async (): Promise<Response> => {
  throw new Error('no network in the tracing contract test');
});

let b: Booted;
let memory: ReturnType<typeof T.useTestBackgroundLogger>;
/** Root span writes still in flight; each run waits for them. */
const recording: Promise<void>[] = [];
let recordRoot: (root: TraceRoot) => Promise<void>;

// Synthetic values only: an example.com address, a made-up name, phone and account.
const NAME = 'Asha Verma';
const EMAIL = 'asha.verma@example.com';
const MESSAGE = `${NAME} (${EMAIL}, +91 98765 43210) says account 918020012345 was debited twice. Triage this report.`;
const AT = '2026-09-20T10:00:00.000Z';
const BRIEF = 'Entity: atspl\nQuestion: where is the parcel\nIds: none\nWindow: last week\nServices in play: package\nReturn: findings';
const FINDINGS = {
  evidence: [{ source: 'db', at: AT, query_or_path: 'deliveries', summary: `one delivery for ${EMAIL}, status SHIPPED` }],
  timeline: [],
  hypotheses: ['the parcel is with the courier'],
  confidence: 'medium',
  gaps: [],
};
const LOW = { ...FINDINGS, hypotheses: ['the dispatch job skipped the card'], confidence: 'low' };
/** Text from the message, the brief, the findings and the prompts; none of it may leave in 'metadata' mode. */
const CONTENT_MARKERS = [
  'Asha',
  'Verma',
  EMAIL,
  '98765',
  '918020012345',
  'debited twice',
  'where is the parcel',
  'status SHIPPED',
  'with the courier',
  'transfer not received',
  'banking support case',
];
/** Content that must be gone in 'redacted' mode too. */
const PII_MARKERS = ['Asha', 'Verma', EMAIL, '98765', '918020012345'];
/** Metadata keys holding ids kept as sent. The ids are compared with Flue's own; checkEgress covers the rest. */
const ID_KEYS = [
  'flue.instance_id',
  'flue.submission_id',
  'flue.conversation_id',
  'flue.session',
  'flue.parent_session',
  'flue.operation_id',
  'flue.turn_id',
  'flue.task_id',
  'flue.tool_call_id',
  'flue.dispatch_id',
  'flue.context_id',
  'flue.context_run_id',
];

type Row = Record<string, any>;
type Envelope = Record<string, unknown>;

beforeAll(async () => {
  await T.simulateLoginForTests();
  bt.setFetch(sdkFetch as unknown as typeof fetch);
  // Before install: the masking function binds to the background logger active when it is set.
  memory = T.useTestBackgroundLogger();
  // Imported here, after TRIAGE_HOME is set: runtime.ts loads triage.agent.ts.
  const { traceRootRecorder } = await import('../../src/ingress/runtime.ts');
  recordRoot = traceRootRecorder(() => b.store, { retryMs: [10, 50, 200, 1000] });
  await install('metadata');
  b = await bootTriage(fake, home);
  // Loads the runtime, which installs the tripwire after Braintrust's two instrumentations.
  b.plan.triageRuntime();
});

afterAll(async () => {
  await uninstallBraintrust();
  bt.setFetch(globalThis.fetch);
  T.clearTestBackgroundLogger();
  T.simulateLogoutForTests();
  await b?.flue.stop();
  home.dispose();
});

/** Tracing from the home's config, with the content mode given. projectId keeps the test logger off the network. */
async function install(content: 'metadata' | 'redacted'): Promise<void> {
  await installBraintrust(
    { tracing: { ...home.config.tracing, content } },
    {
      load: async () => bt as unknown as BraintrustApi,
      projectId: 'test-project-id',
      onRootSpan: (root) => {
        recording.push(recordRoot(root));
      },
    },
  );
}

type Traced = {
  readonly runId: string;
  readonly submissionId: string;
  readonly error: unknown;
  /** This submission's exported rows, merged. */
  readonly rows: Row[];
  /** Flue's raw events for the submission. */
  readonly events: Envelope[];
};

/**
 * Dispatches one message and reads it to the end, the way ingress does:
 * the Flue submission id is written to the run store once the receipt is
 * back. Then waits for the root span writes and drains the test logger.
 */
async function traced(runId: string, seq: number, initialData: unknown, message: string): Promise<Traced> {
  const events: Envelope[] = [];
  const off = observe((o: FlueObservation) => {
    const e = o as unknown as Envelope;
    if (e.instanceId === runId) events.push(e);
  });
  let submissionId = '';
  let error: unknown;
  try {
    const agent = init(b.Triage, { id: runId });
    const receipt = await agent.dispatch({ message, initialData });
    submissionId = receipt.submissionId;
    await b.store.setSubmissionFlueId(runId, seq, submissionId);
    try {
      await agent.read(receipt);
    } catch (err) {
      error = err;
    }
  } finally {
    off();
  }
  await Promise.all(recording.splice(0));
  const rows = ((await memory.drain()) as Row[]).filter((r) => r.metadata?.['flue.submission_id'] === submissionId);
  return { runId, submissionId, error, rows, events: events.filter((e) => e.submissionId === submissionId) };
}

const nameOf = (row: Row): string => String(row.span_attributes?.name);
const typeOf = (row: Row): string => String(row.span_attributes?.type);
const parentOf = (rows: readonly Row[], row: Row): Row | undefined => rows.find((r) => r.span_id === row.span_parents?.[0]);
const roots = (rows: readonly Row[]): Row[] => rows.filter((r) => (r.span_parents ?? []).length === 0);
const withoutIds = (metadata: Record<string, unknown> | undefined): Record<string, unknown> => {
  const out = { ...metadata };
  for (const key of ID_KEYS) delete out[key];
  return out;
};
const metaValues = (rows: readonly Row[], key: string): Set<unknown> =>
  new Set(rows.flatMap((r) => (typeof r.metadata?.[key] === 'string' ? [r.metadata[key]] : [])));

/** The ids Flue put on its events under one key. */
function flueIds(events: readonly Envelope[], key: string): Set<unknown> {
  return new Set(events.flatMap((e) => (typeof e[key] === 'string' ? [e[key]] : [])));
}

// ------------------------------------------------------------------ metadata mode

describe("'metadata' mode, one submission with a delegation", () => {
  let t: Traced;

  beforeAll(async () => {
    const runId = nextRunId('trace_tree');
    const initial = triageInit(runId, { hints: ['atspl'] });
    await createRun(b.store, initial);
    scriptAgents(fake, {
      triage: [
        toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }),
        toolCall('note_evidence', FINDINGS),
        finish(reportDraft(initial)),
        text('report written'),
      ],
      investigate_atspl: [toolCall('note_evidence', FINDINGS), text('recorded the delivery')],
    });
    t = await traced(runId, 1, initial, MESSAGE);
    expect(t.error).toBeUndefined();
  });

  test('is one trace, rooted at the prompt operation', () => {
    expect(t.rows.length).toBeGreaterThan(5);
    const [root, ...others] = roots(t.rows);
    expect(others).toEqual([]);
    expect(nameOf(root as Row)).toBe('flue.prompt');
    expect(new Set(t.rows.map((r) => r.root_span_id))).toEqual(new Set([root?.root_span_id]));
  });

  test('turns and tools sit under the operation, the delegate under its task span', () => {
    const [root] = roots(t.rows) as [Row];
    const children = t.rows.filter((r) => parentOf(t.rows, r) === root);
    expect(children.filter((r) => nameOf(r) === 'flue.turn').map(typeOf)).toEqual(['llm', 'llm', 'llm', 'llm']);
    expect(children.filter((r) => typeOf(r) === 'tool').map(nameOf).sort()).toEqual([
      'tool:finish_report',
      'tool:note_evidence',
      'tool:task',
    ]);
    const task = t.rows.filter((r) => nameOf(r) === 'task:investigate_atspl');
    expect(task).toHaveLength(1);
    expect(parentOf(t.rows, task[0] as Row)).toBe(root);
    const underTask = t.rows.filter((r) => parentOf(t.rows, r) === task[0]).map(nameOf);
    expect(underTask.filter((n) => n === 'flue.turn')).toHaveLength(2);
    expect(underTask).toContain('tool:note_evidence');
    expect(underTask).toContain('flue.prompt');
  });

  test('every tool span is closed and every llm span has token metrics', () => {
    const tools = t.rows.filter((r) => typeOf(r) === 'tool');
    expect(tools).toHaveLength(4);
    for (const tool of tools) {
      expect(tool.metrics?.end, nameOf(tool)).toBeGreaterThanOrEqual(tool.metrics?.start);
      expect(tool.metadata['flue.is_error'], nameOf(tool)).toBe(false);
    }
    const turns = t.rows.filter((r) => typeOf(r) === 'llm');
    expect(turns).toHaveLength(6);
    for (const turn of turns) {
      expect(turn.metrics.prompt_tokens).toBeGreaterThan(0);
      expect(turn.metrics.completion_tokens).toBeGreaterThan(0);
      expect(turn.metrics.tokens).toBeGreaterThan(0);
      expect(turn.metrics.end).toBeDefined();
      expect(turn.metadata).toMatchObject({ model: 'mid', provider: 'faux' });
    }
  });

  test('the run id, the submission id and the Flue ids are in the metadata as sent', () => {
    for (const row of t.rows) {
      expect(row.metadata['flue.instance_id'], nameOf(row)).toBe(t.runId);
      expect(row.metadata['flue.submission_id'], nameOf(row)).toBe(t.submissionId);
    }
    const pairs: [string, string][] = [
      ['flue.operation_id', 'operationId'],
      ['flue.turn_id', 'turnId'],
      ['flue.task_id', 'taskId'],
      ['flue.tool_call_id', 'toolCallId'],
    ];
    for (const [metaKey, eventKey] of pairs) {
      const sent = metaValues(t.rows, metaKey);
      expect(sent.size, metaKey).toBeGreaterThan(0);
      expect(sent, metaKey).toEqual(flueIds(t.events, eventKey));
    }
  });

  test('no content leaves the process', () => {
    const json = JSON.stringify(t.rows);
    for (const marker of CONTENT_MARKERS) expect(json, marker).not.toContain(marker);
    const turn = t.rows.find((r) => typeOf(r) === 'llm' && r.metadata['flue.system_prompt'] !== undefined);
    expect(turn?.metadata['flue.system_prompt']).toMatchObject({ omitted: 'string' });
  });

  test("the root span's row id is stored with the submission, and feedback lands on it", async () => {
    const [root] = roots(t.rows) as [Row];
    const run = await b.store.getRun(t.runId);
    expect(root.id).toMatch(TRACE_SPAN_ID_PATTERN);
    expect(run?.submissions.find((s) => s.seq === 1)?.trace_span_id).toBe(root.id);
    expect(latestTraceSpanId(run as NonNullable<typeof run>)).toBe(root.id);

    const sent = await logRunFeedback(home.config.tracing, {
      runId: t.runId,
      spanId: root.id,
      verdict: 'correct',
      notes: [`checked by ${NAME}`],
    });
    expect(sent).toEqual({ sent: true });
    const feedback = ((await memory.drain()) as Row[]).filter((r) => r.id === root.id);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.scores).toEqual({ accepted: 1 });
    // No comment in 'metadata' mode.
    expect(JSON.stringify(feedback)).not.toContain('Asha');
  });
});

describe('each submission is its own trace', () => {
  test('a follow-up on the same run gets a new trace and its own stored root', async () => {
    const runId = nextRunId('trace_follow_up');
    const initial = triageInit(runId);
    await createRun(b.store, initial);
    const draft = reportDraft(initial);
    scriptAgents(fake, { triage: [finish(draft), text('report written')] });
    const first = await traced(runId, 1, initial, MESSAGE);
    expect(first.error).toBeUndefined();

    await b.store.addSubmission(runId, redactPersisted({ kind: 'ask' as const, question: 'and the second card?' }));
    scriptAgents(fake, { triage: [finish(draft), text('follow-up written')] });
    const second = await traced(runId, 2, initial, 'And the second card?');
    expect(second.error).toBeUndefined();

    const [a] = roots(first.rows) as [Row];
    const [c, ...more] = roots(second.rows) as [Row];
    expect(more).toEqual([]);
    expect(c.root_span_id).not.toBe(a.root_span_id);
    const run = await b.store.getRun(runId);
    expect(run?.submissions.map((s) => [s.seq, s.trace_span_id])).toEqual([
      [1, a.id],
      [2, c.id],
    ]);
    expect(latestTraceSpanId(run as NonNullable<typeof run>)).toBe(c.id);
  });

  test('the strong synthesis starts a second trace with the same submission id; the first root is stored', async () => {
    const runId = nextRunId('trace_synthesis');
    const initial = triageInit(runId, { tier: 'cheap', hints: ['atspl'] });
    await createRun(b.store, initial);
    const draft = reportDraft(initial);
    scriptAgents(fake, {
      triage: [toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }), finish(draft), text('report written')],
      investigate_atspl: [toolCall('note_evidence', LOW), text('recorded, low confidence')],
      synthesis: [toolCall('finish', { ...draft, confidence: 'low', confidence_reason: 'rebuilt on the strong model' })],
    });
    const t = await traced(runId, 1, initial, MESSAGE);
    expect(t.error).toBeUndefined();

    const [main, synthesis, ...more] = roots(t.rows) as [Row, Row];
    expect(more).toEqual([]);
    expect([nameOf(main), nameOf(synthesis)]).toEqual(['flue.prompt', 'flue.prompt']);
    expect(synthesis.root_span_id).not.toBe(main.root_span_id);
    const strong = t.rows.filter((r) => r.root_span_id === synthesis.root_span_id && typeOf(r) === 'llm');
    expect(strong.map((r) => r.metadata.model)).toEqual(['strong']);
    const run = await b.store.getRun(runId);
    expect(run?.submissions[0]?.trace_span_id).toBe(main.id);
  });
});

describe('the tripwire with both instrumentations installed', () => {
  test('a delegation past the task budget is denied, audited and traced as a failed task', async () => {
    const runId = nextRunId('trace_tripwire');
    const initial = triageInit(runId, { hints: ['atspl'] });
    await createRun(b.store, initial);
    const s = scriptAgents(fake, {
      triage: [
        toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }),
        toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }),
        finish(reportDraft(initial)),
        text('report written'),
      ],
      investigate_atspl: [text('first answer')],
      // A spent budget with no high-confidence finding escalates to the strong synthesis.
      synthesis: [toolCall('finish', reportDraft(initial))],
    });
    const t = await traced(runId, 1, initial, MESSAGE);
    expect(t.error).toBeUndefined();

    expect(s.callsFor('investigate_atspl')).toHaveLength(1);
    const deny = auditLines(home).filter((l) => l.run_id === runId && l.service === 'tripwire');
    expect(deny).toHaveLength(1);
    expect(deny[0]).toMatchObject({ tool: 'task', decision: 'deny', target: 'TRIAGE_MAX_TASKS_PER_RUN', transport: 'mock' });

    const tools = t.rows.filter((r) => nameOf(r) === 'tool:task');
    expect(tools.map((r) => r.metadata['flue.is_error'])).toEqual([false, true]);
    for (const tool of tools) expect(tool.metrics.end).toBeDefined();
    // The tripwire refuses the task operation, so the second task span is closed with its error class and has no children.
    const tasks = t.rows.filter((r) => nameOf(r) === 'task:investigate_atspl');
    expect(tasks.map((r) => r.metadata['flue.is_error'] ?? false)).toEqual([false, true]);
    const denied = tasks[1] as Row;
    expect(denied.metrics.end).toBeDefined();
    expect(JSON.parse(denied.error)).toEqual({ type: 'TripwireDeniedError', name: 'TripwireDeniedError' });
    expect(t.rows.filter((r) => parentOf(t.rows, r) === denied)).toEqual([]);
    // The SDK does not mask the error column; in 'metadata' mode the tool's error is only a size.
    expect(JSON.parse((tools[1] as Row).error)).toMatchObject({ omitted: 'object' });
  });
});

// ------------------------------------------------------------------ redacted mode

describe("'redacted' mode", () => {
  let t: Traced;

  beforeAll(async () => {
    // Uninstall forgets the error counters, so the metadata-mode runs are checked here.
    expect(braintrustStatus()).toMatchObject({ errors: 0, flushTimeouts: 0, flushErrors: 0 });
    // The content mode is fixed when the logger starts, so tracing is installed again.
    await uninstallBraintrust();
    await install('redacted');
    const runId = nextRunId('trace_redacted');
    setRunRedactionNames(runId, [NAME]);
    const initial = triageInit(runId, { hints: ['atspl'] });
    await createRun(b.store, initial);
    scriptAgents(fake, {
      triage: [
        toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }),
        toolCall('note_evidence', FINDINGS),
        finish(reportDraft(initial)),
        text('report written'),
      ],
      investigate_atspl: [toolCall('note_evidence', FINDINGS), text(`recorded the delivery for ${NAME}`)],
    });
    t = await traced(runId, 1, initial, MESSAGE);
    expect(t.error).toBeUndefined();
  });

  test('checkEgress is ok on every span with the run names, and the content is there, redacted', () => {
    expect(t.rows.length).toBeGreaterThan(5);
    for (const row of t.rows) {
      const name = nameOf(row);
      const egress = checkEgress(
        { input: row.input, output: row.output, metadata: withoutIds(row.metadata), error: row.error },
        { names: [NAME] },
      );
      expect({ name, egress }).toEqual({ name, egress: { ok: true } });
    }
    const json = JSON.stringify(t.rows);
    for (const marker of PII_MARKERS) expect(json, marker).not.toContain(marker);
    expect(json).toContain('was debited twice');
    expect(json).toContain('where is the parcel');
  });

  test('the ids are unchanged by redaction', () => {
    for (const row of t.rows) {
      expect(row.metadata['flue.instance_id'], nameOf(row)).toBe(t.runId);
      expect(row.metadata['flue.submission_id'], nameOf(row)).toBe(t.submissionId);
    }
    for (const [metaKey, eventKey] of [
      ['flue.operation_id', 'operationId'],
      ['flue.task_id', 'taskId'],
      ['flue.tool_call_id', 'toolCallId'],
    ] as const) {
      expect(metaValues(t.rows, metaKey), metaKey).toEqual(flueIds(t.events, eventKey));
    }
  });

  test('the root span is stored, and the feedback comment goes out redacted', async () => {
    const [root, ...others] = roots(t.rows) as [Row];
    expect(others).toEqual([]);
    const run = await b.store.getRun(t.runId);
    expect(run?.submissions[0]?.trace_span_id).toBe(root.id);
    const sent = await logRunFeedback(
      { ...home.config.tracing, content: 'redacted' },
      { runId: t.runId, spanId: root.id, verdict: 'partial', notes: [`${NAME} confirmed at ${EMAIL}`] },
    );
    expect(sent).toEqual({ sent: true });
    const feedback = (await memory.drain()) as Row[];
    const json = JSON.stringify(feedback);
    expect(json).toContain('confirmed at');
    for (const marker of PII_MARKERS) expect(json, marker).not.toContain(marker);
    expect(feedback.find((r) => r.id === root.id && r.scores !== undefined)?.scores).toEqual({ accepted: 0.5 });
  });
});

describe('side effects', () => {
  test("tracing swallowed no errors (the 'metadata' runs are checked before the redacted install)", () => {
    expect(braintrustStatus()).toMatchObject({ on: true, instrumented: true, errors: 0, flushTimeouts: 0, flushErrors: 0 });
  });

  test('no network request was made, by the SDK or anything else', () => {
    expect(sdkFetch).toHaveBeenCalledTimes(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(httpSpy).toHaveBeenCalledTimes(0);
    expect(httpsSpy).toHaveBeenCalledTimes(0);
  });
});
