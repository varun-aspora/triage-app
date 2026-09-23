// Shared set-up for the agent contract tests (T06.10). Not a contract file
// itself: Vitest only picks up *.contract.ts.
//
// Each contract file boots start({ agents: [Triage] }) once, on a test home
// from makeTestHome() (strict mock mode, every credential blank) with the
// fake model's MODEL_* specs, the repo's knowledge/ tree and an empty repos
// dir so the code tools mount. The fake provider is installed with
// setProvider, so the src/models.ts registration stays as it is.
//
// Model calls are routed per agent by the system prompt each agent renders
// (the T03.6 spike verified that delegates draw from the same queue, and
// that the system prompt tells the agents apart). The router also records
// every call's agent, model and rendered tool names, which is how mounting
// is asserted: from what the model was actually given.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, FauxResponseFactory, Message } from '@earendil-works/pi-ai';
import { type AgentReply, init } from '@flue/runtime';
import { start, type Flue } from '@flue/runtime/node';
import * as v from 'valibot';
import { redactPersisted } from '../../../src/gate/redact.ts';
import { createFakeModel, FakeModelError, type FakeModel, type FakeStep } from '../../../src/mock/fake-model.ts';
import { createFolderRunStore } from '../../../src/runstore/folder.ts';
import type { RunStore } from '../../../src/runstore/types.ts';
import { AuditLineSchema, type AuditLine } from '../../../src/types/audit.ts';
import { type TriageInit, TriageInitSchema } from '../../../src/types/classification.ts';
import type { Entity, Tier } from '../../../src/types/core.ts';
import { assertNoIoGuardInstalled } from '../../support/no-io-guard.ts';
import { makeTestHome, REPO_ROOT, type TestHome } from '../../support/home.ts';

assertNoIoGuardInstalled();

export const KNOWLEDGE_DIR = join(REPO_ROOT, 'knowledge');

/** The synthesis prompt's first line (src/agents/synthesis.ts). */
const SYNTHESIS_MARK = 'You are writing the final triage report for a banking support case.';

// ------------------------------------------------------------------ homes

export type ContractHome = TestHome & { readonly reposDir: string; dispose(): void };

export type ContractHomeOptions = {
  readonly entities?: readonly Entity[];
  /** Extra env values, on top of the fake model specs, knowledge dir and repos dir. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** Export TRIAGE_HOME for this home. Default true; pass false for a second home after boot. */
  readonly exportHome?: boolean;
};

/** A test home for the agent contracts. By default sets TRIAGE_HOME, so modules that load config at import find it. */
export function contractHome(fake: FakeModel, options: ContractHomeOptions = {}): ContractHome {
  const reposDir = mkdtempSync(join(tmpdir(), 'triage-contract-repos-'));
  const home = makeTestHome({
    overrides: {
      ...fake.modelEnv,
      TRIAGE_KNOWLEDGE_DIR: KNOWLEDGE_DIR,
      TRIAGE_REPOS_DIR: reposDir,
      ...options.overrides,
    },
    ...(options.entities !== undefined ? { entities: options.entities } : {}),
  });
  if (options.exportHome !== false) process.env.TRIAGE_HOME = home.home;
  return Object.freeze({
    ...home,
    reposDir,
    dispose() {
      home.cleanup();
      rmSync(reposDir, { recursive: true, force: true });
    },
  });
}

// ------------------------------------------------------------------ boot

type TriageModule = typeof import('../../../src/agents/triage.agent.ts');
type PlanModule = typeof import('../../../src/agents/triage-plan.ts');

export type Booted = {
  readonly flue: Flue;
  readonly Triage: TriageModule['Triage'];
  readonly plan: PlanModule;
  /** The run store of the home the runtime currently uses. */
  readonly store: RunStore;
  /**
   * Points the Triage runtime at another home (config, registry, a folder
   * store under its runs dir). The tripwire stays as first installed.
   */
  use(home: TestHome): void;
};

/**
 * Installs the fake provider, points the Triage runtime at the home and
 * starts Flue with Triage as the only agent. Import happens here, after
 * TRIAGE_HOME is set, because triage.agent.ts computes its durability at import.
 */
