// propose_note against a proposals dir in a temp dir (never under the repo), a
// memory audit sink and a real run budget. No model and no network; every
// value is synthetic. Most cases pass the run's known call ids directly; one
// goes through the run action log, the way the mounted tool reads them.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { BUDGET_EXEMPT_TOOLS, createRunBudget, releaseRunBudget, type RunBudget } from '../../src/gate/budget.ts';
import type { MockLayer } from '../../src/mock/index.ts';
import { logActions, releaseActions } from '../../src/runlog/actions.ts';
import { EVENTS_FILE, flushRunEventLog, installRunEventLog, uninstallRunEventLog } from '../../src/runlog/event-log.ts';
import { conformanceProblems } from '../../src/tools/index.ts';
import {
  createProposeNoteTool,
  MAX_PROPOSALS_PER_RUN,
  PROPOSE_NOTE,
  proposalsFile,
  proposalTitles,
  toolModule,
} from '../../src/tools/propose-note.tool.ts';
import type { ToolDeps } from '../../src/tools/types.ts';
import { ToolEnvelopeSchema, type ToolResult } from '../../src/types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../support/fake-tool-context.ts';

const AT = '2026-09-01T10:00:00.000Z';
const KNOWN = ['call_sql_1', 'call_logs_2'];
const NOTE = {
  title: 'transfer_request joins payout_attempt on request_ref',
  body: 'In rtl workflow, `transfer_request.request_ref` equals `payout_attempt.request_ref`.\n\n### Query\n\n`sql_select` on workflow with `WHERE request_ref = <request_ref>`.',
  evidence: ['call_sql_1'],
};
// Synthetic: ten digits, which the egress check treats as an account number.
const ACCOUNT = '5555001234';

const fakeFixtures = { settings: { mockMode: true, strict: true, record: false, fixturesDir: '/triage-test/fixtures' } } as unknown as MockLayer;

let seq = 0;
const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Harness = {
  readonly runId: string;
  readonly dir: string;
  readonly audit: MemoryAuditSink;
  readonly budget: RunBudget;
  readonly deps: ToolDeps;
  readonly tool: ToolDefinition;
};

function harness(o: { names?: string[]; known?: readonly string[] } = {}): Harness {
  seq += 1;
  const runId = `run_propose_${seq}_${Date.now().toString(36)}`;
  const root = mkdtempSync(join(tmpdir(), 'triage-propose-'));
  dirs.push(root);
  const dir = join(root, 'proposals');
  const audit = createMemoryAuditSink();
  const budget = createRunBudget({ runId, maxToolCalls: 1, maxTasks: 1, maxRowsPerCall: 10, maxBytesPerCall: 1000, maxBytesPerRun: 10_000 });
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseActions(runId);
  });
  const deps = {
    budget,
    audit,
    fixtures: fakeFixtures,
    run: { interface: 'cli', redactionNames: o.names ?? [] },
    now: () => new Date(AT),
  } as unknown as ToolDeps;
  const ctx = makeToolContext({ runId, deps, config: makeTestConfig({ TRIAGE_PROPOSALS_DIR: dir }) });
  const known = new Set(o.known ?? KNOWN);
  return { runId, dir, audit, budget, deps, tool: createProposeNoteTool(ctx, { callIds: () => known }) };
}

async function call(tool: ToolDefinition, data: unknown): Promise<ToolResult> {
  return v.parse(ToolEnvelopeSchema, await tool.run({ data } as never)).output;
}

const fileOf = (h: Harness): string => proposalsFile(h.dir, h.runId);

