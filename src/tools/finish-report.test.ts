import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResultUnavailableError } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { escalationFor, releaseEscalation, type EscalationStore } from '../agents/escalation.ts';
import type { Config } from '../config/env.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget, type RunBudget } from '../gate/budget.ts';
import type { Persisted } from '../gate/redact.ts';
import type { MockLayer } from '../mock/index.ts';
import { createFakeModel } from '../mock/fake-model.ts';
import { ReportSchema as FullReportSchema } from '../report/schema.ts';
import type { WriteReportArgs, WriteReportResult } from '../report/write.ts';
import {
  assertPersisted,
  type ClassificationRecord,
  type EvidenceKey,
  type EvidenceRecord,
  type RunRecord,
  type RunStore,
} from '../runstore/types.ts';
import type { PreflightWarning, TriageInit } from '../types/classification.ts';
import type { Tier } from '../types/core.ts';
import type { CodeFindings, EntityFindings } from '../types/findings.ts';
import type { Report, ReportDraft } from '../types/report.ts';
import { ToolEnvelopeSchema, type ToolEnvelope } from '../types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../../test/support/fake-tool-context.ts';
import {
  computeCost,
  createFinishReportTool,
  defaultPricing,
  FINISH_REPORT,
  MAX_SYNTHESIS_PASSES,
  NO_USAGE_GAP,
  SYNTHESIS_SKIPPED_GAP,
  toolModule,
  type CommitReader,
  type FinishReportOptions,
  type PricingLookup,
  releaseFinishReport,
  synthesisPassesFor,
  type UsageReader,
} from './finish-report.tool.ts';
import { conformanceProblems, toolsFor } from './index.ts';
import type { ToolDeps } from './types.ts';

// The synthesis pass imports models.ts, which loads config at import. Clear
// TRIAGE_HOME so a home exported in the shell is never read.
delete process.env.TRIAGE_HOME;
const { SYNTHESIS_FAILED_GAP } = await import('../agents/synthesis.ts');

// Synthetic values only.
const PHONE = '+91 98765 43210';
const CREATED_AT = '2026-09-24T09:00:00.000Z';
const NOW = new Date('2026-09-24T09:30:00.000Z');
const AT = '2026-09-24T09:10:00.000Z';
const SHA_A = 'abc1234def5678';
const SHA_B = '0123456789abcdef0123456789abcdef01234567';

const fake = createFakeModel();
let config: Config;
beforeAll(() => {
  fake.install();
  config = makeTestConfig({ ...fake.modelEnv });
});

// ------------------------------------------------------------------ draft

const FIXTURE = readFileSync(join(import.meta.dir, '..', 'report', '__fixtures__', 'sample-report.json'), 'utf8');

function baseDraft(tier: Tier = 'mid'): ReportDraft {
  const full = v.parse(FullReportSchema, JSON.parse(FIXTURE)) as Report;
  const { run_id: _r, env_label: _e, generated_at: _g, repo_commits: _c, cost: _k, ...draft } = full;
  return {
    ...draft,
    classification: { ...draft.classification, tier_final: tier },
    gaps: ['atspl package API not configured'],
    escalated: false,
    escalation_reasons: [],
  };
}

function strongDraft(): ReportDraft {
  return {
    ...baseDraft(),
    root_cause: null,
    status: 'inconclusive',
    confidence: 'low',
    confidence_reason: 'the strong model found no vendor event',
    gaps: ['no vendor callback found'],
  };
}

// ------------------------------------------------------------------ findings

function entityFindings(confidence: EntityFindings['confidence']): EntityFindings {
  return {
    evidence: [{ source: 'db', at: AT, query_or_path: 'delivery_requests', summary: 'one request, status FAILED' }],
    timeline: [],
    hypotheses: ['vendor rejected the address'],
    confidence,
    gaps: [],
  };
}

function codeFindings(repos: string[]): CodeFindings {
  return {
    claims: repos.map((repo, i) => ({ repo, file: `src/file-${i}.ts`, lines: '10-20', what_it_shows: 'retry is skipped' })),
    confidence: 'medium',
  };
}

