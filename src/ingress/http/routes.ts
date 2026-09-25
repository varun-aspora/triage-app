// The polling HTTP API (HLD 02 §5.2, LLD 04 §2.1, D13, D25, D39, D43).
//
// createTriageRoutes(deps) returns a Hono app with:
//   POST /triage                       -> 202 {run_id} (or {run_id, deduplicated: true})
//   GET  /triage                       -> {runs: RunSummary[], next_cursor} (filters in run-list.ts)
//   GET  /triage/:run_id               -> {run_id, status, phase, classification, id_chain, report?,
//                                          created_at, updated_at, requested_by, submissions, feedback,
//                                          block, block_history, ...}
//   GET  /triage/:run_id/events        -> {events, next, more}; ?after=<next>&limit=<n>, the run's events.jsonl
//   POST /triage/:run_id/ask           -> 202 {run_id, submission_id}; 409 while the run is blocked
//   POST /triage/:run_id/resume        -> 202 {run_id, submission_id}; 409 when the run cannot be resumed (D55)
//   POST /triage/:run_id/feedback      -> 200 {run_id, verdict, count}; any time, not only after the report
//   POST /triage/:run_id/stop          -> 200 {run_id, stopped_from, aborted, feedback_count, gaps}; 409 when finished
//   POST /triage/:run_id/post-to-slack -> 403, or 501 when enabled (v1)
//
// Auth is not applied here. src/http/bearer-auth.http.ts puts bearerAuth in
// front of every route, unknown ones included.
//
// POST /triage checks the body, then runs prepareRequest before answering, so
// a bad body is a 400 and a failed Slack read is a 422 that points at
// messages[]. An Idempotency-Key header is claimed in the run store for 24
// hours; a repeat answers with the first run id and starts nothing. The
// submission then runs in the background inside the server's own Flue
// runtime. This module never starts a runtime.
//
// A follow-up (ask) and a resume answer 202 as soon as Flue accepts the
// message, with Flue's submission id. A resume is refused with 409 unless the
// run is blocked, failed after it was dispatched, or stopped: the same rule
// resumeRun applies, checked here first so nothing starts for a refusal. It
// is also 409 when resumeRun finds the SSFB tunnel down in local mode (D56);
// the hint carries the fix.
//
// GET /triage/:run_id passes the whole answer through one more
// persisted-profile redaction, even though the store holds redacted text only.
// GET /triage does not: a RunSummary holds ids, enums, counts and timestamps,
// no free text.
//
// post-to-slack never calls Slack and never reads the body, so a caller's
// approved_by has no effect. A bearer holder asserting approval is not an
// approval; the signed Slack interaction that is one arrives in v2 (D39).

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as v from 'valibot';
import { redactPersisted } from '../../gate/redact.ts';
import { FeedbackError, recordFeedback as defaultRecordFeedback, type FeedbackDeps, type FeedbackInput, type FeedbackResult } from '../../report/feedback.ts';
import { EVIDENCE_KEYS, RunNotFoundError, type RunRecord, type RunStore } from '../../runstore/types.ts';
import { RunIdSchema, type KnownIds, type RunId } from '../../types/core.ts';
import type { TriageRequest } from '../../types/request.ts';
import { IngressInputError, NoEnabledEntityError, type InputHints } from '../normalise.ts';
import { MAX_THREAD_FILE_BYTES, type PrepareInput, type PreparedSubmission } from '../prepare.ts';
import { SlackFetchError } from '../slack.ts';
import { SlackPermalinkError } from '../slack-url.ts';
import { RunNotRunningError, stopRun } from '../stop.ts';
import {
  askRun,
  className,
  resumeRefusal,
  resumeRun,
  RunNotResumableError,
  type Dispatcher,
  type ResumeInput,
  type SettleDeps,
  type SubmissionResult,
} from '../submit.ts';
import { findingRefs } from '../../report/finding-refs.ts';
import { readRunEvents } from '../../runlog/read.ts';
import { filterRuns, parseListQuery, statusOfPhase, storeQuery } from './run-list.ts';
import {
  AskBodySchema,
  checkIdempotencyKey,
  FeedbackBodySchema,
  parseBody,
  ResumeBodySchema,
  StopBodySchema,
  TriageBodySchema,
  type TriageBody,
} from './schemas.ts';

