import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import type { ToolDefinition } from '@flue/runtime/tool';
import { escalationFor, releaseEscalation, type EscalationStore } from '../agents/escalation.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget, type RunBudget } from '../gate/budget.ts';
import { redactPersisted } from '../gate/redact.ts';
import type { MockLayer } from '../mock/index.ts';
import { createFolderRunStore } from '../runstore/folder.ts';
import { assertPersisted, type EvidenceKey, type Findings, type Persisted, type RunStore } from '../runstore/types.ts';
import type { Entity } from '../types/core.ts';
import type { CodeFindings, EntityFindings } from '../types/findings.ts';
import { ToolEnvelopeSchema, type ToolEnvelope } from '../types/tool-result.ts';
import { makeToolContext } from '../../test/support/fake-tool-context.ts';
import { conformanceCases, conformanceProblems, FORBIDDEN_INPUT_KEYS, toolsFor } from './index.ts';
import { noteEvidenceSchema, toolModule } from './note-evidence.tool.ts';
import { MOUNTS, type Mount, type ToolDeps } from './types.ts';

// Synthetic values only.
const PHONE = '+91 98765 43210';
const ACCOUNT = '501234567890';
const DECRYPTED_CIF = '7766554433';
const AT = '2026-09-01T10:00:00.000Z';

// ------------------------------------------------------------------ fakes

type StoredEvidence = { runId: string; key: EvidenceKey; json: string };

type FakeStore = RunStore & { readonly puts: StoredEvidence[] };

/** In-memory RunStore: putEvidence only. Runs the same write-side check as real providers. */
function fakeRunStore(): FakeStore {
  const puts: StoredEvidence[] = [];
  const versions = new Map<string, number>();
  const unused = (): never => {
    throw new Error('not used by note_evidence');
  };
  const store = {
    provider: 'folder' as const,
    puts,
    async putEvidence(runId: string, key: EvidenceKey, findings: Persisted<Findings>): Promise<number> {
      const value = assertPersisted(findings, `evidence ${key}`);
      const id = `${runId}/${key}`;
      const version = (versions.get(id) ?? 0) + 1;
      versions.set(id, version);
      puts.push({ runId, key, json: JSON.stringify(value) });
      return version;
    },
    createRun: unused,
    addSubmission: unused,
    setPhase: unused,
    setPhaseIf: unused,
    putClassification: unused,
    putInputRequest: unused,
    markStopped: unused,
    resolveInputRequest: unused,
    putBlock: unused,
    resolveBlock: unused,
    putReport: unused,
    setSubmissionFlueId: unused,
    putFeedback: unused,
    claimIdempotencyKey: unused,
    clearExpiredIdempotencyKeys: unused,
    getRun: unused,
    listRuns: unused,
    putEmbedding: unused,
    findSimilar: unused,
    putUsage: unused,
    deleteRun: unused,
    listExpired: unused,
  };
  return store as FakeStore;
}

const fakeFixtures = (mockMode: boolean): MockLayer =>
  ({
    settings: { mockMode, strict: true, record: false, fixturesDir: '/triage-test/fixtures' },
    store: {},
    recorder: null,
    resolveIo: () => {
      throw new Error('note_evidence does no fixture I/O');
    },
  }) as unknown as MockLayer;

let runSeq = 0;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

type Harness = {
  readonly runId: string;
  readonly store: RunStore;
  readonly audit: MemoryAuditSink;
  readonly budget: RunBudget;
  readonly escalation: EscalationStore;
  readonly deps: ToolDeps;
};

function harness(opts: { store?: RunStore; mockMode?: boolean; names?: string[] } = {}): Harness {
  runSeq += 1;
  const runId = `run_note_evidence_${runSeq}_${Date.now().toString(36)}`;
  const store = opts.store ?? fakeRunStore();
  const audit = createMemoryAuditSink();
  const budget = createRunBudget({
    runId,
    maxToolCalls: 2,
    maxTasks: 1,
    maxRowsPerCall: 10,
    maxBytesPerCall: 1000,
    maxBytesPerRun: 10_000,
  });
  const escalation = escalationFor(runId);
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
  });
  const deps = {
    budget,
    audit,
    fixtures: fakeFixtures(opts.mockMode ?? true),
    connectors: {},
    runStore: store,
    escalation,
    run: { interface: 'cli', redactionNames: opts.names ?? [] },
    now: () => new Date(AT),
    idChain: () => ({ ids: {}, hops: [], basic_state: [] }),
  } as unknown as ToolDeps;
  return { runId, store, audit, budget, escalation, deps };
}

function toolOn(mount: Mount, entity: Entity | null, h: Harness): ToolDefinition {
  const ctx = makeToolContext({ entity, runId: h.runId, deps: h.deps });
  return toolModule.create(ctx, mount);
}

