// The eval driver: one case through the real submission pipeline (D42, D43;
// P1 §3.2, §3.6; LLD 04 §2.1-§2.9).
//
// bootEvalRuntime({ faux }) refuses to go on unless TRIAGE_HOME is an eval
// home. It loads the config with the eval mock flags forced
// (forceEvalFlags) and the fake model's MODEL_* specs, runs assertEvalHome,
// and only then installs the fake provider with setProvider (so the
// src/models.ts registrations stay), points the Triage runtime at the eval
// config and starts Flue through bootRuntime() with the src/db.ts adapter.
// Flue is started once per process: a second boot runs the same checks and
// reuses the running Flue instead of starting another.
//
// runCase(caseSpec, options) builds the request the way ingress does
// (prepareRequest, then runSubmission from T07.4), with two eval choices:
// - the identity step returns the case's own id_chain and basic_state by
//   default, since a case records what identity resolved before the
//   classifier ran. identity: 'fixtures' runs the real step on fixtures.
// - the classifier completes through the fake provider, and serves the
//   case's faux_classification unless the script gives the classifier turns.
// It does not go through the CLI commands.
//
// The result holds the report from the run store (with the real run id put
// back, since the persisted profile can mask digits in it), the tool calls from the
// read() onEvent 'tool-input' chunks (the root conversation's calls), the
// audit lines from the run folder mirror (<runs>/<run_id>/audit.jsonl),
// fixture_misses (audit lines with exit fixture_miss, plus strict misses in
// the identity step, which writes no audit line for them), the report's USD
// cost, whether that cost is partial (a model with no pricing, D59) and the
// wall time. The classifier call reports its usage to the pipeline like any
// other, so the run's store rows include the seq 0 classifier row.
//
// The fake provider has one queue per process, so cases run one at a time:
// runCase waits for the previous call to finish before it installs its script.
//
// Nothing here reaches a network: mock mode is forced, the eval home holds no
// credentials, preflight is skipped in mock mode and the embedder is given a
// fetch that refuses.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Flue, StartOptions } from '@flue/runtime/node';
import { start as flueStart } from '@flue/runtime/node';
import * as v from 'valibot';
import { configureTriageRuntime, triageRuntime } from '../agents/triage-plan.ts';
import { classify as classifyThread, completeWith } from '../classify/classify.ts';
import { type Config, loadConfig } from '../config/env.ts';
import { isConnectorError } from '../connectors/types.ts';
import { loadRegistry, type Registry } from '../config/registry.ts';
import { bootRuntime, resetRuntimeForTests } from '../ingress/runtime.ts';
import { normaliseOptions } from '../ingress/normalise.ts';
import { prepareRequest, type PrepareInput, type PreparedSubmission } from '../ingress/prepare.ts';
import { runSubmission, submissionDeps, type SubmissionDeps, type SubmissionStatus } from '../ingress/submit.ts';
import type { FakeModel } from '../mock/fake-model.ts';
import { createRunStore } from '../runstore/index.ts';
import type { RunStore } from '../runstore/types.ts';
import { type AuditLine, AuditLineSchema } from '../types/audit.ts';
import type { RunId } from '../types/core.ts';
import type { Report } from '../types/report.ts';
import { TriageRequestSchema } from '../types/request.ts';
import { CaseSchema, type EvalCase, toIdChain } from './case-schema.ts';
import { classifierTurn, type FauxCall, type FauxCaller, fauxScript, type FauxTurns } from './contract/faux-script.ts';
import { assertEvalHome, forceEvalFlags } from './home.ts';

/** requested_by on every eval request. */
export const EVAL_REQUESTER = 'evals@example.test';

// ------------------------------------------------------------------ boot

export type EvalBootOptions = {
  /** The fake model. Its MODEL_* specs are forced, so no real model is called. */
  readonly faux: FakeModel;
  /** Extra env values on top of the eval home's .env. The eval mock flags always win. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** Flue's start(). Defaults to start from @flue/runtime/node. Tests pass a spy. */
  readonly start?: (options: StartOptions) => Promise<Flue>;
};

export type EvalRuntime = {
  readonly flue: Flue;
  readonly faux: FakeModel;
  readonly config: Config;
  readonly registry: Registry;
  readonly store: RunStore;
};

/** runCase was called before bootEvalRuntime. */
export class EvalRuntimeNotBootedError extends Error {
  override readonly name = 'EvalRuntimeNotBootedError';
  constructor() {
    super('the eval runtime is not booted; call bootEvalRuntime first');
  }
}

let current: EvalRuntime | undefined;

/**
 * Checks the eval home, then starts Flue once per process. A second call
 * checks again and reuses the running Flue. Throws EvalHomeError, with key
 * names only, before anything is installed or started.
 */
