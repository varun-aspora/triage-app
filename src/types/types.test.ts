import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import { AuditLineSchema } from './audit.ts';
import {
  CATEGORIES,
  ClassificationSchema,
  PreflightWarningSchema,
  PriorCaseSchema,
  TierDecisionSchema,
  TriageInitSchema,
} from './classification.ts';
import {
  ENTITIES,
  EntitySchema,
  InterfaceSchema,
  KNOWN_ID_KEYS,
  KnownIdsSchema,
  RunIdSchema,
  TakenAtSchema,
  TierSchema,
  TimeWindowSchema,
} from './core.ts';
import { CodeFindingsSchema, EntityFindingsSchema, EvidenceRefSchema } from './findings.ts';
import { IdChainSchema } from './id-chain.ts';
import { ReportDraftSchema, ReportSchema, SuggestedFixSchema } from './report.ts';
import { TriageRequestSchema } from './request.ts';
import { notConfigured, ok, refused, ToolEnvelopeSchema, ToolResultSchema, unreachable } from './tool-result.ts';

// All values below are synthetic.
const T = '2026-09-20T10:00:00.000Z';

const request = () => ({
  request_id: '01J8ZQ7XK3TESTRUN0000000000',
  interface: 'cli',
  requested_by: 'ops@example.test',
  source: { kind: 'text' },
  messages: [{ ts: '1726826400.000100', author: 'U000TEST', text: 'card not delivered', is_parent: true }],
  attachments: [],
  hints: { entities: ['atspl'], ids: { customer_id: 'cust-test-1' } },
  window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-23T00:00:00.000Z' },
  received_at: T,
});

const classification = () => ({
  category: 'delivery',
  subcategory: 'welcome_letter',
  entities_likely: ['atspl'],
  current_ask: 'Why was the welcome letter not delivered?',
  money_moved: false,
  misdirected_funds: false,
  tier_proposed: 'cheap',
  confidence: 0.8,
  missing_info: [],
  images_seen: false,
});

const tierDecision = () => ({ proposed: classification(), tier_final: 'mid', rule_fired: 'rule_4_money_moved' });

const idChain = () => ({
  ids: { horus_customer_id: 'horus-test-1', account_form_id: 'form-test-1', user_id: 'user-test-1' },
  hops: [
    { from: 'horus_customer_id', to: 'account_form_id', source: 'ssfb:harbor.customer', status: 'resolved', taken_at: T },
    { from: 'form_id', source: 'ssfb:workflow_op', status: 'unreachable', taken_at: T },
  ],
  basic_state: [{ item: 'account_forms.status_v2', value: 'APPROVED', taken_at: T, source: 'ssfb:harbor' }],
});

const triageInit = () => ({ request: request(), classification: tierDecision(), id_chain: idChain() });

const evidenceRef = () => ({ source: 'db', entity: 'atspl', service: 'package', raw_ref: '/data/call-1.json' });

const entityFindings = () => ({
  evidence: [
    { source: 'db', at: T, query_or_path: 'delivery_requests by external_ref_id', summary: 'one request, status FAILED' },
  ],
  timeline: [{ at: T, what: 'delivery request created', source: evidenceRef() }],
  hypotheses: ['vendor rejected the address'],
  confidence: 'medium',
  gaps: ['atspl:package API not configured'],
});

const codeFindings = () => ({
  claims: [{ repo: 'package-service', file: 'src/delivery.ts', lines: '10-20', what_it_shows: 'retry is skipped on 4xx' }],
  confidence: 'high',
});

const suggestedFix = () => ({
  title: 'Retry delivery',
  kind: 'curl',
  command: 'curl -X POST "$ATSPL_PACKAGE_API_URL/retry" -H "Authorization: Bearer $TOKEN"',
  preconditions: ['address fixed'],
  verify_with: 'SELECT status FROM delivery_requests WHERE id = $1',
});

