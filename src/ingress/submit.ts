// The submission pipeline: from a prepared request to a settled Triage run
// (LLD 04 §1, §2.4, §3; HLD 02 §1.5; D9, D22, D24, D36, D43).
//
// runSubmission(prepared, deps) runs, in order:
//   1. store.createRun with the persisted-profile copy of the request (the
//      ingress names included in the scan). The raw thread never reaches the
//      store.
//   2. Pre-flight and, when due, the repo sync (D47), side by side; both are
//      skipped in mock mode. The run waits for them. Warnings are kept,
//      never fatal.
//   3. The ingress identity step. An unreachable database comes back as
//      unreachable hops; any other non-loud failure becomes an empty chain and
//      a gap. Strict fixture misses, aborts and malformed core results throw.
//   4. The classifier on the model-facing thread, then the known-pattern
//      match, then the tier policy. A classifier failure ends as category
//      unknown and tier strong, and the run is still dispatched.
//   5. store.putClassification with the decision, the id chain and the
//      warnings, and prior cases when TRIAGE_PRIOR_CASES=true.
//   6. A new submission, then init(Triage, { id: run_id, uid: null })
//      .dispatch({ message, initialData }). Flue 2.0.8 puts the uid send
//      condition on init(), not on the handle's dispatch(), so uid: null goes
//      there: an existing instance with this id rejects instead of being
//      continued.
//   7. handle.read(receipt), then phase completed, or failed with the error
//      class name. Evidence already stored is left as it is.
//   8. embedRun after the settle. Its gaps are returned and never change the
//      run's status.
//
// Every step records a phase: preflight, identity, classifying, dispatched,
// investigating, then completed or failed.
//
// Screenshots (D36): Flue's dispatch message takes image parts
// ({ kind: 'user', body, attachments: [{ type: 'image', data, mimeType }] }),
// so images are sent inline when the tier_final model accepts images. The
// sandbox fallback (/data/attachments/<n>.<ext>) is not needed and not built.
// When the tier model is text-only the images are dropped, the decision gets
// images_dropped, and a warning tells the report that screenshots were not
// analysed.
//
// Gaps with no other home (identity gaps, dropped screenshots, prior-case
// retrieval) go into preflight_warnings with their own step name, because
// that is the list the report copies into its gaps.
//
// askRun(run_id, question, by, deps) adds a follow-up submission on the same
// Flue instance, without initialData, and settles it the same way.
//
// A response can also end on ask_requester (P6 §4.3): the tool stores the
// question and moves the run to needs_input, and read() returns as for a
// completed response. dispatchAndSettle checks the store after the read and
// reports status needs_input with the question instead of completed; the
// phase is left as the tool set it and nothing is embedded yet.
//
// answerRun(run_id, input, deps) is the way back: it closes the open
// question with who answered (or skipped) and when, and dispatches the
// answer as a triage.input_answer signal on the same instance. Ids the
// person gave go through the ingress identity step first, and the resulting
// chain rides in the signal's attributes, where the root merges it into the
// run's scope (D26). Free text never widens scope.
//
// The CLI and the HTTP routes both submit through these functions.
// submissionDeps() builds the production deps from the Triage runtime.
import { readFile } from 'node:fs/promises';
import {
  type Agent,
  type AgentHandleDispatchRequest,
  type AgentInstanceHandle,
  type AgentReadOptions,
  type DeliveredAttachment,
  type DeliveredMessage,
  type InitOptions,
  init,
} from '@flue/runtime';
import * as v from 'valibot';
import { triageRuntime, type TriageRuntime } from '../agents/triage-plan.ts';
import { Triage } from '../agents/triage.agent.ts';
import { classify as classifyThread, type ClassifyInput, unknownClassification } from '../classify/classify.ts';
import { loadPatterns, matchPattern, type Pattern } from '../classify/patterns.ts';
import { applyTierPolicy, toTierDecision, type TierPolicyContext, type TierPolicyResult } from '../classify/policy.ts';
import type { Config } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';
import type { Registry } from '../config/registry.ts';
import { infraRepoNames, loadRepos } from '../config/repos.ts';
import { createExecRunner, type ExecRunner } from '../connectors/exec.ts';
import { mockPortFromFixtures } from '../connectors/mock.ts';
import { ConnectorError } from '../connectors/types.ts';
import { createEmbedder, type Embedder, type FetchLike } from '../embed/index.ts';
import { createJsonlAuditSink } from '../gate/audit-sink.ts';
import { redactModelFacing, redactPersisted } from '../gate/redact.ts';
import { createMockLayer } from '../mock/index.ts';
import { acceptsImages, modelForTier } from '../models.ts';
import { netTcpConnect } from '../ops/doctor/probes.ts';
import { runPreflight, type PreflightResult } from '../ops/preflight.ts';
import { syncBeforeRun } from '../ops/repos-autosync.ts';
import type { TcpProbe } from '../ops/tunnel.ts';
import { embedRun as defaultEmbedRun } from '../runstore/embed-run.ts';
import { priorCasesFor, type PriorCasesResult } from '../runstore/prior-cases.ts';
import { RunNotFoundError, type RunStore, type SubmissionInput } from '../runstore/types.ts';
import {
  type Classification,
  type PreflightWarning,
  type PriorCase,
  type TriageInit,
  TriageInitSchema,
} from '../types/classification.ts';
import { type Entity, type Interface, type KnownIds, RunIdSchema, type RunId, type Tier } from '../types/core.ts';
import type { IdChain } from '../types/id-chain.ts';
import { INPUT_ANSWER_CHAIN_ATTR, INPUT_ANSWER_SIGNAL, type InputRequest, QuestionIdSchema } from '../types/input-request.ts';
import type { Attachment, TriageRequest } from '../types/request.ts';
import { type IngressIdentity, NO_IDS_GAP, resolveIngressIdentity } from './identity.ts';
import { IngressInputError } from './normalise.ts';
import type { PreparedSubmission } from './prepare.ts';
import { renderAnswer, renderAsk, renderThread, type RenderImages } from './render-thread.ts';