export async function bootEvalRuntime(options: EvalBootOptions): Promise<EvalRuntime> {
  const overrides = forceEvalFlags({ ...options.overrides, ...options.faux.modelEnv });
  const config = loadConfig({ overrides });
  const registry = loadRegistry(config);
  assertEvalHome(config, registry);

  options.faux.install();
  const store = await createRunStore(config);
  configureTriageRuntime({ config, registry, runStore: store });
  prepareDbDir(config);

  const start = options.start ?? flueStart;
  const flue = await bootRuntime({
    // env is empty, so Flue picks up no provider key from the shell.
    start: (o) => start({ ...o, env: {} }),
    db: async () => (await import('../db.ts')).createPersistence(config),
    eventLog: { runsDir: config.paths.runsDir },
  });
  current = Object.freeze({ flue, faux: options.faux, config, registry, store });
  return current;
}

/** Stops Flue and forgets the eval runtime, so a later boot starts again. */
export async function stopEvalRuntime(): Promise<void> {
  const rt = current;
  current = undefined;
  resetRuntimeForTests();
  configureTriageRuntime({});
  await rt?.flue.stop();
}

/** The booted runtime, if any. */
export function evalRuntime(): EvalRuntime | undefined {
  return current;
}

// sqlite opens its file lazily and does not create the directory.
function prepareDbDir(config: Config): void {
  if (config.db.provider !== 'sqlite') return;
  const file = config.db.url.trim();
  if (file === '' || file === ':memory:') return;
  mkdirSync(dirname(isAbsolute(file) ? file : resolve(config.home, file)), { recursive: true });
}

// ------------------------------------------------------------------ runCase

export type RunCaseOptions = {
  /** Scripted faux turns per caller. The classifier turn defaults to the case's faux_classification. */
  readonly turns?: FauxTurns;
  /** 'case' (default) uses the case's id_chain; 'fixtures' runs the ingress identity step on fixtures. */
  readonly identity?: 'case' | 'fixtures';
  /** Directory the case's attachment bytes_ref paths are relative to. */
  readonly caseDir?: string;
  /** Defaults to a new ULID. */
  readonly runId?: RunId;
  readonly signal?: AbortSignal;
};

export type CaseToolCall = { readonly id: string; readonly name: string; readonly input: unknown };

export type CaseResult = {
  readonly run_id: RunId;
  readonly status: SubmissionStatus;
  /** The error class name when the run failed. */
  readonly error?: string;
  readonly report: Report | null;
  readonly tool_calls: readonly CaseToolCall[];
  readonly audit: readonly AuditLine[];
  readonly fixture_misses: number;
  /** The report's cost.usd_total; null when there is no report or no usage was recorded. */
  readonly cost_usd: number | null;
  /** True when cost_usd leaves out a model with no pricing (report.cost.unpriced_models, D59). */
  readonly cost_partial: boolean;
  readonly wall_ms: number;
  /** Every model call the faux script routed, in order. */
  readonly model_calls: readonly FauxCall[];
  /** Errors the faux script raised, such as a caller with no turns left. */
  readonly faux_failures: readonly string[];
  /** Scripted turns not used, per caller. */
  readonly turns_left: Readonly<Partial<Record<FauxCaller, number>>>;
};

let queue: Promise<unknown> = Promise.resolve();

/** Runs one case through runSubmission. Cases run one at a time. */
export function runCase(caseSpec: EvalCase, options: RunCaseOptions = {}): Promise<CaseResult> {
  const next = queue.then(
    () => runOne(caseSpec, options),
    () => runOne(caseSpec, options),
  );
  queue = next.catch(() => undefined);
  return next;
}