const report = () => ({
  run_id: '01J8ZQ7XK3TESTRUN0000000000',
  env_label: 'local',
  generated_at: T,
  request: { current_ask: 'Why was the welcome letter not delivered?', requested_by: 'ops@example.test' },
  classification: tierDecision(),
  id_chain: idChain(),
  current_state: [{ item: 'delivery status', value: 'FAILED', taken_at: T, source: evidenceRef() }],
  timeline: [{ at: T, entity: 'atspl', what: 'vendor rejected', source: evidenceRef() }],
  root_cause: { statement: 'Vendor rejected the address', code_refs: [{ repo: 'package-service', file: 'a.ts', lines: '1-2' }] },
  scope: { kind: 'single' },
  status: 'root_cause_confirmed',
  cx_answer: { action_owner: 'unknown', money_safe: 'yes', should_retry: 'wait', reply_text: 'We are checking.' },
  actions: { cx: [], eng: [], ops_bank: [] },
  suggested_fix: [suggestedFix()],
  confidence: 'medium',
  confidence_reason: 'vendor event quoted',
  evidence_ladder: ['db', 'logs'],
  entities_consulted: ['atspl'],
  gaps: [],
  escalated: false,
  escalation_reasons: [],
  images_seen: false,
  repo_commits: [{ repo: 'package-service', commit: 'abc1234' }],
  cost: { models: { 'anthropic/test': { calls: 2, input_tokens: 100, output_tokens: 50 } }, wall_ms: 1200 },
});

const auditLine = () => ({
  run_id: '01J8ZQ7XK3TESTRUN0000000000',
  ts: T,
  interface: 'cli',
  entity: 'atspl',
  tool: 'sql_select',
  decision: 'allow',
  service: 'package',
  target: 'ATSPL_PACKAGE_DB_URL',
  transport: 'mock',
  summary_redacted: 'SELECT on delivery_requests, 1 row',
  duration_ms: 12,
  exit: 'ok',
});

const parses = (schema: v.GenericSchema, value: unknown) => v.safeParse(schema, value).success;
const without = <O extends Record<string, unknown>>(o: O, key: keyof O) => {
  const copy: Record<string, unknown> = { ...o };
  delete copy[key as string];
  return copy;
};

describe('valid samples parse', () => {
  const cases: [string, v.GenericSchema, unknown][] = [
    ['KnownIds', KnownIdsSchema, { old_user_id: 'u-1', account_form_id: 'f-1' }],
    ['TriageRequest', TriageRequestSchema, request()],
    ['IdChain', IdChainSchema, idChain()],
    ['Classification', ClassificationSchema, classification()],
    ['TierDecision', TierDecisionSchema, tierDecision()],
    ['PriorCase', PriorCaseSchema, { category: 'delivery', report_status: 'resolved', age_days: 12, similarity: 0.81 }],
    ['PreflightWarning', PreflightWarningSchema, { step: 'tunnel', message: 'ssfb tunnel is down' }],
    ['TriageInit', TriageInitSchema, triageInit()],
    ['EvidenceRef', EvidenceRefSchema, evidenceRef()],
    ['EntityFindings', EntityFindingsSchema, entityFindings()],
    ['CodeFindings', CodeFindingsSchema, codeFindings()],
    ['SuggestedFix', SuggestedFixSchema, suggestedFix()],
    ['Report', ReportSchema, report()],
    ['AuditLine', AuditLineSchema, auditLine()],
    ['ToolResult', ToolResultSchema, { status: 'ok', taken_at: T, data: { rows: 1 } }],
    ['ToolEnvelope', ToolEnvelopeSchema, ok({ rows: 1 })],
  ];
  for (const [name, schema, value] of cases) {
    test(name, () => {
      const result = v.safeParse(schema, value);
      if (!result.success) throw new Error(`${name}: ${JSON.stringify(v.flatten(result.issues))}`);
    });
  }

  test('a report draft without harness-filled fields parses', () => {
    const r = report();
    const draft = without(without(without(without(without(r, 'run_id'), 'env_label'), 'generated_at'), 'repo_commits'), 'cost');
    expect(parses(ReportDraftSchema, draft)).toBe(true);
  });
});

describe('core', () => {
  test('entity and tier lists', () => {
    expect([...ENTITIES]).toEqual(['ssfb', 'atspl', 'rtl']);
    expect(parses(EntitySchema, 'shivalik')).toBe(false);
    expect(parses(TierSchema, 'huge')).toBe(false);
    expect(parses(InterfaceSchema, 'claude-code')).toBe(true);
    expect(parses(InterfaceSchema, 'email')).toBe(false);
  });

  test('KnownIds has old_user_id and account_form_id', () => {
    expect(KNOWN_ID_KEYS).toContain('old_user_id');
    expect(KNOWN_ID_KEYS).toContain('account_form_id');
    expect(Object.keys(KnownIdsSchema.entries).sort()).toEqual([...KNOWN_ID_KEYS].sort());
  });

  test('TakenAt must be an ISO timestamp', () => {
    expect(parses(TakenAtSchema, new Date().toISOString())).toBe(true);
    expect(parses(TakenAtSchema, 'yesterday')).toBe(false);
    expect(parses(TakenAtSchema, '')).toBe(false);
  });

  test('run id refuses path characters', () => {
    expect(parses(RunIdSchema, '../etc')).toBe(false);
    expect(parses(RunIdSchema, 'a/b')).toBe(false);
    expect(parses(RunIdSchema, '')).toBe(false);
  });

  test('window from after to is rejected', () => {
    expect(parses(TimeWindowSchema, { from: '2026-09-23T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' })).toBe(false);
  });
});

