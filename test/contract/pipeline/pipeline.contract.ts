// Pipeline contract scenarios (T10.9; D42; LLD 04 §2.1-§2.9; P1 §3.2).
//
// Three hand-written cases go through runCase (T10.4), which runs the real
// submission pipeline: identity, classifier, tier policy, dispatch to Triage,
// delegates, note_evidence and finish_report. Every model turn is scripted per
// caller with the faux script, mock mode is strict and nothing leaves the
// process.
//
// - pipeline-ssfb-single: one entity. The identity step runs on the
//   hand-written fixtures in fixtures/contract/pipeline/, investigate_ssfb
//   has one call refused by the scope gate and one refused as not configured,
//   records its findings, and the root ends with finish_report.
// - pipeline-ssfb-rtl-fanout: the LLD 04 multi-entity request. The SSFB
//   workflow copy has no row for the form and the RTL copy has it, so the root
//   sends investigate_ssfb and investigate_rtl in one turn. Both write
//   evidence files. The delegates' tool calls are asserted through the audit
//   lines, since the root stream only carries the root's own calls.
// - pipeline-classifier-failure: the classifier answers with invalid output.
//   The run still dispatches, on strong, with classifier_error recorded.
//
// Every run's usage is in the store too (D59): the classifier as seq 0 and the
// run's own calls as seq 1. ./usage.contract.ts covers usage in more depth.
//
// The fixture files are flat JSON files, one per case, each holding full
// fixture records. The fixture store reads cases/<case id>/<kind>/<entity>/
// <hash>.json, so beforeAll lays them out in a temp tree and boots the eval
// runtime with TRIAGE_FIXTURES_DIR pointing at it. The store checks every file
// against the fixture schema and its key when it serves it.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseClassification } from '../../../src/classify/classify.ts';
import { applyTierPolicy, RULES, toTierDecision } from '../../../src/classify/policy.ts';
import { checkNoRealIo, checkScopeNeverAllowed } from '../../../src/evals/audit-gates.ts';
import { type EvalCase, parseCaseYaml, policyContextFor, toIdChain } from '../../../src/evals/case-schema.ts';
import { type CaseResult, bootEvalRuntime, evalRuntime, runCase, stopEvalRuntime } from '../../../src/evals/driver.ts';
import { validateCaseIds } from '../../../src/evals/pseudonym.ts';
import { ULID_RE } from '../../../src/ingress/ulid.ts';
import { redactPersisted } from '../../../src/gate/redact.ts';
import { createFakeModel, text, toolCall, toolCalls, finish, type FakeStep } from '../../../src/mock/fake-model.ts';
import { hashKeyString, keyString, semanticKey } from '../../../src/mock/key.ts';
import { type Fixture, FixtureSchema } from '../../../src/mock/types.ts';
import type { AuditLine } from '../../../src/types/audit.ts';
import type { Classification } from '../../../src/types/classification.ts';
import type { Entity } from '../../../src/types/core.ts';
import type { EntityFindings } from '../../../src/types/findings.ts';
import { ReportSchema } from '../../../src/types/report.ts';
import { REPO_ROOT } from '../../support/home.ts';
import { brief, evalHome, reportDraft } from '../eval-support.ts';

const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cases');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures', 'contract', 'pipeline');

// A well-formed id that is in no case's chain, for the scope refusal.
const STRANGER = 'e3f5a7c9-1b2d-4f4a-8c6e-9d1f3b5a7c9e';

// Fixed run ids. A new ULID can hold six digits in a row; the persisted
// profile masks that in the stored report.json, whose run_id then fails
// RunIdSchema (accepted in T08.4). These ids are ULID-shaped with no such run,
// so the report check does not depend on the clock.
const RUN_IDS = Object.freeze({
  single: '01JPQ7PAPASSFBAAAAAAAAAAA1',
  fanout: '01JPQ7PAPARTXBAAAAAAAAAAA2',
  unparseable: '01JPQ7PAPACXFAAAAAAAAAAAA3',
  schema_invalid: '01JPQ7PAPACXFBAAAAAAAAAAA4',
});

// ------------------------------------------------------------------ files

const FixtureFileSchema = v.strictObject({
  case_id: v.string(),
  notes: v.string(),
  fixtures: v.array(v.unknown()),
});

type FixtureFile = { readonly file: string; readonly case_id: string; readonly fixtures: readonly Fixture[] };

