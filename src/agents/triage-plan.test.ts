import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentResponseToolCall, SandboxFactory } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { ConfigError } from '../config/errors.ts';
import type { RunStore } from '../runstore/types.ts';
import { mergeIdChains, widenIdChain } from '../tools/_lib/context.ts';
import { ASK_REQUESTER } from '../tools/ask-requester.tool.ts';
import { FINISH_REPORT, synthesisPassesFor } from '../tools/finish-report.tool.ts';
import { toolsFor } from '../tools/index.ts';
import { type TriageInit, TriageInitSchema } from '../types/classification.ts';
import { ENTITIES, type Entity, type Tier } from '../types/core.ts';
import type { IdChain } from '../types/id-chain.ts';
import { INPUT_ANSWER_CHAIN_ATTR, INPUT_ANSWER_SIGNAL } from '../types/input-request.ts';
import { makeTestHome, REPO_ROOT, type TestHome } from '../../test/support/home.ts';
import { escalationFor } from './escalation.ts';
import { rootAgents } from './index.ts';
import { type Knowledge, loadKnowledge } from './skills.ts';
import {
  answerChainOf,
  askOpenedFor,
  calledAsk,
  calledFinish,
  configureTriageRuntime,
  defaultDurability,
  durabilityAtImport,
  durabilityFor,
  enabledEntitiesFor,
  focusEntitiesFor,
  FINISH_REQUIRED_SIGNAL,
  finishDecision,
  FinishRequiredError,
  lazyRunStore,
  MAX_FINISH_SIGNALS,
  mirrorOf,
  planState,
  reportWrittenFor,
  runDepsFor,
  sameMirror,
  settleRun,
  TRIAGE_AGENT_NAME,
  triagePlan,
  triageRuntime,
  triageToolContext,
  watchFinishReport,
} from './triage-plan.ts';
import { runUsage } from './tripwire.ts';

// Model specs are pi-ai built-ins, so modelForTier accepts them without a
// registered provider. No model is called in this file.
const MODELS = {
  MODEL_TIER_CHEAP: 'anthropic/claude-haiku-4-5',
  MODEL_TIER_MID: 'anthropic/claude-sonnet-4-5',
  MODEL_TIER_STRONG: 'anthropic/claude-opus-4-1',
  MODEL_THINKING_CHEAP: 'off',
  MODEL_THINKING_MID: 'low',
  MODEL_THINKING_STRONG: 'high',
};

const AGENT_FILE = fileURLToPath(new URL('./triage.agent.ts', import.meta.url));
const PLAN_FILE = fileURLToPath(new URL('./triage-plan.ts', import.meta.url));

let knowledge: Knowledge;
const homes: TestHome[] = [];

function home(entities?: readonly Entity[], overrides: Record<string, string> = {}): TestHome {
  const h = makeTestHome({ overrides: { ...MODELS, ...overrides }, ...(entities ? { entities } : {}) });
  homes.push(h);
  return h;
}

let runSeq = 0;
function nextRunId(): string {
  runSeq += 1;
  return `run_triage_plan_${runSeq}`;
}

// All values are synthetic.
function init(opts: { tier?: Tier; hints?: readonly Entity[]; moneyMoved?: boolean; runId?: string } = {}): TriageInit {
  return v.parse(TriageInitSchema, {
    request: {
      request_id: opts.runId ?? 'run_triage_plan_0',
      interface: 'cli',
      requested_by: 'ops@example.test',
      source: { kind: 'text' },
      messages: [{ ts: '1726826400.000100', author: 'U000TEST', text: 'transfer not received', is_parent: true }],
      attachments: [],
      hints: opts.hints === undefined ? {} : { entities: [...opts.hints] },
      window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-23T00:00:00.000Z' },
      received_at: '2026-09-23T10:00:00.000Z',
    },
    classification: {
      proposed: {
        category: 'unknown',
        subcategory: 'test',
        entities_likely: [],
        current_ask: 'Where is the transfer?',
        money_moved: opts.moneyMoved ?? false,
        misdirected_funds: false,
        tier_proposed: opts.tier ?? 'mid',
        confidence: 0.7,
        missing_info: [],
        images_seen: false,
      },
      tier_final: opts.tier ?? 'mid',
      rule_fired: 'rule_test',
    },
    id_chain: { ids: { customer_id: 'cust-test-1' }, hops: [], basic_state: [] },
  });
}