// ------------------------------------------------------------------ types

export type SubmissionConfig = {
  readonly mock: Pick<Config['mock'], 'enabled'>;
  readonly runs: Pick<Config['runs'], 'priorCases'>;
  readonly budgets: Pick<Config['budgets'], 'runTimeoutMs' | 'runMaxAttempts'>;
};

/** The parts of Flue's instance handle the pipeline uses. */
export type AgentHandle = Pick<AgentInstanceHandle, 'dispatch' | 'read' | 'abort'>;

/** Flue's init(), injectable so tests use a fake. */
export type Dispatcher = { init(agent: Agent, options: InitOptions): AgentHandle };

export type EmbedRunFn = typeof defaultEmbedRun;

/** What dispatch, read and the settle need. askRun takes only these. */
export type SettleDeps = {
  readonly config: SubmissionConfig;
  readonly store: RunStore;
  readonly dispatcher: Dispatcher;
  /** The Triage root agent. */
  readonly agent: Agent;
  /** null when MODEL_EMBEDDING is blank. */
  readonly embedder: Embedder | null;
  /** Defaults to embedRun from src/runstore/embed-run.ts. */
  readonly embedRun?: EmbedRunFn;
  /** Stops the local wait only. The run itself keeps going (use abort for that). */
  readonly signal?: AbortSignal;
  /** Passed to read(): every conversation chunk as it is recorded. */
  readonly onEvent?: AgentReadOptions['onEvent'];
  /** How long read() may wait. Default: run timeout x attempts, plus a minute. */
  readonly readTimeoutMs?: number;
  /** Clock for the answer's resolution time. Defaults to the system clock. */
  readonly now?: () => Date;
};