export async function bootTriage(fake: FakeModel, home: TestHome): Promise<Booted> {
  fake.install();
  const { Triage } = await import('../../../src/agents/triage.agent.ts');
  const plan = await import('../../../src/agents/triage-plan.ts');
  const { loadKnowledge } = await import('../../../src/agents/skills.ts');
  const knowledge = loadKnowledge(KNOWLEDGE_DIR);
  let store: RunStore | undefined;
  const use = (h: TestHome): void => {
    store = createFolderRunStore({ runsDir: h.config.paths.runsDir, dataDir: h.config.paths.dataDir });
    plan.configureTriageRuntime({ config: h.config, registry: h.registry, knowledge, runStore: store });
  };
  use(home);
  // env is empty, so no provider key can be picked up from the shell.
  const flue = await start({ agents: [Triage], env: {} });
  return {
    flue,
    Triage,
    plan,
    get store(): RunStore {
      if (store === undefined) throw new Error('bootTriage: no home in use');
      return store;
    },
    use,
  };
}

// ------------------------------------------------------------------ requests

let runSeq = 0;

/** A fresh run id per call, so runs never share Flue state or run folders. */
export function nextRunId(prefix: string): string {
  runSeq += 1;
  return `run_${prefix}_${Date.now().toString(36)}_${runSeq}`;
}

export type InitOptions = {
  readonly tier?: Tier;
  readonly hints?: readonly Entity[];
  readonly moneyMoved?: boolean;
};

/** A valid TriageInit. Every value is synthetic. */
export function triageInit(runId: string, opts: InitOptions = {}): TriageInit {
  const tier = opts.tier ?? 'mid';
  return v.parse(TriageInitSchema, {
    request: {
      request_id: runId,
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
        tier_proposed: tier,
        confidence: 0.7,
        missing_info: [],
        images_seen: false,
      },
      tier_final: tier,
      rule_fired: 'rule_contract',
    },
    id_chain: { ids: { customer_id: 'cust-contract-1' }, hops: [], basic_state: [] },
  });
}

/** Creates the run and its first submission the way ingress does, so note_evidence and finish_report find them. */
export async function createRun(store: RunStore, triage: TriageInit): Promise<void> {
  const runId = triage.request.request_id;
  await store.createRun(runId, redactPersisted(triage.request));
  await store.addSubmission(runId, redactPersisted({ kind: 'initial' as const }));
}

export type RunResult =
  | { readonly ok: true; readonly reply: AgentReply; readonly tools: string[] }
  | { readonly ok: false; readonly error: unknown; readonly tools: string[] };

/** Dispatches one message to a Triage instance and waits for it to settle. Never throws. */
export async function runTriage(
  Triage: Booted['Triage'],
  runId: string,
  initialData: unknown,
  message = 'Triage this report.',
): Promise<RunResult> {
  const agent = init(Triage, { id: runId });
  const tools: string[] = [];
  try {
    const receipt = await agent.dispatch({ message, initialData });
    const reply = await agent.read(receipt, {
      onEvent: (chunk) => {
        if (chunk.type === 'tool-input') tools.push(chunk.toolName);
      },
    });
    return { ok: true, reply, tools };
  } catch (error) {
    return { ok: false, error, tools };
  }
}

// ------------------------------------------------------------------ routing

/** Who a model call belongs to: the root, a delegate, or the strong synthesis pass. */
export type AgentKey = 'triage' | 'synthesis' | 'code_walker' | `investigate_${Entity}` | `investigate_${Entity}_deep`;

export type SeenCall = {
  readonly agent: AgentKey;
  /** The faux model id: classifier, cheap, mid or strong. */
  readonly model: string;
  /** Tool names as rendered into the model context, sorted. */
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  /** Text of every user message in the context, in order (signals arrive as user messages). */
  readonly userTexts: readonly string[];
  /** Every tool result in the context, in order. */
  readonly toolResults: readonly { readonly toolName: string; readonly isError: boolean; readonly text: string }[];
};

type Part = { type: string; text?: string };

function textOf(content: string | readonly Part[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n');
}

function userTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((m) => (m.role === 'user' ? [textOf(m.content)] : []));
}