function fakeStore(): RunStore & { calls: string[] } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (..._args: unknown[]): Promise<never> => {
      calls.push(name);
      return undefined as never;
    };
  const store = {
    provider: 'folder' as const,
    calls,
    createRun: record('createRun'),
    addSubmission: record('addSubmission'),
    setPhase: record('setPhase'),
    putClassification: record('putClassification'),
    putInputRequest: record('putInputRequest'),
    resolveInputRequest: record('resolveInputRequest'),
    putEvidence: record('putEvidence'),
    putReport: record('putReport'),
    putFeedback: record('putFeedback'),
    claimIdempotencyKey: record('claimIdempotencyKey'),
    clearExpiredIdempotencyKeys: record('clearExpiredIdempotencyKeys'),
    getRun: record('getRun'),
    listRuns: record('listRuns'),
    putEmbedding: record('putEmbedding'),
    findSimilar: record('findSimilar'),
    deleteRun: record('deleteRun'),
    listExpired: record('listExpired'),
  };
  return store;
}

const noSandbox: SandboxFactory = {
  createSandbox: () => {
    throw new Error('no sandbox in unit tests');
  },
};

function useTestRuntime(h: TestHome): void {
  configureTriageRuntime({
    config: h.config,
    registry: h.registry,
    knowledge,
    runStore: fakeStore(),
    sandbox: noSandbox,
    installTripwire: false,
  });
}

beforeAll(() => {
  knowledge = loadKnowledge(join(REPO_ROOT, 'knowledge'));
});

afterEach(() => {
  configureTriageRuntime();
});

afterAll(() => {
  for (const h of homes) h.cleanup();
});

// ------------------------------------------------------------------ plan

describe('triagePlan: model and thinking', () => {
  const cases: [Tier, string, string][] = [
    ['cheap', MODELS.MODEL_TIER_CHEAP, 'off'],
    ['mid', MODELS.MODEL_TIER_MID, 'low'],
    ['strong', MODELS.MODEL_TIER_STRONG, 'high'],
  ];
  for (const [tier, model, thinking] of cases) {
    test(`tier ${tier} uses modelForTier(${tier}) with thinking ${thinking}`, () => {
      const h = home();
      const plan = triagePlan(init({ tier }), h.config, h.registry);
      expect(plan.tier).toBe(tier);
      expect(plan.model).toBe(model);
      expect(plan.thinkingLevel).toBe(thinking as typeof plan.thinkingLevel);
    });
  }

  test('the tier is tier_final, not the classifier proposal', () => {
    const h = home();
    const data = init({ tier: 'strong' });
    data.classification.proposed.tier_proposed = 'cheap';
    expect(triagePlan(data, h.config, h.registry).model).toBe(MODELS.MODEL_TIER_STRONG);
  });

  test('a blank tier model is refused with a ConfigError naming the key', () => {
    const h = home(undefined, { MODEL_TIER_MID: '' });
    expect(() => triagePlan(init({ tier: 'mid' }), h.config, h.registry)).toThrow(ConfigError);
    expect(() => triagePlan(init({ tier: 'mid' }), h.config, h.registry)).toThrow(/MODEL_TIER_MID/);
  });

  test('an openrouter tier model is refused', () => {
    const h = home(undefined, { MODEL_TIER_CHEAP: 'openrouter/some-model' });
    expect(() => triagePlan(init({ tier: 'cheap' }), h.config, h.registry)).toThrow(/openrouter/);
  });
});