/** How long an Idempotency-Key maps to its run (LLD 04 §2.1). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Told to the caller when the Slack read fails. */
export const MESSAGES_HINT = 'Send the thread as messages[] in the body instead of slack_url.';

export const SLACK_POST_DISABLED = 'posting to Slack over HTTP is disabled (TRIAGE_HTTP_ALLOW_SLACK_POST=false)';
export const SLACK_POST_NOT_IMPLEMENTED = 'posting to Slack over HTTP needs a signed Slack approval, which arrives in v2; use triage post';

/** A follow-up or a resume that has been started: dispatched resolves with Flue's submission id. */
export type AskStart = {
  readonly dispatched: Promise<string>;
  readonly settled: Promise<unknown>;
};

/** What ran in the background when a failure is reported. */
export type BackgroundWork = 'submission' | 'ask' | 'resume';

export type TriageRouteDeps = {
  readonly store: RunStore;
  /** prepareRequest with the server's deps. Throws the ingress errors. */
  readonly prepare: (input: PrepareInput) => Promise<PreparedSubmission>;
  /** runSubmission with the server's deps. Runs in the background. */
  readonly submit: (prepared: PreparedSubmission) => Promise<unknown>;
  /** Starts a follow-up. startAsk() builds one from SettleDeps. */
  readonly ask: (runId: RunId, question: string, by: string) => AskStart;
  /** Sends a blocked, failed or stopped run on (D55). startResume() builds one from SettleDeps. */
  readonly resume: (runId: RunId, input: ResumeInput) => AskStart;
  /** TRIAGE_HOME, for the feedback eval draft. */
  readonly home: string;
  /** TRIAGE_HTTP_ALLOW_SLACK_POST. */
  readonly allowSlackPost: boolean;
  /** Defaults to recordFeedback from src/report/feedback.ts. */
  readonly recordFeedback?: (runId: string, input: FeedbackInput, deps: FeedbackDeps) => Promise<FeedbackResult>;
  /** A durable Flue abort of the run's instance, for a stop. Left out: the stop only marks the store. */
  readonly abortRun?: (runId: RunId) => Promise<void>;
  /** TRIAGE_RUNS_DIR, where each run's events.jsonl is. Left out: GET .../events answers an empty log. */
  readonly runsDir?: string;
  /** Defaults to IDEMPOTENCY_TTL_MS. */
  readonly idempotencyTtlMs?: number;
  /** A background submission, follow-up or resume failed. Gets the class name only by default. */
  readonly onBackgroundError?: (runId: string, what: BackgroundWork, err: unknown) => void;
};

export type TriageRouteDepsSource = TriageRouteDeps | (() => TriageRouteDeps | Promise<TriageRouteDeps>);

