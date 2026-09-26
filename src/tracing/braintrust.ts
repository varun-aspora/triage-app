// Braintrust tracing (D82). The only file that imports the braintrust
// package; everything else calls the helpers below. Tracing never fails a
// run, a feedback command, a CLI command or shutdown: every error here is
// swallowed and counted (braintrustStatus()).
//
// installBraintrust(config) does nothing unless config.tracing.enabled. When
// it is on, it loads braintrust (lazily, so a process with tracing off never
// runs the SDK's import side effects), then:
//   1. setMaskingFunction(): the second redaction layer. Every exported span
//      field Braintrust masks (input, output, expected, metadata, context,
//      scores, metrics) goes through toPlain and redactPersisted without
//      names; the correlation ids in a metadata object (flue.*, model,
//      provider, run_id) are put back as they were, when they look like ids.
//      It runs at flush time, outside any run, so it cannot know a run's
//      names; the first layer masks those.
//   2. initLogger() with the key from config, passed in, never through
//      process.env (so childEnv() never copies it into a child process).
//   3. instrument() with braintrustFlueInstrumentation(), its observe wrapped
//      with projectEvent() (redact-event.ts, the first layer, with the run's
//      ingress names from runRedactionNames). key, interceptor and dispose are
//      passed through. The wrapper stays synchronous: Flue emits
//      operation_start, turn_request and tool_start just before it runs the
//      matching interceptor, which needs the span the event started.
//   4. instrument() with a second, later-installed interceptor that captures
//      each Flue submission's root span. Flue runs interceptors in install
//      order, so inside it currentSpan() is the span the bridge just made
//      current. The first agent 'prompt' operation of a submission outside a
//      task, whose span has no parents, is the submission's root (Flue 2.0.8
//      never emits run_start, so every submission is its own trace). On
//      Flue 2.0.8 that prompt's interceptor context has no submissionId
//      (only the outer submission operation, which has no span, carries
//      it), so the observe wrapper keeps the submission id of each prompt
//      operation_start and the capture looks it up by operation id. A
//      nested harness.prompt() (the synthesis inside finish_report) makes a
//      second root with the same submission id; the first one wins. Flue
//      emits submission_running at the start of every attempt, so on a
//      retry in the same process (a recovery replacement) the observe
//      wrapper forgets the earlier attempt's root and the new attempt's
//      prompt is captured as the submission's root.
//      onTraceRoot() hands the root to the runtime, which stores its row id
//      (the id logFeedback needs) with the submission.
//
// Braintrust's error column, span names, tags, feedback comments and
// feedback metadata are never masked by the SDK, so everything written to
// them here is either an id or enum, or has been through redactPersisted.
// Image parts and other long binary base64 never leave (withoutBinary in
// redact-event.ts, in both layers).
//
// traceModelCall() records a model call Flue does not see (the decision
// model, embeddings) as an llm span named '<kind>:<model>', a trace of its
// own tagged with run_id. In 'redacted' mode its content is masked with the
// names the caller passes and the run's names; a call with neither a run id
// nor names sends only type and size, as in 'metadata' mode.
//
// logRunFeedback() sends a verdict to a submission's root span as scores;
// it starts the logger itself (without instrument()), because the feedback
// command and stop never boot the runtime. In such a process it also waits,
// for a few seconds at most, for the row to be sent, so a failed send
// (a bad key, no network) comes back as a failure the caller logs. In a
// process that installed the instrumentation (the server) the row goes with
// the next flush, and a failed send there is only counted. The notes go in
// the comment only in 'redacted' mode and only when the run's names are
// known; otherwise the scores go alone.
//
// flushBraintrust() waits for queued rows with a time limit and says how it
// ended. The HTTP logger's own beforeExit flush does not run on
// process.exit() or signals, and the Flue bridge never flushes on 2.0.8, so
// callers flush before exit. The SDK reports send errors only through its
// background logger's onFlushError, which startLogger sets to count them.
//
// The state sits under a Symbol.for key on globalThis (like the usage meter),
// so a second copy of this module shares it and install runs once.