describe('triagePlan: entities, delegates and skills', () => {
  test('hints.entities=[atspl] still mounts every enabled entity, with atspl as the focus', () => {
    const h = home();
    const plan = triagePlan(init({ hints: ['atspl'] }), h.config, h.registry);
    expect(plan.entities).toEqual(['ssfb', 'atspl', 'rtl']);
    expect(plan.focus).toEqual(['atspl']);
    expect(plan.delegates).toEqual([
      'investigate_ssfb',
      'investigate_ssfb_deep',
      'investigate_atspl',
      'investigate_atspl_deep',
      'investigate_rtl',
      'investigate_rtl_deep',
      'code_walker',
    ]);
    expect(plan.skills).toEqual(['ssfb-overview', 'atspl-overview', 'rtl-overview', 'patterns', 'frontend-routing']);
  });

  test('a hint for an entity outside TRIAGE_ENTITIES adds nothing', () => {
    const h = home(['ssfb', 'atspl']);
    const onlyOutside = triagePlan(init({ hints: ['rtl'] }), h.config, h.registry);
    expect(onlyOutside.entities).toEqual(['ssfb', 'atspl']);
    expect(onlyOutside.focus).toEqual([]);
    expect(onlyOutside.delegates).not.toContain('investigate_rtl');
    expect(onlyOutside.skills).not.toContain('rtl-overview');

    const mixed = triagePlan(init({ hints: ['atspl', 'rtl'] }), h.config, h.registry);
    expect(mixed.focus).toEqual(['atspl']);
    expect(mixed.delegates).not.toContain('investigate_rtl_deep');
  });

  test('no hints, or an empty list, means every enabled entity and no focus', () => {
    const h = home(['ssfb', 'rtl']);
    for (const data of [init(), init({ hints: [] })]) {
      const plan = triagePlan(data, h.config, h.registry);
      expect(plan.entities).toEqual(['ssfb', 'rtl']);
      expect(plan.focus).toEqual([]);
      expect(plan.delegates).toEqual([
        'investigate_ssfb',
        'investigate_ssfb_deep',
        'investigate_rtl',
        'investigate_rtl_deep',
        'code_walker',
      ]);
      expect(plan.skills).toEqual(['ssfb-overview', 'rtl-overview', 'patterns', 'frontend-routing']);
    }
  });

  test('hints never change what is mounted, and the focus is always inside it', () => {
    const subsets = (all: readonly Entity[]): Entity[][] =>
      all.reduce<Entity[][]>((acc, e) => [...acc, ...acc.map((s) => [...s, e])], [[]]);
    for (const enabled of subsets(ENTITIES).filter((s) => s.length > 0)) {
      const h = home(enabled);
      const mounted = enabledEntitiesFor(h.config, h.registry);
      expect([...mounted]).toEqual(ENTITIES.filter((e) => enabled.includes(e)));
      for (const hints of subsets(ENTITIES)) {
        const plan = triagePlan(init({ hints }), h.config, h.registry);
        expect(plan.entities).toEqual(mounted);
        expect([...focusEntitiesFor(init({ hints }), mounted, h.registry)]).toEqual(
          ENTITIES.filter((e) => enabled.includes(e) && hints.includes(e)),
        );
      }
    }
  });

  test('delegate names are unique and every planned skill exists in knowledge/', () => {
    const h = home();
    const plan = triagePlan(init(), h.config, h.registry);
    expect(new Set(plan.delegates).size).toBe(plan.delegates.length);
    for (const name of plan.skills) expect(knowledge.skills.has(name)).toBe(true);
  });

  test('planState is plain JSON', () => {
    const h = home();
    const state = planState(triagePlan(init({ hints: ['ssfb'] }), h.config, h.registry));
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state.entities).toEqual(['ssfb', 'atspl', 'rtl']);
    expect(state.focus).toEqual(['ssfb']);
  });
});

// ------------------------------------------------------------------ mount and deps