export function createTriageRoutes(source: TriageRouteDepsSource): Hono {
  const load = memoise(source);
  const app = new Hono();
  const limit = bodyLimit({
    maxSize: MAX_THREAD_FILE_BYTES,
    onError: (c) => c.json({ error: 'body too large' }, 413),
  });

  app.onError((err, c) => {
    console.error(`triage http: ${c.req.method} ${c.req.routePath} failed (${className(err)})`);
    return c.json({ error: 'internal error' }, 500);
  });

  app.post('/triage', limit, async (c) => {
    const key = checkIdempotencyKey(c.req.header('idempotency-key'));
    if (!key.ok) return invalid(c, ['Idempotency-Key'], key.reason);
    const body = await readJson(c);
    if (body === NOT_JSON) return invalid(c, ['body'], 'is not valid JSON');
    const parsed = parseBody(TriageBodySchema, body);
    if (!parsed.ok) return invalid(c, parsed.fields);

    const deps = await load();
    let prepared: PreparedSubmission;
    try {
      prepared = await deps.prepare(toPrepareInput(parsed.value));
    } catch (err) {
      return prepareError(c, err);
    }

    if (key.key !== undefined) {
      const holder = await deps.store.claimIdempotencyKey(key.key, prepared.run_id, deps.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS);
      // The prepared request is dropped; the first run owns this key.
      if (holder !== prepared.run_id) return c.json({ run_id: holder, deduplicated: true }, 202);
    }

    const runId = prepared.run_id;
    void Promise.resolve()
      .then(() => deps.submit(prepared))
      .catch((err: unknown) => backgroundError(deps, runId, 'submission', err));
    return c.json({ run_id: runId }, 202);
  });

  app.get('/triage', async (c) => {
    const parsed = parseListQuery(c.req.query());
    if (!parsed.ok) return invalid(c, [parsed.field], parsed.reason);
    const deps = await load();
    // With a status, feedback or cursor filter the store returns every match
    // and the route drops rows. The folder store reads every run anyway and v1
    // volumes are small, so this costs little; push the filters into the store
    // if Postgres volumes grow.
    const rows = await deps.store.listRuns(storeQuery(parsed.value));
    return c.json(filterRuns(rows, parsed.value));
  });

  app.get('/triage/:run_id', async (c) => {
    const runId = c.req.param('run_id');
    if (!v.is(RunIdSchema, runId)) return invalid(c, ['run_id'], 'is not a run id');
    const deps = await load();
    const run = await deps.store.getRun(runId);
    if (run === null) return notFound(c);
    return c.json(runView(run));
  });

  app.get('/triage/:run_id/events', async (c) => {
    const runId = c.req.param('run_id');
    if (!v.is(RunIdSchema, runId)) return invalid(c, ['run_id'], 'is not a run id');
    const after = intParam(c.req.query('after'));
    const limitParam = intParam(c.req.query('limit'));
    if (after === null) return invalid(c, ['after'], 'must be a whole number');
    if (limitParam === null) return invalid(c, ['limit'], 'must be a whole number');
    const deps = await load();
    if ((await deps.store.getRun(runId)) === null) return notFound(c);
    if (deps.runsDir === undefined) return c.json({ events: [], next: after ?? 0, more: false });
    // The lines are persisted-profile text already; they are not redacted again here.
    const page = await readRunEvents(deps.runsDir, runId, {
      ...(after !== undefined ? { after } : {}),
      ...(limitParam !== undefined ? { limit: limitParam } : {}),
    });
    return c.json(page);
  });

  app.post('/triage/:run_id/ask', limit, async (c) => {
    const runId = c.req.param('run_id');
    if (!v.is(RunIdSchema, runId)) return invalid(c, ['run_id'], 'is not a run id');
    const body = await readJson(c);
    if (body === NOT_JSON) return invalid(c, ['body'], 'is not valid JSON');
    const parsed = parseBody(AskBodySchema, body);
    if (!parsed.ok) return invalid(c, parsed.fields);

    const deps = await load();
    const run = await deps.store.getRun(runId);
    if (run === null) return notFound(c);
    // A blocked run waits for a resume, which closes its block. A follow-up would leave the block open.
    if (run.phase === 'blocked') return c.json({ error: 'run is blocked', hint: 'resume it first' }, 409);

    const started = deps.ask(runId, parsed.value.question, parsed.value.requested_by);
    const first = await firstOf(started);
    if (first.kind === 'error') {
      if (first.err instanceof RunNotFoundError) return notFound(c);
      if (first.err instanceof IngressInputError) return invalid(c, [first.err.key], first.err.reason);
      throw first.err;
    }
    // Still running: report a later failure, never leave it unhandled.
    started.settled.catch((err: unknown) => backgroundError(deps, runId, 'ask', err));
    return c.json({ run_id: runId, submission_id: submissionIdOf(first) }, 202);
  });

  app.post('/triage/:run_id/resume', limit, async (c) => {
    const runId = c.req.param('run_id');
    if (!v.is(RunIdSchema, runId)) return invalid(c, ['run_id'], 'is not a run id');
    const body = await readJson(c);
    if (body === NOT_JSON) return invalid(c, ['body'], 'is not valid JSON');
    const parsed = parseBody(ResumeBodySchema, body);
    if (!parsed.ok) return invalid(c, parsed.fields);

    const deps = await load();
    const run = await deps.store.getRun(runId);
    if (run === null) return notFound(c);
    // The check resumeRun makes, made here first so a refusal starts nothing.
    const refusal = resumeRefusal(run);
    if (refusal !== null) return notResumable(c, refusal);

    const note = parsed.value.note;
    const started = deps.resume(runId, { by: parsed.value.requested_by, ...(note !== undefined && note !== '' ? { note } : {}) });
    const first = await firstOf(started);
    if (first.kind === 'error') {
      if (first.err instanceof RunNotFoundError) return notFound(c);
      // The run moved on between the check above and the resume.
      if (first.err instanceof RunNotResumableError) return notResumable(c, first.err);
      if (first.err instanceof IngressInputError) return invalid(c, [first.err.key === 'by' ? 'requested_by' : first.err.key], first.err.reason);
      throw first.err;
    }
    started.settled.catch((err: unknown) => backgroundError(deps, runId, 'resume', err));
    return c.json({ run_id: runId, submission_id: submissionIdOf(first) }, 202);
  });

  app.post('/triage/:run_id/feedback', limit, async (c) => {
    const runId = c.req.param('run_id');
    const body = await readJson(c);
    if (body === NOT_JSON) return invalid(c, ['body'], 'is not valid JSON');
    const parsed = parseBody(FeedbackBodySchema, body);
    if (!parsed.ok) return invalid(c, parsed.fields);

    const deps = await load();
    const record = deps.recordFeedback ?? defaultRecordFeedback;
    try {
      const result = await record(runId, { ...parsed.value, interface: 'http' }, { store: deps.store, home: deps.home });
      return c.json({ run_id: runId, verdict: result.record.verdict, count: result.count });
    } catch (err) {
      if (!(err instanceof FeedbackError)) throw err;
      if (err.code === 'run_not_found') return notFound(c);
      if (err.code === 'invalid_run_id') return invalid(c, ['run_id'], 'is not a run id');
      return invalid(c, err.fields);
    }
  });

  app.post('/triage/:run_id/stop', limit, async (c) => {
    const runId = c.req.param('run_id');
    if (!v.is(RunIdSchema, runId)) return invalid(c, ['run_id'], 'is not a run id');
    const body = await readJson(c);
    if (body === NOT_JSON) return invalid(c, ['body'], 'is not valid JSON');
    const parsed = parseBody(StopBodySchema, body);
    if (!parsed.ok) return invalid(c, parsed.fields);

    const deps = await load();
    try {
      const result = await stopRun(
        runId,
        { by: parsed.value.given_by, interface: 'http', ...(parsed.value.verdict !== undefined ? { verdict: parsed.value.verdict } : {}) },
        { store: deps.store, home: deps.home, ...(deps.abortRun !== undefined ? { abort: deps.abortRun } : {}) },
      );
      return c.json({
        run_id: runId,
        stopped_from: result.stopped_from,
        aborted: result.aborted,
        feedback_count: result.feedback?.count ?? null,
        gaps: [...result.gaps],
      });
    } catch (err) {
      if (err instanceof RunNotFoundError) return notFound(c);
      if (err instanceof RunNotRunningError) return c.json({ error: 'run is not running', phase: err.phase }, 409);
      if (err instanceof IngressInputError) return invalid(c, [err.key === 'by' ? 'given_by' : err.key], err.reason);
      throw err;
    }
  });

  // The body is never read: approved_by from a bearer holder is not an approval.
  app.post('/triage/:run_id/post-to-slack', async (c) => {
    const deps = await load();
    if (!deps.allowSlackPost) return c.json({ error: SLACK_POST_DISABLED }, 403);
    return c.json({ error: SLACK_POST_NOT_IMPLEMENTED }, 501);
  });

  return app;
}

