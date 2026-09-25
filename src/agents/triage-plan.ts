// The choices and run wiring behind the Triage root agent (HLD 02 §1.1,
// LLD 04 §2.4, §3; D3, D10, D22, D23, D42, D45).
//
// The first half is pure, so it can be unit tested under bun:
// - triagePlan(init, config, registry): the tier model and its thinking
//   level, the enabled entities (every one in TRIAGE_ENTITIES that the
//   registry enables), the focus (the enabled entities request.hints.entities
//   names) and the delegate and skill names the root mounts. Hints set where
//   the root starts, not what it can reach: a case that starts in one entity
//   often continues in another.
// - finishDecision(retries, calledFinish, calledAsk, calledBlocked): what
//   useAgentFinish does when a response would stop. A written report, an
//   opened question or an opened block ends it; otherwise signal once, then
//   fail.
// - durabilityFor(config) and the persistent state mirrors.
//
// The second half wires one run:
// - triageRuntime() loads config, registry and knowledge once per process,
//   builds the connectors (real mode only), the sandbox factory and a run
//   store handle, and installs the tripwire so token usage is metered.
//   configureTriageRuntime() replaces any of these (tests, eval driver).
// - runDepsFor(runId, init) builds the run's ToolDeps once and returns the
//   same object on every render. Keeping one object matters: widenIdChain
//   finds the chain by deps identity, and the delegates share it, so an id
//   resolve_identity adds is seen by later investigator calls.
// - watchFinishReport() wraps finish_report, ask_requester and stop_blocked
//   so the root knows whether the report was actually written, the question
//   opened or the run parked. Flue's tool call record says only whether a
//   call threw, and a redaction refusal is a normal (refused) result.
// - settleRun(runId) drops the per-run state when a response settles.

import type { AgentResponseToolCall, SandboxFactory, ThinkingLevel } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { type Config, loadConfig } from '../config/env.ts';
import { KEY_BY_NAME } from '../config/keys.ts';
import { loadRegistry, type Registry } from '../config/registry.ts';
import { createCodegraphConnector } from '../connectors/codegraph.ts';
import { createExecRunner } from '../connectors/exec.ts';
import { createHttpConnector } from '../connectors/http/client.ts';
import { createQuickwitConnector } from '../connectors/quickwit/client.ts';
import { createSqlConnector } from '../connectors/sql/pg-client.ts';
import { type AuditSink, createJsonlAuditSink } from '../gate/audit-sink.ts';
import { modelForTier, thinkingForTier } from '../models.ts';
import { netTcpConnect } from '../ops/doctor/probes.ts';
import { runTunnelPreflight } from '../ops/preflight.ts';
import { getRunStore } from '../runstore/index.ts';
import type { RunStore } from '../runstore/types.ts';
import { releaseConnectorFailures } from '../tools/_lib/connector-failures.ts';
import { createToolDeps, type ToolConnectors } from '../tools/_lib/context.ts';
import { ASK_REQUESTER } from '../tools/ask-requester.tool.ts';
import {
  type CommitReader,
  commitReaderFor,
  FINISH_REPORT,
  releaseFinishReport,
  type UsageReader,
} from '../tools/finish-report.tool.ts';
import { STOP_BLOCKED } from '../tools/stop-blocked.tool.ts';
import type { ToolContext, ToolDeps } from '../tools/types.ts';
import type { TriageInit } from '../types/classification.ts';
import { ENTITIES, type Entity, type Interface, type RunId, type Tier } from '../types/core.ts';
import { type IdChain, IdChainSchema } from '../types/id-chain.ts';
import { INPUT_ANSWER_CHAIN_ATTR, INPUT_ANSWER_SIGNAL } from '../types/input-request.ts';
import { CODE_WALKER_NAME } from './delegates/code-walker.ts';
import { investigatorName } from './delegates/investigator.ts';
import { type Escalation, type EscalationSnapshot, escalationFor, releaseEscalation } from './escalation.ts';
import { sandboxFactory } from './sandbox.ts';
import { currentKnowledge, type Knowledge, loadKnowledge } from './skills.ts';
import { logRunEvent, setRunRedactionNames } from '../runlog/event-log.ts';
import { installedTripwire, installTripwire, runUsage, tripwireOptionsFor } from './tripwire.ts';