describe('TriageRequest', () => {
  test('has no redaction_names field', () => {
    expect(Object.keys(TriageRequestSchema.entries)).not.toContain('redaction_names');
  });

  test('bad interface and bad source kind are rejected', () => {
    expect(parses(TriageRequestSchema, { ...request(), interface: 'email' })).toBe(false);
    expect(parses(TriageRequestSchema, { ...request(), source: { kind: 'slack' } })).toBe(false);
  });

  test('hint entity outside the list is rejected', () => {
    expect(parses(TriageRequestSchema, { ...request(), hints: { entities: ['other'] } })).toBe(false);
  });
});

describe('TriageInit', () => {
  test('bare {} is rejected', () => {
    expect(parses(TriageInitSchema, {})).toBe(false);
  });

  test('missing classification is rejected', () => {
    expect(parses(TriageInitSchema, without(triageInit(), 'classification'))).toBe(false);
  });

  test('missing id_chain is rejected', () => {
    expect(parses(TriageInitSchema, without(triageInit(), 'id_chain'))).toBe(false);
  });

  test('redaction_names and preflight_warnings parse and are optional', () => {
    const value = {
      ...triageInit(),
      redaction_names: ['Test Person'],
      preflight_warnings: [
        { entity: 'ssfb', step: 'tunnel', message: 'tunnel is down', fix: 'triage tunnel up' },
        { step: 'qw-login', message: 'not logged in' },
      ],
    };
    const result = v.safeParse(TriageInitSchema, value);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.redaction_names).toEqual(['Test Person']);
      expect(result.output.preflight_warnings?.length).toBe(2);
    }
    expect(parses(TriageInitSchema, triageInit())).toBe(true);
  });

  test('a non-string or empty redaction name is rejected', () => {
    expect(parses(TriageInitSchema, { ...triageInit(), redaction_names: ['ok', 42] })).toBe(false);
    expect(parses(TriageInitSchema, { ...triageInit(), redaction_names: [''] })).toBe(false);
  });

  test('a preflight warning without step or message is rejected', () => {
    expect(parses(TriageInitSchema, { ...triageInit(), preflight_warnings: [{ message: 'x' }] })).toBe(false);
    expect(parses(TriageInitSchema, { ...triageInit(), preflight_warnings: [{ step: 'x' }] })).toBe(false);
    expect(parses(TriageInitSchema, { ...triageInit(), preflight_warnings: [{ entity: 'x', step: 's', message: 'm' }] })).toBe(
      false,
    );
  });
});

describe('Classification', () => {
  test('tier_proposed outside cheap|mid|strong is rejected', () => {
    expect(parses(ClassificationSchema, { ...classification(), tier_proposed: 'huge' })).toBe(false);
  });

  test('confidence bounds', () => {
    expect(parses(ClassificationSchema, { ...classification(), confidence: 0 })).toBe(true);
    expect(parses(ClassificationSchema, { ...classification(), confidence: 1 })).toBe(true);
    expect(parses(ClassificationSchema, { ...classification(), confidence: -0.01 })).toBe(false);
    expect(parses(ClassificationSchema, { ...classification(), confidence: 1.01 })).toBe(false);
  });

  test('category list includes unknown and rejects others', () => {
    expect(CATEGORIES).toContain('unknown');
    expect(parses(ClassificationSchema, { ...classification(), category: 'loans' })).toBe(false);
  });

  test('tier decision rejects a bad tier_final', () => {
    expect(parses(TierDecisionSchema, { ...tierDecision(), tier_final: 'huge' })).toBe(false);
  });
});

describe('IdChain', () => {
  test("hop status accepts 'unreachable' and rejects unknown values", () => {
    expect(parses(IdChainSchema, idChain())).toBe(true);
    const bad = idChain();
    bad.hops[0] = { ...bad.hops[0]!, status: 'maybe' };
    expect(parses(IdChainSchema, bad)).toBe(false);
  });

  test('basic_state item without taken_at is rejected', () => {
    const bad = idChain();
    bad.basic_state = [without(bad.basic_state[0]!, 'taken_at') as (typeof bad.basic_state)[number]];
    expect(parses(IdChainSchema, bad)).toBe(false);
  });

  test('hop without taken_at is rejected', () => {
    const bad = idChain();
    bad.hops = [without(bad.hops[0]!, 'taken_at') as (typeof bad.hops)[number]];
    expect(parses(IdChainSchema, bad)).toBe(false);
  });
});

