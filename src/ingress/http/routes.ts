// The polling HTTP API (HLD 02 §5.2, LLD 04 §2.1, D13, D25, D39, D43).
//
// createTriageRoutes(deps) returns a Hono app with:
//   POST /triage                       -> 202 {run_id} (or {run_id, deduplicated: true})
//   GET  /triage                       -> {runs: RunSummary[], next_cursor} (filters in run-list.ts)
//   GET  /triage/:run_id               -> {run_id, status, phase, classification, id_chain, report?,
//                                          created_at, updated_at, requested_by, submissions, feedback, ...}
//   POST /triage/:run_id/ask           -> 202 {run_id, submission_id}
//   POST /triage/:run_id/feedback      -> 200 {run_id, verdict, count}
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
import { askRun, className, type Dispatcher, type SettleDeps, type SubmissionResult } from '../submit.ts';
import { filterRuns, parseListQuery, statusOfPhase, storeQuery } from './run-list.ts';
import { AskBodySchema, checkIdempotencyKey, FeedbackBodySchema, parseBody, TriageBodySchema, type TriageBody } from './schemas.ts';

/** How long an Idempotency-Key maps to its run (LLD 04 §2.1). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Told to the caller when the Slack read fails. */
export const MESSAGES_HINT = 'Send the thread as messages[] in the body instead of slack_url.';

export const SLACK_POST_DISABLED = 'posting to Slack over HTTP is disabled (TRIAGE_HTTP_ALLOW_SLACK_POST=false)';
export const SLACK_POST_NOT_IMPLEMENTED = 'posting to Slack over HTTP needs a signed Slack approval, which arrives in v2; use triage post';

/** A follow-up that has been started: dispatched resolves with Flue's submission id. */
export type AskStart = {
  readonly dispatched: Promise<string>;
  readonly settled: Promise<unknown>;
};

export type TriageRouteDeps = {
  readonly store: RunStore;
  /** prepareRequest with the server's deps. Throws the ingress errors. */
  readonly prepare: (input: PrepareInput) => Promise<PreparedSubmission>;
  /** runSubmission with the server's deps. Runs in the background. */
  readonly submit: (prepared: PreparedSubmission) => Promise<unknown>;
  /** Starts a follow-up. startAsk() builds one from SettleDeps. */
  readonly ask: (runId: RunId, question: string, by: string) => AskStart;
  /** TRIAGE_HOME, for the feedback eval draft. */
  readonly home: string;
  /** TRIAGE_HTTP_ALLOW_SLACK_POST. */
  readonly allowSlackPost: boolean;
  /** Defaults to recordFeedback from src/report/feedback.ts. */
  readonly recordFeedback?: (runId: string, input: FeedbackInput, deps: FeedbackDeps) => Promise<FeedbackResult>;
  /** Defaults to IDEMPOTENCY_TTL_MS. */
  readonly idempotencyTtlMs?: number;
  /** A background submission or follow-up failed. Gets the class name only by default. */
  readonly onBackgroundError?: (runId: string, what: 'submission' | 'ask', err: unknown) => void;
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

  app.post('/triage/:run_id/ask', limit, async (c) => {
    const runId = c.req.param('run_id');
    if (!v.is(RunIdSchema, runId)) return invalid(c, ['run_id'], 'is not a run id');
    const body = await readJson(c);
    if (body === NOT_JSON) return invalid(c, ['body'], 'is not valid JSON');
    const parsed = parseBody(AskBodySchema, body);
    if (!parsed.ok) return invalid(c, parsed.fields);

    const deps = await load();
    if ((await deps.store.getRun(runId)) === null) return notFound(c);

    const started = deps.ask(runId, parsed.value.question, parsed.value.requested_by);
    type First = { kind: 'dispatched'; id: string } | { kind: 'settled'; value: unknown } | { kind: 'error'; err: unknown };
    const first: First = await Promise.race([
      started.dispatched.then((id): First => ({ kind: 'dispatched', id })),
      started.settled.then(
        (value): First => ({ kind: 'settled', value }),
        (err: unknown): First => ({ kind: 'error', err }),
      ),
    ]);
    if (first.kind === 'error') {
      if (first.err instanceof RunNotFoundError) return notFound(c);
      if (first.err instanceof IngressInputError) return invalid(c, [first.err.key], first.err.reason);
      throw first.err;
    }
    // Still running: report a later failure, never leave it unhandled.
    started.settled.catch((err: unknown) => backgroundError(deps, runId, 'ask', err));
    const submissionId = first.kind === 'dispatched' ? first.id : submissionIdOf(first.value);
    return c.json({ run_id: runId, submission_id: submissionId }, 202);
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
      if (err.code === 'no_report') return c.json({ error: 'run has no report yet' }, 409);
      if (err.code === 'invalid_run_id') return invalid(c, ['run_id'], 'is not a run id');
      return invalid(c, err.fields);
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
  const settled = ask(runId, question, by, { ...deps, dispatcher });
  return { dispatched, settled };
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
    ...(request?.requested_by !== undefined ? { requested_by: request.requested_by } : {}),
    ...(request?.interface !== undefined ? { interface: request.interface } : {}),
    // This is the persisted copy, so its p<digits> part is usually masked.
    ...(source?.kind === 'slack' ? { permalink: source.permalink } : {}),
    current_ask: run.report?.request?.current_ask ?? decision?.proposed?.current_ask ?? null,
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
    feedback: (run.feedback ?? []).map((f) => ({
      verdict: f.verdict,
      ...(f.actual_root_cause !== undefined ? { actual_root_cause: f.actual_root_cause } : {}),
      ...(f.faster_path !== undefined ? { faster_path: f.faster_path } : {}),
      given_by: f.given_by,
      given_at: f.given_at,
      interface: f.interface,
    })),
    ...(run.report !== null && run.report_md !== null ? { report_md: run.report_md } : {}),
  };
  // The persisted profile can mask digit runs in a ULID, so the id is put back after.
  return { run_id: run.run_id, ...redactPersisted(view).value };
}

// ------------------------------------------------------------------ helpers

function toPrepareInput(body: TriageBody): PrepareInput {
  const common = { interface: 'http' as const, requested_by: body.requested_by };
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
  const { slack_url: _unused, ...rest } = body;
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

function notFound(c: Context): Response {
  return c.json({ error: 'run not found' }, 404);
}

const NOT_JSON = Symbol('not json');

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return NOT_JSON;
  }
}

function submissionIdOf(value: unknown): string | null {
  const id = (value as Partial<SubmissionResult> | null)?.submission_id;
  return typeof id === 'string' ? id : null;
}

function backgroundError(deps: TriageRouteDeps, runId: string, what: 'submission' | 'ask', err: unknown): void {
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
