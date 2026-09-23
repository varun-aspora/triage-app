// The process-wide tripwire (HLD 02 §2 'Not mounted anywhere', D2, D45).
//
// installTripwire() installs one Flue instrument() under a symbol key:
// - its interceptor denies any tool operation whose name is not on the
//   allowlist (the tools this deployment mounts, the six sandbox tools and
//   Flue's task, activate_skill, read_skill_resource and finish), and any
//   task operation once the run's task budget is spent. Each deny writes
//   one audit line and throws, so the model sees a failed call and the run
//   goes on. It cannot see arguments; the typed tools gate those.
// - its observe() charges each task delegation (task_start) to the run's
//   budget with consumeTask, and sums token usage per model from turn
//   events. runUsage(runId) returns that sum for finish_report's cost.
//
// Flue emits task_start synchronously just before it runs the task
// operation, so the decision made in observe() is the one the interceptor
// enforces. If a task_start was never seen, the interceptor charges the
// task itself, so a delegation is never free.
//
// The run id is the agent instance id: ingress starts each run with
// init(Triage, { id: run_id }).

import {
  type FlueExecutionContext,
  type FlueExecutionOperation,
  type FlueInstrumentation,
  type FlueObservation,
  instrument,
} from '@flue/runtime';
import * as v from 'valibot';
import type { Config } from '../config/env.ts';
import type { Registry } from '../config/registry.ts';
import { COUNT_ONLY_TOOLS, makeAuditLine } from '../gate/audit.ts';
import type { AuditSink } from '../gate/audit-sink.ts';
import {
  BUDGET_EXHAUSTED_MESSAGE,
  type BudgetDecision,
  type BudgetRefusalReason,
  createRunBudget,
  type EntityLimits,
  getRunBudget,
  type RunBudget,
} from '../gate/budget.ts';
import { toolsFor } from '../tools/index.ts';
import type { RunUsage, UsageEntry } from '../tools/finish-report.tool.ts';
import type { ToolContext, ToolDeps } from '../tools/types.ts';
import type { AuditTransport } from '../types/audit.ts';
import { type Entity, type Interface, type RunId, RunIdSchema } from '../types/core.ts';

/** The six tools a Flue sandbox adds (D45). */
export const SANDBOX_TOOL_NAMES: readonly string[] = Object.freeze(['read', 'write', 'edit', 'bash', 'grep', 'glob']);

/** Flue's framework tools the agents use. give_up is not on the list. */
export const FRAMEWORK_TOOL_NAMES: readonly string[] = Object.freeze([
  'task',
  'activate_skill',
  'read_skill_resource',
  'finish',
]);

/** The instrument() key. Symbol.for so a second copy of this module finds the same key. */
export const TRIPWIRE_KEY: symbol = Symbol.for('triage-app.tripwire');

/** Audit target for a tool name outside the allowlist: the setting the allowlist is built from. */
export const ALLOWLIST_TARGET = 'TRIAGE_ENTITIES';

const BUDGET_TARGET: Record<BudgetRefusalReason, string> = {
  tasks: 'TRIAGE_MAX_TASKS_PER_RUN',
  tool_calls: 'TRIAGE_MAX_TOOL_CALLS_PER_RUN',
  bytes: 'TRIAGE_MAX_BYTES_PER_RUN',
  entity_calls: 'TRIAGE_MAX_TASKS_PER_RUN',
};

/** Run id used on audit lines when the operation carries none that fits RunIdSchema. */
export const UNKNOWN_RUN_ID = 'unknown_run';

/** Thrown by the interceptor for a denied operation. The message is what the model sees. */
export class TripwireDeniedError extends Error {
  override readonly name = 'TripwireDeniedError';
  readonly operation: 'tool' | 'task';
  constructor(operation: 'tool' | 'task', message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.operation = operation;
  }
}

// ------------------------------------------------------------ allowlist

export type AllowlistContext = {
  readonly config: Config;
  readonly registry: Registry;
};

// create() and enabled() must not read deps (CONVENTIONS.md), so a deps
// object that throws on any read is enough to build the tool sets.
const NO_DEPS = new Proxy(Object.create(null) as object, {
  get(_t, key) {
    throw new Error(`tool deps read (${String(key)}) while building the tripwire allowlist`);
  },
}) as ToolDeps;

/**
 * Every tool name any agent in this deployment can call: the triage mount,
 * investigator_deep (which includes investigator) for each entity in
 * TRIAGE_ENTITIES, code_walker, the six sandbox tools and Flue's framework
 * tools. Sorted and unique.
 */