/** The pinned Flue identity of the root agent. */
export const TRIAGE_AGENT_NAME = 'triage';

/** The signal useAgentFinish appends when the report was not written. */
export const FINISH_REQUIRED_SIGNAL = 'triage.finish_required';
export const FINISH_REQUIRED_BODY =
  'You stopped without a written report. Call finish_report with the report draft before you finish. ' +
  'If it refused, fix what it listed and call it again.';

/** How many finish_required signals a response gets before it fails. */
export const MAX_FINISH_SIGNALS = 1;

export const PATTERNS_SKILL = 'patterns';
export const FRONTEND_ROUTING_SKILL = 'frontend-routing';

export function overviewSkillName(entity: Entity): string {
  return `${entity}-overview`;
}

// ------------------------------------------------------------------ plan

export type TriagePlan = {
  readonly tier: Tier;
  /** modelForTier(tier_final), a 'provider/model' spec. */
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  /** Every enabled entity, in ENTITIES order. Each gets its investigators. */
  readonly entities: readonly Entity[];
  /** The enabled entities request.hints.entities names, in ENTITIES order; empty with no hints. */
  readonly focus: readonly Entity[];
  /** investigate_<e> and investigate_<e>_deep per entity, then code_walker. */
  readonly delegates: readonly string[];
  /** <e>-overview per entity, then patterns and frontend-routing. */
  readonly skills: readonly string[];
};

/** Every entity in TRIAGE_ENTITIES that the registry enables. The root mounts investigators for all of them. */
export function enabledEntitiesFor(
  config: Pick<Config, 'entities'>,
  registry: Pick<Registry, 'isEnabled'>,
): readonly Entity[] {
  return Object.freeze(ENTITIES.filter((e) => config.entities.includes(e) && registry.isEnabled(e)));
}

/**
 * The enabled entities the request names, where the root starts. A hinted
 * entity that is not enabled adds nothing; no hints (or an empty list) means
 * no focus, and the root picks from the category and the id chain.
 */
export function focusEntitiesFor(
  init: Pick<TriageInit, 'request'>,
  enabled: readonly Entity[],
  registry: Pick<Registry, 'enabledEntities'>,
): readonly Entity[] {
  const hints = init.request.hints.entities ?? [];
  if (hints.length === 0) return Object.freeze([]);
  const named = new Set<string>(registry.enabledEntities(hints));
  return Object.freeze(enabled.filter((e) => named.has(e)));
}

export function triagePlan(init: TriageInit, config: Config, registry: Registry): TriagePlan {
  const tier = init.classification.tier_final;
  const entities = enabledEntitiesFor(config, registry);
  const focus = focusEntitiesFor(init, entities, registry);
  const delegates = [
    ...entities.flatMap((e) => [investigatorName(e), investigatorName(e, true)]),
    CODE_WALKER_NAME,
  ];
  const skills = [...entities.map(overviewSkillName), PATTERNS_SKILL, FRONTEND_ROUTING_SKILL];
  return Object.freeze({
    tier,
    model: modelForTier(tier, config),
    thinkingLevel: thinkingForTier(tier, config),
    entities,
    focus,
    delegates: Object.freeze(delegates),
    skills: Object.freeze(skills),
  });
}

/** The plan as it goes into persistent state (JSON only). */
export type PlanState = {
  readonly tier: Tier;
  readonly model: string;
  readonly thinking_level: ThinkingLevel;
  readonly entities: Entity[];
  readonly focus: Entity[];
  readonly delegates: string[];
  readonly skills: string[];
};

export function planState(plan: TriagePlan): PlanState {
  return {
    tier: plan.tier,
    model: plan.model,
    thinking_level: plan.thinkingLevel,
    entities: [...plan.entities],
    focus: [...plan.focus],
    delegates: [...plan.delegates],
    skills: [...plan.skills],
  };
}

// ------------------------------------------------------------------ finish