describe('the triage mount', () => {
  test('toolsFor(triage) holds ask_requester, resolve_identity, note_evidence and finish_report only', () => {
    const h = home();
    useTestRuntime(h);
    const runId = nextRunId();
    const deps = runDepsFor(runId, init({ runId }));
    const names = toolsFor('triage', triageToolContext(runId, deps)).map((t) => t.name).sort();
    expect(names).toEqual(['ask_requester', 'finish_report', 'note_evidence', 'resolve_identity']);
    for (const io of ['sql_select', 'http_call', 'logs_search']) expect(names).not.toContain(io);
    settleRun(runId);
  });

  test('the deps carry initialData and a UsageReader backed by runUsage', async () => {
    const h = home();
    useTestRuntime(h);
    const runId = nextRunId();
    const data = init({ runId });
    const deps = runDepsFor(runId, data);
    expect(deps.initialData).toBe(data);
    expect(deps.usage).toBe(runUsage);
    expect(await deps.usage?.(runId)).toEqual(runUsage(runId));
    expect(deps.run.interface).toBe('cli');
    expect(deps.run.window).toEqual(data.request.window);
    // Mock mode: no real connectors and no commit reader are built.
    expect(deps.connectors).toEqual({});
    expect(deps.repoCommit).toBeUndefined();
    settleRun(runId);
  });

  test('the same deps object is returned on every render, so a widened chain survives', () => {
    const h = home();
    useTestRuntime(h);
    const runId = nextRunId();
    const data = init({ runId });
    const first = runDepsFor(runId, data);
    widenIdChain(first, { ...data.id_chain, ids: { ...data.id_chain.ids, account_id: 'acct-test-9' } });
    const second = runDepsFor(runId, data);
    expect(second).toBe(first);
    expect(second.idChain().ids.account_id).toBe('acct-test-9');
    settleRun(runId);
    expect(runDepsFor(runId, data)).not.toBe(first);
    settleRun(runId);
  });

  test('the runtime is built once and uses the given parts', () => {
    const h = home();
    useTestRuntime(h);
    const rt = triageRuntime();
    expect(triageRuntime()).toBe(rt);
    expect(rt.config).toBe(h.config);
    expect(rt.sandbox).toBe(noSandbox);
    expect(rt.usage).toBe(runUsage);
  });
});

// ------------------------------------------------------------------ finish

describe('finishDecision', () => {
  test('a written report ends the response and resets the count', () => {
    expect(finishDecision(0, true)).toEqual({ kind: 'done', retries: 0 });
    expect(finishDecision(1, true)).toEqual({ kind: 'done', retries: 0 });
  });

  test('the first miss signals, the second miss fails', () => {
    expect(MAX_FINISH_SIGNALS).toBe(1);
    expect(finishDecision(0, false)).toEqual({ kind: 'signal', retries: 1 });
    expect(finishDecision(1, false)).toEqual({ kind: 'fail', retries: 1 });
    expect(finishDecision(5, false).kind).toBe('fail');
  });

  test('a bad stored count counts as zero', () => {
    for (const bad of [-1, Number.NaN, 0.5]) expect(finishDecision(bad, false)).toEqual({ kind: 'signal', retries: 1 });
  });

  test('sequence: the model never finishes, so one signal is appended, then the hook throws', () => {
    let retries = 0;
    const appended: string[] = [];
    const finish = (): void => {
      const step = finishDecision(retries, false);
      if (step.kind === 'signal') {
        retries = step.retries;
        appended.push(FINISH_REQUIRED_SIGNAL);
        return;
      }
      if (step.kind === 'fail') throw new FinishRequiredError();
    };
    finish();
    expect(appended).toEqual(['triage.finish_required']);
    expect(finish).toThrow(FinishRequiredError);
    expect(appended).toHaveLength(1);
  });

  test('sequence: a miss then a written report settles with no second signal', () => {
    const first = finishDecision(0, false);
    expect(first.kind).toBe('signal');
    expect(finishDecision(first.retries, true)).toEqual({ kind: 'done', retries: 0 });
  });
});