export type SubmissionDeps = SettleDeps & {
  /** Pre-flight for every enabled entity. Not called in mock mode. */
  readonly preflight: (input: { readonly signal: AbortSignal }) => Promise<Pick<PreflightResult, 'warnings'>>;
  /**
   * Syncs the repos when due for this interface (D47), then fetches the deploy
   * manifests repos of every enabled entity. Not called in mock mode. Left out: no sync.
   */
  readonly repoSync?: (input: { readonly interface: Interface; readonly signal: AbortSignal }) => Promise<readonly PreflightWarning[]>;
  readonly identity: (
    request: Pick<TriageRequest, 'request_id' | 'interface' | 'messages' | 'hints'>,
    opts: { readonly redactionNames: readonly string[]; readonly signal: AbortSignal },
  ) => Promise<IngressIdentity>;
  readonly classify: (input: ClassifyInput, signal: AbortSignal) => Promise<Classification>;
  /** Defaults to applyTierPolicy. */
  readonly policy?: (raw: unknown, ctx: TierPolicyContext) => TierPolicyResult;
  /** Whether the model behind a tier accepts image input (D36). Must not throw. */
  readonly tierAcceptsImages: (tier: Tier) => boolean;
  /** knowledge/patterns/patterns.json. Missing or failing means no pattern match. */
  readonly patterns?: () => Promise<readonly Pattern[]>;
  /** The service names of the likely entities, for the pattern match. */
  readonly servicesFor?: (entities: readonly Entity[]) => readonly string[];
  /** Called only when TRIAGE_PRIOR_CASES=true. */
  readonly priorCases: (runId: RunId, signal: AbortSignal) => Promise<PriorCasesResult>;
  /** Reads an attachment's bytes from its bytes_ref. */
  readonly readAttachment: (bytesRef: string, signal: AbortSignal) => Promise<Uint8Array>;
};

export type SubmissionStatus = 'completed' | 'failed' | 'needs_input';

export type SubmissionResult = {
  readonly run_id: RunId;
  readonly status: SubmissionStatus;
  /** The run store's submission number (1, 2, ...). */
  readonly submission_seq: number;
  /** Flue's submission id from the dispatch receipt. */
  readonly submission_id: string;
  /** The final assistant text, when completed. */
  readonly reply_text?: string;
  /** The error class name, when failed. */
  readonly error?: string;
  /** The question the run paused on, when needs_input. */
  readonly input_request?: InputRequest;
  /** Things that did not happen after the settle, such as embeddings. */
  readonly gaps: readonly string[];
};

/** read() waited longer than the read timeout. The run was asked to abort. */
export class SubmissionReadTimeoutError extends Error {
  override readonly name = 'SubmissionReadTimeoutError';
  constructor(ms: number) {
    super(`gave up waiting for the run after ${ms} ms`);
  }
}

/** The prepared submission does not hold together. A programming error. */
export class SubmissionInputError extends Error {
  override readonly name = 'SubmissionInputError';
}

/** answerRun on a run that is not waiting for an answer, or not on that question. */
export class RunNotWaitingError extends Error {
  override readonly name = 'RunNotWaitingError';
  readonly runId: string;
  readonly questionId?: string;
  constructor(runId: string, questionId?: string) {
    super(questionId === undefined ? `run ${runId} is not waiting for an answer` : `run ${runId} is not waiting on question ${questionId}`);
    this.runId = runId;
    if (questionId !== undefined) this.questionId = questionId;
  }
}

/** Extra wait on top of the run's own deadline before read() gives up. */
export const READ_GRACE_MS = 60_000;

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;
const NO_IMAGES_REASON = 'the model for this tier does not accept images';

// ------------------------------------------------------------------ submit