async function call(tool: ToolDefinition, data: unknown): Promise<ToolEnvelope> {
  const run = tool.run as (c: unknown) => Promise<unknown>;
  const out = await run({ data, toolCallId: 'call_1', signal: new AbortController().signal, log: console });
  return v.parse(ToolEnvelopeSchema, out);
}

function findings(overrides: Partial<EntityFindings> = {}): EntityFindings {
  return {
    evidence: [{ source: 'db', at: AT, query_or_path: 'harbor.account_forms', summary: 'form is approved' }],
    timeline: [],
    hypotheses: ['the payout is waiting on the bank'],
    confidence: 'medium',
    gaps: [],
    ...overrides,
  };
}

const codeFindings = (): CodeFindings => ({
  claims: [{ repo: 'harbor', file: 'src/payout.ts', lines: '10-20', what_it_shows: 'retry loop' }],
  confidence: 'high',
});

// ------------------------------------------------------------------ tests

describe('note_evidence: schema refusal', () => {
  const bad: [string, unknown, string][] = [
    ['bad confidence', findings({ confidence: 'certain' as never }), 'confidence'],
    [
      'missing summary',
      { ...findings(), evidence: [{ source: 'db', at: AT, query_or_path: 'harbor.account_forms' }] },
      'evidence.0.summary',
    ],
    ['extra entity field', { ...findings(), entity: 'atspl' }, 'entity'],
    ['extra run_id field', { ...findings(), run_id: 'run_other' }, 'run_id'],
  ];

  test.each(bad)('%s is refused with the failing path and nothing is written', async (_label, data, path) => {
    const h = harness();
    const out = await call(toolOn('investigator', 'ssfb', h), data);
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain(path);
    expect((h.store as FakeStore).puts).toHaveLength(0);
    expect(h.escalation.snapshot().findings).toHaveLength(0);
    expect(h.audit.lines).toHaveLength(1);
    expect(h.audit.lines[0]).toMatchObject({ tool: 'note_evidence', decision: 'deny', entity: 'ssfb' });
    expect(h.audit.lines[0]?.reason).toContain(path);
  });

  test('the refusal names paths, not the rejected values', async () => {
    const h = harness();
    const out = await call(toolOn('investigator', 'ssfb', h), findings({ confidence: `sure ${PHONE}` as never }));
    expect(out.output.status).toBe('refused');
    expect(out.output.message).not.toContain('98765');
    expect(JSON.stringify(h.audit.lines)).not.toContain('98765');
  });
});

describe('note_evidence: persisted redaction', () => {
  test('a phone and an account number in summaries are masked in the stored JSON', async () => {
    const h = harness();
    const data = findings({
      evidence: [
        {
          source: 'db',
          at: AT,
          query_or_path: 'harbor.accounts',
          summary: `customer on ${PHONE} has account ${ACCOUNT} frozen`,
        },
      ],
      timeline: [{ at: AT, what: `debit on ${ACCOUNT}`, source: { source: 'logs' } }],
    });
    const out = await call(toolOn('investigator', 'ssfb', h), data);
    expect(out.output).toMatchObject({ status: 'ok', data: { evidence_id: 'ssfb@v1', version: 1 } });

    const puts = (h.store as FakeStore).puts;
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe('ssfb');
    expect(puts[0]?.runId).toBe(h.runId);
    const stored = puts[0]?.json ?? '';
    expect(stored).not.toContain('98765');
    expect(stored).not.toContain('43210');
    expect(stored).not.toContain(ACCOUNT);
    expect(stored).toContain('frozen');
  });

  test('decrypt_fields plaintext pasted into a finding is masked on persist (D34)', async () => {
    const h = harness();
    const data = findings({
      hypotheses: [`decrypted mobile is ${PHONE} and cif is ${DECRYPTED_CIF}, they do not match the form`],
      gaps: [`could not confirm owner of ${DECRYPTED_CIF}`],
    });
    const out = await call(toolOn('investigator', 'ssfb', h), data);
    expect(out.output.status).toBe('ok');
    const stored = (h.store as FakeStore).puts[0]?.json ?? '';
    expect(stored).not.toContain(DECRYPTED_CIF);
    expect(stored).not.toContain('98765');
    expect(stored).toContain('do not match the form');
    // The escalation copy is masked too, since the root mirrors it into state.
    expect(JSON.stringify(h.escalation.snapshot().findings)).not.toContain(DECRYPTED_CIF);
  });

  test('ingress names are masked on persist', async () => {
    const h = harness({ names: ['Asha Testperson'] });
    await call(toolOn('investigator', 'atspl', h), findings({ hypotheses: ['Asha Testperson retried twice'] }));
    expect((h.store as FakeStore).puts[0]?.json).not.toContain('Asha Testperson');
  });

  test('the folder store writes a masked evidence/<entity>.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'note-evidence-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = createFolderRunStore({ runsDir: join(root, 'runs'), dataDir: join(root, 'data') });
    const h = harness({ store });
    await store.createRun(
      h.runId,
      redactPersisted({
        request_id: h.runId,
        interface: 'cli',
        requested_by: 'ops-reviewer',
        source: { kind: 'text' },
        messages: [{ ts: 't1', author: 'support', text: 'transfer stuck', is_parent: true }],
        attachments: [],
        hints: {},
        window: { from: AT, to: AT },
        received_at: AT,
      } as never),
    );
    const data = findings({
      evidence: [{ source: 'db', at: AT, query_or_path: 'harbor.accounts', summary: `${PHONE} owns ${ACCOUNT}` }],
    });
    const tool = toolOn('investigator', 'rtl', h);
    expect((await call(tool, data)).output).toMatchObject({ status: 'ok', data: { version: 1 } });
    expect((await call(tool, data)).output).toMatchObject({ status: 'ok', data: { evidence_id: 'rtl@v2', version: 2 } });
    const text = readFileSync(join(root, 'runs', h.runId, 'evidence', 'rtl.json'), 'utf8');
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain('98765');
    expect(JSON.parse(text).confidence).toBe('medium');
  });
});