describe('calledFinish and watchFinishReport', () => {
  const call = (tool: string, isError = false): AgentResponseToolCall => ({ tool, isError });

  test('needs a finish_report call that did not throw and a written report', () => {
    expect(calledFinish([call(FINISH_REPORT)], true)).toBe(true);
    expect(calledFinish([call(FINISH_REPORT)], false)).toBe(false);
    expect(calledFinish([call(FINISH_REPORT, true)], true)).toBe(false);
    expect(calledFinish([call('note_evidence'), call('task')], true)).toBe(false);
    expect(calledFinish([], true)).toBe(false);
  });

  function fakeTool(name: string, status: string): ToolDefinition {
    return {
      name,
      description: 'test tool',
      input: v.object({}),
      output: undefined,
      run: async () => ({ output: { status, taken_at: '2026-09-23T10:00:00.000Z' } }),
    } as unknown as ToolDefinition;
  }

  test('an ok finish_report result marks the report as written', async () => {
    const runId = nextRunId();
    const tool = watchFinishReport(runId, fakeTool(FINISH_REPORT, 'ok'));
    expect(reportWrittenFor(runId)).toBe(false);
    const result = await tool.run({} as never);
    expect(result).toEqual({ output: { status: 'ok', taken_at: '2026-09-23T10:00:00.000Z' } });
    expect(reportWrittenFor(runId)).toBe(true);
    settleRun(runId);
    expect(reportWrittenFor(runId)).toBe(false);
  });

  test('a refused finish_report result does not count as written', async () => {
    const runId = nextRunId();
    const tool = watchFinishReport(runId, fakeTool(FINISH_REPORT, 'refused'));
    await tool.run({} as never);
    expect(reportWrittenFor(runId)).toBe(false);
    expect(calledFinish([call(FINISH_REPORT)], reportWrittenFor(runId))).toBe(false);
  });

  test('a throwing finish_report leaves the report unwritten', async () => {
    const runId = nextRunId();
    const failing = { ...fakeTool(FINISH_REPORT, 'ok'), run: async () => Promise.reject(new Error('boom')) };
    const tool = watchFinishReport(runId, failing as ToolDefinition);
    await expect(tool.run({} as never)).rejects.toThrow('boom');
    expect(reportWrittenFor(runId)).toBe(false);
  });

  test('other tools are returned unchanged', () => {
    const other = fakeTool('note_evidence', 'ok');
    expect(watchFinishReport(nextRunId(), other)).toBe(other);
  });

  test('the wrapped tool keeps name, schema and harness flag', () => {
    const base = { ...fakeTool(FINISH_REPORT, 'ok'), harness: true } as ToolDefinition;
    const wrapped = watchFinishReport(nextRunId(), base);
    expect(wrapped.name).toBe(FINISH_REPORT);
    expect(wrapped.input).toBe(base.input);
    expect(wrapped.harness).toBe(true);
  });
});

// ------------------------------------------------------------------ mirrors and settle

describe('state mirrors', () => {
  const findings = (confidence: 'high' | 'medium' | 'low') => ({
    evidence: [],
    timeline: [],
    hypotheses: [],
    confidence,
    gaps: [],
  });

  test('evidence_index counts notes per key in a fixed order with the latest confidence', () => {
    const mirror = mirrorOf({
      triggered: true,
      reasons: ['low_confidence'],
      findings: [
        { entity: 'code', findings: { claims: [], confidence: 'medium' } },
        { entity: 'rtl', findings: findings('low') },
        { entity: 'ssfb', findings: findings('medium') },
        { entity: 'ssfb', findings: findings('high') },
      ],
    });
    expect(mirror.escalation).toEqual({ triggered: true, reasons: ['low_confidence'] });
    expect(mirror.evidence_index).toEqual([
      { key: 'ssfb', notes: 2, confidence: 'high' },
      { key: 'rtl', notes: 1, confidence: 'low' },
      { key: 'code', notes: 1, confidence: 'medium' },
    ]);
    expect(JSON.parse(JSON.stringify(mirror))).toEqual(mirror);
  });

  test('an empty run mirrors to the persistent state defaults', () => {
    const mirror = mirrorOf({ triggered: false, reasons: [], findings: [] });
    expect(sameMirror(mirror, { escalation: { triggered: false, reasons: [] }, evidence_index: [] })).toBe(true);
  });

  test('settleRun drops the escalation store and the synthesis count', () => {
    const runId = nextRunId();
    escalationFor(runId).record({ entity: 'atspl', findings: findings('low') });
    expect(escalationFor(runId).snapshot().findings).toHaveLength(1);
    settleRun(runId);
    expect(escalationFor(runId).snapshot().findings).toHaveLength(0);
    expect(synthesisPassesFor(runId)).toBe(0);
    settleRun(runId);
  });
});