/**
 * Starts askRun and resolves `dispatched` as soon as Flue accepts the
 * follow-up, so the route can answer 202 without waiting for the reply.
 */
export function startAsk(
  runId: RunId,
  question: string,
  by: string,
  deps: SettleDeps,
  ask: typeof askRun = askRun,
): AskStart {
  const tracked = trackDispatch(deps);
  return { dispatched: tracked.dispatched, settled: ask(runId, question, by, tracked.deps) };
}

/** The same for resumeRun (D55): `dispatched` resolves once Flue accepts the resume signal. */
export function startResume(runId: RunId, input: ResumeInput, deps: SettleDeps, resume: typeof resumeRun = resumeRun): AskStart {
  const tracked = trackDispatch(deps);
  return { dispatched: tracked.dispatched, settled: resume(runId, input, tracked.deps) };
}

/** Wraps the dispatcher so the first dispatch receipt resolves `dispatched`. */
function trackDispatch(deps: SettleDeps): { readonly deps: SettleDeps; readonly dispatched: Promise<string> } {
  let resolveDispatched!: (id: string) => void;
  const dispatched = new Promise<string>((resolve) => {
    resolveDispatched = resolve;
  });
  const inner = deps.dispatcher;
  const dispatcher: Dispatcher = {
    init(agent, options) {
      const handle = inner.init(agent, options);
      return {
        dispatch: async (request) => {
          const receipt = await handle.dispatch(request);
          resolveDispatched(receipt.submissionId);
          return receipt;
        },
        read: handle.read.bind(handle),
        abort: handle.abort.bind(handle),
      };
    },
  };
  return { deps: { ...deps, dispatcher }, dispatched };
}