describe('note_evidence: escalation store', () => {
  test('a low-confidence finding from a delegate-style context shows up as a trigger', async () => {
    const h = harness();
    // What investigatorFor(entity, runId) builds: entity and run id by closure.
    const [tool] = toolsFor('investigator', makeToolContext({ entity: 'atspl', runId: h.runId, deps: h.deps })).filter(
      (t) => t.name === 'note_evidence',
    );
    expect(tool).toBeDefined();
    const out = await call(tool as ToolDefinition, findings({ confidence: 'low', hypotheses: [] }));
    expect(out.output.status).toBe('ok');

    const snap = escalationFor(h.runId).snapshot();
    expect(snap.findings).toHaveLength(1);
    expect(snap.findings[0]).toMatchObject({ entity: 'atspl', findings: { confidence: 'low' } });
    expect(snap.triggered).toBe(true);
    expect(snap.reasons).toContain('low_confidence');
  });

  test('a refused call records nothing', async () => {
    const h = harness();
    await call(toolOn('investigator', 'ssfb', h), { ...findings({ confidence: 'low' }), entity: 'rtl' });
    expect(escalationFor(h.runId).snapshot().findings).toHaveLength(0);
  });
});

describe('note_evidence: schema scan', () => {
  // Walks a valibot schema and collects every object key, at any depth.
  function allKeys(schema: unknown, out: Set<string> = new Set()): Set<string> {
    const s = schema as { entries?: Record<string, unknown>; item?: unknown; wrapped?: unknown; options?: unknown[]; pipe?: unknown[] };
    if (s === null || typeof s !== 'object') return out;
    if (s.entries !== undefined) {
      for (const [key, child] of Object.entries(s.entries)) {
        out.add(key);
        allKeys(child, out);
      }
    }
    if (s.item !== undefined) allKeys(s.item, out);
    if (s.wrapped !== undefined) allKeys(s.wrapped, out);
    for (const o of s.options ?? []) allKeys(o, out);
    return out;
  }

  const cases = conformanceCases(toolModule);

  test('every mount is covered', () => {
    expect(new Set(cases.map((c) => c.mount))).toEqual(new Set(MOUNTS));
  });

  test.each(cases.map((c) => [c.mount, c.entity] as const))('%s/%s has no entity or run_id input', (mount, entity) => {
    const tool = toolModule.create(makeToolContext({ entity }), mount);
    expect(conformanceProblems(toolModule, tool)).toEqual([]);
    const top = Object.keys((tool.input as unknown as { entries: Record<string, unknown> }).entries);
    for (const key of FORBIDDEN_INPUT_KEYS) expect(top).not.toContain(key);
    const deep = allKeys(tool.input);
    expect(deep.has('run_id')).toBe(false);
    expect(deep.has('runId')).toBe(false);
    // EvidenceRef may name the source's entity; the findings' own entity never appears.
    expect(top).not.toContain('entity');
  });

  test('create() does not touch deps', () => {
    for (const { mount, entity } of cases) {
      expect(() => toolModule.create(makeToolContext({ entity }), mount)).not.toThrow();
    }
  });
});

describe('note_evidence: budget', () => {
  test('passes after the run budget is exhausted and does not count', async () => {
    const h = harness();
    while (h.budget.consumeToolCall('sql_select', 'ssfb').ok) {
      // use up the budget
    }
    expect(h.budget.state().exhausted).toBe(true);
    const callsBefore = h.budget.state().calls;
    const out = await call(toolOn('investigator_deep', 'ssfb', h), findings());
    expect(out.output.status).toBe('ok');
    expect(h.budget.state().calls).toBe(callsBefore);
    expect((h.store as FakeStore).puts).toHaveLength(1);
  });
});

