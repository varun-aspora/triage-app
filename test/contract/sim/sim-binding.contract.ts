// SIM eval case, scripted reference path (docs/11 §5, D94).
//
// evals/cases/sim-binding-stuck goes through runCase on its own fixtures
// (fixtures/cases/sim-binding-stuck/, served by semantic key) with the calls
// the SIM-binding pattern's first queries name: the device id from the RTL
// app-server hits, guardian attempts by device id, the empty refresh_tokens
// and harbor form lookups, harbor polls, guardian callbacks (asked twice, so
// the repeat cache answers the second), the kong-vendor webhook count and the
// RTL workflow rows. Then the section 5 pass criteria are asserted over the
// run's report, audit lines and run log.
//
// This proves the case can be solved from its fixtures and that the criteria
// read a run's report, audit lines and run log correctly. It proves nothing
// about a model: the turns are scripted. The owner judges the model by
// re-running the ticket and comparing with the expected answer in case.yaml.
//
// The eval home keeps every DSN and Quickwit key blank, and the pipeline
// answers not configured before it looks for a fixture. As in the strict-miss
// contract, loadRegistry is wrapped so the guardian, harbor and RTL workflow
// databases and the SSFB and RTL Quickwit report 'ok' with a placeholder. The
// config the eval guard checks stays blank, mock mode is forced, and a
// mock-mode runtime has no connectors, so nothing can use the placeholder.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { applyTierPolicy, toTierDecision } from '../../../src/classify/policy.ts';
import { type EvalCase, parseCaseYaml, policyContextFor, toIdChain } from '../../../src/evals/case-schema.ts';
import { bootEvalRuntime, type CaseResult, evalRuntime, runCase, stopEvalRuntime } from '../../../src/evals/driver.ts';
import {
  countNotConfigured,
  journeyKeyedCitations,
  productionCalls,
  ranAgainRepeats,
  readKnowledgeTexts,
  reportText,
  untracedLogValues,
} from '../../../src/evals/run-checks.ts';
import { redactPersisted } from '../../../src/gate/redact.ts';
import { createFakeModel, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import { REUSED_MARK } from '../../../src/runlog/actions.ts';
import { flushRunEventLog, type RunEventLine } from '../../../src/runlog/event-log.ts';
import { readRunEvents } from '../../../src/runlog/read.ts';
import type { RunId } from '../../../src/types/core.ts';
import { REPO_ROOT } from '../../support/home.ts';
import { brief, evalHome, reportDraft } from '../eval-support.ts';
import { expectFinished, expectNoRealIo, outputOf, toolResults } from '../safety/safety-support.ts';

vi.mock('../../../src/config/registry.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/config/registry.ts')>();
  type Registry = import('../../../src/config/registry.ts').Registry;
  const PLACEHOLDER = 'https://fixture-only.invalid';
  const DBS = new Set(['ssfb:guardian', 'ssfb:harbor', 'rtl:workflow']);
  // An 'ok' capability whose value is a non-enumerable placeholder, like the real ones.
  const ok = <T extends object>(visible: T, value: string): T & { readonly status: 'ok'; readonly value: string } => {
    const out = { ...visible, status: 'ok' as const };
    Object.defineProperty(out, 'value', { value, enumerable: false });
    return Object.freeze(out) as T & { readonly status: 'ok'; readonly value: string };
  };
  const fixtureOnly = (registry: Registry): Registry =>
    Object.freeze({
      ...registry,
      serviceDb: (entity, service) => {
        const cap = registry.serviceDb(entity, service);
        if (cap === undefined || cap.status === 'ok' || !DBS.has(`${entity}:${service}`)) return cap;
        return ok({ envName: cap.envName, naiveTimestampZone: cap.naiveTimestampZone }, PLACEHOLDER);
      },
      quickwit: (entity) => {
        const cap = registry.quickwit(entity);
        if (entity === 'atspl' || cap.status === 'ok') return cap;
        return Object.freeze({ status: 'ok', transport: 'qw', index: 'fixture-only', context: 'fixture-only', maxConcurrency: 1, maxHits: 500 });
      },
    } satisfies Registry);
  return { ...original, loadRegistry: (...args: Parameters<typeof original.loadRegistry>) => fixtureOnly(original.loadRegistry(...args)) };
});