async function runOne(caseSpec: EvalCase, options: RunCaseOptions): Promise<CaseResult> {
  const rt = current;
  if (rt === undefined) throw new EvalRuntimeNotBootedError();
  const evalCase = v.parse(CaseSchema, caseSpec);

  const turns: FauxTurns = { ...options.turns };
  if (turns.classifier === undefined && evalCase.faux_classification !== undefined) {
    turns.classifier = [classifierTurn(evalCase.faux_classification)];
  }
  const script = fauxScript(turns);
  script.install(rt.faux);
  // Fixtures under <fixtures>/cases/<case id>/ are checked before shared/.
  configureTriageRuntime({ config: rt.config, registry: rt.registry, runStore: rt.store, caseId: evalCase.id });

  const began = performance.now();
  const prepared = await prepareCase(evalCase, rt, options);
  const toolCalls: CaseToolCall[] = [];
  const identityMisses = { count: 0 };
  const deps = caseDeps(evalCase, rt, options, identityMisses, (chunk) => {
    if (chunk.type === 'tool-input') toolCalls.push({ id: chunk.toolCallId, name: chunk.toolName, input: chunk.input });
  });

  let status: SubmissionStatus;
  let error: string | undefined;
  try {
    const result = await runSubmission(prepared, deps);
    status = result.status;
    error = result.error;
  } catch (err) {
    // A strict miss that stops the run before dispatch is a case result, not a crash.
    if (!isStrictMiss(err)) throw err;
    status = 'failed';
    error = (err as Error).name;
  }
  const wall_ms = Math.round(performance.now() - began);

  const run = await rt.store.getRun(prepared.run_id);
  // The stored report went through the persisted profile, which masks a run of
  // six digits inside a ULID, so its run_id may not match RunIdSchema. Put the
  // real run id back, as slack-post does.
  const report = run?.report ? { ...run.report, run_id: prepared.run_id } : null;
  const audit = readRunAudit(rt.config, prepared.run_id);
  const auditMisses = audit.filter((l) => l.exit === 'fixture_miss').length;

  return Object.freeze({
    run_id: prepared.run_id,
    status,
    ...(error !== undefined ? { error } : {}),
    report,
    tool_calls: Object.freeze(toolCalls),
    audit: Object.freeze(audit),
    fixture_misses: auditMisses + identityMisses.count,
    cost_usd: report?.cost?.usd_total ?? null,
    cost_partial: (report?.cost?.unpriced_models?.length ?? 0) > 0,
    wall_ms,
    model_calls: Object.freeze([...script.calls]),
    faux_failures: Object.freeze(script.failures()),
    turns_left: Object.freeze(script.left()),
  });
}

/** The prepared submission for a case, through prepareRequest as ingress builds it. */
async function prepareCase(c: EvalCase, rt: EvalRuntime, options: RunCaseOptions): Promise<PreparedSubmission> {
  const common = { interface: 'cli' as const, requested_by: EVAL_REQUESTER };
  const input: PrepareInput =
    c.request.messages !== undefined
      ? { ...common, kind: 'json', body: { messages: c.request.messages, ids: { ...c.ids } } }
      : { ...common, kind: 'text', text: c.request.text ?? '', hints: { ids: { ...c.ids } } };
  const { newId: _unused, ...normalise } = normaliseOptions(rt.config, rt.registry);
  const prepared = await prepareRequest(input, {
    normalise,
    ...(options.runId !== undefined ? { newId: () => options.runId as RunId } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const attachments = c.request.attachments ?? [];
  if (attachments.length === 0) return prepared;
  // prepareRequest takes attachments only from Slack, so a case's are added here.
  const request = v.parse(TriageRequestSchema, {
    ...prepared.request,
    attachments: attachments.map((a) => ({ ...a, bytes_ref: attachmentPath(a.bytes_ref, options.caseDir) })),
  });
  return Object.freeze({ ...prepared, request });
}

function attachmentPath(ref: string, caseDir: string | undefined): string {
  if (isAbsolute(ref) || caseDir === undefined) return ref;
  return join(caseDir, ref);
}

function caseDeps(
  c: EvalCase,
  rt: EvalRuntime,
  options: RunCaseOptions,
  identityMisses: { count: number },
  onEvent: NonNullable<SubmissionDeps['onEvent']>,
): SubmissionDeps {
  const base = submissionDeps({
    runtime: triageRuntime(),
    onEvent,
    fetch: () => Promise.reject(new Error('evals make no network calls')),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const chain = toIdChain(c);
  return {
    ...base,
    // onUsage is passed on so the classifier call is counted as intake usage (seq 0, D59).
    classify: (input, signal, onUsage) =>
      classifyThread(input, {
        config: rt.config,
        signal,
        complete: completeWith(rt.faux.provider),
        ...(onUsage !== undefined ? { onUsage } : {}),
      }),
    identity:
      options.identity === 'fixtures'
        ? async (request, opts) => {
            try {
              return await base.identity(request, opts);
            } catch (err) {
              // The identity core writes no audit line for a strict miss, so it is counted here.
              // The error goes on unchanged: the pipeline decides what a miss does to the run.
              if (isStrictMiss(err)) identityMisses.count += 1;
              throw err;
            }
          }
        : async () => ({ id_chain: chain, basic_state: chain.basic_state, gaps: [] }),
  };
}

// A strict mock miss, as the mock layer (FixtureMissError) or a connector (strict_miss) raises it.
function isStrictMiss(err: unknown): boolean {
  return (err as Error | null)?.name === 'FixtureMissError' || isConnectorError(err, 'strict_miss');
}

/** The run's audit lines from the run folder mirror. Empty when none were written. */
export function readRunAudit(config: Pick<Config, 'paths'>, runId: RunId): AuditLine[] {
  let text: string;
  try {
    text = readFileSync(join(config.paths.runsDir, runId, 'audit.jsonl'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => v.parse(AuditLineSchema, JSON.parse(line)));
}