// ------------------------------------------------------------------ store

type StoreState = {
  evidence: Partial<Record<EvidenceKey, EvidenceRecord>>;
  classification: ClassificationRecord | null;
};

type MemoryStore = RunStore & {
  readonly state: StoreState;
  readonly reports: { report: Report; md: string }[];
  readonly calls: { putReport: number; getRun: number };
};

/** In-memory RunStore with the reads finish_report and writeReport use. putReport runs the providers' write check. */
function memoryStore(runId: string): MemoryStore {
  const state: StoreState = { evidence: {}, classification: null };
  const reports: { report: Report; md: string }[] = [];
  const calls = { putReport: 0, getRun: 0 };
  const unused = (): never => {
    throw new Error('not used by finish_report');
  };
  const store = {
    provider: 'folder' as const,
    state,
    reports,
    calls,
    async getRun(id: string): Promise<RunRecord | null> {
      calls.getRun++;
      if (id !== runId) return null;
      return {
        run_id: id,
        schema_version: 1,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        phase: 'investigating',
        request: {},
        classification: state.classification,
        evidence: state.evidence,
        submissions: [{ seq: 1, kind: 'initial', created_at: CREATED_AT, report: null, report_md: null }],
        input_request: null,
        input_history: [],
        report: null,
        report_md: null,
        feedback: [],
        feedback_latest: null,
        embeddings: [],
      } as unknown as RunRecord;
    },
    async putReport(_id: string, _seq: number, report: Persisted<Report>, md: Persisted<string>): Promise<void> {
      calls.putReport++;
      reports.push({ report: assertPersisted(report, 'report'), md: assertPersisted(md, 'md') });
    },
    createRun: unused,
    addSubmission: unused,
    setPhase: unused,
    putClassification: unused,
    putInputRequest: unused,
    resolveInputRequest: unused,
    putEvidence: unused,
    putFeedback: unused,
    claimIdempotencyKey: unused,
    clearExpiredIdempotencyKeys: unused,
    listRuns: unused,
    putEmbedding: unused,
    findSimilar: unused,
    deleteRun: unused,
    listExpired: unused,
  };
  return store as MemoryStore;
}

function putEvidence(store: MemoryStore, key: EvidenceKey, findings: EntityFindings | CodeFindings, version = 1): void {
  store.state.evidence[key] = { key, version, findings };
}

// ------------------------------------------------------------------ harness

const fakeFixtures = (): MockLayer =>
  ({
    settings: { mockMode: true, strict: true, record: false, fixturesDir: '/triage-test/fixtures' },
    store: {},
    recorder: null,
    resolveIo: () => {
      throw new Error('finish_report does no fixture I/O');
    },
  }) as unknown as MockLayer;

type Call = { text: string; options: Record<string, unknown> };

function stubHarness(respond: () => Promise<unknown> = async () => ({ data: strongDraft() })) {
  const calls: Call[] = [];
  const harness = {
    prompt(text: string, options: Record<string, unknown>) {
      calls.push({ text, options });
      return respond();
    },
  };
  return { harness, calls };
}

type WriterSpy = { calls: WriteReportArgs[]; result: WriteReportResult | null };

function fakeWriter(result?: WriteReportResult): { spy: WriterSpy; writeReport: FinishReportOptions['writeReport'] } {
  const spy: WriterSpy = { calls: [], result: result ?? null };
  return {
    spy,
    writeReport: async (args) => {
      spy.calls.push(args);
      if (spy.result !== null) return spy.result;
      return {
        ok: true,
        paths: { submissionId: 1, json: `${args.runId}/submissions/1/report.json`, md: `${args.runId}/submissions/1/report.md` },
        report: { ...args.draft, run_id: args.runId, env_label: '', generated_at: NOW.toISOString() } as Report,
      };
    },
  };
}