export async function runSubmission(prepared: PreparedSubmission, deps: SubmissionDeps): Promise<SubmissionResult> {
  const runId = prepared.run_id;
  const request = prepared.request;
  if (!v.is(RunIdSchema, runId)) throw new SubmissionInputError('run_id is not a run id');
  if (request.request_id !== runId) throw new SubmissionInputError('run_id must equal request.request_id');
  const names = [...prepared.redaction_names];
  const signal = deps.signal ?? new AbortController().signal;
  const store = deps.store;

  const persistedRequest = redactPersisted(request, { names });
  await store.createRun(runId, persistedRequest);

  let initialData: TriageInit;
  let images: DeliveredAttachment[];
  let render: RenderImages;
  try {
    const warnings: PreflightWarning[] = [];

    await store.setPhase(runId, 'preflight');
    if (!deps.config.mock.enabled) {
      // Every enabled entity, not only the ones the request names: the names
      // are where the agent starts, and it may brief any enabled entity.
      const [pf, repos] = await Promise.all([
        deps.preflight({ signal }),
        deps.repoSync?.({ interface: request.interface, signal }) ?? [],
      ]);
      warnings.push(...pf.warnings, ...repos);
    }

    await store.setPhase(runId, 'identity');
    const identity = await identityStep(request, names, deps, signal);
    warnings.push(...identity.gaps.map((message) => warning('identity', message)));

    const loaded = await loadImages(request.attachments, deps, signal);
    if (loaded.failed > 0) {
      warnings.push(warning('attachments', `${loaded.failed} screenshot(s) could not be read and were left out`));
    }

    await store.setPhase(runId, 'classifying');
    const classification = await classifyStep(request, identity, loaded.images, names, deps, signal);
    const patterns = await loadKnownPatterns(deps, warnings);
    const matched = withPatternMatch(classification, request, patterns, deps);
    const policy = deps.policy ?? applyTierPolicy;
    const result = policy(matched, {
      imageCapable: deps.tierAcceptsImages,
      hasImages: loaded.images.length > 0,
      patterns,
      ...(request.hints.tier !== undefined ? { override: { tier: request.hints.tier, by: request.requested_by } } : {}),
    });
    let decision = toTierDecision(result);

    const sendImages = loaded.images.length > 0 && safeAccepts(deps, decision.tier_final);
    images = sendImages ? loaded.images : [];
    render = { attached: images.length, dropped: sendImages ? 0 : loaded.images.length, dropReason: NO_IMAGES_REASON };
    if (!sendImages && loaded.images.length > 0) {
      decision = { ...decision, images_dropped: true };
      warnings.push(warning('attachments', `${loaded.images.length} screenshot(s) were not analysed: ${NO_IMAGES_REASON}`));
    }

    let priorCases: PriorCase[] | undefined;
    if (deps.config.runs.priorCases) {
      const pc = await deps.priorCases(runId, signal);
      priorCases = pc.cases.map((c) => ({ ...c }));
      warnings.push(...pc.gaps.map((message) => warning('prior_cases', message)));
    }

    await store.putClassification(
      runId,
      redactPersisted({ decision, id_chain: identity.id_chain, preflight_warnings: warnings }, { names }),
    );

    initialData = v.parse(TriageInitSchema, {
      // The persisted copy, with the run id put back: the persisted profile
      // masks runs of digits, which a ULID can hold.
      request: { ...persistedRequest.value, request_id: runId },
      classification: decision,
      id_chain: identity.id_chain,
      preflight_warnings: warnings,
      redaction_names: names,
      ...(priorCases !== undefined ? { prior_cases: priorCases } : {}),
    });
  } catch (err) {
    await recordFailed(store, runId, err);
    throw err;
  }

  const message: DeliveredMessage = {
    kind: 'user',
    body: renderThread(request, render),
    ...(images.length > 0 ? { attachments: images } : {}),
  };
  return dispatchAndSettle(
    runId,
    { kind: 'initial' },
    { message, initialData },
    { id: runId, uid: null },
    deps,
  );
}

// ------------------------------------------------------------------ ask