describe('propose_note', () => {
  test('writes the header and the proposal to <proposals dir>/<run id>.md, and appends the next one', async () => {
    const h = harness();
    const out = await call(h.tool, NOTE);
    expect(out.status).toBe('ok');
    expect(out.data).toEqual({ proposal: 1, left: MAX_PROPOSALS_PER_RUN - 1 });

    const text = readFileSync(fileOf(h), 'utf8');
    expect(text).toContain(`# Proposals for run ${h.runId}`);
    expect(text).toContain(`- run: ${h.runId}`);
    expect(text).toContain('- date: 2026-09-01');
    expect(text).toContain('- agent: triage');
    expect(text).toContain(`## 1. ${NOTE.title}`);
    expect(text).toContain(NOTE.body);
    expect(text).toContain('Evidence: `call_sql_1`');
    expect(statSync(h.dir).mode & 0o777).toBe(0o700);

    const second = await call(h.tool, { ...NOTE, title: 'second', evidence: ['call_logs_2', 'call_sql_1', 'call_logs_2'] });
    expect(second.data).toEqual({ proposal: 2, left: MAX_PROPOSALS_PER_RUN - 2 });
    const after = readFileSync(fileOf(h), 'utf8');
    expect(after.match(/^# Proposals/gm)).toHaveLength(1);
    expect(proposalTitles(after)).toEqual([NOTE.title, 'second']);
    expect(after).toContain('Evidence: `call_logs_2`, `call_sql_1`\n');

    expect(h.audit.lines.at(-1)).toMatchObject({ tool: PROPOSE_NOTE, decision: 'allow', target: 'TRIAGE_PROPOSALS_DIR', exit: 'ok' });
    expect(JSON.stringify(h.audit.lines)).not.toContain('payout_attempt');
  });

  test('logs one run event per proposal with the title and evidence ids, not the body', async () => {
    const h = harness();
    const runsDir = join(h.dir, '..', 'runs');
    installRunEventLog({ runsDir, observe: () => () => {} });
    cleanups.push(uninstallRunEventLog);
    await call(h.tool, NOTE);
    await flushRunEventLog();
    const lines = readFileSync(join(runsDir, h.runId, EVENTS_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: 'pipeline', type: 'proposal', data: { n: 1, title: NOTE.title, evidence: ['call_sql_1'] } });
    expect(JSON.stringify(lines)).not.toContain('Query');
  });

  test('refuses evidence ids that are not calls of this run, lists them and writes nothing', async () => {
    const h = harness();
    const out = await call(h.tool, { ...NOTE, evidence: ['call_sql_1', 'call_made_up', 'call_other'] });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('call_made_up, call_other');
    expect(out.message).not.toContain('call_sql_1,');
    expect(existsSync(fileOf(h))).toBe(false);
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'unknown evidence: 2' });
  });

  test('refuses an empty evidence list', async () => {
    const h = harness();
    const out = await call(h.tool, { ...NOTE, evidence: [] });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('evidence');
    expect(existsSync(fileOf(h))).toBe(false);
  });

  test('refuses an unmasked email, account number or ingress name, names the pattern and writes nothing', async () => {
    const h = harness({ names: ['Asha Verma'] });
    const cases: [Record<string, unknown>, string][] = [
      [{ ...NOTE, body: `${NOTE.body}\nThe user wrote from person@example.com.` }, 'email'],
      [{ ...NOTE, title: `account ${ACCOUNT} joins` }, 'title'],
      [{ ...NOTE, body: `${NOTE.body}\nAsked by Asha Verma.` }, 'body'],
    ];
    for (const [data, where] of cases) {
      const out = await call(h.tool, data);
      expect(out.status).toBe('refused');
      expect(out.message).toContain('unmasked');
      expect(out.message).toContain(where === 'email' ? 'body' : where);
      expect(out.message).not.toContain(ACCOUNT);
      expect(out.message).not.toContain('person@example.com');
    }
    expect(existsSync(fileOf(h))).toBe(false);
    expect(h.audit.lines.every((l) => l.decision === 'deny')).toBe(true);
  });

  test('refuses a body with a # or ## heading, which would break the file layout', async () => {
    const h = harness();
    const out = await call(h.tool, { ...NOTE, body: 'text\n## 9. not a proposal' });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('###');
    expect(existsSync(fileOf(h))).toBe(false);
  });

  test('refuses a title with a line separator or a body with control characters, so no proposal can be added through them', async () => {
    const h = harness();
    for (const data of [
      { ...NOTE, title: 'a join\u2028## 2. a fake proposal' },
      { ...NOTE, body: `${NOTE.body}\n\u001b[2Jcleared` },
    ]) {
      const out = await call(h.tool, data);
      expect(out.status).toBe('refused');
      expect(out.message).toContain('control characters');
    }
    expect(existsSync(fileOf(h))).toBe(false);
  });

  test(`keeps at most ${MAX_PROPOSALS_PER_RUN} proposals per run`, async () => {
    const h = harness();
    for (let i = 1; i <= MAX_PROPOSALS_PER_RUN; i++) {
      expect((await call(h.tool, { ...NOTE, title: `note ${i}` })).status).toBe('ok');
    }
    const out = await call(h.tool, { ...NOTE, title: 'one too many' });
    expect(out.status).toBe('refused');
    expect(out.message).toContain(`already has ${MAX_PROPOSALS_PER_RUN} proposals`);
    expect(proposalTitles(readFileSync(fileOf(h), 'utf8'))).toHaveLength(MAX_PROPOSALS_PER_RUN);
  });

  test('is budget exempt: it works after the run budget ran out and does not count', async () => {
    expect(BUDGET_EXEMPT_TOOLS).toContain(PROPOSE_NOTE);
    const h = harness();
    expect(h.budget.consumeToolCall('sql_select').ok).toBe(true);
    expect(h.budget.consumeToolCall('sql_select').ok).toBe(false);
    const before = h.budget.state().calls;
    expect((await call(h.tool, NOTE)).status).toBe('ok');
    expect(h.budget.state().calls).toBe(before);
    expect(h.budget.consumeToolCall(PROPOSE_NOTE).ok).toBe(true);
    expect(h.budget.state().calls).toBe(before);
  });

  test('reads the known call ids from the run action log by default', async () => {
    const h = harness();
    const fake = {
      name: 'sql_select',
      description: 'test tool',
      input: v.object({}),
      run: async () => ({ output: { status: 'ok', data: { row_count: 1 } } }),
    } as unknown as ToolDefinition;
    const [wrapped] = logActions([fake], makeToolContext({ runId: h.runId, deps: h.deps }));
    await (wrapped!.run as (c: unknown) => Promise<unknown>)({ data: {}, toolCallId: 'call_logged_7', log: console });

    const ctx = makeToolContext({ runId: h.runId, deps: h.deps, config: makeTestConfig({ TRIAGE_PROPOSALS_DIR: h.dir }) });
    const tool = toolModule.create(ctx, 'agent');
    expect((await call(tool, { ...NOTE, evidence: ['call_logged_7'] })).status).toBe('ok');
    const wrong = await call(tool, { ...NOTE, evidence: ['call_sql_1'] });
    expect(wrong.status).toBe('refused');
    // The refusal lists the agent's own recent calls with their ids, so the model can fix the evidence.
    expect(JSON.stringify(wrong)).toContain('sql_select {} -> ok rows=1 [call call_logged_7]');
  });

  test('mounts on the single agent, the split root and the investigators, and conforms', () => {
    expect([...toolModule.mounts].sort()).toEqual(['agent', 'investigator', 'triage']);
    const ctx = makeToolContext({ config: makeTestConfig({ TRIAGE_PROPOSALS_DIR: '/triage-test/proposals' }) });
    expect(toolModule.enabled(ctx, 'agent')).toEqual({ on: true });
    expect(conformanceProblems(toolModule, toolModule.create(ctx, 'agent'))).toEqual([]);
  });

  test('is off when the proposals dir sits inside the knowledge dir', () => {
    const ctx = makeToolContext({
      config: makeTestConfig({ TRIAGE_KNOWLEDGE_DIR: '/triage-test/k', TRIAGE_PROPOSALS_DIR: '/triage-test/k/_proposed' }),
    });
    const enabled = toolModule.enabled(ctx, 'agent');
    expect(enabled.on).toBe(false);
    expect(enabled.on === false && enabled.reason).toContain('TRIAGE_KNOWLEDGE_DIR');
  });
});