type Setup = {
  runId: string;
  store: MemoryStore;
  audit: MemoryAuditSink;
  budget: RunBudget;
  escalation: EscalationStore;
  tool: ToolDefinition;
  harness: ReturnType<typeof stubHarness>;
  deps: ToolDeps;
};

type SetupOptions = {
  tier?: Tier;
  moneyMoved?: boolean;
  initialData?: 'none' | Partial<TriageInit>;
  runNames?: string[];
  usage?: UsageReader;
  repoCommit?: CommitReader;
  options?: FinishReportOptions;
  respond?: () => Promise<unknown>;
  maxToolCalls?: number;
};

let runSeq = 0;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function initFor(tier: Tier, moneyMoved: boolean, extra: Partial<TriageInit>): TriageInit {
  const draft = baseDraft(tier);
  return {
    request: {} as TriageInit['request'],
    classification: {
      ...draft.classification,
      tier_final: tier,
      proposed: { ...draft.classification.proposed, money_moved: moneyMoved },
    },
    id_chain: draft.id_chain,
    ...extra,
  };
}

function setup(opts: SetupOptions = {}): Setup {
  runSeq += 1;
  const runId = `run_finish_report_t${runSeq}`;
  const store = memoryStore(runId);
  const audit = createMemoryAuditSink();
  const budget = createRunBudget({
    runId,
    maxToolCalls: opts.maxToolCalls ?? 5,
    maxTasks: 2,
    maxRowsPerCall: 10,
    maxBytesPerCall: 1000,
    maxBytesPerRun: 10_000,
  });
  const escalation = escalationFor(runId);
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
    releaseFinishReport(runId);
  });
  const tier = opts.tier ?? 'mid';
  const initialData =
    opts.initialData === 'none' ? undefined : initFor(tier, opts.moneyMoved ?? false, opts.initialData ?? {});
  const deps = {
    budget,
    audit,
    fixtures: fakeFixtures(),
    connectors: {},
    runStore: store,
    escalation,
    run: { interface: 'cli', redactionNames: opts.runNames ?? [] },
    now: () => NOW,
    idChain: () => ({ ids: {}, hops: [], basic_state: [] }),
    ...(initialData !== undefined ? { initialData } : {}),
    usage: opts.usage ?? (() => ({})),
    ...(opts.repoCommit !== undefined ? { repoCommit: opts.repoCommit } : {}),
  } as unknown as ToolDeps;
  const ctx = makeToolContext({ runId, config, deps });
  const pricing: PricingLookup = () => ({ input: 3, output: 15 });
  const tool = createFinishReportTool(ctx, { pricing, ...opts.options });
  return { runId, store, audit, budget, escalation, tool, harness: stubHarness(opts.respond), deps };
}

async function call(s: Setup, data: unknown, signal: AbortSignal = new AbortController().signal): Promise<ToolEnvelope> {
  const run = s.tool.run as (c: unknown) => Promise<unknown>;
  const out = await run({ data, toolCallId: 'call_1', signal, log: console, harness: s.harness.harness });
  return v.parse(ToolEnvelopeSchema, out);
}

// ------------------------------------------------------------------ module

describe('finish_report module', () => {
  test('is mounted on triage only, as a harness tool with a conforming input', () => {
    expect(toolModule.name).toBe(FINISH_REPORT);
    expect(toolModule.mounts).toEqual(['triage']);
    const ctx = makeToolContext({ config });
    const tool = toolModule.create(ctx, 'triage');
    expect(tool.name).toBe(FINISH_REPORT);
    expect((tool as { harness?: boolean }).harness).toBe(true);
    expect(conformanceProblems(toolModule, tool)).toEqual([]);
  });

  test('the generated tool list puts it on triage and not on the delegates', () => {
    const triage = toolsFor('triage', makeToolContext({ config })).map((t) => t.name);
    expect(triage).toContain(FINISH_REPORT);
    const investigator = toolsFor('investigator_deep', makeToolContext({ config, entity: 'ssfb' })).map((t) => t.name);
    expect(investigator).not.toContain(FINISH_REPORT);
    const walker = toolsFor('code_walker', makeToolContext({ config })).map((t) => t.name);
    expect(walker).not.toContain(FINISH_REPORT);
  });
});