/** A follow-up question on an existing run: a new submission on the same Flue instance. */
export async function askRun(runId: string, question: string, by: string, deps: SettleDeps): Promise<SubmissionResult> {
  if (!v.is(RunIdSchema, runId)) throw new IngressInputError('run_id', 'is not a run id');
  if (typeof question !== 'string' || question.trim() === '') throw new IngressInputError('question', 'is empty');
  if (typeof by !== 'string' || by.trim() === '') throw new IngressInputError('by', 'is required');
  const run = await deps.store.getRun(runId);
  if (run === null) throw new RunNotFoundError(runId);
  const message: DeliveredMessage = { kind: 'user', body: renderAsk(question.trim(), by.trim()) };
  // No initialData and no uid: the instance exists and is continued.
  return dispatchAndSettle(runId, { kind: 'ask', question: question.trim() }, { message }, { id: runId }, deps);
}

// ------------------------------------------------------------------ answer

export type AnswerInput = {
  /** Defaults to the open question. */
  readonly question_id?: string;
  /** Left out with skip. */
  readonly answer?: string;
  readonly skip?: boolean;
  /** Ids the person gave; resolved by the ingress identity step before they join the run's scope. */
  readonly ids?: Partial<KnownIds>;
  /** Who answered: an email, a Slack user id or the OS user. */
  readonly by: string;
};

/** answerRun needs the settle deps, plus the identity step when ids are given. */
export type AnswerDeps = SettleDeps & { readonly identity?: SubmissionDeps['identity'] };

/** The answer to the question a run is waiting on: closes it and resumes the run as a new submission. */
export async function answerRun(runId: string, input: AnswerInput, deps: AnswerDeps): Promise<SubmissionResult> {
  if (!v.is(RunIdSchema, runId)) throw new IngressInputError('run_id', 'is not a run id');
  const by = typeof input.by === 'string' ? input.by.trim() : '';
  if (by === '') throw new IngressInputError('by', 'is required');
  const skip = input.skip === true;
  const answer = typeof input.answer === 'string' ? input.answer.trim() : '';
  if (skip && answer !== '') throw new IngressInputError('answer', 'must be empty with skip');
  if (!skip && answer === '') throw new IngressInputError('answer', 'is empty');
  if (input.question_id !== undefined && !v.is(QuestionIdSchema, input.question_id)) throw new IngressInputError('question_id', 'is not a question id');

  const run = await deps.store.getRun(runId);
  if (run === null) throw new RunNotFoundError(runId);
  const open = run.input_request;
  if (open === null) throw new RunNotWaitingError(runId);
  const questionId = input.question_id ?? open.question_id;
  if (questionId !== open.question_id) throw new RunNotWaitingError(runId, questionId);

  const signal = deps.signal ?? new AbortController().signal;
  const ids = input.ids ?? {};
  let chain: IdChain | undefined;
  const gaps: string[] = [];
  if (Object.keys(ids).length > 0) {
    if (deps.identity === undefined) throw new SubmissionInputError('ids need the identity step in the deps');
    const identity = await identityStep(
      { request_id: runId, interface: run.request.interface, messages: [], hints: { ids } },
      [],
      deps as Pick<SubmissionDeps, 'identity'>,
      signal,
    );
    chain = identity.id_chain;
    gaps.push(...identity.gaps.filter((g) => g !== NO_IDS_GAP));
  }

  const now = deps.now ?? (() => new Date());
  await deps.store.resolveInputRequest(
    runId,
    questionId,
    redactPersisted({ status: skip ? 'skipped' : 'answered', resolved_at: now().toISOString(), resolved_by: by }),
  );

  const message: DeliveredMessage = {
    kind: 'signal',
    type: INPUT_ANSWER_SIGNAL,
    body: renderAnswer(open, { skip, answer, by, ids: chain?.ids ?? {}, gaps }),
    attributes: {
      question_id: questionId,
      ...(chain !== undefined ? { [INPUT_ANSWER_CHAIN_ATTR]: JSON.stringify(chain) } : {}),
    },
  };
  return dispatchAndSettle(
    runId,
    { kind: 'answer', question_id: questionId, ...(skip ? {} : { answer }) },
    { message },
    { id: runId },
    deps,
  );
}