import type {
  FlueEventContext,
  FlueExecutionContext,
  FlueExecutionOperation,
  FlueInstrumentation,
  FlueObservation,
} from '@flue/runtime';
import type * as Braintrust from 'braintrust';
import type { Config, TracingContentMode } from '../config/env.ts';
import { redactPersisted } from '../gate/redact.ts';
import { toPlain } from '../runlog/serialize.ts';
import { projectContent, projectEvent, withoutBinary } from './redact-event.ts';

/** The part of the braintrust module this file uses. Tests may pass their own. */
export type BraintrustApi = Pick<
  typeof Braintrust,
  | 'initLogger'
  | 'setMaskingFunction'
  | 'braintrustFlueInstrumentation'
  | 'flush'
  | 'startSpan'
  | 'currentSpan'
  | 'NOOP_SPAN'
  | '_internalGetGlobalState'
>;

export type TracingConfig = Config['tracing'];

export type BraintrustDeps = {
  /** Loads the braintrust module. Defaults to import('braintrust'). */
  readonly load?: () => Promise<BraintrustApi>;
  /** Flue's instrument(). Tests pass a stand-in. */
  readonly instrument?: (instrumentation: FlueInstrumentation) => () => Promise<void>;
  /** A run's ingress names. Defaults to runRedactionNames from the run event log. */
  readonly names?: (runId: string) => readonly string[];
  /** Milliseconds since the epoch, for traceModelCall's span times. Defaults to Date.now. */
  readonly now?: () => number;
  /** Passed to initLogger. Tests set it so the logger never looks the project up over the network. */
  readonly projectId?: string;
  /** How long logRunFeedback waits for its row to be sent, in a process without the instrumentation. Default 3000 ms. */
  readonly feedbackFlushMs?: number;
};

export type InstallOptions = BraintrustDeps & {
  /** Called with each submission's root span as it is captured. */
  readonly onRootSpan?: (root: TraceRoot) => void;
};

/** A Flue submission's root span in Braintrust. */
export type TraceRoot = {
  /** The run id (the Flue agent instance id). */
  readonly runId: string;
  readonly flueSubmissionId: string;
  /** The root span's row id: what logFeedback takes, and what the run store keeps (trace_span_id). */
  readonly spanId: string;
  /** The trace id. */
  readonly rootSpanId: string;
};