// ------------------------------------------------------------------ refusal and retry

describe('finish_report: writeReport refusals', () => {
  test('an unmasked phone comes back as a refused envelope, not a throw, and nothing is stored', async () => {
    const s = setup();
    const dirty = baseDraft();
    dirty.cx_answer = { ...dirty.cx_answer, reply_text: `Please call the customer on ${PHONE}.` };

    const out = await call(s, dirty);

    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('phone');
    expect(out.output.message).toContain('cx_answer.reply_text');
    expect(out.output.message).toContain('call finish_report again');
    expect(out.output.message).not.toContain('98765');
    expect(s.store.calls.putReport).toBe(0);
    expect(s.store.reports).toHaveLength(0);
    const deny = s.audit.lines.at(-1)!;
    expect(deny.decision).toBe('deny');
    expect(deny.tool).toBe(FINISH_REPORT);
    expect(JSON.stringify(s.audit.lines)).not.toContain('98765');
  });

  test('a schema refusal lists the schema path and stores nothing', async () => {
    const s = setup();
    const bad = { ...baseDraft(), escalated: true, escalation_reasons: [] };

    const out = await call(s, bad);

    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('$.escalation_reasons');
    expect(s.store.calls.putReport).toBe(0);
  });

  test('a retry with a clean draft after a refusal writes report.json and report.md once', async () => {
    const s = setup();
    const dirty = baseDraft();
    dirty.cx_answer = { ...dirty.cx_answer, reply_text: `Call ${PHONE}` };
    expect((await call(s, dirty)).output.status).toBe('refused');
    expect(s.store.calls.putReport).toBe(0);

    const out = await call(s, baseDraft());

    expect(out.output.status).toBe('ok');
    expect(s.store.calls.putReport).toBe(1);
    const data = out.output.data as { report_json: string; report_md: string; status: string };
    expect(data.report_json).toBe(`${s.runId}/submissions/1/report.json`);
    expect(data.report_md).toBe(`${s.runId}/submissions/1/report.md`);
    const stored = s.store.reports[0]!;
    expect(stored.report.run_id).toBe(s.runId);
    expect(stored.md.length).toBeGreaterThan(0);
    expect(s.audit.lines.at(-1)!.decision).toBe('allow');
  });

  test('a draft of the wrong shape is refused with the failing paths before anything is read', async () => {
    const s = setup();
    const { cx_answer: _drop, ...partial } = baseDraft();

    const out = await call(s, partial);

    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('cx_answer');
    expect(s.store.calls.getRun).toBe(0);
    expect(s.store.calls.putReport).toBe(0);
  });

  test('an aborted signal throws and writes nothing', async () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(call(s, baseDraft(), controller.signal)).rejects.toThrow();
    expect(s.store.calls.putReport).toBe(0);
  });
});

// ------------------------------------------------------------------ escalation