const CASE_DIR = join(REPO_ROOT, 'evals', 'cases', 'sim-binding-stuck');
// ULID-shaped with no run of six digits, so the stored report keeps its run_id.
const RUN_ID = '01JPQ7PASXMBNDAAAAAAAAAAA1' as RunId;

function loadCase(): EvalCase {
  const parsed = parseCaseYaml(readFileSync(join(CASE_DIR, 'case.yaml'), 'utf8'));
  if (!parsed.ok) throw new Error(`case.yaml: ${parsed.problems.join('; ')}`);
  return parsed.case;
}

const c = loadCase();
const USER = c.id_chain.ids.aspora_user_id as string;
// The fixtures' placeholder device id.
const DEVICE = 'de71ce00-0000-4000-8000-000000000002';
// RTL Part 1 completion, and the same time misread as IST (D73).
const PART_1 = '2026-09-07T10:03:57.000Z';
const PART_1_IST_SHIFTED = '2026-09-07T04:33:57.000Z';
// "No SMS arrived", said some way in the findings.
const NO_SMS =
  /(no|zero|none of the) (inbound |incoming )?(sms|text message|vendor callback|callback)|sms[^.\n]{0,60}(never|not|did not|didn't) (arrive|reach|get|come)/i;

const ATTEMPTS_SQL =
  'SELECT verification_id, status, sim_country_code, registration_country_code, polling_attempts, created_at, verification_completion_deadline FROM device_auth_attempts WHERE device_id = $1 ORDER BY created_at';
const CALLBACKS = { service: 'guardian', message: 'Processing Twilio callback', columns: ['iso_country_code'], order: 'oldest' };

const data = (id: string) => `/data/${id}.json`;

function draft(): Record<string, unknown> {
  const decision = toTierDecision(applyTierPolicy(c.faux_classification, policyContextFor(c)));
  const guardian = { source: 'db', entity: 'ssfb', service: 'guardian', raw_ref: data('sim-guardian-attempts') };
  const workflow = { source: 'db', entity: 'rtl', service: 'workflow', raw_ref: data('sim-rtl-workflow') };
  return reportDraft(decision.tier_final, {
    request: { current_ask: c.expected.current_ask, requested_by: 'cx-oncall' },
    classification: decision,
    id_chain: redactPersisted(toIdChain(c)).value,
    entities_consulted: ['rtl', 'ssfb'],
    status: 'pending_user',
    confidence: 'medium',
    confidence_reason: 'Guardian attempts, harbor polls and the callback and webhook counts agree.',
    root_cause: {
      statement:
        'No inbound SMS ever reached the vendor or guardian: all 17 attempts on the one device stay PENDING with sim_country_code 0. The SMS is not leaving the phone or the carrier does not deliver it.',
      code_refs: [],
    },
    current_state: [
      { item: 'SIM-binding attempts on the device', value: '17, all PENDING, sim_country_code 0', taken_at: '2026-09-24T11:55:09.000Z', source: guardian },
    ],
    timeline: [
      { at: PART_1, entity: 'rtl', what: 'RTL Part 1 (NRI_ONBOARDING_UAE) completed', source: workflow },
      { at: '2026-09-07T10:04:06.000Z', entity: 'ssfb', what: 'first SIM-binding attempt on the device', source: guardian },
    ],
    cx_answer: {
      action_owner: 'user',
      money_safe: 'yes',
      should_retry: 'yes',
      reply_text: 'Please retry once and stay on the screen, check Messages shows the SMS as Sent, and that the registered SIM is the default for messages.',
    },
    // Near-duplicates finish_report merges (D95).
    gaps: [
      'no harbor form for the user',
      'no harbor form for the user yet, expected before VERIFIED',
      'the app cannot report whether the SMS was sent',
    ],
  });
}

const knowledge = readKnowledgeTexts(join(REPO_ROOT, 'knowledge'));
const fake = createFakeModel();
const home = evalHome();
let r: CaseResult;
let events: RunEventLine[] = [];

beforeAll(async () => {
  // The eval home serves <repo>/fixtures, and runCase reads cases/<case id>/ first.
  await bootEvalRuntime({ faux: fake });
  r = await runCase(c, {
    runId: RUN_ID,
    turns: {
      root: [
        toolCall('task', { agent: 'investigate_rtl', prompt: brief('rtl') }),
        toolCall('task', {
          agent: 'investigate_ssfb',
          prompt: `${brief('ssfb')}\nJourney keys: x-device-id = ${DEVICE} (rtl app-server-service hits by the user id)`,
        }),
        finish(draft()),
        text('report written'),
      ],
      investigate_rtl: [
        toolCall('logs_search', { service: 'appserver', terms: [USER], columns: ['x-device-id'] }, { id: 'sim-rtl-logs' }),
        toolCall(
          'sql_select',
          {
            service: 'workflow',
            sql: 'SELECT workflow_identifier, status, current_step_identifier, created_at, updated_at FROM workflow_executions WHERE reference_id = $1',
            params: [USER],
          },
          { id: 'sim-rtl-workflow' },
        ),
        toolCall('note_evidence', {
          evidence: [{ source: 'db', at: PART_1, query_or_path: 'rtl workflow_executions by the user id', summary: 'Part 1 completed' }],
          timeline: [],
          hypotheses: ['Part 1 is done; SIM binding is on the SSFB side'],
          confidence: 'high',
          gaps: [],
          suggested_next_entity: 'ssfb',
        }),
        text('recorded'),
      ],
      investigate_ssfb: [
        toolCall('sql_select', { service: 'guardian', sql: 'SELECT subject, device_id, status FROM refresh_tokens WHERE subject = $1', params: [USER] }),
        toolCall('sql_select', { service: 'guardian', sql: ATTEMPTS_SQL, params: [DEVICE] }, { id: 'sim-guardian-attempts' }),
        toolCall('sql_select', { service: 'harbor', sql: 'SELECT form_id, status FROM account_forms WHERE external_user_ref = $1', params: [USER] }),
        toolCall('logs_search', { service: 'harbor', message: 'checking verification status', terms: [DEVICE] }),
        toolCall('logs_search', CALLBACKS),
        toolCall('logs_search', CALLBACKS),
        toolCall('logs_search', { message: 'POST /guardian/api/v1/callbacks/vendors/twilio/sms', count: true }),
        toolCall('note_evidence', {
          evidence: [
            { source: 'db', at: '2026-09-24T11:52:09.000Z', query_or_path: 'guardian device_auth_attempts by device_id', summary: '17 attempts, all PENDING' },
            { source: 'logs', at: '2026-09-24T11:55:09.000Z', query_or_path: 'guardian and kong-vendor callbacks', summary: 'no inbound SMS callback' },
          ],
          timeline: [],
          hypotheses: ['the SMS never leaves the phone or the carrier does not deliver it'],
          confidence: 'medium',
          gaps: [],
        }),
        text('recorded'),
      ],
    },
  });
  await flushRunEventLog();
  const runsDir = evalRuntime()?.config.paths.runsDir;
  if (runsDir === undefined) throw new Error('no eval runtime');
  events = (await readRunEvents(runsDir, r.run_id, { limit: 5000 })).events;
});

afterAll(async () => {
  await stopEvalRuntime();
  home.dispose();
});

describe('SIM eval case: scripted reference path', () => {
  test('the run completes on the case fixtures, with no miss and no real I/O', () => {
    expectFinished(r);
    expect(r.fixture_misses).toBe(0);
    expectNoRealIo(r);
  });

  test('the device id from the RTL hits opens the guardian attempts (D77, Q13), which are all PENDING', () => {
    const attempts = toolResults(r, 'investigate_ssfb', 'sql_select').find((t) => t.toolCallId === 'sim-guardian-attempts');
    expect(attempts?.isError).toBe(false);
    const rows = (outputOf(attempts)?.data as { rows?: { status: string; sim_country_code: number }[] } | undefined)?.rows ?? [];
    expect(rows).toHaveLength(17);
    expect(rows.every((row) => row.status === 'PENDING' && row.sim_country_code === 0)).toBe(true);
    const sql = r.audit.filter((l) => l.tool === 'sql_select');
    expect(sql.every((l) => l.decision === 'allow' && l.exit === 'ok')).toBe(true);
  });

  test('the RTL workflow result carries the Part 1 time as UTC, not shifted', () => {
    const wf = toolResults(r, 'investigate_rtl', 'sql_select').find((t) => t.toolCallId === 'sim-rtl-workflow');
    expect(wf?.text).toContain('2026-09-07T10:03:57Z');
    expect(wf?.text).not.toContain('04:33:57');
  });

  test('the second identical callbacks search is answered from the repeat cache (D79)', () => {
    const logs = r.audit.filter((l) => l.tool === 'logs_search');
    expect(logs.map((l) => l.exit)).toEqual(['ok', 'ok', 'ok', 'reused', 'ok']);
  });

  test('finish_report merged the near-duplicate gaps (D95)', () => {
    const gaps = r.report?.gaps ?? [];
    expect(gaps).toContain('no harbor form for the user yet, expected before VERIFIED');
    expect(gaps).not.toContain('no harbor form for the user');
  });

  test('the run-log checks read these events: without the reuse note or with a made-up label they fail', () => {
    const rewrite = (from: string, to: string): RunEventLine[] => JSON.parse(JSON.stringify(events).replaceAll(from, to)) as RunEventLine[];
    expect(ranAgainRepeats(events)).toEqual([]);
    expect(ranAgainRepeats(rewrite(REUSED_MARK, 'ran')).map((c) => c.name)).toEqual(['logs_search']);
    const made = rewrite('checking verification status', 'polling the sim state');
    expect(untracedLogValues(made, knowledge)).toEqual([{ tool_call: expect.any(String), field: 'message' }]);
  });

  test('the report meets the section 5 criteria: root cause found, device-keyed attempts, no SMS, Part 1 in UTC', () => {
    const report = r.report;
    if (report === null) throw new Error('no report');
    // Root cause found: report-format.md puts pending_user ahead of root_cause_confirmed, and the next step here is the user's.
    expect(['pending_user', 'root_cause_confirmed']).toContain(report.status);
    expect(['medium', 'high']).toContain(report.confidence);
    expect(report.root_cause).not.toBeNull();
    expect(journeyKeyedCitations(report, events, { entity: 'ssfb', service: 'guardian' })).toBeGreaterThan(0);
    expect(reportText(report)).toMatch(NO_SMS);
    const same = (a: string) => (b: string) => Date.parse(a) === Date.parse(b);
    expect(report.timeline.some((row) => row.entity === 'rtl' && same(PART_1)(row.at))).toBe(true);
    const times = [...report.timeline.map((row) => row.at), ...report.current_state.map((row) => row.taken_at)];
    expect(times.some(same(PART_1_IST_SHIFTED))).toBe(false);
    expect(reportText(report)).not.toContain(PART_1_IST_SHIFTED.slice(0, 19));
  });

  test('the run meets the section 5 limits: no not-configured call, no repeat run again, at most 60 production calls, no untraced log value', () => {
    expect(countNotConfigured(r.audit)).toBe(0);
    expect(ranAgainRepeats(events)).toEqual([]);
    expect(productionCalls(r.audit)).toBeLessThanOrEqual(60);
    expect(untracedLogValues(events, knowledge)).toEqual([]);
  });
});