/** A Braintrust row id: 16 hex characters, or a UUID with BRAINTRUST_LEGACY_IDS. */
export const TRACE_SPAN_ID_PATTERN: RegExp = /^(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The capture interceptor's instrument() key. */
export const TRACE_ROOT_CAPTURE_KEY: symbol = Symbol.for('triage-app.braintrust-capture');

/** What the masking function returns for a field it could not redact. */
export const MASK_FAILED = '[redaction failed]';

/** Roots and waiting callbacks kept per process; the oldest are dropped past this. */
const MAX_TRACKED = 1000;

/** Metadata keys whose string values are put back after the masking function redacts them. */
const RESTORED_KEYS = new Set([
  'flue.run_id',
  'flue.instance_id',
  'flue.submission_id',
  'flue.dispatch_id',
  'flue.agent_name',
  'flue.conversation_id',
  'flue.session',
  'flue.parent_session',
  'flue.harness',
  'flue.task_id',
  'flue.operation_id',
  'flue.turn_id',
  'flue.context_id',
  'flue.context_run_id',
  'flue.tool_call_id',
  'flue.tool_name',
  'flue.agent',
  'flue.operation',
  'flue.turn_purpose',
  'flue.stop_reason',
  'flue.api',
  'flue.model',
  'flue.provider',
  'model',
  'response_model',
  'provider',
  'reasoning',
  'run_id',
  'kind',
]);

/**
 * An id, model or enum value: no spaces, @ or +, so free text, emails and
 * phones never match. '|' is allowed for pi-ai's OpenAI Responses tool call
 * ids ('<call_id>|<item_id>').
 */
const ID_SHAPE = /^[A-Za-z0-9._:/|-]{1,256}$/;

type Logger = ReturnType<BraintrustApi['initLogger']>;

type Ready = {
  readonly api: BraintrustApi;
  readonly logger: Logger;
  readonly mode: TracingContentMode;
  readonly names: (runId: string) => readonly string[];
  readonly now: () => number;
  instrumented: boolean;
  readonly disposers: (() => Promise<void>)[];
  readonly roots: Map<string, TraceRoot>;
  /** Prompt operation id -> Flue submission id, from operation_start, until the capture reads it. */
  readonly prompts: Map<string, string>;
  readonly waiting: Map<string, ((root: TraceRoot) => void)[]>;
  readonly listeners: Set<(root: TraceRoot) => void>;
};

type State = {
  ready: Ready | null;
  starting: Promise<Ready | null> | null;
  errors: number;
  flushTimeouts: number;
  /** Send errors the SDK's background logger reported (also counted in errors). */
  flushErrors: number;
};

const KEY = Symbol.for('triage-app.braintrust');
type Global = typeof globalThis & { [KEY]?: State };

function state(): State {
  const g = globalThis as Global;
  g[KEY] ??= { ready: null, starting: null, errors: 0, flushTimeouts: 0, flushErrors: 0 };
  return g[KEY];
}

// ------------------------------------------------------------------ install

/**
 * Turns tracing on for this process when config.tracing.enabled. Safe to call
 * more than once: the logger starts and the instrumentation installs once.
 * Resolves when done; never rejects.
 */
export async function installBraintrust(config: Pick<Config, 'tracing'>, options: InstallOptions = {}): Promise<void> {
  if (!config.tracing.enabled) return;
  const s = state();
  const ready = await startLogger(config.tracing, options);
  if (ready === null) return;
  if (options.onRootSpan !== undefined) ready.listeners.add(options.onRootSpan);
  if (ready.instrumented) return;
  // Set before the first await, so a concurrent call does not install twice.
  ready.instrumented = true;
  try {
    const instrument = options.instrument ?? (await import('@flue/runtime')).instrument;
    ready.disposers.push(instrument(wrapBridge(ready)));
    ready.disposers.push(instrument(captureInstrumentation(ready)));
  } catch {
    s.errors++;
  }
}

export type BraintrustStatus = {
  readonly on: boolean;
  readonly instrumented: boolean;
  /** Every error swallowed, send errors included. */
  readonly errors: number;
  readonly flushTimeouts: number;
  /** Send errors the SDK reported (a failed login or log request). */
  readonly flushErrors: number;
};

/** Whether tracing is on in this process, and how many errors it has swallowed. */
export function braintrustStatus(): BraintrustStatus {
  const s = state();
  return {
    on: s.ready !== null,
    instrumented: s.ready?.instrumented ?? false,
    errors: s.errors,
    flushTimeouts: s.flushTimeouts,
    flushErrors: s.flushErrors,
  };
}

/**
 * Calls cb with the submission's root span once it is captured (at once when
 * it already was). A no-op when tracing is off, so cb never runs.
 */
export function onTraceRoot(flueSubmissionId: string, cb: (root: TraceRoot) => void): void {
  const ready = state().ready;
  if (ready === null) return;
  const root = ready.roots.get(flueSubmissionId);
  if (root !== undefined) {
    callSafely(cb, root);
    return;
  }
  const list = ready.waiting.get(flueSubmissionId) ?? [];
  list.push(cb);
  ready.waiting.set(flueSubmissionId, list);
  trim(ready.waiting);
}

/**
 * How a flush ended: 'off' (tracing is off), 'done', 'failed' (the SDK
 * reported a send error or the flush threw), or 'timeout' (rows may still
 * be in flight).
 */
export type FlushOutcome = 'off' | 'done' | 'failed' | 'timeout';

/**
 * Waits for every queued row to be sent, for at most timeoutMs. Returns at
 * once when tracing is off. Never throws; a timeout or an error is counted.
 */
export async function flushBraintrust(timeoutMs = 3000): Promise<FlushOutcome> {
  const s = state();
  const ready = s.ready;
  if (ready === null) return 'off';
  const sendErrors = s.flushErrors;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  // The flush keeps its own catch, so one that fails after the timeout won is not an unhandled rejection.
  const flushed = Promise.resolve()
    .then(() => ready.api.flush())
    .then(
      () => 'done' as const,
      () => {
        s.errors++;
        return 'failed' as const;
      },
    );
  try {
    const outcome = await Promise.race([flushed, timedOut]);
    if (outcome === 'timeout') {
      s.flushTimeouts++;
      return 'timeout';
    }
    return outcome === 'failed' || s.flushErrors > sendErrors ? 'failed' : 'done';
  } finally {
    clearTimeout(timer);
  }
}

/** Removes the instrumentation and forgets the state. Tests only. */
export async function uninstallBraintrust(): Promise<void> {
  const g = globalThis as Global;
  const ready = g[KEY]?.ready;
  delete g[KEY];
  if (ready === null || ready === undefined) return;
  for (const dispose of ready.disposers.reverse()) await dispose().catch(() => undefined);
  try {
    ready.api.setMaskingFunction(null);
  } catch {
    // Nothing left to undo.
  }
  // The bridge keeps its span maps on a global of its own.
  const bridge = (globalThis as Record<symbol, unknown>)[Symbol.for('braintrust.flue.observe-bridge')];
  (bridge as { reset?: () => void } | undefined)?.reset?.();
}

// ------------------------------------------------------------------ model calls

export type ModelCallKind = 'decision' | 'embed';

export type ModelCallMeta = {
  readonly runId?: string;
  /**
   * Names to mask in 'redacted' mode, added to the run's (the ingress names
   * the caller holds). With neither these nor a run id, the content is sent
   * as type and size only.
   */
  readonly names?: readonly string[];
  /** The configured spec, 'provider/model'. */
  readonly model: string;
  /** What was sent. Content: sent under the content mode. */
  readonly input?: unknown;
  /** Extra metadata: ids and enums only (purpose, agent), never content. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
};

/** What traceModelCall records from a call's result. */
export type ModelCallRecord = {
  /** What came back. Content: sent under the content mode. Keep it small (a count of vectors, not the vectors). */
  readonly output?: unknown;
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
  /** USD, from the pricer or the provider. null or omitted: unknown, not sent. */
  readonly costUsd?: number | null;
  /** The model the provider reports, when it adds to the spec (a dated id). */
  readonly responseModel?: string;
};

/**
 * Runs fn. When tracing is on, records it as an llm span '<kind>:<model>'
 * with run_id, usage metrics and cost (from extract), and a redacted error
 * when fn throws. fn's result or error is returned or thrown as it was; the
 * span never changes either.
 */
export async function traceModelCall<T>(
  kind: ModelCallKind,
  meta: ModelCallMeta,
  fn: () => Promise<T>,
  extract?: (result: T) => ModelCallRecord,
): Promise<T> {
  const s = state();
  const ready = s.ready;
  if (ready === null) return fn();
  const { mode, names } = modelCallContent(ready, meta);
  let span: Braintrust.Span | undefined;
  try {
    span = ready.api.startSpan({
      name: `${kind}:${meta.model}`,
      type: 'llm',
      startTime: ready.now() / 1000,
      event: {
        ...(meta.input !== undefined ? { input: projectContent(meta.input, mode, names) } : {}),
        metadata: modelCallMetadata(kind, meta),
      },
    });
  } catch {
    s.errors++;
  }
  if (span === undefined) return fn();
  try {
    const result = await fn();
    try {
      logModelResult(span, mode, extract?.(result), names);
    } catch {
      s.errors++;
    }
    return result;
  } catch (err) {
    try {
      span.log({ error: errorText(err, mode, names), metadata: { is_error: true } });
    } catch {
      s.errors++;
    }
    throw err;
  } finally {
    try {
      span.end({ endTime: ready.now() / 1000 });
    } catch {
      s.errors++;
    }
  }
}

// ------------------------------------------------------------------ feedback

export type TraceVerdict = 'correct' | 'partial' | 'wrong' | 'pending';

export type RunFeedbackTrace = {
  readonly runId: string;
  /** The judged submission's root span row id (TraceRoot.spanId, the run store's trace_span_id). */
  readonly spanId: string | undefined;
  readonly verdict: TraceVerdict;
  readonly findings?: readonly {
    readonly id: string;
    readonly verdict: Exclude<TraceVerdict, 'pending'>;
    readonly note?: string;
  }[];
  /** Free text given with the verdict (notes, actual root cause, faster path). Sent only in 'redacted' mode. */
  readonly notes?: readonly (string | undefined)[];
  /**
   * The run's ingress names, when the caller knows them. Added to any this
   * process has. With none known, the notes are not sent.
   */
  readonly names?: readonly string[];
  /** The verdict is stop's Cancel. */
  readonly cancelled?: boolean;
};

export type FeedbackExport =
  | { readonly sent: true }
  | {
      readonly sent: false;
      readonly reason: 'off' | 'no_span' | 'nothing_to_send' | 'failed';
      /** An error class name, when reason is 'failed'. Never a message. */
      readonly error?: string;
    };

/** The score a verdict becomes. pending sends none. */
export const VERDICT_SCORES: Readonly<Record<TraceVerdict, number | undefined>> = Object.freeze({
  correct: 1,
  partial: 0.5,
  wrong: 0,
  pending: undefined,
});

/**
 * Sends a verdict to the submission's root span as scores: accepted, and
 * finding:<id> per finding. The notes go in the comment only in 'redacted'
 * mode and when the run's names are known, after redactPersisted with them.
 * Starts the logger when this process has not, and then waits for the row
 * to be sent: a send that fails or times out is reason 'failed' with error
 * 'FlushFailed' or 'FlushTimeout'. Best effort: never throws.
 */
export async function logRunFeedback(
  tracing: TracingConfig,
  feedback: RunFeedbackTrace,
  deps: BraintrustDeps = {},
): Promise<FeedbackExport> {
  if (!tracing.enabled) return { sent: false, reason: 'off' };
  const spanId = feedback.spanId;
  if (spanId === undefined || !TRACE_SPAN_ID_PATTERN.test(spanId)) return { sent: false, reason: 'no_span' };
  const s = state();
  try {
    const ready = await startLogger(tracing, deps);
    if (ready === null) return { sent: false, reason: 'failed', error: 'LoggerNotStarted' };
    const scores: Record<string, number> = {};
    const accepted = VERDICT_SCORES[feedback.verdict];
    if (accepted !== undefined) scores.accepted = accepted;
    for (const finding of feedback.findings ?? []) {
      const score = VERDICT_SCORES[finding.verdict];
      if (score !== undefined && ID_SHAPE.test(finding.id)) scores[`finding:${finding.id}`] = score;
    }
    const comment = ready.mode === 'redacted' ? feedbackComment(ready, feedback) : undefined;
    if (Object.keys(scores).length === 0 && comment === undefined) return { sent: false, reason: 'nothing_to_send' };
    ready.logger.logFeedback({
      id: spanId,
      ...(Object.keys(scores).length > 0 ? { scores } : {}),
      ...(comment !== undefined ? { comment } : {}),
      metadata: {
        run_id: feedback.runId,
        verdict: feedback.verdict,
        ...(feedback.cancelled === true ? { cancelled: true } : {}),
      },
      source: 'external',
    });
    // A process with the instrumentation lives on and flushes later; one without it (feedback, stop) is about to exit.
    if (!ready.instrumented) {
      const outcome = await flushBraintrust(deps.feedbackFlushMs ?? 3000);
      if (outcome === 'timeout') return { sent: false, reason: 'failed', error: 'FlushTimeout' };
      if (outcome === 'failed') return { sent: false, reason: 'failed', error: 'FlushFailed' };
    }
    return { sent: true };
  } catch (err) {
    s.errors++;
    return { sent: false, reason: 'failed', error: className(err) };
  }
}

// ------------------------------------------------------------------ internals

async function startLogger(tracing: TracingConfig, deps: BraintrustDeps): Promise<Ready | null> {
  const s = state();
  if (!tracing.enabled || tracing.apiKey === undefined) return null;
  if (s.ready !== null) return s.ready;
  s.starting ??= (async () => {
    try {
      const api = deps.load !== undefined ? await deps.load() : ((await import('braintrust')) as BraintrustApi);
      const names = deps.names ?? (await import('../runlog/event-log.ts')).runRedactionNames;
      api.setMaskingFunction(maskField);
      countSendErrors(api);
      const logger = api.initLogger({
        projectName: tracing.projectName,
        apiKey: tracing.apiKey,
        asyncFlush: true,
        ...(tracing.appUrl !== undefined ? { appUrl: tracing.appUrl } : {}),
        ...(deps.projectId !== undefined ? { projectId: deps.projectId } : {}),
      });
      s.ready = {
        api,
        logger,
        mode: tracing.content,
        names,
        now: deps.now ?? Date.now,
        instrumented: false,
        disposers: [],
        roots: new Map(),
        prompts: new Map(),
        waiting: new Map(),
        listeners: new Set(),
      };
      return s.ready;
    } catch {
      s.errors++;
      return null;
    } finally {
      s.starting = null;
    }
  })();
  return s.starting;
}

function wrapBridge(ready: Ready): FlueInstrumentation {
  const bridge = ready.api.braintrustFlueInstrumentation() as unknown as FlueInstrumentation;
  return {
    ...(bridge.key !== undefined ? { key: bridge.key } : {}),
    interceptor: bridge.interceptor,
    dispose: () => bridge.dispose(),
    observe: (observation: FlueObservation, ctx: FlueEventContext) => {
      try {
        const event = observation as unknown as Record<string, unknown>;
        noteEvent(ready, event);
        const names = ready.mode === 'redacted' ? namesFor(ready, runIdOf(event, ctx)) : [];
        const projected = projectEvent(event, ready.mode, names);
        if (projected === null) return;
        void bridge.observe(projected as unknown as FlueObservation, ctx);
      } catch {
        state().errors++;
      }
    },
  };
}

function captureInstrumentation(ready: Ready): FlueInstrumentation {
  return {
    key: TRACE_ROOT_CAPTURE_KEY,
    observe: () => undefined,
    interceptor: (operation, ctx, next) => {
      try {
        captureRoot(ready, operation, ctx);
      } catch {
        state().errors++;
      }
      return next();
    },
    dispose: () => undefined,
  };
}

function captureRoot(ready: Ready, operation: FlueExecutionOperation, ctx: FlueExecutionContext): void {
  if (operation.type !== 'agent' || operation.operationKind !== 'prompt') return;
  const fromEvent = ready.prompts.get(operation.operationId);
  ready.prompts.delete(operation.operationId);
  const flueSubmissionId = ctx.submissionId ?? fromEvent;
  if (flueSubmissionId === undefined || ctx.taskId !== undefined || ready.roots.has(flueSubmissionId)) return;
  const runId = ctx.instanceId ?? ctx.eventContext?.id;
  if (typeof runId !== 'string') return;
  const span = ready.api.currentSpan();
  if (Object.is(span, ready.api.NOOP_SPAN) || span.spanParents.length > 0) return;
  const root: TraceRoot = { runId, flueSubmissionId, spanId: span.id, rootSpanId: span.rootSpanId };
  ready.roots.set(flueSubmissionId, root);
  trim(ready.roots);
  for (const listener of ready.listeners) callSafely(listener, root);
  const waiting = ready.waiting.get(flueSubmissionId);
  ready.waiting.delete(flueSubmissionId);
  for (const cb of waiting ?? []) callSafely(cb, root);
}

/**
 * Keeps the submission id of a prompt operation outside a task, for
 * captureRoot. A new attempt of a submission (submission_running) forgets
 * the root of the one before, so its prompt is captured again.
 */
function noteEvent(ready: Ready, event: Record<string, unknown>): void {
  if (event.type === 'submission_running' && typeof event.submissionId === 'string') {
    ready.roots.delete(event.submissionId);
    return;
  }
  if (event.type !== 'operation_start' || event.operationKind !== 'prompt' || event.taskId !== undefined) return;
  const { operationId, submissionId } = event;
  if (typeof operationId !== 'string' || typeof submissionId !== 'string' || ready.roots.has(submissionId)) return;
  ready.prompts.set(operationId, submissionId);
  trim(ready.prompts);
}

/** The second layer: persisted profile on one exported span field, ids put back. */
function maskField(value: unknown): unknown {
  try {
    const safe = redactPersisted(withoutBinary(toPlain(value))).value;
    if (!isRecord(value) || !isRecord(safe)) return safe;
    for (const key of Object.keys(value)) {
      const original = value[key];
      if (RESTORED_KEYS.has(key) && typeof original === 'string' && ID_SHAPE.test(original)) safe[key] = original;
    }
    return safe;
  } catch {
    state().errors++;
    return MASK_FAILED;
  }
}

function modelCallMetadata(kind: ModelCallKind, meta: ModelCallMeta): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { kind, model: meta.model };
  if (meta.runId !== undefined) out.run_id = meta.runId;
  for (const [key, v] of Object.entries(meta.metadata ?? {})) {
    if (typeof v !== 'string' || ID_SHAPE.test(v)) out[key] = v;
  }
  return out;
}

// 'redacted' content needs names to mask: the caller's, or the run's. A call
// with neither falls back to type and size.
function modelCallContent(ready: Ready, meta: ModelCallMeta): { mode: TracingContentMode; names: readonly string[] } {
  if (ready.mode !== 'redacted') return { mode: ready.mode, names: [] };
  if (meta.names === undefined && meta.runId === undefined) return { mode: 'metadata', names: [] };
  const fromRun = meta.runId !== undefined ? namesFor(ready, meta.runId) : [];
  return { mode: 'redacted', names: [...new Set([...(meta.names ?? []), ...fromRun])] };
}

function logModelResult(span: Braintrust.Span, mode: TracingContentMode, record: ModelCallRecord | undefined, names: readonly string[]): void {
  if (record === undefined) return;
  const metrics: Record<string, number> = {};
  const usage = record.usage ?? {};
  const put = (key: string, n: number | undefined): void => {
    if (typeof n === 'number' && Number.isFinite(n)) metrics[key] = n;
  };
  put('prompt_tokens', usage.input);
  put('completion_tokens', usage.output);
  put('prompt_cached_tokens', usage.cacheRead);
  put('prompt_cache_creation_tokens', usage.cacheWrite);
  const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n),
  );
  if (counts.length > 0) metrics.tokens = counts.reduce((a, b) => a + b, 0);
  if (record.costUsd !== null) put('estimated_cost', record.costUsd);
  const responseModel = record.responseModel !== undefined && ID_SHAPE.test(record.responseModel) ? record.responseModel : undefined;
  span.log({
    ...(record.output !== undefined ? { output: projectContent(record.output, mode, names) } : {}),
    ...(responseModel !== undefined ? { metadata: { response_model: responseModel } } : {}),
    metrics,
  });
}