describe('finish_report: escalation and strong synthesis', () => {
  test('escalation on a cheap run calls synthesizeOnStrong once, with the strong model', async () => {
    const writer = fakeWriter();
    const s = setup({ tier: 'cheap', options: { writeReport: writer.writeReport } });
    putEvidence(s.store, 'atspl', entityFindings('low'));

    const out = await call(s, baseDraft('cheap'));

    expect(out.output.status).toBe('ok');
    expect(s.harness.calls).toHaveLength(1);
    expect(s.harness.calls[0]!.options.model).toBe(fake.modelEnv.MODEL_TIER_STRONG);
    expect(s.harness.calls[0]!.text).toContain('vendor rejected the address');
    const written = writer.spy.calls[0]!.draft;
    expect(written.escalated).toBe(true);
    expect(written.escalation_reasons).toEqual(['low_confidence']);
    expect(written.status).toBe('inconclusive');
    expect(written.gaps).toContain('no vendor callback found');
  });

  test('the same evidence on a strong run does not call synthesis', async () => {
    const writer = fakeWriter();
    const s = setup({ tier: 'strong', options: { writeReport: writer.writeReport } });
    putEvidence(s.store, 'atspl', entityFindings('low'));

    const out = await call(s, baseDraft('strong'));

    expect(out.output.status).toBe('ok');
    expect(s.harness.calls).toHaveLength(0);
    expect(writer.spy.calls[0]!.draft.escalated).toBe(false);
  });

  test('a cheap run with no trigger keeps the draft and does not call synthesis', async () => {
    const writer = fakeWriter();
    const s = setup({ tier: 'cheap', options: { writeReport: writer.writeReport } });
    putEvidence(s.store, 'atspl', entityFindings('high'));

    await call(s, baseDraft('cheap'));

    expect(s.harness.calls).toHaveLength(0);
    expect(writer.spy.calls[0]!.draft.status).toBe(baseDraft().status);
  });

  test('money moved on a mid run triggers synthesis from initialData', async () => {
    const writer = fakeWriter();
    const s = setup({ tier: 'mid', moneyMoved: true, options: { writeReport: writer.writeReport } });

    await call(s, baseDraft('mid'));

    expect(s.harness.calls).toHaveLength(1);
    expect(writer.spy.calls[0]!.draft.escalation_reasons).toEqual(['money_moved_non_strong']);
  });

  test('findings recorded in the escalation store count when the store has no evidence yet', async () => {
    const writer = fakeWriter();
    const s = setup({ tier: 'cheap', options: { writeReport: writer.writeReport } });
    s.escalation.record({ entity: 'ssfb', findings: entityFindings('low') });

    await call(s, baseDraft('cheap'));

    expect(s.harness.calls).toHaveLength(1);
  });

  test('stored evidence wins over an older escalation-store record for the same key', async () => {
    const writer = fakeWriter();
    const s = setup({ tier: 'cheap', options: { writeReport: writer.writeReport } });
    s.escalation.record({ entity: 'ssfb', findings: entityFindings('low') });
    putEvidence(s.store, 'ssfb', entityFindings('high'), 2);

    await call(s, baseDraft('cheap'));

    expect(s.harness.calls).toHaveLength(0);
  });

  test('a ResultUnavailableError keeps the draft, adds a gap and still writes the report', async () => {
    const writer = fakeWriter();
    const s = setup({
      tier: 'cheap',
      options: { writeReport: writer.writeReport },
      respond: async () => {
        throw new ResultUnavailableError('evidence too thin', '');
      },
    });
    putEvidence(s.store, 'atspl', entityFindings('low'));

    const out = await call(s, baseDraft('cheap'));

    expect(out.output.status).toBe('ok');
    expect(s.harness.calls).toHaveLength(1);
    expect(writer.spy.calls).toHaveLength(1);
    const written = writer.spy.calls[0]!.draft;
    expect(written.status).toBe(baseDraft().status);
    expect(written.root_cause).toEqual(baseDraft().root_cause);
    expect(written.gaps.some((g) => g.startsWith(SYNTHESIS_FAILED_GAP))).toBe(true);
    expect(written.escalated).toBe(true);
  });

  test('a refusal after synthesis says the fields came from the rebuild', async () => {
    const refusal: WriteReportResult = { ok: false, reason: 'unmasked', patterns: ['phone'], fields: ['$.timeline[0].what'] };
    const writer = fakeWriter(refusal);
    const s = setup({ tier: 'cheap', options: { writeReport: writer.writeReport } });
    putEvidence(s.store, 'atspl', entityFindings('low'));

    const out = await call(s, baseDraft('cheap'));

    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('strong-model synthesis');
    expect(out.output.message).toContain('$.timeline[0].what');
  });

  test(`synthesis runs at most ${MAX_SYNTHESIS_PASSES} times; after that the draft is kept with a gap`, async () => {
    const refusal: WriteReportResult = { ok: false, reason: 'unmasked', patterns: ['phone'], fields: ['$.timeline[0].what'] };
    const writer = fakeWriter(refusal);
    const s = setup({ tier: 'cheap', options: { writeReport: writer.writeReport } });
    putEvidence(s.store, 'atspl', entityFindings('low'));

    for (let i = 0; i < MAX_SYNTHESIS_PASSES; i++) await call(s, baseDraft('cheap'));
    writer.spy.result = null;
    const out = await call(s, baseDraft('cheap'));

    expect(out.output.status).toBe('ok');
    expect(s.harness.calls).toHaveLength(MAX_SYNTHESIS_PASSES);
    const last = writer.spy.calls.at(-1)!.draft;
    expect(last.gaps).toContain(SYNTHESIS_SKIPPED_GAP);
    expect(last.escalated).toBe(true);
    expect(last.escalation_reasons).toEqual(['low_confidence']);
  });

  test('the synthesis cap is per run, so a rebuilt tool for the same run shares it', async () => {
    const refusal: WriteReportResult = { ok: false, reason: 'unmasked', patterns: ['phone'], fields: ['$.timeline[0].what'] };
    const writer = fakeWriter(refusal);
    const s = setup({ tier: 'cheap', options: { writeReport: writer.writeReport } });
    putEvidence(s.store, 'atspl', entityFindings('low'));
    const ctx = makeToolContext({ runId: s.runId, config, deps: s.deps });
    const pricing: PricingLookup = () => ({ input: 3, output: 15 });

    // Flue re-renders the agent before every model turn, so each call gets a new tool.
    for (let i = 0; i < MAX_SYNTHESIS_PASSES + 2; i++) {
      const tool = createFinishReportTool(ctx, { pricing, writeReport: writer.writeReport });
      await call({ ...s, tool }, baseDraft('cheap'));
    }

    expect(s.harness.calls).toHaveLength(MAX_SYNTHESIS_PASSES);
    expect(synthesisPassesFor(s.runId)).toBe(MAX_SYNTHESIS_PASSES);
    expect(writer.spy.calls.at(-1)!.draft.gaps).toContain(SYNTHESIS_SKIPPED_GAP);

    // Another run starts with its own count.
    const other = setup({ tier: 'cheap', options: { writeReport: writer.writeReport } });
    putEvidence(other.store, 'atspl', entityFindings('low'));
    await call(other, baseDraft('cheap'));
    expect(other.harness.calls).toHaveLength(1);

    expect(releaseFinishReport(s.runId)).toBe(true);
    expect(synthesisPassesFor(s.runId)).toBe(0);
  });
});