/** The GET answer. Everything but the run id goes through the persisted profile again. */
export function runView(run: RunRecord): Record<string, unknown> {
  // Optional access throughout: older or partial records (and test fixtures)
  // may lack parts of the request or classification.
  const request = run.request as Partial<TriageRequest> | undefined;
  const source = request?.source;
  const decision = run.classification?.decision;
  const warnings = run.classification?.preflight_warnings;
  const view = {
    status: statusOfPhase(run.phase),
    phase: run.phase,
    classification: decision ?? null,
    id_chain: run.classification?.id_chain ?? null,
    ...(run.report !== null ? { report: run.report } : {}),
    created_at: run.created_at,
    updated_at: run.updated_at,
    ...(run.phase_reason !== undefined ? { phase_reason: run.phase_reason } : {}),
    // The open block while the run waits on a system that did not answer (D55), and the closed ones.
    block: run.block ?? null,
    block_history: run.block_history ?? [],
    ...(request?.requested_by !== undefined ? { requested_by: request.requested_by } : {}),
    ...(request?.interface !== undefined ? { interface: request.interface } : {}),
    // This is the persisted copy, so its p<digits> part is usually masked.
    ...(source?.kind === 'slack' ? { permalink: source.permalink } : {}),
    current_ask: run.report?.request?.current_ask ?? null,
    ...(warnings !== undefined ? { preflight_warnings: warnings } : {}),
    evidence: EVIDENCE_KEYS.flatMap((key) => {
      const item = run.evidence?.[key];
      return item !== undefined ? [{ key, version: item.version }] : [];
    }),
    submissions: (run.submissions ?? []).map((s) => ({
      seq: s.seq,
      kind: s.kind,
      ...(s.question !== undefined ? { question: s.question } : {}),
      created_at: s.created_at,
      has_report: s.report !== null && s.report !== undefined,
    })),
    // Ids the feedback route takes in findings[]; the latest findings versions and the root cause.
    findings: findingRefs({ evidence: run.evidence ?? {}, report: run.report }),
    feedback: (run.feedback ?? []).map((f) => ({
      verdict: f.verdict,
      ...(f.actual_root_cause !== undefined ? { actual_root_cause: f.actual_root_cause } : {}),
      ...(f.faster_path !== undefined ? { faster_path: f.faster_path } : {}),
      ...(f.notes !== undefined ? { notes: f.notes } : {}),
      given_by: f.given_by,
      given_at: f.given_at,
      interface: f.interface,
      ...(f.phase !== undefined ? { phase: f.phase } : {}),
      ...(f.submission_seq !== undefined ? { submission_seq: f.submission_seq } : {}),
      ...(f.report_seq !== undefined ? { report_seq: f.report_seq } : {}),
      ...(f.cancelled === true ? { cancelled: true } : {}),
      ...(f.findings !== undefined ? { findings: f.findings } : {}),
    })),
    ...(run.report !== null && run.report_md !== null ? { report_md: run.report_md } : {}),
  };
  // The persisted profile can mask digit runs in a ULID, so the id is put back after.
  return { run_id: run.run_id, ...redactPersisted(view).value };
}