describe('Findings', () => {
  test('EntityFindings enforces high|medium|low', () => {
    for (const c of ['high', 'medium', 'low']) expect(parses(EntityFindingsSchema, { ...entityFindings(), confidence: c })).toBe(true);
    expect(parses(EntityFindingsSchema, { ...entityFindings(), confidence: 'certain' })).toBe(false);
    expect(parses(EntityFindingsSchema, { ...entityFindings(), confidence: 0.9 })).toBe(false);
  });

  test('EntityFindings refuses an extra entity field and a missing summary', () => {
    expect(parses(EntityFindingsSchema, { ...entityFindings(), entity: 'ssfb' })).toBe(false);
    const f = entityFindings();
    const noSummary = { ...f, evidence: [without(f.evidence[0]!, 'summary')] };
    expect(parses(EntityFindingsSchema, noSummary)).toBe(false);
  });

  test('CodeFindings enforces confidence and refuses extra fields', () => {
    expect(parses(CodeFindingsSchema, { ...codeFindings(), confidence: 'maybe' })).toBe(false);
    expect(parses(CodeFindingsSchema, { ...codeFindings(), run_id: 'x' })).toBe(false);
  });
});

describe('Report', () => {
  test('suggested_fix kind outside curl|sql|manual is rejected', () => {
    expect(parses(ReportSchema, { ...report(), suggested_fix: [{ ...suggestedFix(), kind: 'bash' }] })).toBe(false);
    for (const kind of ['curl', 'sql', 'manual']) {
      expect(parses(ReportSchema, { ...report(), suggested_fix: [{ ...suggestedFix(), kind }] })).toBe(true);
    }
  });

  test('current_state item without taken_at is rejected', () => {
    const r = report();
    expect(parses(ReportSchema, { ...r, current_state: [without(r.current_state[0]!, 'taken_at')] })).toBe(false);
  });

  test('status outside the five values is rejected', () => {
    for (const status of ['root_cause_confirmed', 'resolved', 'pending_user', 'pending_bank', 'inconclusive']) {
      expect(parses(ReportSchema, { ...report(), status })).toBe(true);
    }
    expect(parses(ReportSchema, { ...report(), status: 'done' })).toBe(false);
  });

  test("cx_answer.action_owner accepts 'unknown' and rejects other values", () => {
    const r = report();
    expect(parses(ReportSchema, { ...r, cx_answer: { ...r.cx_answer, action_owner: 'unknown' } })).toBe(true);
    expect(parses(ReportSchema, { ...r, cx_answer: { ...r.cx_answer, action_owner: 'vendor' } })).toBe(false);
    expect(parses(ReportSchema, { ...r, cx_answer: { ...r.cx_answer, should_retry: 'maybe' } })).toBe(false);
  });

  test('null root_cause and null cost are allowed', () => {
    expect(parses(ReportSchema, { ...report(), root_cause: null, cost: null })).toBe(true);
  });

  test('repo_commits needs a hex commit', () => {
    expect(parses(ReportSchema, { ...report(), repo_commits: [{ repo: 'r', commit: 'main' }] })).toBe(false);
  });

  test('root_cause has no service field and the report has no preflight field', () => {
    const rootCause = ReportSchema.entries.root_cause.wrapped;
    expect(Object.keys(rootCause.entries)).not.toContain('service');
    expect(Object.keys(ReportSchema.entries)).not.toContain('preflight_warnings');
  });
});

describe('AuditLine', () => {
  test('transport is required and must be real|mock', () => {
    expect(parses(AuditLineSchema, without(auditLine(), 'transport'))).toBe(false);
    expect(parses(AuditLineSchema, { ...auditLine(), transport: 'fake' })).toBe(false);
    expect(parses(AuditLineSchema, { ...auditLine(), transport: 'real' })).toBe(true);
  });

  test('decision must be allow|deny, and deny needs a reason', () => {
    expect(parses(AuditLineSchema, { ...auditLine(), decision: 'maybe' })).toBe(false);
    expect(parses(AuditLineSchema, { ...auditLine(), decision: 'deny' })).toBe(false);
    expect(parses(AuditLineSchema, { ...auditLine(), decision: 'deny', reason: '  ' })).toBe(false);
    expect(parses(AuditLineSchema, { ...auditLine(), decision: 'deny', reason: 'not a SELECT' })).toBe(true);
  });

  test('target accepts an env var name and refuses a DSN or URL', () => {
    expect(parses(AuditLineSchema, { ...auditLine(), target: 'postgres://user:pass@db.example.test/x' })).toBe(false);
    expect(parses(AuditLineSchema, { ...auditLine(), target: 'https://api.example.test' })).toBe(false);
    expect(parses(AuditLineSchema, { ...auditLine(), target: 'lowercase_name' })).toBe(false);
  });

  test('rule_index is a number or default', () => {
    expect(parses(AuditLineSchema, { ...auditLine(), rule_index: 'default', action: 'block' })).toBe(true);
    expect(parses(AuditLineSchema, { ...auditLine(), rule_index: 2, action: 'allow' })).toBe(true);
    expect(parses(AuditLineSchema, { ...auditLine(), rule_index: 'first' })).toBe(false);
  });
});