// ------------------------------------------------------------------ budget

describe('finish_report: budget', () => {
  test('passes after the run budget is exhausted and does not count against it', async () => {
    const s = setup({ tier: 'strong', maxToolCalls: 1 });
    expect(s.budget.consumeToolCall('sql_select').ok).toBe(true);
    expect(s.budget.consumeToolCall('sql_select').ok).toBe(false);
    expect(s.budget.state().exhausted).toBe(true);
    const before = s.budget.state().calls;

    const out = await call(s, baseDraft('strong'));

    expect(out.output.status).toBe('ok');
    expect(s.store.calls.putReport).toBe(1);
    expect(s.budget.state().calls).toBe(before);
  });

  test('an exhausted budget with no high finding triggers synthesis on a cheap run', async () => {
    const writer = fakeWriter();
    const s = setup({ tier: 'cheap', maxToolCalls: 1, options: { writeReport: writer.writeReport } });
    s.budget.consumeToolCall('sql_select');
    s.budget.consumeToolCall('sql_select');
    putEvidence(s.store, 'atspl', entityFindings('medium'));

    await call(s, baseDraft('cheap'));

    expect(s.harness.calls).toHaveLength(1);
    expect(writer.spy.calls[0]!.draft.escalation_reasons).toEqual(['budget_exhausted_no_root_cause']);
  });
});

// ------------------------------------------------------------------ repo commits