describe('note_evidence: mounts', () => {
  test('mounted on triage, investigator, investigator_deep and code_walker', () => {
    expect([...toolModule.mounts].sort()).toEqual(['code_walker', 'investigator', 'investigator_deep', 'triage']);
    expect(toolModule.entities).toBe('all');
    for (const entity of ['ssfb', 'atspl', 'rtl'] as const) {
      for (const mount of ['investigator', 'investigator_deep'] as const) {
        const names = toolsFor(mount, makeToolContext({ entity })).map((t) => t.name);
        expect(names.filter((n) => n === 'note_evidence')).toHaveLength(1);
      }
    }
    expect(toolsFor('triage', makeToolContext()).map((t) => t.name)).toContain('note_evidence');
    expect(toolsFor('code_walker', makeToolContext()).map((t) => t.name)).toContain('note_evidence');
  });

  test('code_walker gets the CodeFindings schema, investigators get EntityFindings', () => {
    expect(Object.keys(noteEvidenceSchema('code_walker').entries).sort()).toEqual(
      ['claims', 'confidence', 'matches_known_pattern'].sort(),
    );
    expect(Object.keys(noteEvidenceSchema('investigator').entries)).toContain('hypotheses');
    const tool = toolModule.create(makeToolContext(), 'code_walker');
    expect(tool.input).toBe(noteEvidenceSchema('code_walker'));
  });

  test('CodeFindings is accepted on code_walker and stored under code', async () => {
    const h = harness();
    const out = await call(toolOn('code_walker', null, h), codeFindings());
    expect(out.output).toMatchObject({ status: 'ok', data: { evidence_id: 'code@v1', version: 1 } });
    expect((h.store as FakeStore).puts[0]?.key).toBe('code');
    expect(h.escalation.snapshot().findings[0]).toMatchObject({ entity: 'code', findings: { confidence: 'high' } });
    expect(h.audit.lines[0]).toMatchObject({ decision: 'allow', entity: null, target: 'TRIAGE_RUNS_DIR' });
  });

  test('EntityFindings is refused on code_walker', async () => {
    const h = harness();
    const out = await call(toolOn('code_walker', null, h), findings());
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('CodeFindings');
    expect(out.output.message).toContain('claims');
    expect((h.store as FakeStore).puts).toHaveLength(0);
  });

  test('CodeFindings is refused on an investigator', async () => {
    const h = harness();
    const out = await call(toolOn('investigator', 'ssfb', h), codeFindings());
    expect(out.output.status).toBe('refused');
    expect((h.store as FakeStore).puts).toHaveLength(0);
  });

  test('the triage mount refuses, because the root has no entity to record under', async () => {
    const h = harness();
    const out = await call(toolOn('triage', null, h), findings());
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('investigate_<entity>');
    expect((h.store as FakeStore).puts).toHaveLength(0);
    expect(h.escalation.snapshot().findings).toHaveLength(0);
    expect(h.audit.lines[0]).toMatchObject({ decision: 'deny', entity: null });
  });
});

describe('note_evidence: audit', () => {
  test('one allow line per accepted call, mock transport in mock mode, no free text', async () => {
    const h = harness();
    await call(toolOn('investigator', 'ssfb', h), findings({ hypotheses: [`owner of ${ACCOUNT}`] }));
    expect(h.audit.lines).toHaveLength(1);
    const line = h.audit.lines[0];
    expect(line).toMatchObject({
      run_id: h.runId,
      tool: 'note_evidence',
      decision: 'allow',
      entity: 'ssfb',
      transport: 'mock',
      target: 'TRIAGE_RUNS_DIR',
      exit: 'ok',
    });
    expect(line?.summary_redacted).toBe('note_evidence ssfb@v1 confidence medium');
  });

  test('real transport off mock mode, and the postgres target by name', async () => {
    const store = Object.assign(fakeRunStore(), { provider: 'postgres' as const });
    const h = harness({ store, mockMode: false });
    await call(toolOn('investigator', 'ssfb', h), findings());
    expect(h.audit.lines[0]).toMatchObject({ transport: 'real', target: 'TRIAGE_DB_URL' });
  });

  test('an aborted signal throws before anything is written', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const run = toolOn('investigator', 'ssfb', h).run as (c: unknown) => Promise<unknown>;
    await expect(run({ data: findings(), toolCallId: 'c', signal: controller.signal, log: console })).rejects.toThrow();
    expect((h.store as FakeStore).puts).toHaveLength(0);
    expect(h.audit.lines).toHaveLength(0);
  });
});