/** An error for the unmasked error column: its class name, plus the redacted message in 'redacted' mode. */
function errorText(err: unknown, mode: TracingContentMode, names: readonly string[]): string {
  const name = className(err);
  if (mode !== 'redacted') return name;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message === '' ? name : `${name}: ${redactPersisted(message, { names }).value}`;
}

function feedbackComment(ready: Ready, feedback: RunFeedbackTrace): string | undefined {
  const lines: string[] = [];
  for (const note of feedback.notes ?? []) if (typeof note === 'string' && note.trim() !== '') lines.push(note.trim());
  for (const finding of feedback.findings ?? []) {
    if (finding.note !== undefined && finding.note.trim() !== '' && ID_SHAPE.test(finding.id)) {
      lines.push(`finding ${finding.id}: ${finding.note.trim()}`);
    }
  }
  if (lines.length === 0) return undefined;
  const names = [...new Set([...(feedback.names ?? []), ...namesFor(ready, feedback.runId)])];
  // Reviewer notes can name the requester or the customer; without the run's names they are not sent.
  if (names.length === 0) return undefined;
  return redactPersisted(lines.join('\n'), { names }).value;
}

// The SDK sends rows in the background and reports a failed send (login or
// log request) only through the background logger's onFlushError, which
// initLogger does not take. It is set here on the logger the state holds.
function countSendErrors(api: BraintrustApi): void {
  const s = state();
  try {
    const bg = api._internalGetGlobalState().bgLogger() as { onFlushError?: (err: unknown) => void };
    bg.onFlushError = () => {
      s.errors++;
      s.flushErrors++;
    };
  } catch {
    s.errors++;
  }
}

function namesFor(ready: Ready, runId: string): readonly string[] {
  try {
    return ready.names(runId);
  } catch {
    state().errors++;
    return [];
  }
}

function runIdOf(event: Record<string, unknown>, ctx: FlueEventContext): string {
  if (typeof event.instanceId === 'string') return event.instanceId;
  const id = (ctx as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : '';
}

function callSafely(cb: (root: TraceRoot) => void, root: TraceRoot): void {
  try {
    cb(root);
  } catch {
    state().errors++;
  }
}

function trim(map: Map<string, unknown>): void {
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function className(err: unknown): string {
  const name = err instanceof Error ? err.name : undefined;
  return typeof name === 'string' && /^[A-Za-z0-9_$]{1,64}$/.test(name) ? name : 'Error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