describe('finish_report: repo_commits', () => {
  test('one {repo, commit} per repo in the code evidence, from the commit reader', async () => {
    const writer = fakeWriter();
    const asked: string[] = [];
    const repoCommit: CommitReader = async (repo) => {
      asked.push(repo);
      if (repo === 'rhythm-service') return { status: 'ok', repo, commit: SHA_A };
      if (repo === 'harbor-service') return { status: 'ok', repo, commit: SHA_B };
      return { status: 'unavailable', reason: 'repo is not checked out under TRIAGE_REPOS_DIR' };
    };
    const s = setup({ tier: 'strong', repoCommit, options: { writeReport: writer.writeReport } });
    putEvidence(s.store, 'code', codeFindings(['rhythm-service', 'harbor-service', 'rhythm-service', 'ledger-service']));

    await call(s, baseDraft('strong'));

    expect(asked).toEqual(['rhythm-service', 'harbor-service', 'ledger-service']);
    const written = writer.spy.calls[0]!.draft;
    expect(written.repo_commits).toEqual([
      { repo: 'rhythm-service', commit: SHA_A },
      { repo: 'harbor-service', commit: SHA_B },
    ]);
    expect(written.gaps).toContain(
      'commit not recorded for repo ledger-service: repo is not checked out under TRIAGE_REPOS_DIR',
    );
  });

  test('no code evidence gives an empty list; no reader gives a gap per repo', async () => {
    const writer = fakeWriter();
    const s = setup({ tier: 'strong', options: { writeReport: writer.writeReport } });
    await call(s, baseDraft('strong'));
    expect(writer.spy.calls[0]!.draft.repo_commits).toEqual([]);

    const writer2 = fakeWriter();
    const s2 = setup({ tier: 'strong', options: { writeReport: writer2.writeReport } });
    putEvidence(s2.store, 'code', codeFindings(['rhythm-service']));
    await call(s2, baseDraft('strong'));
    const written = writer2.spy.calls[0]!.draft;
    expect(written.repo_commits).toEqual([]);
    expect(written.gaps).toContain('commit not recorded for repo rhythm-service: no commit reader for this run');
  });

  test('a reader answer that is not a commit id is not recorded', async () => {
    const writer = fakeWriter();
    const repoCommit: CommitReader = async (repo) => ({ status: 'ok', repo, commit: 'HEAD' });
    const s = setup({ tier: 'strong', repoCommit, options: { writeReport: writer.writeReport } });
    putEvidence(s.store, 'code', codeFindings(['rhythm-service']));

    await call(s, baseDraft('strong'));

    expect(writer.spy.calls[0]!.draft.repo_commits).toEqual([]);
    expect(writer.spy.calls[0]!.draft.gaps).toContain('commit not recorded for repo rhythm-service: not a commit id');
  });
});

// ------------------------------------------------------------------ cost