describe('tool-result helpers', () => {
  const isIso = (s: unknown) => typeof s === 'string' && parses(TakenAtSchema, s) && !Number.isNaN(Date.parse(s));

  test('every helper returns the { output } envelope with an ISO taken_at', () => {
    const envelopes = [ok({ rows: [] }), refused('only SELECT is allowed'), notConfigured('atspl', 'package'), unreachable('tunnel down')];
    for (const e of envelopes) {
      expect(Object.keys(e)).toEqual(['output']);
      expect(isIso(e.output.taken_at)).toBe(true);
      expect(parses(ToolEnvelopeSchema, e)).toBe(true);
      expect(() => JSON.stringify(e)).not.toThrow();
    }
  });

  test('statuses and payloads', () => {
    expect(ok({ n: 1 }).output).toMatchObject({ status: 'ok', data: { n: 1 } });
    expect(refused('no').output).toMatchObject({ status: 'refused', message: 'no' });
    expect(unreachable('down').output).toMatchObject({ status: 'unreachable', message: 'down' });
  });

  test("notConfigured message is 'not configured for <entity>:<service>'", () => {
    const e = notConfigured('atspl', 'package');
    expect(e.output.status).toBe('not_configured');
    expect(e.output.message).toBe('not configured for atspl:package');
  });

  test('the clock is injectable', () => {
    const fixed = () => new Date(T);
    expect(ok(1, fixed).output.taken_at).toBe(T);
    expect(refused('x', fixed).output.taken_at).toBe(T);
  });
});

describe('module rules', () => {
  const dir = import.meta.dir;
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  test('every schema module is present', () => {
    expect(sources.sort()).toEqual(
      ['audit.ts', 'classification.ts', 'core.ts', 'findings.ts', 'id-chain.ts', 'input-request.ts', 'report.ts', 'request.ts', 'tool-result.ts'].sort(),
    );
  });

  test('nothing in src/types imports from other src/ folders or packages other than valibot', () => {
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8');
      const specifiers = [...text.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const spec of specifiers) {
        const allowed = spec === 'valibot' || /^\.\/[a-z-]+\.ts$/.test(spec);
        if (!allowed) throw new Error(`${file} imports ${spec}`);
      }
      expect(text).not.toMatch(/\bBun\./);
      expect(text).not.toMatch(/from\s+['"]bun:/);
    }
  });

  test('every exported type is v.InferOutput of its exported schema', () => {
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text).not.toMatch(/export\s+interface\s/);
      for (const m of text.matchAll(/export\s+type\s+(\w+)\s*=\s*([^;]+);/g)) {
        const [, name, rhs] = m;
        expect(rhs!.trim()).toBe(`v.InferOutput<typeof ${name}Schema>`);
        expect(text).toContain(`export const ${name}Schema =`);
      }
    }
  });

  test('every top-level domain schema is an object schema that Flue accepts', async () => {
    const objectTypes = ['object', 'strict_object', 'loose_object', 'object_with_rest'];
    const modules = await Promise.all(sources.map((f) => import(join(dir, f))));
    const domain = [
      'TriageRequestSchema',
      'IdChainSchema',
      'ClassificationSchema',
      'TierDecisionSchema',
      'TriageInitSchema',
      'EvidenceRefSchema',
      'EntityFindingsSchema',
      'CodeFindingsSchema',
      'ReportSchema',
      'ReportDraftSchema',
      'AuditLineSchema',
      'ToolResultSchema',
      'ToolEnvelopeSchema',
      'KnownIdsSchema',
    ];
    const all: Record<string, { type: string }> = Object.assign({}, ...modules);
    for (const name of domain) {
      expect(all[name]).toBeDefined();
      expect(objectTypes).toContain(all[name]!.type);
    }
  });
});