export type FinishStep =
  | { readonly kind: 'done'; readonly retries: number }
  | { readonly kind: 'signal'; readonly retries: number }
  | { readonly kind: 'fail'; readonly retries: number };

/**
 * What to do at a would-stop point. retries is the persisted finish_retries.
 * A written report ends the response and resets the count, so a follow-up
 * submission on the same run gets its own signal; so does an opened question
 * for the requester (calledAsk), which parks the run in needs_input, and an
 * opened block (calledBlocked), which parks it in blocked (D55). The first
 * miss signals once; the next miss fails.
 */
export function finishDecision(retries: number, calledFinish: boolean, calledAsk = false, calledBlocked = false): FinishStep {
  const used = Number.isInteger(retries) && retries > 0 ? retries : 0;
  if (calledFinish || calledAsk || calledBlocked) return { kind: 'done', retries: 0 };
  if (used < MAX_FINISH_SIGNALS) return { kind: 'signal', retries: used + 1 };
  return { kind: 'fail', retries: used };
}

/** Thrown by useAgentFinish on the second miss. The submission settles failed; evidence stays. */
export class FinishRequiredError extends Error {
  override readonly name = 'FinishRequiredError';
  constructor() {
    super('finish_report was not called with a report that could be written, after one reminder');
  }
}

/**
 * True when this response has a finish_report call that did not throw and
 * the watched tool saw it write the report.
 */
export function calledFinish(toolCalls: readonly AgentResponseToolCall[], reportWritten: boolean): boolean {
  return reportWritten && toolCalls.some((c) => c.tool === FINISH_REPORT && !c.isError);
}

/** True when this response has an ask_requester call that did not throw and the watched tool saw it open a question. */
export function calledAsk(toolCalls: readonly AgentResponseToolCall[], askOpened: boolean): boolean {
  return askOpened && toolCalls.some((c) => c.tool === ASK_REQUESTER && !c.isError);
}

/** True when this response has a stop_blocked call that did not throw and the watched tool saw it park the run. */
export function calledBlocked(toolCalls: readonly AgentResponseToolCall[], blockOpened: boolean): boolean {
  return blockOpened && toolCalls.some((c) => c.tool === STOP_BLOCKED && !c.isError);
}

const reportsWritten = new Set<RunId>();
const asksOpened = new Set<RunId>();
const blocksOpened = new Set<RunId>();

export function reportWrittenFor(runId: RunId): boolean {
  return reportsWritten.has(runId);
}

/** True when ask_requester opened a question for the run in this process. */
export function askOpenedFor(runId: RunId): boolean {
  return asksOpened.has(runId);
}

/** True when stop_blocked parked the run in this process. */
export function blockOpenedFor(runId: RunId): boolean {
  return blocksOpened.has(runId);
}

/**
 * The verified id chain an answer brings along (answerRun puts it in the
 * signal's attributes), or null for any other delivery or a malformed one.
 */