// ------------------------------------------------------------------ settle

async function dispatchAndSettle(
  runId: RunId,
  submission: SubmissionInput,
  request: AgentHandleDispatchRequest,
  initOptions: InitOptions,
  deps: SettleDeps,
): Promise<SubmissionResult> {
  const store = deps.store;
  const callerSignal = deps.signal ?? new AbortController().signal;

  let seq: number;
  let handle: AgentHandle;
  let receipt: Awaited<ReturnType<AgentHandle['dispatch']>>;
  try {
    seq = await store.addSubmission(runId, redactPersisted(submission));
    await store.setPhase(runId, 'dispatched');
    handle = deps.dispatcher.init(deps.agent, initOptions);
    receipt = await handle.dispatch(request);
    await store.setPhase(runId, 'investigating');
  } catch (err) {
    await recordFailed(store, runId, err);
    throw err;
  }

  const timeoutMs = deps.readTimeoutMs ?? defaultReadTimeoutMs(deps.config);
  const timeout = AbortSignal.timeout(timeoutMs);
  const readSignal = AbortSignal.any([callerSignal, timeout]);

  let status: SubmissionStatus;
  let replyText: string | undefined;
  let error: string | undefined;
  let inputRequest: InputRequest | undefined;
  try {
    const reply = await handle.read(receipt, {
      signal: readSignal,
      ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
    });
    status = 'completed';
    replyText = reply.text;
  } catch (err) {
    // The caller stopped waiting. The run goes on and stays readable.
    if (callerSignal.aborted) throw err;
    let cause = err;
    if (timeout.aborted) {
      cause = new SubmissionReadTimeoutError(timeoutMs);
      await handle.abort().catch(() => undefined);
    }
    status = 'failed';
    error = failureReason(cause);
  }

  if (status === 'completed') {
    // The response may have ended on ask_requester: then the run is parked on
    // the question the tool stored, not done.
    const run = await store.getRun(runId);
    if (run !== null && run.phase === 'needs_input' && run.input_request !== null) {
      status = 'needs_input';
      inputRequest = run.input_request;
    }
  }
  if (status === 'completed') await store.setPhase(runId, 'completed');
  else if (status === 'failed') await store.setPhase(runId, 'failed', { reason: error ?? 'Error' });

  // A parked run is embedded when it settles for real, like any other.
  const gaps = status === 'needs_input' ? [] : await embedAfterSettle(deps, runId);
  return Object.freeze({
    run_id: runId,
    status,
    submission_seq: seq,
    submission_id: receipt.submissionId,
    ...(replyText !== undefined ? { reply_text: replyText } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(inputRequest !== undefined ? { input_request: inputRequest } : {}),
    gaps: Object.freeze(gaps),
  });
}

async function embedAfterSettle(deps: SettleDeps, runId: RunId): Promise<string[]> {
  const embed = deps.embedRun ?? defaultEmbedRun;
  try {
    const r = await embed(deps.store, deps.embedder, runId);
    return [...r.gaps];
  } catch (err) {
    // embedRun does not throw by contract; this keeps a broken one from failing the run.
    return [`embeddings skipped (${className(err)})`];
  }
}

export function defaultReadTimeoutMs(config: SubmissionConfig): number {
  const attempts = Math.max(1, config.budgets.runMaxAttempts);
  return config.budgets.runTimeoutMs * attempts + READ_GRACE_MS;
}

// ------------------------------------------------------------------ steps

// Errors the identity step passes on: a strict fixture miss, an abort, and a
// malformed core result. Anything else means the step could not run.
const LOUD_IDENTITY_ERRORS: ReadonlySet<string> = new Set(['FixtureMissError', 'IngressIdentityError']);

async function identityStep(
  request: Pick<TriageRequest, 'request_id' | 'interface' | 'messages' | 'hints'>,
  names: readonly string[],
  deps: Pick<SubmissionDeps, 'identity'>,
  signal: AbortSignal,
): Promise<IngressIdentity> {
  try {
    return await deps.identity(request, { redactionNames: names, signal });
  } catch (err) {
    if (signal.aborted || LOUD_IDENTITY_ERRORS.has(className(err))) throw err;
    const id_chain: IdChain = { ids: {}, hops: [], basic_state: [] };
    return { id_chain, basic_state: [], gaps: [`identity step did not run (${className(err)}); the classifier saw the thread only`] };
  }
}

async function classifyStep(
  request: TriageRequest,
  identity: IngressIdentity,
  images: readonly DeliveredAttachment[],
  names: readonly string[],
  deps: SubmissionDeps,
  signal: AbortSignal,
): Promise<Classification> {
  const input: ClassifyInput = {
    thread: redactModelFacing(request.messages),
    idChain: identity.id_chain,
    basicState: identity.basic_state,
    images: images.map((i) => ({ mimeType: i.mimeType, data: i.data })),
    redactionNames: names,
  };
  try {
    return await deps.classify(input, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    return unknownClassification(`classifier failed: ${className(err)}`);
  }
}

async function loadKnownPatterns(deps: SubmissionDeps, warnings: PreflightWarning[]): Promise<readonly Pattern[]> {
  if (deps.patterns === undefined) return [];
  try {
    return await deps.patterns();
  } catch {
    warnings.push(warning('patterns', 'known patterns did not load, so no pattern was matched'));
    return [];
  }
}

// patterns.ts is the only source of matched_pattern_id (the classifier's is dropped).
function withPatternMatch(
  classification: Classification,
  request: TriageRequest,
  patterns: readonly Pattern[],
  deps: SubmissionDeps,
): Classification {
  if (patterns.length === 0 || classification.classifier_error !== undefined) return classification;
  const services = deps.servicesFor?.(classification.entities_likely) ?? [];
  const text = request.messages.map((m) => m.text).join('\n');
  const match = matchPattern(text, services, classification.category, patterns);
  return match === null ? classification : { ...classification, matched_pattern_id: match.matched_pattern_id };
}

type LoadedImages = { readonly images: DeliveredAttachment[]; readonly failed: number };

async function loadImages(attachments: readonly Attachment[], deps: SubmissionDeps, signal: AbortSignal): Promise<LoadedImages> {
  const images: DeliveredAttachment[] = [];
  let failed = 0;
  for (const a of attachments) {
    if (!IMAGE_MIME.test(a.mime)) continue;
    try {
      const bytes = await deps.readAttachment(a.bytes_ref, signal);
      images.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: a.mime, filename: a.name });
    } catch (err) {
      if (signal.aborted) throw err;
      failed += 1;
    }
  }
  return { images, failed };
}