export function allowedToolNames(ctx: AllowlistContext): readonly string[] {
  const base = { runId: 'tripwire_allowlist', config: ctx.config, registry: ctx.registry, deps: NO_DEPS };
  const at = (entity: Entity | null): ToolContext => ({ ...base, entity });
  const names = new Set<string>([...SANDBOX_TOOL_NAMES, ...FRAMEWORK_TOOL_NAMES]);
  const add = (tools: readonly { name: string }[]): void => tools.forEach((t) => names.add(t.name));
  add(toolsFor('triage', at(null)));
  for (const entity of ctx.registry.enabledEntities()) add(toolsFor('investigator_deep', at(entity)));
  add(toolsFor('code_walker', at(null)));
  return Object.freeze([...names].sort());
}

// ------------------------------------------------------------ budgets

/** Returns the run's budget, creating it when this is the first use. */
export type BudgetSource = (runId: RunId) => RunBudget;

/**
 * The budget source for a deployment: the run's registered budget, or a new
 * one with the same limits createToolDeps would use. Whichever of the two
 * runs first creates it; the other finds it registered.
 */
export function runBudgetSource(config: Config, registry?: Registry): BudgetSource {
  return (runId) => {
    const existing = getRunBudget(runId);
    if (existing !== undefined) return existing;
    const perEntity: Partial<Record<Entity, EntityLimits>> = {};
    for (const entity of registry?.entities ?? []) {
      if (!config.entities.includes(entity)) continue;
      const qw = registry?.quickwit(entity);
      if (qw?.status === 'ok') perEntity[entity] = { maxHits: qw.maxHits };
    }
    const { budgets, sql } = config;
    return createRunBudget({
      runId,
      maxToolCalls: budgets.maxToolCallsPerRun,
      maxTasks: budgets.maxTasksPerRun,
      maxRowsPerCall: sql.maxRows,
      maxBytesPerCall: budgets.maxResponseBytesPerCall,
      maxBytesPerRun: budgets.maxBytesPerRun,
      perEntity,
    });
  };
}

// ------------------------------------------------------------ usage

type MutableUsage = { input_tokens: number; output_tokens: number; calls: number };

const usageByRun = new Map<string, Map<string, MutableUsage>>();

/** Summed input and output tokens per model ('provider/model') for one run. Empty when none was seen. */
export function runUsage(runId: RunId): RunUsage {
  const perModel = usageByRun.get(runId);
  const out: Record<string, UsageEntry> = {};
  for (const [model, u] of perModel ?? []) out[model] = Object.freeze({ ...u });
  return Object.freeze(out);
}