export function answerChainOf(delivery: unknown): IdChain | null {
  const d = delivery as { kind?: unknown; type?: unknown; attributes?: Readonly<Record<string, string>> } | null | undefined;
  if (d?.kind !== 'signal' || d.type !== INPUT_ANSWER_SIGNAL) return null;
  const raw = d.attributes?.[INPUT_ANSWER_CHAIN_ATTR];
  if (raw === undefined) return null;
  try {
    const parsed = v.safeParse(IdChainSchema, JSON.parse(raw));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function isOkEnvelope(result: unknown): boolean {
  const output = (result as { output?: { status?: unknown } } | null | undefined)?.output;
  return output?.status === 'ok';
}

const ENDING_MARKS: ReadonlyMap<string, Set<RunId>> = new Map([
  [FINISH_REPORT, reportsWritten],
  [ASK_REQUESTER, asksOpened],
  [STOP_BLOCKED, blocksOpened],
]);

/**
 * Wraps the three tools that may end a response: an ok finish_report marks
 * the run's report as written, an ok ask_requester marks a question as
 * opened, an ok stop_blocked marks the run as parked. Other tools pass
 * through.
 */
export function watchFinishReport(runId: RunId, tool: ToolDefinition): ToolDefinition {
  const marks = ENDING_MARKS.get(tool.name);
  if (marks === undefined) return tool;
  const run = tool.run.bind(tool) as (context: never) => unknown;
  return {
    ...tool,
    async run(context: never) {
      const result = await run(context);
      if (isOkEnvelope(result)) marks.add(runId);
      return result;
    },
  } as ToolDefinition;
}

// ------------------------------------------------------------------ state mirrors

export type EvidenceIndexEntry = {
  readonly key: Entity | 'code';
  /** note_evidence calls recorded for the key in this process. */
  readonly notes: number;
  /** Confidence of the latest one. */
  readonly confidence: 'high' | 'medium' | 'low';
};

export type StateMirror = {
  readonly escalation: Escalation;
  readonly evidence_index: EvidenceIndexEntry[];
};

/** What the root copies from escalationFor(runId).snapshot() into persistent state. */
export function mirrorOf(snapshot: Pick<EscalationSnapshot, 'triggered' | 'reasons' | 'findings'>): StateMirror {
  const byKey = new Map<Entity | 'code', { notes: number; confidence: EvidenceIndexEntry['confidence'] }>();
  for (const record of snapshot.findings) {
    const prev = byKey.get(record.entity);
    byKey.set(record.entity, { notes: (prev?.notes ?? 0) + 1, confidence: record.findings.confidence });
  }
  const order: readonly (Entity | 'code')[] = [...ENTITIES, 'code'];
  const evidence_index = order.flatMap((key) => {
    const entry = byKey.get(key);
    return entry === undefined ? [] : [{ key, ...entry }];
  });
  return { escalation: { triggered: snapshot.triggered, reasons: [...snapshot.reasons] }, evidence_index };
}

export function mirrorFor(runId: RunId, init: TriageInit): StateMirror {
  const snapshot = escalationFor(runId).snapshot({
    classification: { money_moved: init.classification.proposed.money_moved },
    tierFinal: init.classification.tier_final,
  });
  return mirrorOf(snapshot);
}

export function sameMirror(a: StateMirror, b: StateMirror): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------------ durability

export type TriageDurability = { readonly timeoutMs: number; readonly maxAttempts: number };

export function durabilityFor(config: Pick<Config, 'budgets'>): TriageDurability {
  return { timeoutMs: config.budgets.runTimeoutMs, maxAttempts: config.budgets.runMaxAttempts };
}

/** The keys.ts defaults of TRIAGE_RUN_TIMEOUT_MS and TRIAGE_RUN_MAX_ATTEMPTS. */
export function defaultDurability(): TriageDurability {
  const num = (key: string): number => Number(KEY_BY_NAME.get(key)?.default);
  return { timeoutMs: num('TRIAGE_RUN_TIMEOUT_MS'), maxAttempts: num('TRIAGE_RUN_MAX_ATTEMPTS') };
}

/**
 * The durability static, computed when the agent module loads. Flue reads it
 * while the agent is not running, so it cannot wait for a render. Without a
 * usable home (vite build, --help) the defaults apply; a broken home still
 * fails loudly at the first render.
 */
export function durabilityAtImport(load: () => Config = () => loadConfig()): TriageDurability {
  try {
    return durabilityFor(load());
  } catch {
    return defaultDurability();
  }
}

// ------------------------------------------------------------------ runtime

export type TriageRuntime = {
  readonly config: Config;
  readonly registry: Registry;
  readonly knowledge: Knowledge;
  readonly runStore: RunStore;
  readonly connectors: ToolConnectors;
  readonly sandbox: SandboxFactory;
  readonly usage: UsageReader;
  /** Missing means finish_report records a gap per repo instead of a commit. */
  readonly repoCommit?: CommitReader;
  /** Audit sink for tool deps. Defaults to the JSONL sink createToolDeps builds. */
  readonly audit?: AuditSink;
  /** Fixtures under cases/<caseId>/ are checked first (evals). */
  readonly caseId?: string;
  readonly now?: () => Date;
};

export type TriageRuntimeOptions = Partial<TriageRuntime> & {
  /** Install the process-wide tripwire on first use. Default true. */
  readonly installTripwire?: boolean;
};

let options: TriageRuntimeOptions = {};
let runtime: TriageRuntime | undefined;
const runDeps = new Map<RunId, ToolDeps>();
const runInterfaces = new Map<RunId, Interface>();

/**
 * Replaces parts of the runtime before the first render (tests, the eval
 * driver). Drops the cached runtime and every cached run's deps.
 */
export function configureTriageRuntime(next: TriageRuntimeOptions = {}): void {
  options = { ...next };
  runtime = undefined;
  runDeps.clear();
  runInterfaces.clear();
}

/** The runtime, built on the first render and cached for the process. */
export function triageRuntime(): TriageRuntime {
  runtime ??= buildRuntime(options);
  return runtime;
}

function buildRuntime(o: TriageRuntimeOptions): TriageRuntime {
  const config = o.config ?? loadConfig();
  const registry = o.registry ?? loadRegistry(config);
  const knowledge = o.knowledge ?? knowledgeFor(config);
  const real = !config.mock.enabled;
  if (o.installTripwire !== false) {
    const audit = createJsonlAuditSink({ auditLogPath: config.paths.auditLog, runsDir: config.paths.runsDir });
    installTripwire(
      tripwireOptionsFor(config, registry, audit, { interfaceOf: (runId) => runInterfaces.get(runId) ?? 'cli' }),
    );
  }
  const repoCommit = o.repoCommit ?? (real ? commitReaderFor({ config, runner: createExecRunner() }) : undefined);
  return Object.freeze({
    config,
    registry,
    knowledge,
    runStore: o.runStore ?? lazyRunStore(config, getRunStore),
    connectors: o.connectors ?? (real ? realConnectors(config, registry) : {}),
    sandbox: o.sandbox ?? sandboxFactory(config),
    usage: o.usage ?? runUsage,
    ...(repoCommit !== undefined ? { repoCommit } : {}),
    ...(o.audit !== undefined ? { audit: o.audit } : {}),
    ...(o.caseId !== undefined ? { caseId: o.caseId } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
  });
}

// The knowledge loaded at boot, or loaded now from TRIAGE_KNOWLEDGE_DIR.
function knowledgeFor(config: Config): Knowledge {
  try {
    return currentKnowledge();
  } catch {
    return loadKnowledge(config.paths.knowledgeDir);
  }
}

/**
 * The real connectors. Built only when mock mode is off; none of them
 * connects or spawns until a tool calls it. cbs_call builds its own per run.
 */
export function realConnectors(config: Config, registry: Registry): ToolConnectors {
  return Object.freeze({
    sql: createSqlConnector({
      registry,
      config,
      // A lost connection is tried again (D57). In local mode the SSFB tunnel
      // is brought back first: it is the part of the path that dies on its
      // own. Other entities are reached directly, so there is nothing to redo.
      reconnect: async (target, signal) => {
        if (target.entity !== 'ssfb') return;
        await runTunnelPreflight({ config, registry, runner: createExecRunner(), tcpProbe: netTcpConnect, isTty: false, signal });
      },
      onRetry: (r) =>
        logRunEvent(r.run_id, 'sql_retry', { entity: r.entity, service: r.service, target_env: r.target_env, attempt: r.attempt, code: r.code }),
    }),
    http: createHttpConnector({ registry, config }),
    quickwit: createQuickwitConnector({ registry, config }),
    codegraph: createCodegraphConnector({ config, runner: createExecRunner() }),
  });
}

/**
 * A RunStore whose methods wait for the real store. The render is synchronous
 * and building the postgres store is not, so the deps hold this handle.
 */
export function lazyRunStore(config: Pick<Config, 'db'>, load: () => Promise<RunStore>): RunStore {
  let pending: Promise<RunStore> | undefined;
  const store = (): Promise<RunStore> => {
    if (pending === undefined) {
      const p = load();
      pending = p;
      p.catch(() => {
        if (pending === p) pending = undefined;
      });
    }
    return pending;
  };
  return Object.freeze({
    provider: config.db.provider === 'postgres' ? 'postgres' : 'folder',
    createRun: async (...a) => (await store()).createRun(...a),
    addSubmission: async (...a) => (await store()).addSubmission(...a),
    setPhase: async (...a) => (await store()).setPhase(...a),
    putClassification: async (...a) => (await store()).putClassification(...a),
    putInputRequest: async (...a) => (await store()).putInputRequest(...a),
    markStopped: async (...a) => (await store()).markStopped(...a),
    resolveInputRequest: async (...a) => (await store()).resolveInputRequest(...a),
    putBlock: async (...a) => (await store()).putBlock(...a),
    resolveBlock: async (...a) => (await store()).resolveBlock(...a),
    putEvidence: async (...a) => (await store()).putEvidence(...a),
    putReport: async (...a) => (await store()).putReport(...a),
    putFeedback: async (...a) => (await store()).putFeedback(...a),
    claimIdempotencyKey: async (...a) => (await store()).claimIdempotencyKey(...a),
    clearExpiredIdempotencyKeys: async () => (await store()).clearExpiredIdempotencyKeys(),
    getRun: async (...a) => (await store()).getRun(...a),
    listRuns: async (...a) => (await store()).listRuns(...a),
    putEmbedding: async (...a) => (await store()).putEmbedding(...a),
    findSimilar: async (...a) => (await store()).findSimilar(...a),
    deleteRun: async (...a) => (await store()).deleteRun(...a),
    listExpired: async (...a) => (await store()).listExpired(...a),
  } satisfies RunStore);
}

/**
 * The run's ToolDeps, built on the first render of the run and returned
 * as the same object afterwards. The triage mount's extra fields are set
 * here: initialData, the UsageReader over runUsage and the CommitReader.
 */
export function runDepsFor(runId: RunId, init: TriageInit, rt: TriageRuntime = triageRuntime(), savedChain?: IdChain): ToolDeps {
  const cached = runDeps.get(runId);
  if (cached !== undefined) return cached;
  runInterfaces.set(runId, init.request.interface);
  // A follow-up in a new process has not seen runSubmission, so the event log learns the names here.
  setRunRedactionNames(runId, init.redaction_names ?? []);
  const deps = createToolDeps({
    runId,
    config: rt.config,
    registry: rt.registry,
    interface: init.request.interface,
    // The chain a previous submission left in persistent state wins over the
    // one ingress resolved at creation: it holds everything added since.
    idChain: savedChain ?? init.id_chain,
    connectors: rt.connectors,
    runStore: rt.runStore,
    redactionNames: init.redaction_names ?? [],
    requestWindow: init.request.window,
    ...(rt.caseId !== undefined ? { caseId: rt.caseId } : {}),
    ...(rt.audit !== undefined ? { audit: rt.audit } : {}),
    ...(rt.now !== undefined ? { now: rt.now } : {}),
    extra: {
      initialData: init,
      usage: rt.usage,
      ...(rt.repoCommit !== undefined ? { repoCommit: rt.repoCommit } : {}),
    },
  });
  runDeps.set(runId, deps);
  return deps;
}

/** The ToolContext of the triage mount: no entity, the run id by closure. */
export function triageToolContext(runId: RunId, deps: ToolDeps, rt: TriageRuntime = triageRuntime()): ToolContext {
  return Object.freeze({ runId, entity: null, config: rt.config, registry: rt.registry, deps });
}

/**
 * Drops the run's in-process state once a response settles: its deps, the
 * escalation store, the connector failure record, the synthesis count, the
 * written-report, opened-question and opened-block marks and the metered
 * usage. Persistent state and the run store keep what matters.
 */
export function settleRun(runId: RunId): void {
  runDeps.delete(runId);
  runInterfaces.delete(runId);
  reportsWritten.delete(runId);
  asksOpened.delete(runId);
  blocksOpened.delete(runId);
  releaseEscalation(runId);
  releaseConnectorFailures(runId);
  releaseFinishReport(runId);
  installedTripwire()?.forgetRun(runId);
}