// ------------------------------------------------------------------ helpers

function toPrepareInput(body: TriageBody): PrepareInput {
  const common = {
    interface: 'http' as const,
    requested_by: body.requested_by,
    ...(body.context !== undefined ? { context: body.context } : {}),
  };
  if (body.slack_url !== undefined) {
    const hints: {
      -readonly [K in keyof InputHints]: InputHints[K];
    } = {};
    // Keys are checked against KnownIds by buildTriageRequest.
    if (body.ids !== undefined) hints.ids = body.ids as Partial<KnownIds>;
    if (body.entities !== undefined) hints.entities = body.entities;
    if (body.tier !== undefined) hints.tier = body.tier;
    if (body.time_window !== undefined) hints.time_window = body.time_window;
    return { ...common, kind: 'slack', url: body.slack_url, hints };
  }
  const { slack_url: _unused, context: _context, ...rest } = body;
  return { ...common, kind: 'json', body: rest };
}

function prepareError(c: Context, err: unknown): Response {
  if (err instanceof SlackFetchError) {
    return c.json({ error: 'slack thread read failed', code: err.code, hint: MESSAGES_HINT }, 422);
  }
  if (err instanceof SlackPermalinkError) return invalid(c, ['slack_url'], err.reason);
  if (err instanceof IngressInputError) return invalid(c, [err.key], err.reason);
  if (err instanceof NoEnabledEntityError) return invalid(c, ['entities'], 'leave no enabled entity');
  throw err;
}

function invalid(c: Context, fields: readonly string[], reason?: string): Response {
  return c.json({ error: 'invalid request', fields, ...(reason !== undefined ? { reason } : {}) }, 400);
}

/** undefined when absent or blank, null when not a whole number >= 0. */
function intParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  return /^[0-9]{1,9}$/.test(raw) ? Number(raw) : null;
}

function notFound(c: Context): Response {
  return c.json({ error: 'run not found' }, 404);
}

function notResumable(c: Context, err: RunNotResumableError): Response {
  return c.json({ error: 'run is not resumable', phase: err.phase, hint: err.hint }, 409);
}

type First = { kind: 'dispatched'; id: string } | { kind: 'settled'; value: unknown } | { kind: 'error'; err: unknown };

/** The dispatch receipt, or the result or error when the reply came first. */
function firstOf(started: AskStart): Promise<First> {
  return Promise.race([
    started.dispatched.then((id): First => ({ kind: 'dispatched', id })),
    started.settled.then(
      (value): First => ({ kind: 'settled', value }),
      (err: unknown): First => ({ kind: 'error', err }),
    ),
  ]);
}

const NOT_JSON = Symbol('not json');

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return NOT_JSON;
  }
}

function submissionIdOf(first: Exclude<First, { kind: 'error' }>): string | null {
  if (first.kind === 'dispatched') return first.id;
  const id = (first.value as Partial<SubmissionResult> | null)?.submission_id;
  return typeof id === 'string' ? id : null;
}

function backgroundError(deps: TriageRouteDeps, runId: string, what: BackgroundWork, err: unknown): void {
  if (deps.onBackgroundError !== undefined) {
    try {
      deps.onBackgroundError(runId, what, err);
    } catch {
      // A broken reporter must not become an unhandled rejection.
    }
    return;
  }
  console.error(`triage http: background ${what} for run ${runId} failed (${className(err)})`);
}

function memoise(source: TriageRouteDepsSource): () => Promise<TriageRouteDeps> {
  if (typeof source !== 'function') return () => Promise.resolve(source);
  let pending: Promise<TriageRouteDeps> | undefined;
  return () => {
    if (pending === undefined) {
      const p = Promise.resolve().then(source);
      pending = p;
      // A failed build is retried on the next request.
      p.catch(() => {
        if (pending === p) pending = undefined;
      });
    }
    return pending;
  };
}