function addUsage(runId: string, model: string, input: number, output: number): void {
  let perModel = usageByRun.get(runId);
  if (perModel === undefined) usageByRun.set(runId, (perModel = new Map()));
  const u = perModel.get(model) ?? { input_tokens: 0, output_tokens: 0, calls: 0 };
  u.input_tokens += count(input);
  u.output_tokens += count(output);
  u.calls += 1;
  perModel.set(model, u);
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

// ------------------------------------------------------------ the tripwire

export type TripwireOptions = {
  readonly audit: AuditSink;
  readonly budget: BudgetSource;
  /** Tool names that may run. Use allowedToolNames(). */
  readonly allowed: Iterable<string>;
  /** transport on deny lines: 'mock' in mock mode, so the eval gate sees every line as mock. */
  readonly transport: AuditTransport;
  /** The run's interface for audit lines. Defaults to 'cli'. */
  readonly interfaceOf?: (runId: RunId) => Interface;
  readonly now?: () => Date;
};

/** Options for a deployment: the allowlist, budgets and transport come from config. */
export function tripwireOptionsFor(
  config: Config,
  registry: Registry,
  audit: AuditSink,
  extra: Pick<TripwireOptions, 'interfaceOf' | 'now'> = {},
): TripwireOptions {
  return {
    audit,
    budget: runBudgetSource(config, registry),
    allowed: allowedToolNames({ config, registry }),
    transport: config.mock.enabled ? 'mock' : 'real',
    ...extra,
  };
}

export type Tripwire = FlueInstrumentation & {
  readonly key: symbol;
  /** Whether a tool name passes. */
  allows(toolName: string): boolean;
  /** Drops this tripwire's pending task decisions and the usage for a finished run. */
  forgetRun(runId: RunId): void;
};

function runIdOf(id: string | undefined): RunId {
  return id !== undefined && v.is(RunIdSchema, id) ? id : UNKNOWN_RUN_ID;
}

/** A tool name as it goes on the audit line: kept as is when it is a plain token, quoted otherwise. */
function auditToolName(name: string): string {
  if (/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) return name;
  const quoted = JSON.stringify(name);
  return quoted.length > 80 ? `${quoted.slice(0, 77)}..."` : quoted;
}

/** Builds the instrumentation without installing it. installTripwire() installs it. */
export function createTripwire(options: TripwireOptions): Tripwire {
  const allowed = new Set(options.allowed);
  const now = options.now ?? (() => new Date());
  const interfaceOf = options.interfaceOf ?? (() => 'cli' as const);
  // taskId -> the budget decision made when the task started.
  const taskDecisions = new Map<string, { runId: RunId; decision: BudgetDecision }>();

  const consume = (runId: RunId): BudgetDecision => {
    try {
      return options.budget(runId).consumeTask();
    } catch {
      // No budget can be built for this run (for example an invalid id): refuse.
      return { ok: false, message: BUDGET_EXHAUSTED_MESSAGE, reason: 'tasks' };
    }
  };

  /** Writes the deny audit line and returns the error to throw. The error is returned even if the write fails. */
  const denial = (
    operation: 'tool' | 'task',
    runId: RunId,
    fields: { tool: string; target: string; summary: string; reason: string },
    message: string,
  ): TripwireDeniedError => {
    try {
      options.audit.write(
        makeAuditLine({
          run_id: runId,
          ts: now().toISOString(),
          interface: interfaceOf(runId),
          entity: null,
          tool: fields.tool,
          decision: 'deny',
          reason: fields.reason,
          service: 'tripwire',
          target: fields.target,
          transport: options.transport,
          summary: fields.summary,
          duration_ms: 0,
          exit: 'refused',
          // Count-only tools must carry a count; a refused call handled none.
          ...(COUNT_ONLY_TOOLS.has(fields.tool) ? { count: 0 } : {}),
        }),
      );
    } catch (cause) {
      return new TripwireDeniedError(operation, message, { cause });
    }
    return new TripwireDeniedError(operation, message);
  };

  const observe = (event: FlueObservation, ctx: { id?: string }): void => {
    if (event.type === 'task_start') {
      const runId = runIdOf(event.instanceId ?? ctx.id);
      taskDecisions.set(event.taskId, { runId, decision: consume(runId) });
      return;
    }
    if (event.type === 'turn') {
      const usage = event.response.usage;
      if (usage === undefined) return;
      const runId = event.instanceId ?? ctx.id;
      if (runId === undefined) return;
      addUsage(runId, `${event.request.providerId}/${event.request.requestedModel}`, usage.input, usage.output);
    }
  };

  const interceptor = async <T>(
    operation: FlueExecutionOperation,
    ctx: FlueExecutionContext,
    next: () => Promise<T>,
  ): Promise<T> => {
    if (operation.type === 'tool' && !allowed.has(operation.toolName)) {
      const tool = auditToolName(operation.toolName);
      throw denial(
        'tool',
        runIdOf(ctx.instanceId),
        {
          tool,
          target: ALLOWLIST_TARGET,
          summary: `tripwire: tool ${tool} is not on the allowlist`,
          reason: 'tool name not on the tripwire allowlist',
        },
        `tool ${tool} is not available here; use the tools you were given`,
      );
    }
    if (operation.type === 'task') {
      const recorded = taskDecisions.get(operation.taskId);
      taskDecisions.delete(operation.taskId);
      const runId = recorded?.runId ?? runIdOf(ctx.instanceId);
      const decision = recorded?.decision ?? consume(runId);
      if (!decision.ok) {
        throw denial(
          'task',
          runId,
          {
            tool: 'task',
            target: BUDGET_TARGET[decision.reason],
            summary: `tripwire: task delegation refused (${decision.reason})`,
            reason: `run budget exhausted: ${decision.reason}`,
          },
          decision.message,
        );
      }
    }
    return next();
  };

  return {
    key: TRIPWIRE_KEY,
    observe,
    interceptor,
    dispose() {
      taskDecisions.clear();
    },
    allows: (toolName) => allowed.has(toolName),
    forgetRun(runId) {
      usageByRun.delete(runId);
      for (const [taskId, d] of taskDecisions) if (d.runId === runId) taskDecisions.delete(taskId);
    },
  };
}

// ------------------------------------------------------------ install

type Installed = { readonly tripwire: Tripwire; readonly dispose: () => Promise<void> };

let installed: Installed | undefined;

export type InstallDeps = {
  /** Flue's instrument(). Tests pass a counting stand-in. */
  readonly instrument?: (instrumentation: FlueInstrumentation) => () => Promise<void>;
};

/**
 * Installs the tripwire once per process. A second call returns the first
 * install and ignores its options; it never installs again.
 */
export function installTripwire(options: TripwireOptions, deps: InstallDeps = {}): Installed {
  if (installed !== undefined) return installed;
  const tripwire = createTripwire(options);
  const disposeFlue = (deps.instrument ?? instrument)(tripwire);
  const current: Installed = {
    tripwire,
    dispose: async () => {
      if (installed === current) installed = undefined;
      await disposeFlue();
    },
  };
  installed = current;
  return current;
}

/** The installed tripwire, if any. */
export function installedTripwire(): Tripwire | undefined {
  return installed?.tripwire;
}