function safeAccepts(deps: SubmissionDeps, tier: Tier): boolean {
  try {
    return deps.tierAcceptsImages(tier) === true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ helpers

function warning(step: string, message: string): PreflightWarning {
  return { step, message };
}

/** The error's class name, for phase reasons and gaps. Never the message. */
export function className(err: unknown): string {
  if (!(err instanceof Error)) return 'Error';
  const ctor = err.constructor?.name;
  if (typeof ctor === 'string' && ctor !== '' && ctor !== 'Error') return ctor;
  return err.name !== '' ? err.name : 'Error';
}

function failureReason(err: unknown): string {
  const name = className(err);
  const outcome = (err as { outcome?: unknown } | null)?.outcome;
  return outcome === 'aborted' ? `${name} (aborted)` : name;
}

async function recordFailed(store: RunStore, runId: RunId, err: unknown): Promise<void> {
  try {
    await store.setPhase(runId, 'failed', { reason: className(err) });
  } catch {
    // The original error matters more; the run may not exist yet.
  }
}

// ------------------------------------------------------------------ production deps

export type SubmissionDepsOptions = {
  /** Defaults to triageRuntime(), so the pipeline and the agent share one store and config. */
  readonly runtime?: TriageRuntime;
  /** Whether stdin is a terminal; pre-flight runs aws sso login only then. Default false. */
  readonly isTty?: boolean;
  readonly runner?: ExecRunner;
  readonly tcpProbe?: TcpProbe;
  /** For the embedder (ollama or openai). Never called in mock mode. */
  readonly fetch?: FetchLike;
  /** Defaults to Flue's init(). */
  readonly dispatcher?: Dispatcher;
  readonly signal?: AbortSignal;
  readonly onEvent?: AgentReadOptions['onEvent'];
};

/** The real deps: Flue init, the runtime's store and connectors, runPreflight, identity, classifier and embedder. */
export function submissionDeps(options: SubmissionDepsOptions = {}): SubmissionDeps {
  const rt = options.runtime ?? triageRuntime();
  const { config, registry } = rt;
  const store = rt.runStore;
  const embedder = embedderFor(config, options.fetch);
  const mock = createMockLayer(config, { home: config.home, ...(rt.caseId !== undefined ? { caseId: rt.caseId } : {}) });
  const audit = rt.audit ?? createJsonlAuditSink({ auditLogPath: config.paths.auditLog, runsDir: config.paths.runsDir });
  const now = rt.now ?? (() => new Date());
  const sql = rt.connectors.sql ?? {
    runSelect: () => Promise.reject(new ConnectorError('not_configured', 'no sql connector for this run')),
  };
  return {
    config,
    store,
    agent: Triage,
    dispatcher: options.dispatcher ?? { init },
    embedder,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    preflight: ({ signal }) =>
      runPreflight({
        config,
        registry,
        runner: options.runner ?? createExecRunner(),
        tcpProbe: options.tcpProbe ?? netTcpConnect,
        isTty: options.isTty ?? false,
        signal,
      }),
    repoSync: ({ interface: iface, signal }) =>
      syncBeforeRun(iface, { config, runner: options.runner ?? createExecRunner(), signal }, infraReposToSync(config, registry)),
    identity: (request, { redactionNames, signal }) =>
      resolveIngressIdentity(request, {
        sql,
        mock: mockPortFromFixtures(mock),
        audit,
        now,
        signal,
        entities: registry,
        sqlTimeouts: { statementTimeoutMs: config.sql.statementTimeoutMs, lockTimeoutMs: config.sql.lockTimeoutMs },
        redactionNames,
      }),
    classify: (input, signal) => classifyThread(input, { config, signal }),
    tierAcceptsImages: (tier) => {
      try {
        return acceptsImages(modelForTier(tier, config));
      } catch {
        return false;
      }
    },
    patterns: () => loadPatterns(config.paths.knowledgeDir),
    servicesFor: (entities) => entities.filter((e) => registry.isEnabled(e)).flatMap((e) => [...registry.services(e)]),
    priorCases: (runId, signal) => priorCasesFor(config, store, embedder, runId, { signal }),
    readAttachment: (bytesRef, signal) => readFile(bytesRef, { signal }),
  };
}

// The deploy manifests repos of every enabled entity. A repos.json that does
// not load means none; the code tools report that problem.
function infraReposToSync(config: Config, registry: Registry): readonly string[] {
  try {
    return infraRepoNames(registry, loadRepos(config, registry), registry.enabledEntities());
  } catch {
    return [];
  }
}

// A refused MODEL_EMBEDDING must not stop runs: embeddings are derived data.
function embedderFor(config: Config, fetchImpl: FetchLike | undefined): Embedder | null {
  try {
    return createEmbedder(config, { fetch: fetchImpl ?? ((url, reqInit) => fetch(url, reqInit)) });
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}