// ------------------------------------------------------------------ durability

describe('durability', () => {
  test('follows TRIAGE_RUN_TIMEOUT_MS and TRIAGE_RUN_MAX_ATTEMPTS', () => {
    const h = home(undefined, { TRIAGE_RUN_TIMEOUT_MS: '123000', TRIAGE_RUN_MAX_ATTEMPTS: '3' });
    expect(durabilityFor(h.config)).toEqual({ timeoutMs: 123000, maxAttempts: 3 });
    expect(durabilityAtImport(() => h.config)).toEqual({ timeoutMs: 123000, maxAttempts: 3 });
  });

  test('falls back to the keys.ts defaults when config cannot load', () => {
    expect(defaultDurability()).toEqual({ timeoutMs: 900000, maxAttempts: 2 });
    const failing = (): never => {
      throw ConfigError.of('TRIAGE_HOME', 'is not set; export it in the shell');
    };
    expect(durabilityAtImport(failing)).toEqual(defaultDurability());
  });
});

// ------------------------------------------------------------------ lazy run store

describe('lazyRunStore', () => {
  test('loads the store once and forwards calls', async () => {
    const inner = fakeStore();
    let loads = 0;
    const store = lazyRunStore({ db: { provider: 'sqlite', url: ':memory:' } }, async () => {
      loads += 1;
      return inner;
    });
    expect(store.provider).toBe('folder');
    expect(loads).toBe(0);
    await store.getRun('run_x');
    await store.putEvidence('run_x', 'ssfb', {} as never);
    expect(loads).toBe(1);
    expect(inner.calls).toEqual(['getRun', 'putEvidence']);
  });

  test('a failed load is not kept, so the next call tries again', async () => {
    const inner = fakeStore();
    let loads = 0;
    const store = lazyRunStore({ db: { provider: 'postgres', url: 'postgresql://x/y' } }, async () => {
      loads += 1;
      if (loads === 1) throw new Error('store not ready');
      return inner;
    });
    expect(store.provider).toBe('postgres');
    await expect(store.getRun('run_x')).rejects.toThrow('store not ready');
    await store.getRun('run_x');
    expect(loads).toBe(2);
  });
});

// ------------------------------------------------------------------ static checks