/** Classifies a model call by the prompt its agent rendered. Throws for a prompt it does not know. */
export function agentOf(context: Context): AgentKey {
  const system = context.systemPrompt ?? '';
  if (userTexts(context.messages).some((t) => t.includes(SYNTHESIS_MARK))) return 'synthesis';
  if (system.includes('## This delegate')) {
    if (system.includes('You have no database, API or log tools')) return 'code_walker';
    const entity = /- Entity: (ssfb|atspl|rtl)\. /.exec(system)?.[1] as Entity | undefined;
    if (entity === undefined) throw new FakeModelError('a delegate prompt names no entity');
    return system.includes('You are the deep variant') ? `investigate_${entity}_deep` : `investigate_${entity}`;
  }
  if (system.includes('## Fixed rules') && system.includes('## Brief skeleton for this run')) return 'triage';
  throw new FakeModelError('a model call came from an agent the contract router does not know');
}

export type Script = Partial<Record<AgentKey, readonly FakeStep[]>>;

export type Scripted = {
  /** Every model call, in order. */
  readonly calls: SeenCall[];
  /** Calls for one agent. */
  callsFor(agent: AgentKey): SeenCall[];
  /** Steps not used yet, per agent. */
  left(): Partial<Record<AgentKey, number>>;
};

/**
 * Scripts the fake model with one queue per agent. A call for an agent with
 * no steps left fails the run with a 'fake model:' message.
 */
export function scriptAgents(fake: FakeModel, script: Script): Scripted {
  const queues = new Map<AgentKey, FakeStep[]>(
    Object.entries(script).map(([k, steps]) => [k as AgentKey, [...(steps ?? [])]]),
  );
  const calls: SeenCall[] = [];
  const router: FauxResponseFactory = (context, options, state, model) => {
    const agent = agentOf(context);
    calls.push({
      agent,
      model: model.id,
      tools: (context.tools ?? []).map((t) => t.name).sort(),
      systemPrompt: context.systemPrompt ?? '',
      userTexts: userTexts(context.messages),
      toolResults: context.messages.flatMap((m) =>
        m.role === 'toolResult' ? [{ toolName: m.toolName, isError: m.isError, text: textOf(m.content) }] : [],
      ),
    });
    const step = queues.get(agent)?.shift();
    if (step === undefined) throw new FakeModelError(`no scripted response left for ${agent}`);
    return typeof step === 'function' ? step(context, options, state, model) : step;
  };
  const total = [...queues.values()].reduce((n, q) => n + q.length, 0);
  fake.script(Array.from({ length: total }, () => router));
  return {
    calls,
    callsFor: (agent) => calls.filter((c) => c.agent === agent),
    left: () => Object.fromEntries([...queues].map(([k, q]) => [k, q.length])),
  };
}

/**
 * The names a system prompt lists under one of Flue's headings, such as
 * '## Available Skills' or '## Available Agents' ('- **name** — description').
 */
export function listed(systemPrompt: string, heading: '## Available Skills' | '## Available Agents'): string[] {
  const start = systemPrompt.indexOf(`${heading}\n`);
  if (start === -1) return [];
  const rest = systemPrompt.slice(start + heading.length + 1);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1] as string);
}

// ------------------------------------------------------------------ audit

/** Every audit line in TRIAGE_AUDIT_LOG, parsed. Empty when nothing was written. */
export function auditLines(home: TestHome): AuditLine[] {
  let text: string;
  try {
    text = readFileSync(home.config.paths.auditLog, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => v.parse(AuditLineSchema, JSON.parse(line)));
}

// ------------------------------------------------------------------ report draft

/** A valid report draft from the sample report fixture, set to the run's request and tier. */
export function reportDraft(triage: TriageInit, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const full = JSON.parse(readFileSync(join(REPO_ROOT, 'src/report/__fixtures__/sample-report.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const { run_id: _r, env_label: _e, generated_at: _g, repo_commits: _c, cost: _k, ...draft } = full;
  const classification = draft.classification as Record<string, unknown>;
  return {
    ...draft,
    classification: { ...classification, tier_final: triage.classification.tier_final },
    escalated: false,
    escalation_reasons: [],
    ...overrides,
  };
}
