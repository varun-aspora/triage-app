// Agent contract: the single shape (TRIAGE_AGENT_SHAPE=single; plan 16 wave B,
// D103, D108, D109, D110).
//
// Boots start({ agents: [Triage] }) on a strict mock-mode home with the
// single shape and asserts, from what the fake model was given:
// - mounting: the root sees each data tool once with an entity input (the
//   SSFB-only tools without one) and the shared tools once, every entity note
//   plus repo-map, patterns, frontend-routing and codegraph-limits, and the
//   worker as its only subagent. No investigate_* or code_walker, and no
//   entity-prefixed tool.
// - one scripted run end to end: the root calls sql_select and logs_search
//   with entity rtl on the ticket's seed lead, saves evidence with
//   note_evidence for rtl, hands a count to the worker through task (the
//   worker calls logs_search for rtl and replies), then calls finish_report.
//   The run completes and the stored report's entities_consulted has rtl,
//   which the draft left out. A call for a service rtl does not have is
//   refused with the valid pairs.
// - the routers (this harness and src/evals/contract/faux-script.ts) route
//   the real single root prompt as the root and the worker prompt as
//   'worker'.
//
// A test home keeps every DSN and Quickwit key blank, and the tool pipeline
// answers not configured before it looks for a fixture. As in the SIM and
// strict-miss contracts, loadRegistry is wrapped so the RTL workflow database
// and RTL Quickwit report 'ok' with a placeholder. The config stays blank,
// mock mode is forced, and a mock-mode runtime has no connectors, so nothing
// can use the placeholder. The fixtures are written to a temp dir under
// shared/, which TRIAGE_FIXTURES_DIR points at.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { delegateContext, type DelegateEnv } from '../../../src/agents/delegates/investigator.ts';
import { rootOnlyTool, workerMounts } from '../../../src/agents/delegates/worker.ts';
import { loadKnowledge, rootSkills } from '../../../src/agents/skills.ts';
import { FRAMEWORK_TOOL_NAMES, SANDBOX_TOOL_NAMES } from '../../../src/agents/tripwire.ts';
import { callerOf } from '../../../src/evals/contract/faux-script.ts';
import { createFakeModel, finish, text, toolCall, toolCalls } from '../../../src/mock/fake-model.ts';
import { hashKeyString, keyString, semanticKey } from '../../../src/mock/key.ts';
import type { FixtureKind, SemanticKey } from '../../../src/mock/types.ts';
import { agentEntitiesOf } from '../../../src/tools/agent-entity.ts';
import { toolsFor } from '../../../src/tools/index.ts';
import { type TriageInit, TriageInitSchema } from '../../../src/types/classification.ts';
import { ENTITIES } from '../../../src/types/core.ts';
import { throwingDeps } from '../../support/fake-tool-context.ts';
import {
  agentOf,
  auditLines,
  bootTriage,
  type Booted,
  contractHome,
  createRun,
  KNOWLEDGE_DIR,
  listed,
  nextRunId,
  reportDraft,
  runTriage,
  type SeenCall,
  scriptAgents,
  triageInit,
} from './harness.ts';

vi.mock('../../../src/config/registry.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/config/registry.ts')>();
  type Registry = import('../../../src/config/registry.ts').Registry;
  const PLACEHOLDER = 'https://fixture-only.invalid';
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
        if (cap === undefined || cap.status === 'ok' || `${entity}:${service}` !== 'rtl:workflow') return cap;
        return ok({ envName: cap.envName, naiveTimestampZone: cap.naiveTimestampZone }, PLACEHOLDER);
      },
      quickwit: (entity) => {
        const cap = registry.quickwit(entity);
        if (entity !== 'rtl' || cap.status === 'ok') return cap;
        return Object.freeze({ status: 'ok', transport: 'qw', index: 'fixture-only', context: 'fixture-only', maxConcurrency: 1, maxHits: 500 });
      },
    } satisfies Registry);
  return { ...original, loadRegistry: (...args: Parameters<typeof original.loadRegistry>) => fixtureOnly(original.loadRegistry(...args)) };
});

// ------------------------------------------------------------------ fixtures

// The seed lead: an id the requester wrote in the thread. Synthetic.
const LEAD = '5a1e0000-0000-4000-8000-00000000c0de';
const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-23T00:00:00.000Z' };
const WORKFLOW_SQL = 'SELECT id, status, current_step_identifier FROM workflow_executions WHERE reference_id = $1';
const HITS_INPUT = { entity: 'rtl', service: 'appserver', terms: [LEAD], columns: ['x-device-id'] };
const COUNT_INPUT = { entity: 'rtl', service: 'appserver', terms: [LEAD], count: true };
const WORKER_REPLY = 'appserver has 3 lines for the lead in the window. Calls: logs_search count for rtl on appserver.';