describe('triage.agent.ts', () => {
  const source = readFileSync(AGENT_FILE, 'utf8');

  test("'use agent' is the first statement", () => {
    expect(source.startsWith("'use agent';\n")).toBe(true);
  });

  test('reads neither the deploy mode nor the env label', () => {
    for (const file of [AGENT_FILE, PLAN_FILE]) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('TRIAGE_DEPLOY_MODE');
      expect(text).not.toContain('TRIAGE_ENV_LABEL');
      expect(text).not.toMatch(/deployModeForPreflight|envLabel/);
    }
  });

  test('calls useModel and useSandbox exactly once, and mounts toolsFor(triage)', () => {
    expect(source.match(/\buseModel\(/g)).toHaveLength(1);
    expect(source.match(/\buseSandbox\(/g)).toHaveLength(1);
    expect(source).toContain("toolsFor('triage'");
    for (const io of ['sql_select', 'http_call', 'logs_search']) expect(source).not.toContain(io);
  });

  test('src files use no Bun APIs', () => {
    for (const file of [AGENT_FILE, PLAN_FILE]) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/\bBun\.|from ['"]bun:/);
    }
  });

  test('exports rootAgent with the pinned name, the TriageInit schema and durability', async () => {
    const mod = await import('./triage.agent.ts');
    expect(mod.rootAgent).toBe(mod.Triage);
    expect(mod.Triage.agentName).toBe(TRIAGE_AGENT_NAME);
    expect(mod.Triage.initialData).toBe(TriageInitSchema);
    const { timeoutMs, maxAttempts } = mod.Triage.durability;
    expect(Number.isInteger(timeoutMs) && timeoutMs > 0).toBe(true);
    expect(Number.isInteger(maxAttempts) && maxAttempts > 0).toBe(true);
    // The agentName literal in the file matches the constant.
    expect(source).toContain(`Triage.agentName = '${TRIAGE_AGENT_NAME}';`);
  });

  test('the generated agent list contains it', async () => {
    const mod = await import('./triage.agent.ts');
    expect(rootAgents).toContain(mod.Triage);
  });

  test('the only capitalized export is the agent function', async () => {
    const mod = await import('./triage.agent.ts');
    const capitalized = Object.keys(mod).filter((k) => /^[A-Z]/.test(k));
    expect(capitalized).toEqual(['Triage']);
  });
});

// ------------------------------------------------------------------ ask_requester and the answer

describe('ask_requester as a valid end of a response', () => {
  const call = (tool: string, isError = false): AgentResponseToolCall => ({ tool, isError });

  function stopTool(name: string, status: string): ToolDefinition {
    return {
      name,
      description: 'test tool',
      input: v.object({}),
      output: undefined,
      run: async () => ({ output: { status, taken_at: '2026-09-23T10:00:00.000Z' } }),
    } as unknown as ToolDefinition;
  }

  test('finishDecision is done when a question was opened, and the count resets', () => {
    expect(finishDecision(0, false, true)).toEqual({ kind: 'done', retries: 0 });
    expect(finishDecision(1, false, true)).toEqual({ kind: 'done', retries: 0 });
    expect(finishDecision(0, true, true)).toEqual({ kind: 'done', retries: 0 });
    expect(finishDecision(0, false, false)).toEqual({ kind: 'signal', retries: 1 });
    expect(finishDecision(1, false)).toEqual({ kind: 'fail', retries: 1 });
  });

  test('calledAsk needs an ok ask_requester call that the watched tool saw open a question', async () => {
    const runId = nextRunId();
    expect(calledAsk([call(ASK_REQUESTER)], false)).toBe(false);
    expect(calledAsk([call(ASK_REQUESTER, true)], true)).toBe(false);
    expect(calledAsk([call('task'), call(FINISH_REPORT)], true)).toBe(false);

    const tool = watchFinishReport(runId, stopTool(ASK_REQUESTER, 'ok'));
    expect(askOpenedFor(runId)).toBe(false);
    await tool.run({} as never);
    expect(askOpenedFor(runId)).toBe(true);
    expect(calledAsk([call(ASK_REQUESTER)], askOpenedFor(runId))).toBe(true);
    // The two marks are separate: an opened question is not a written report.
    expect(reportWrittenFor(runId)).toBe(false);
    settleRun(runId);
    expect(askOpenedFor(runId)).toBe(false);
  });

  test('a refused or throwing ask_requester does not count, and other tools pass through unwrapped', async () => {
    const runId = nextRunId();
    await watchFinishReport(runId, stopTool(ASK_REQUESTER, 'refused')).run({} as never);
    expect(askOpenedFor(runId)).toBe(false);
    const failing = { ...stopTool(ASK_REQUESTER, 'ok'), run: async () => Promise.reject(new Error('boom')) };
    await expect(watchFinishReport(runId, failing as ToolDefinition).run({} as never)).rejects.toThrow('boom');
    expect(askOpenedFor(runId)).toBe(false);
    const other = stopTool('note_evidence', 'ok');
    expect(watchFinishReport(runId, other)).toBe(other);
  });

  test('answerChainOf reads a chain from an input answer signal only', () => {
    const chain: IdChain = { ids: { customer_id: 'c-1' }, hops: [], basic_state: [] };
    const attributes = { question_id: 'q1', [INPUT_ANSWER_CHAIN_ATTR]: JSON.stringify(chain) };
    expect(answerChainOf({ kind: 'signal', type: INPUT_ANSWER_SIGNAL, body: 'x', attributes })).toEqual(chain);
    expect(answerChainOf({ kind: 'signal', type: 'triage.finish_required', body: 'x', attributes })).toBeNull();
    expect(answerChainOf({ kind: 'user', body: 'x' })).toBeNull();
    expect(answerChainOf({ kind: 'signal', type: INPUT_ANSWER_SIGNAL, body: 'x' })).toBeNull();
    expect(answerChainOf({ kind: 'signal', type: INPUT_ANSWER_SIGNAL, body: 'x', attributes: { question_id: 'q1' } })).toBeNull();
    expect(answerChainOf({ kind: 'signal', type: INPUT_ANSWER_SIGNAL, body: 'x', attributes: { [INPUT_ANSWER_CHAIN_ATTR]: '{not json' } })).toBeNull();
    expect(answerChainOf({ kind: 'signal', type: INPUT_ANSWER_SIGNAL, body: 'x', attributes: { [INPUT_ANSWER_CHAIN_ATTR]: '{"ids":{}}' } })).toBeNull();
    expect(answerChainOf(null)).toBeNull();
    expect(answerChainOf(undefined)).toBeNull();
  });

  test('mergeIdChains adds ids (the answer wins) and appends hops and state it does not hold yet', () => {
    const hop = { from: 'customer_id' as const, to: 'account_id' as const, source: 'ssfb:rhythm.customer_account_mappings', status: 'resolved' as const, taken_at: '2026-09-23T10:00:00.000Z' };
    const item = { item: 'harbor_customer_state', value: 'ACTIVE', taken_at: '2026-09-23T10:00:00.000Z', source: 'ssfb:harbor.customer' };
    const base: IdChain = { ids: { customer_id: 'c-1', account_id: 'a-1' }, hops: [hop], basic_state: [item] };
    const extra: IdChain = { ids: { account_id: 'a-2', form_id: 'f-1' }, hops: [hop, { ...hop, to: 'form_id' }], basic_state: [item, { ...item, item: 'account_form_status_v2', value: 'SIGNED' }] };
    const merged = mergeIdChains(base, extra);
    expect(merged.ids).toEqual({ customer_id: 'c-1', account_id: 'a-2', form_id: 'f-1' });
    expect(merged.hops).toHaveLength(2);
    expect(merged.basic_state.map((s) => s.item)).toEqual(['harbor_customer_state', 'account_form_status_v2']);
    // Pure: the inputs are untouched.
    expect(base.hops).toHaveLength(1);
    expect(extra.ids.customer_id).toBeUndefined();
  });

  test('runDepsFor seeds the chain from a saved one when given, on the first render of the run only', () => {
    const h = home();
    useTestRuntime(h);
    const runId = nextRunId();
    const data = init({ runId });
    const saved: IdChain = { ...data.id_chain, ids: { ...data.id_chain.ids, form_id: 'form-saved-1' } };
    const deps = runDepsFor(runId, data, undefined, saved);
    expect(deps.idChain().ids.form_id).toBe('form-saved-1');
    // Cached: a later render without the saved chain gets the same deps.
    expect(runDepsFor(runId, data)).toBe(deps);
    settleRun(runId);
    const fresh = runDepsFor(runId, data);
    expect(fresh.idChain().ids.form_id).toBeUndefined();
    settleRun(runId);
  });
});