function loadCase(id: string): EvalCase {
  const parsed = parseCaseYaml(readFileSync(join(CASES_DIR, `${id}.yaml`), 'utf8'));
  if (!parsed.ok) throw new Error(`${id}.yaml: ${parsed.problems.join('; ')}`);
  return parsed.case;
}

function caseIds(): string[] {
  return readdirSync(CASES_DIR)
    .filter((n) => /^pipeline-.*\.yaml$/.test(n))
    .map((n) => n.replace(/\.yaml$/, ''))
    .sort();
}

function fixtureFiles(): FixtureFile[] {
  return readdirSync(FIXTURES_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((name) => {
      const raw = v.parse(FixtureFileSchema, JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')));
      return { file: name, case_id: raw.case_id, fixtures: raw.fixtures.map((f) => v.parse(FixtureSchema, f)) };
    });
}

/** Writes every fixture record to <root>/cases/<case id>/<kind>/<entity>/<hash>.json. */
function layOutFixtures(root: string): void {
  for (const file of fixtureFiles()) {
    for (const f of file.fixtures) {
      const dir = join(root, 'cases', file.case_id, f.kind, f.entity);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${hashKeyString(f.key_string)}.json`), `${JSON.stringify(f, null, 2)}\n`);
    }
  }
}

// ------------------------------------------------------------------ scripts

type Decision = ReturnType<typeof toTierDecision>;

/** The decision the tier policy gives this classification for this case. */
function policyDecision(c: EvalCase, classification: unknown): Decision {
  return toTierDecision(applyTierPolicy(classification, policyContextFor(c)));
}

/**
 * A report draft for the case: the policy decision, the case's chain as stored
 * and the entities consulted. requested_by is a handle, because the egress
 * check refuses an email address in the report.
 */
function draftFor(c: EvalCase, decision: Decision, entities: readonly Entity[]): Record<string, unknown> {
  return reportDraft(decision.tier_final, {
    request: { current_ask: c.expected.current_ask ?? 'Find out what the customer is asking about.', requested_by: 'cx-oncall' },
    classification: decision,
    // The persisted profile masks the account number, as the egress check needs.
    id_chain: redactPersisted(toIdChain(c)).value,
    entities_consulted: [...entities],
  });
}

function findings(over: Partial<EntityFindings> & Pick<EntityFindings, 'hypotheses'>): EntityFindings {
  return {
    evidence: [
      {
        source: 'db',
        at: '2026-09-24T00:00:00.000Z',
        query_or_path: 'workflow and account state from the ID chain',
        summary: 'the basic state from the ID chain was read; the service database is not configured here',
      },
    ],
    timeline: [],
    confidence: 'medium',
    gaps: [],
    ...over,
  };
}

const WORKFLOW_SQL = 'SELECT status, current_step_identifier FROM workflow_executions WHERE reference_id = $1';
const ACCOUNT_SQL = 'SELECT account_status, debit_allowed FROM customer_account_mappings WHERE account_id = $1';

// ------------------------------------------------------------------ result helpers

const linesFor = (r: CaseResult, tool: string, entity?: Entity | null): AuditLine[] =>
  r.audit.filter((l) => l.tool === tool && (entity === undefined || l.entity === entity));

const hopShape = (hops: readonly { from: string; to?: string; source: string; status: string }[]) =>
  hops.map((h) => ({ from: h.from, ...(h.to !== undefined ? { to: h.to } : {}), source: h.source, status: h.status }));

/** The chain ids without the account number, which the persisted profile masks. */
function unmaskedIds(ids: Record<string, string | undefined>): Record<string, string | undefined> {
  const { account_number: _n, ...rest } = ids;
  return rest;
}

async function storedRun(r: CaseResult) {
  const run = await evalRuntime()?.store.getRun(r.run_id);
  if (run === undefined || run === null) throw new Error('the run is not in the store');
  return run;
}

function runDir(r: CaseResult): string {
  const rt = evalRuntime();
  if (rt === undefined) throw new Error('the eval runtime is not booted');
  return join(rt.config.paths.runsDir, r.run_id);
}

function expectCleanResult(r: CaseResult): void {
  expect(r.status).toBe('completed');
  expect(r.faux_failures).toEqual([]);
  expect(Object.values(r.turns_left).every((n) => n === 0)).toBe(true);
  expect(r.fixture_misses).toBe(0);
  expect(r.audit.length).toBeGreaterThan(0);
  expect(r.audit.every((l) => l.transport === 'mock')).toBe(true);
  expect(checkNoRealIo(r.audit)).toEqual({ ok: true, offending: [] });
}

// ------------------------------------------------------------------ set-up

const home = evalHome();
const fixturesTree = mkdtempSync(join(tmpdir(), 'triage-pipeline-fixtures-'));
const fake = createFakeModel();
const results: CaseResult[] = [];

beforeAll(async () => {
  layOutFixtures(fixturesTree);
  await bootEvalRuntime({ faux: fake, overrides: { TRIAGE_FIXTURES_DIR: fixturesTree } });
});

afterAll(async () => {
  await stopEvalRuntime();
  home.dispose();
  rmSync(fixturesTree, { recursive: true, force: true });
});

// ------------------------------------------------------------------ cases and fixtures

describe('pipeline cases and fixtures', () => {
  test('every case parses, is named after its file and passes validateCaseIds', () => {
    const ids = caseIds();
    expect(ids).toEqual(['pipeline-classifier-failure', 'pipeline-ssfb-rtl-fanout', 'pipeline-ssfb-single']);
    for (const id of ids) {
      const c = loadCase(id);
      expect(c.id).toBe(id);
      expect(c.label_source).toBe('synthetic');
      expect(validateCaseIds(c)).toEqual({ ok: true });
    }
  });

  test('the expected tier of each case with a faux classification is the policy result', () => {
    for (const id of caseIds()) {
      const c = loadCase(id);
      if (c.faux_classification === undefined) continue;
      expect(policyDecision(c, c.faux_classification).tier_final).toBe(c.expected.tier);
    }
  });

  test('the fixed run ids are ULIDs with no run of six digits', () => {
    for (const id of Object.values(RUN_IDS)) {
      expect(id).toMatch(ULID_RE);
      expect(id).not.toMatch(/\d{6}/);
    }
  });

  test('every fixture record is valid, keyed by its own key, and uses only ids from its case chain', () => {
    const files = fixtureFiles();
    expect(files.map((f) => f.case_id)).toEqual(['pipeline-ssfb-rtl-fanout', 'pipeline-ssfb-single']);
    for (const file of files) {
      expect(file.file).toBe(`${file.case_id}.json`);
      const chain = Object.values(loadCase(file.case_id).id_chain.ids);
      for (const f of file.fixtures) {
        expect(f.kind).toBe('resolve_identity');
        expect(f.meta.source).toBe('hand');
        expect(f.key_string).toBe(keyString(semanticKey(f.kind, f.key as never)));
        const key = f.key as { ids: [string, string][] };
        for (const [, value] of key.ids) expect(chain).toContain(value);
      }
    }
  });
});

// ------------------------------------------------------------------ single entity

describe('pipeline: single-entity happy path', () => {
  const c = loadCase('pipeline-ssfb-single');
  const decision = policyDecision(c, c.faux_classification);
  const chain = toIdChain(c);
  let r: CaseResult;

  beforeAll(async () => {
    r = await runCase(c, {
      identity: 'fixtures',
      runId: RUN_IDS.single,
      turns: {
        root: [
          toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }),
          finish(draftFor(c, decision, ['ssfb'])),
          text('report written'),
        ],
        investigate_ssfb: [
          // Out of scope: an id that is not in the run's chain.
          toolCall('sql_select', { service: 'rhythm', sql: ACCOUNT_SQL, params: [STRANGER] }),
          // In scope, then refused because the rhythm database is not configured in an eval home.
          toolCall('sql_select', { service: 'rhythm', sql: ACCOUNT_SQL, params: [chain.ids.account_id] }),
          toolCall(
            'note_evidence',
            findings({
              hypotheses: ['the balance view reads a cached account state that was not refreshed after activation'],
              gaps: ['not configured for ssfb:rhythm'],
            }),
          ),
          text('recorded'),
        ],
      },
    });
    results.push(r);
  });

  test('the run completes with a report that validates against ReportSchema', () => {
    expectCleanResult(r);
    expect(v.is(ReportSchema, r.report)).toBe(true);
    expect(r.report?.run_id).toBe(r.run_id);
    expect(r.report?.entities_consulted).toEqual(['ssfb']);
    expect(r.report?.escalated).toBe(false);
  });

  test('classification.json is persisted and tier_final is the policy result', async () => {
    expect(existsSync(join(runDir(r), 'classification.json'))).toBe(true);
    expect(existsSync(join(runDir(r), 'report.json'))).toBe(true);
    const run = await storedRun(r);
    expect(decision).toMatchObject({ tier_final: 'mid', rule_fired: RULES.proposed });
    expect(run.classification?.decision.tier_final).toBe(decision.tier_final);
    expect(run.classification?.decision.rule_fired).toBe(decision.rule_fired);
    expect(run.classification?.decision.proposed.matched_pattern_id).toBeUndefined();
    expect(r.report?.classification.tier_final).toBe(decision.tier_final);
  });

  test('the identity step resolved the case chain from the hand-written fixtures', async () => {
    const run = await storedRun(r);
    const stored = run.classification?.id_chain;
    expect(unmaskedIds(stored?.ids ?? {})).toEqual(unmaskedIds(chain.ids));
    // The persisted copy masks the account number.
    expect(stored?.ids.account_number).toBeDefined();
    expect(stored?.ids.account_number).not.toBe(chain.ids.account_number);
    expect(hopShape(stored?.hops ?? [])).toEqual(hopShape(chain.hops));
    const identity = linesFor(r, 'resolve_identity');
    expect(identity).toHaveLength(7);
    expect(identity.every((l) => l.exit === 'ok' && l.decision === 'allow')).toBe(true);
  });

  test('the root ran on the policy tier and only its own calls are in the root stream', () => {
    const root = r.model_calls.filter((m) => m.caller === 'root');
    expect(root).toHaveLength(3);
    expect(root.every((m) => m.model === decision.tier_final)).toBe(true);
    expect(r.tool_calls.map((t) => t.name)).toEqual(['task', 'finish_report']);
  });

  test('the investigator calls are audited: a scope refusal, a not-configured refusal and the evidence', () => {
    const sql = linesFor(r, 'sql_select', 'ssfb');
    expect(sql).toHaveLength(2);
    expect(sql[0]).toMatchObject({ decision: 'deny', exit: 'refused', service: 'rhythm' });
    expect(sql[0]?.reason).toMatch(/^scope: /);
    expect(sql[1]).toMatchObject({ decision: 'deny', exit: 'not_configured', target: 'SSFB_RHYTHM_DB_URL' });
    expect(linesFor(r, 'note_evidence', 'ssfb')).toHaveLength(1);
    expect(linesFor(r, 'finish_report')).toHaveLength(1);
    const scope = checkScopeNeverAllowed(r.audit, chain, [STRANGER]);
    expect(scope.ok).toBe(true);
    expect(scope.allowed).toEqual([]);
    // The refused call carried the stranger id, masked, and was counted as an attempt.
    expect(scope.attempted_denies).toBe(1);
    expect(sql[0]?.reason).not.toContain(STRANGER);
  });

  test('evidence is written for ssfb only', async () => {
    const run = await storedRun(r);
    expect(Object.keys(run.evidence).sort()).toEqual(['ssfb']);
    expect(existsSync(join(runDir(r), 'evidence', 'ssfb.json'))).toBe(true);
  });
});

// ------------------------------------------------------------------ fan-out

describe('pipeline: SSFB and RTL fan-out', () => {
  const c = loadCase('pipeline-ssfb-rtl-fanout');
  const decision = policyDecision(c, c.faux_classification);
  const chain = toIdChain(c);
  let r: CaseResult;

  beforeAll(async () => {
    r = await runCase(c, {
      identity: 'fixtures',
      runId: RUN_IDS.fanout,
      turns: {
        root: [
          // One assistant turn with both tasks, so Flue runs the delegates in parallel (LLD 04 §2.5).
          toolCalls([
            { name: 'task', args: { agent: 'investigate_ssfb', prompt: brief('ssfb') } },
            { name: 'task', args: { agent: 'investigate_rtl', prompt: brief('rtl') } },
          ]),
          finish(draftFor(c, decision, ['ssfb', 'rtl'])),
          text('report written'),
        ],
        investigate_ssfb: [
          toolCall('sql_select', { service: 'workflow', sql: WORKFLOW_SQL, params: [chain.ids.form_id] }),
          toolCall(
            'note_evidence',
            findings({
              hypotheses: ['the SSFB workflow copy has no execution for this form, so onboarding runs on the RTL side'],
              gaps: ['not configured for ssfb:workflow'],
              suggested_next_entity: 'rtl',
            }),
          ),
          text('recorded'),
        ],
        investigate_rtl: [
          toolCall('sql_select', { service: 'workflow', sql: WORKFLOW_SQL, params: [chain.ids.form_id] }),
          toolCall(
            'note_evidence',
            findings({
              hypotheses: ['the RTL onboarding workflow is waiting at KYC_REVIEW'],
              gaps: ['not configured for rtl:workflow'],
            }),
          ),
          text('recorded'),
        ],
      },
    });
    results.push(r);
  });

  test('the run completes with a valid report that consulted both entities', async () => {
    expectCleanResult(r);
    expect(v.is(ReportSchema, r.report)).toBe(true);
    expect(r.report?.entities_consulted).toEqual(['ssfb', 'rtl']);
    // SSFB points at RTL, so only one entity blames itself and no conflict fires.
    expect(r.report?.escalated).toBe(false);
    const run = await storedRun(r);
    expect(run.classification?.decision.tier_final).toBe(decision.tier_final);
    expect(r.report?.classification.tier_final).toBe(decision.tier_final);
  });

  test('the identity step found the form on the RTL workflow copy, not the SSFB one', async () => {
    const run = await storedRun(r);
    expect(hopShape(run.classification?.id_chain.hops ?? [])).toEqual(hopShape(chain.hops));
    expect(linesFor(r, 'resolve_identity', 'rtl')).toHaveLength(1);
    expect(linesFor(r, 'resolve_identity')).toHaveLength(8);
  });

  test('both tasks were sent in one root turn and both results came back before the next one', () => {
    const root = r.model_calls.filter((m) => m.caller === 'root');
    expect(root).toHaveLength(3);
    const tasks = r.tool_calls.filter((t) => t.name === 'task');
    expect(tasks.map((t) => (t.input as { agent: string }).agent).sort()).toEqual(['investigate_rtl', 'investigate_ssfb']);
    const second = root[1];
    expect(second?.toolResults.filter((t) => t.toolName === 'task')).toHaveLength(2);
    expect(second?.toolResults.every((t) => !t.isError)).toBe(true);
  });

  test('evidence/ssfb.json and evidence/rtl.json are written', async () => {
    const dir = join(runDir(r), 'evidence');
    expect(existsSync(join(dir, 'ssfb.json'))).toBe(true);
    expect(existsSync(join(dir, 'rtl.json'))).toBe(true);
    const run = await storedRun(r);
    expect(Object.keys(run.evidence).sort()).toEqual(['rtl', 'ssfb']);
    expect(run.evidence.ssfb?.findings).toMatchObject({ suggested_next_entity: 'rtl', confidence: 'medium' });
    expect(run.evidence.rtl?.findings).toMatchObject({ hypotheses: ['the RTL onboarding workflow is waiting at KYC_REVIEW'] });
  });

  test("the investigators' calls are asserted from the audit lines, not the root stream", () => {
    // The root stream has the root's calls only.
    expect(r.tool_calls.map((t) => t.name).sort()).toEqual(['finish_report', 'task', 'task']);
    for (const [entity, target] of [
      ['ssfb', 'SSFB_WORKFLOW_DB_URL'],
      ['rtl', 'RTL_WORKFLOW_DB_URL'],
    ] as const) {
      const sql = linesFor(r, 'sql_select', entity);
      expect(sql).toHaveLength(1);
      expect(sql[0]).toMatchObject({ decision: 'deny', exit: 'not_configured', service: 'workflow', target, transport: 'mock' });
      const notes = linesFor(r, 'note_evidence', entity);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ decision: 'allow', transport: 'mock' });
    }
    expect(linesFor(r, 'sql_select', 'atspl')).toEqual([]);
    expect(r.model_calls.filter((m) => m.caller === 'investigate_ssfb')).toHaveLength(3);
    expect(r.model_calls.filter((m) => m.caller === 'investigate_rtl')).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ classifier failure

describe('pipeline: classifier failure -> strong', () => {
  const c = loadCase('pipeline-classifier-failure');

  // Two kinds of invalid output: no JSON at all, and JSON that fails the schema.
  const outputs = {
    unparseable: 'I cannot tell what this thread is about.',
    schema_invalid: JSON.stringify({ category: 'not_a_category', tier_proposed: 'cheap', confidence: 2 }),
  } as const;
  const runs: Partial<Record<keyof typeof outputs, CaseResult>> = {};

  const turnsFor = (answer: string, decision: Decision): Record<string, readonly FakeStep[]> => ({
    classifier: [text(answer)],
    root: [
      toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }),
      finish(draftFor(c, decision, ['ssfb'])),
      text('report written'),
    ],
    investigate_ssfb: [
      toolCall('note_evidence', findings({ hypotheses: ['the thread gives too little to name a fault'], confidence: 'medium' })),
      text('recorded'),
    ],
  });

  beforeAll(async () => {
    for (const [kind, answer] of Object.entries(outputs) as [keyof typeof outputs, string][]) {
      const decision = policyDecision(c, parseClassification(answer, false));
      const r = await runCase(c, { runId: RUN_IDS[kind], turns: turnsFor(answer, decision) });
      runs[kind] = r;
      results.push(r);
    }
  });

  for (const kind of Object.keys(outputs) as (keyof typeof outputs)[]) {
    describe(kind, () => {
      const expected: Classification = parseClassification(outputs[kind], false);

      test('the classifier output is invalid, so classifier_error is set and the category is unknown', () => {
        expect(expected.category).toBe('unknown');
        expect(expected.classifier_error).toBeTruthy();
      });

      test('the run still dispatches and completes with a valid report', () => {
        const r = runs[kind] as CaseResult;
        expectCleanResult(r);
        expect(v.is(ReportSchema, r.report)).toBe(true);
        expect(r.tool_calls.map((t) => t.name)).toEqual(['task', 'finish_report']);
        expect(r.model_calls.filter((m) => m.caller === 'classifier')).toHaveLength(1);
      });

      test('tier_final is strong by rule 1 and classifier_error is recorded', async () => {
        const r = runs[kind] as CaseResult;
        const run = await storedRun(r);
        expect(existsSync(join(runDir(r), 'classification.json'))).toBe(true);
        expect(run.classification?.decision).toMatchObject({ tier_final: 'strong', rule_fired: RULES.invalidOrUnknown });
        expect(run.classification?.decision.proposed.category).toBe('unknown');
        expect(run.classification?.decision.proposed.classifier_error).toBe(expected.classifier_error);
        expect(r.report?.classification.tier_final).toBe('strong');
        expect(r.report?.classification.proposed.classifier_error).toBe(expected.classifier_error);
      });

      test('the root and the delegate ran on the strong model', () => {
        const r = runs[kind] as CaseResult;
        const root = r.model_calls.filter((m) => m.caller === 'root');
        expect(root).toHaveLength(3);
        expect(root.every((m) => m.model === 'strong')).toBe(true);
        expect(linesFor(r, 'note_evidence', 'ssfb')).toHaveLength(1);
      });
    });
  }
});

// ------------------------------------------------------------------ result shape

describe('pipeline: runCase output', () => {
  test('every run has run_id, report, tool_calls, audit and fixture_misses=0', () => {
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(Object.keys(r)).toEqual(expect.arrayContaining(['run_id', 'report', 'tool_calls', 'audit', 'fixture_misses']));
      expect(typeof r.run_id).toBe('string');
      expect(r.report).not.toBeNull();
      expect(r.tool_calls.length).toBeGreaterThan(0);
      expect(r.audit.every((l) => l.run_id === r.run_id)).toBe(true);
      expect(r.fixture_misses).toBe(0);
      expect(r.cost_usd).toBe(0);
      expect(r.cost_partial).toBe(false);
    }
    expect(results.map((r) => r.run_id).sort()).toEqual(Object.values(RUN_IDS).sort());
    // No model call reached a queue it was not scripted for.
    expect(fake.failures()).toEqual([]);
  });

  test('every run stores the classifier call as seq 0 and its own calls as seq 1, final and at $0 (D59)', async () => {
    for (const r of results) {
      const run = await storedRun(r);
      expect(run.usage.map((u) => [u.seq, u.final])).toEqual([
        [0, true],
        [1, true],
      ]);
      // Invalid classifier output is still a call that did not fail.
      expect(run.usage[0]?.rows.map((row) => [row.model, row.agent, row.purpose, row.calls, row.failed_calls])).toEqual([
        ['faux/classifier', 'classifier', 'classify', 1, 0],
      ]);
      const agents = run.usage[1]?.rows.map((row) => row.agent) ?? [];
      expect(agents).toContain('triage');
      expect(agents.some((a) => a.startsWith('investigate_'))).toBe(true);
      // Prior cases are off and MODEL_EMBEDDING is blank in the eval home, so nothing is embedded.
      expect(agents).not.toContain('embedder');
      expect(run.usage.flatMap((u) => u.rows).every((row) => row.usd === 0)).toBe(true);
    }
  });
});