const fixturesDir = mkdtempSync(join(tmpdir(), 'triage-single-fixtures-'));

/** Writes one hand fixture under shared/<kind>/rtl/, keyed the way the tool keys the call. */
function writeFixture<K extends FixtureKind>(kind: K, key: SemanticKey<K>, result: unknown): void {
  const key_string = keyString(key);
  const dir = join(fixturesDir, 'shared', kind, 'rtl');
  mkdirSync(dir, { recursive: true });
  const record = { schema: 1, kind, entity: 'rtl', key, key_string, result, meta: { source: 'hand', recorded_at: '2026-09-29T00:00:00.000Z' } };
  writeFileSync(join(dir, `${hashKeyString(key_string)}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

writeFixture('sql_select', semanticKey('sql_select', { entity: 'rtl', service: 'workflow', tables: ['workflow_executions'], params: [LEAD] }), {
  rows: [{ id: 'e8ec0000-0000-4000-8000-0000000000c1', status: 'IN_PROGRESS', current_step_identifier: 'KYC_REVIEW' }],
});
// logsKeyInput puts columns into the terms as 'columns:<names>'.
writeFixture('logs_search', semanticKey('logs_search', { entity: 'rtl', service: 'appserver', terms: [LEAD, 'columns:x-device-id'], mode: 'search' }), {
  hits: [
    {
      timestamp: '2026-09-20T10:04:05.000Z',
      service: 'app-server-service',
      level: 'info',
      message: 'HTTP request completed',
      path: '/api/v1/onboarding/status',
      status: 200,
      'x-device-id': 'de71ce00-0000-4000-8000-0000000000c2',
    },
  ],
  num_hits: 1,
  window: WINDOW,
  truncated: false,
});
writeFixture('logs_search', semanticKey('logs_search', { entity: 'rtl', service: 'appserver', terms: [LEAD], mode: 'count' }), {
  count: 3,
  num_hits: 3,
  window: WINDOW,
  truncated: false,
});

// ------------------------------------------------------------------ set-up

const fake = createFakeModel();
const home = contractHome(fake, { overrides: { TRIAGE_AGENT_SHAPE: 'single', TRIAGE_FIXTURES_DIR: fixturesDir } });
const knowledge = loadKnowledge(KNOWLEDGE_DIR);
let b: Booted;

const HARNESS_TOOLS = new Set([...SANDBOX_TOOL_NAMES, ...FRAMEWORK_TOOL_NAMES]);
const SHARED_ROOT_TOOLS = ['ask_requester', 'codebase_note_evidence', 'finish_report', 'resolve_identity', 'run_log', 'stop_blocked'];
const ENTITY_TOOLS_ALWAYS = ['sql_select', 'logs_search', 'http_call', 'note_evidence'];
const SSFB_ONLY = ['get_account_statement', 'detect_silent_reversals'];
const SPLIT_ONLY = ['investigate_', 'code_walker'];

const sorted = (names: readonly string[]): string[] => [...names].sort();
/** The typed tools in a call, without the sandbox and framework tools. */
const ownTools = (call: SeenCall): string[] => call.tools.filter((t) => !HARNESS_TOOLS.has(t));

function env(): DelegateEnv {
  return { config: home.config, registry: home.registry, deps: throwingDeps(), knowledge };
}

/** A TriageInit whose ID chain carries LEAD as a seed lead from the thread. */
function initWithLead(runId: string): TriageInit {
  const base = triageInit(runId, { hints: ['rtl'] });
  return v.parse(TriageInitSchema, {
    ...base,
    request: {
      ...base.request,
      messages: [{ ts: '1726826400.000100', author: 'U000TEST', text: `Alphadesk user ID ${LEAD}: onboarding stuck`, is_parent: true }],
    },
    id_chain: {
      ...base.id_chain,
      leads: [{ value: LEAD, kind: 'uuid', source: 'thread', label: 'Alphadesk user ID', status: 'seed' }],
    },
  });
}

beforeAll(async () => {
  b = await bootTriage(fake, home);
});

afterAll(async () => {
  await b?.flue.stop();
  home.dispose();
  rmSync(fixturesDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ mounting

describe('single shape: what the root is given', () => {
  let first: SeenCall;
  let init: TriageInit;
  let ok: boolean;

  beforeAll(async () => {
    const id = nextRunId('single_mount');
    init = triageInit(id);
    await createRun(b.store, init);
    const s = scriptAgents(fake, { triage: [finish(reportDraft(init)), text('report written')] });
    const result = await runTriage(b.Triage, id, init);
    ok = result.ok;
    first = s.callsFor('triage')[0] as SeenCall;
  });

  test('the run plans the single shape and completes', () => {
    expect(b.plan.triagePlan(init, home.config, home.registry).shape).toBe('single');
    expect(ok).toBe(true);
    expect(fake.failures()).toEqual([]);
  });

  test('the model context holds the agent mount: each entity tool once with an entity input, shared tools once', () => {
    const own = ownTools(first);
    const ctx = delegateContext(init.request.request_id, null, env(), 'triage');
    const agent = toolsFor('agent', ctx);
    expect(sorted(own)).toEqual(sorted(agent.map((t) => t.name)));
    expect(new Set(first.tools).size).toBe(first.tools.length);
    for (const t of [...SHARED_ROOT_TOOLS, ...ENTITY_TOOLS_ALWAYS, ...SSFB_ONLY]) expect(own.filter((n) => n === t), t).toHaveLength(1);
    // Each data tool picks among every enabled entity; the SSFB-only tools have ssfb fixed.
    for (const t of ENTITY_TOOLS_ALWAYS) {
      expect(agentEntitiesOf(agent.find((x) => x.name === t)!), t).toEqual({ entities: home.registry.enabledEntities(), picked: true });
    }
    for (const t of SSFB_ONLY) expect(agentEntitiesOf(agent.find((x) => x.name === t)!), t).toEqual({ entities: ['ssfb'], picked: false });
    // No entity-prefixed name is mounted.
    expect(own.filter((n) => /^(ssfb|atspl|rtl)_/.test(n))).toEqual([]);
    // Removed in D111: finacle goes through http_call.
    expect(own).not.toContain('cbs_call');
    expect(first.tools).toContain('task');
    expect(first.model).toBe('mid');
  });

  test('the worker is the only subagent, and no investigator or code_walker is mentioned as mounted', () => {
    expect(listed(first.systemPrompt, '## Available Agents')).toEqual(['worker']);
    for (const t of first.tools) for (const prefix of SPLIT_ONLY) expect(t.startsWith(prefix), t).toBe(false);
  });

  test('every entity note is mounted, plus repo-map, patterns, frontend-routing and codegraph-limits', () => {
    const skills = listed(first.systemPrompt, '## Available Skills');
    expect(skills).toEqual(rootSkills(ENTITIES, knowledge, 'single').map((s) => s.name));
    const entityNotes = [...knowledge.skills.keys()].filter((n) => ENTITIES.some((e) => n.startsWith(`${e}-`)));
    expect(entityNotes.length).toBeGreaterThan(3);
    for (const note of entityNotes) expect(skills, note).toContain(note);
    for (const note of ['repo-map', 'patterns', 'frontend-routing', 'codegraph-limits']) expect(skills).toContain(note);
  });

  test('the system prompt is the single method: One agent, tool lines per entity, no brief skeleton', () => {
    expect(first.systemPrompt).toContain('## Fixed rules');
    expect(first.systemPrompt).toContain('## One agent');
    expect(first.systemPrompt).not.toContain('## Brief skeleton for this run');
    expect(first.systemPrompt).toMatch(/^ {2}- rtl: \w+(, \w+)*$/m);
    expect(first.systemPrompt).toMatch(/^ {2}- rtl: .*\bsql_select\b/m);
    expect(first.systemPrompt).toMatch(/^ {2}- ssfb: .*\bget_account_statement\b/m);
    expect(first.systemPrompt).not.toMatch(/^ {2}- rtl: .*\bget_account_statement\b/m);
    expect(first.systemPrompt).not.toMatch(/\b(ssfb|atspl|rtl)_(sql_select|logs_search|note_evidence)\b/);
  });

  test('both routers send the single root prompt to the root', () => {
    expect(callerOf({ systemPrompt: first.systemPrompt, messages: [] })).toBe('root');
    expect(agentOf({ systemPrompt: first.systemPrompt, messages: [] })).toBe('triage');
  });
});

// ------------------------------------------------------------------ end to end

describe('single shape: one scripted run', () => {
  let id: string;
  let init: TriageInit;
  let s: ReturnType<typeof scriptAgents>;
  let result: Awaited<ReturnType<typeof runTriage>>;

  beforeAll(async () => {
    id = nextRunId('single_e2e');
    init = initWithLead(id);
    await createRun(b.store, init);
    s = scriptAgents(fake, {
      triage: [
        toolCalls([
          { name: 'sql_select', args: { entity: 'rtl', service: 'workflow', sql: WORKFLOW_SQL, params: [LEAD] } },
          { name: 'logs_search', args: HITS_INPUT },
          // rtl has no harbor: refused with the valid pairs before any gate.
          { name: 'sql_select', args: { entity: 'rtl', service: 'harbor', sql: WORKFLOW_SQL, params: [LEAD] } },
        ]),
        toolCall('note_evidence', {
          entity: 'rtl',
          evidence: [
            { source: 'db', at: '2026-09-20T10:04:05.000Z', query_or_path: 'rtl workflow_executions by the lead', summary: 'the workflow is IN_PROGRESS at KYC_REVIEW' },
          ],
          timeline: [],
          hypotheses: ['the onboarding workflow waits on KYC review in RTL'],
          confidence: 'medium',
          gaps: [],
        }),
        toolCall('task', {
          agent: 'worker',
          prompt: `Job: count appserver log lines for ${LEAD} in the window.\nIds: ${LEAD}\nWindow: 2026-09-01 to 2026-09-23\nNotes: rtl-overview`,
        }),
        finish(reportDraft(init, { entities_consulted: [] })),
        text('report written'),
      ],
      worker: [toolCall('logs_search', COUNT_INPUT), text(WORKER_REPLY)],
    });
    result = await runTriage(b.Triage, id, init);
  });

  test('the run completes and every scripted turn is used', () => {
    expect(result.ok).toBe(true);
    expect(fake.failures()).toEqual([]);
    expect(s.left()).toEqual({ triage: 0, worker: 0 });
    expect(result.tools).toEqual(['sql_select', 'logs_search', 'sql_select', 'note_evidence', 'task', 'finish_report']);
  });

  test('the data calls on the seed lead are answered from the fixtures', () => {
    const second = s.callsFor('triage')[1] as SeenCall;
    const [sql, wrongService] = second.toolResults.filter((r) => r.toolName === 'sql_select');
    const logs = second.toolResults.find((r) => r.toolName === 'logs_search');
    expect(sql?.isError).toBe(false);
    expect(sql?.text).toContain('KYC_REVIEW');
    expect(wrongService?.text).toContain('Refused: rtl has no such service for sql_select; valid entity:service pairs: ');
    expect(wrongService?.text).toContain('rtl:workflow');
    expect(wrongService?.text).toContain('ssfb:harbor');
    expect(logs?.isError).toBe(false);
    expect(logs?.text).toContain('/api/v1/onboarding/status');
    // Audit lines keep the bare tool name and carry the entity.
    const lines = auditLines(home).filter((l) => l.run_id === id);
    const data = lines.filter((l) => l.tool === 'sql_select' || l.tool === 'logs_search');
    // The root's two calls run in parallel, so their lines can land in either order.
    expect(data.map((l) => [l.tool, l.entity, l.decision, l.transport]).sort()).toEqual([
      ['logs_search', 'rtl', 'allow', 'mock'],
      ['logs_search', 'rtl', 'allow', 'mock'],
      ['sql_select', 'rtl', 'allow', 'mock'],
    ]);
  });

  test('note_evidence for rtl records under rtl once rtl was queried', async () => {
    const third = s.callsFor('triage')[2] as SeenCall;
    const note = third.toolResults.find((r) => r.toolName === 'note_evidence');
    expect(note?.isError).toBe(false);
    expect(note?.text).not.toMatch(/^Refused/);
    const run = await b.store.getRun(id);
    expect(run?.evidence.rtl).toBeDefined();
  });

  test('the worker gets its own prompt and tools, calls one tool and its reply reaches the root', () => {
    const calls = s.callsFor('worker');
    expect(calls).toHaveLength(2);
    const w = calls[0] as SeenCall;
    expect(w.systemPrompt).toContain('## This worker');
    expect(w.systemPrompt).not.toContain('## Fixed rules');
    expect(w.model).toBe('mid');
    expect(callerOf({ systemPrompt: w.systemPrompt, messages: [] })).toBe('worker');
    const mounts = workerMounts(id as never, { env: env() });
    expect(sorted(ownTools(w))).toEqual(sorted(mounts.tools.map((t) => t.name)));
    expect(ownTools(w).some(rootOnlyTool)).toBe(false);
    expect(ownTools(w)).toContain('logs_search');
    expect(listed(w.systemPrompt, '## Available Agents')).toEqual([]);
    const count = (calls[1] as SeenCall).toolResults.find((r) => r.toolName === 'logs_search');
    expect(count?.isError).toBe(false);
    expect(count?.text).toContain('3');
    const fourth = s.callsFor('triage')[3] as SeenCall;
    const task = fourth.toolResults.find((r) => r.toolName === 'task');
    expect(task?.text).toContain(WORKER_REPLY);
  });

  test('the stored report adds rtl to entities_consulted from the run', async () => {
    const run = await b.store.getRun(id);
    expect(run?.report).not.toBeNull();
    expect(run?.report?.entities_consulted).toEqual(['rtl']);
  });
});

test('every audit line written in this file has transport mock', () => {
  const lines = auditLines(home);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => l.transport !== 'mock')).toEqual([]);
});