describe('finish_report: cost', () => {
  test('tokens per model and a USD total when pricing is known', async () => {
    const writer = fakeWriter();
    const usage: UsageReader = (runId) => {
      expect(runId).toStartWith('run_finish_report_');
      return {
        'faux/mid': { input_tokens: 1000, output_tokens: 500, calls: 2 },
        'faux/strong': { input_tokens: 2000, output_tokens: 0 },
      };
    };
    const s = setup({ tier: 'strong', usage, options: { writeReport: writer.writeReport } });

    await call(s, baseDraft('strong'));

    const cost = writer.spy.calls[0]!.draft.cost;
    expect(cost).toEqual({
      models: {
        'faux/mid': { calls: 2, input_tokens: 1000, output_tokens: 500 },
        'faux/strong': { calls: 0, input_tokens: 2000, output_tokens: 0 },
      },
      wall_ms: 30 * 60 * 1000,
      // (1000*3 + 500*15 + 2000*3) / 1e6
      usd_total: 0.0165,
    });
  });

  test('a model without pricing gives cost null and a gap', async () => {
    const writer = fakeWriter();
    const usage: UsageReader = () => ({
      'faux/mid': { input_tokens: 10, output_tokens: 5 },
      'ollama/unknown-20250929': { input_tokens: 10, output_tokens: 5 },
    });
    const pricing: PricingLookup = (spec) => (spec === 'faux/mid' ? { input: 1, output: 1 } : undefined);
    const s = setup({ tier: 'strong', usage, options: { writeReport: writer.writeReport, pricing } });

    await call(s, baseDraft('strong'));

    const written = writer.spy.calls[0]!.draft;
    expect(written.cost).toBeNull();
    const gap = written.gaps.find((g) => g.startsWith('cost not computed'));
    expect(gap).toBeDefined();
    // The model id's date run is masked so the gap cannot trip the egress check.
    expect(gap).not.toContain('20250929');
  });

  test('without a usage reader the cost is null with a gap', async () => {
    const r = await computeCost(undefined, () => ({ input: 1, output: 1 }), 0);
    expect(r).toEqual({ cost: null, gaps: [NO_USAGE_GAP] });
  });

  test('the default pricing has nothing for an unknown model', async () => {
    expect(await defaultPricing('faux/not-a-model')).toBeUndefined();
    expect(await defaultPricing('not-a-spec')).toBeUndefined();
  });
});

// ------------------------------------------------------------------ initialData

describe('finish_report: initialData', () => {
  const warnings: PreflightWarning[] = [
    { entity: 'ssfb', step: 'tunnel', message: 'tunnel is down', fix: 'triage tunnel up ssfb' },
    { step: 'repos', message: 'repo drift on 1234567 commits' },
  ];

  test('preflight_warnings are copied into gaps and redaction_names are forwarded', async () => {
    const writer = fakeWriter();
    const s = setup({
      tier: 'strong',
      initialData: { redaction_names: ['Asha Testperson'], preflight_warnings: warnings },
      runNames: ['Ravi Sampleuser'],
      options: { writeReport: writer.writeReport },
    });

    await call(s, baseDraft('strong'));

    const args = writer.spy.calls[0]!;
    expect(args.ingressNames).toEqual(['Asha Testperson', 'Ravi Sampleuser']);
    expect(args.runId).toBe(s.runId);
    expect(args.store).toBe(s.store);
    expect(args.draft.gaps).toContain('preflight ssfb tunnel: tunnel is down (fix: triage tunnel up ssfb)');
    const repos = args.draft.gaps.find((g) => g.startsWith('preflight repos:'));
    expect(repos).toBeDefined();
    expect(repos).not.toContain('1234567');
    // The draft's own gaps are kept first.
    expect(args.draft.gaps[0]).toBe('atspl package API not configured');
  });

  test('a preflight gap holding an ingress name is masked before the write, so the report is not refused', async () => {
    const s = setup({
      tier: 'strong',
      initialData: {
        redaction_names: ['Asha Testperson'],
        preflight_warnings: [{ step: 'slack', message: 'profile of Asha Testperson could not be read' }],
      },
    });

    const out = await call(s, baseDraft('strong'));

    expect(out.output.status).toBe('ok');
    expect(JSON.stringify(s.store.reports[0]!.report)).not.toContain('Asha Testperson');
  });

  test('without initialData the stored classification record supplies the warnings and the tier', async () => {
    const writer = fakeWriter();
    const s = setup({ initialData: 'none', options: { writeReport: writer.writeReport } });
    const init = initFor('cheap', false, {});
    s.store.state.classification = {
      decision: init.classification,
      id_chain: init.id_chain,
      preflight_warnings: [warnings[0]!],
    };
    putEvidence(s.store, 'atspl', entityFindings('low'));

    // The draft claims strong; the stored decision says cheap, and that wins.
    await call(s, baseDraft('strong'));

    expect(s.harness.calls).toHaveLength(1);
    expect(writer.spy.calls[0]!.draft.gaps).toContain('preflight ssfb tunnel: tunnel is down (fix: triage tunnel up ssfb)');
  });
});
