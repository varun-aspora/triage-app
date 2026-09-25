// ask_requester against the folder run store in a temp dir, a memory audit
// sink and a real run budget. No model and no network; every value is
// synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { escalationFor, releaseEscalation } from '../agents/escalation.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget, type RunBudget } from '../gate/budget.ts';
import { redactPersisted } from '../gate/redact.ts';
import type { MockLayer } from '../mock/index.ts';
import { sampleRequest } from '../runstore/contract.ts';
import { createFolderRunStore } from '../runstore/folder.ts';
import type { RunStore } from '../runstore/types.ts';
import { ToolEnvelopeSchema, type ToolResult } from '../types/tool-result.ts';
import { makeToolContext } from '../../test/support/fake-tool-context.ts';
import { ASK_REQUESTER, STOP_NOTE, toolModule } from './ask-requester.tool.ts';
import { conformanceProblems } from './index.ts';
import type { ToolDeps } from './types.ts';

const AT = '2026-09-01T10:00:00.000Z';
const QUESTION = 'Which transfer is this about: the one on 2 Sep for 5,000 or the one on 3 Sep for 12,000?';
const WHY = 'Two transfers match the thread and their outcomes differ.';
// Synthetic: ten digits, which the egress check treats as an account number.
const ACCOUNT = '5555001234';

const fakeFixtures = (mockMode: boolean): MockLayer =>
  ({
    settings: { mockMode, strict: true, record: false, fixturesDir: '/triage-test/fixtures' },
    store: {},
    recorder: null,
    resolveIo: () => {
      throw new Error('ask_requester does no fixture I/O');
    },
  }) as unknown as MockLayer;

let seq = 0;
const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Harness = {
  readonly runId: string;
  readonly store: RunStore;
  readonly audit: MemoryAuditSink;
  readonly budget: RunBudget;
  readonly tool: ToolDefinition;
};

async function harness(o: { maxAsks?: number; maxToolCalls?: number; names?: string[]; mockMode?: boolean } = {}): Promise<Harness> {
  seq += 1;
  const runId = `run_ask_${seq}_${Date.now().toString(36)}`;
  const dir = mkdtempSync(join(tmpdir(), 'triage-ask-'));
  dirs.push(dir);
  const store = createFolderRunStore({ runsDir: join(dir, 'runs'), dataDir: join(dir, 'data') });
  await store.createRun(runId, redactPersisted(sampleRequest(runId)));
  await store.setPhase(runId, 'investigating', { worker_pid: 4242 });
  const audit = createMemoryAuditSink();
  const budget = createRunBudget({
    runId,
    maxToolCalls: o.maxToolCalls ?? 5,
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
    fixtures: fakeFixtures(o.mockMode ?? true),
    connectors: {},
    runStore: store,
    escalation,
    run: { interface: 'cli', redactionNames: o.names ?? [] },
    now: () => new Date(AT),
    idChain: () => ({ ids: {}, hops: [], basic_state: [] }),
  } as unknown as ToolDeps;
  const ctx = makeToolContext({ entity: null, runId, deps, env: { TRIAGE_MAX_ASKS_PER_RUN: String(o.maxAsks ?? 2) } });
  return { runId, store, audit, budget, tool: toolModule.create(ctx, 'triage') };
}

async function call(tool: ToolDefinition, data: unknown): Promise<ToolResult> {
  return v.parse(ToolEnvelopeSchema, await tool.run({ data } as never)).output;
}

describe('ask_requester', () => {
  test('opens q1, parks the run in needs_input and tells the model to stop', async () => {
    const h = await harness();
    const out = await call(h.tool, { question: QUESTION, why: WHY });
    expect(out.status).toBe('ok');
    expect(out.data).toEqual({ question_id: 'q1', status: 'waiting', note: STOP_NOTE });
    expect(out.taken_at).toBe(AT);

    const run = await h.store.getRun(h.runId);
    expect(run?.phase).toBe('needs_input');
    expect(run?.worker_pid).toBe(4242);
    expect(run?.input_request).toEqual({
      question_id: 'q1',
      kind: 'provide',
      question: QUESTION,
      why: WHY,
      options: [],
      free_text: true,
      asked_at: AT,
    });
    expect(run?.input_history).toEqual([]);

    const line = h.audit.lines.at(-1);
    expect(line).toMatchObject({ tool: ASK_REQUESTER, decision: 'allow', entity: null, service: 'input', target: 'TRIAGE_RUNS_DIR', transport: 'mock', exit: 'ok' });
    expect(JSON.stringify(h.audit.lines)).not.toContain('Which transfer');
  });

  test('stores the options and free_text as given; free text stays on when there are no options', async () => {
    const h = await harness();
    const out = await call(h.tool, { question: QUESTION, why: WHY, options: ['2 Sep for 5,000', '3 Sep for 12,000'], free_text: false });
    expect(out.status).toBe('ok');
    expect((await h.store.getRun(h.runId))?.input_request).toMatchObject({ options: ['2 Sep for 5,000', '3 Sep for 12,000'], free_text: false });

    const g = await harness();
    await call(g.tool, { question: QUESTION, why: WHY, free_text: false });
    expect((await g.store.getRun(g.runId))?.input_request).toMatchObject({ options: [], free_text: true });
  });

  test('refuses while a question is open', async () => {
    const h = await harness();
    expect((await call(h.tool, { question: QUESTION, why: WHY })).status).toBe('ok');
    const again = await call(h.tool, { question: 'And which account?', why: WHY });
    expect(again.status).toBe('refused');
    expect(again.message).toContain('q1 is already open');
    expect(again.message).toContain(STOP_NOTE);
    expect((await h.store.getRun(h.runId))?.input_request?.question_id).toBe('q1');
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'already open' });
  });

  test('refuses past TRIAGE_MAX_ASKS_PER_RUN, counted from the store, and numbers questions in order', async () => {
    const h = await harness({ maxAsks: 2 });
    expect((await call(h.tool, { question: QUESTION, why: WHY })).status).toBe('ok');
    await h.store.resolveInputRequest(h.runId, 'q1', redactPersisted({ status: 'answered', resolved_at: AT, resolved_by: 'ops' }));
    const second = await call(h.tool, { question: 'And which account?', why: WHY });
    expect(second.status).toBe('ok');
    expect(second.data).toMatchObject({ question_id: 'q2' });
    await h.store.resolveInputRequest(h.runId, 'q2', redactPersisted({ status: 'skipped', resolved_at: AT, resolved_by: 'ops' }));
    const third = await call(h.tool, { question: 'One more?', why: WHY });
    expect(third.status).toBe('refused');
    expect(third.message).toContain('used its 2 questions');
    expect(third.message).toContain('gaps');
    expect((await h.store.getRun(h.runId))?.input_request).toBeNull();
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'limit: 2' });
  });

  test('refuses an unmasked identifier and stores nothing', async () => {
    const h = await harness();
    for (const data of [
      { question: `Is the account ${ACCOUNT} the right one?`, why: WHY },
      { question: QUESTION, why: `the account ${ACCOUNT} shows two debits` },
      { question: QUESTION, why: WHY, options: [`${ACCOUNT} on 2 Sep`, 'the other one'] },
    ]) {
      const out = await call(h.tool, data);
      expect(out.status).toBe('refused');
      expect(out.message).toContain('unmasked');
      expect(out.message).toContain('last four');
      expect(out.message).not.toContain(ACCOUNT);
    }
    const run = await h.store.getRun(h.runId);
    expect(run?.phase).toBe('investigating');
    expect(run?.input_request).toBeNull();
    expect(JSON.stringify(h.audit.lines)).not.toContain(ACCOUNT);
    expect(h.audit.lines.filter((l) => l.decision === 'deny')).toHaveLength(3);
  });

  test('masks ingress names in the stored question', async () => {
    const h = await harness({ names: ['Asha Verma'] });
    const out = await call(h.tool, { question: 'Is this about the account Asha Verma opened in May, or the one from June?', why: WHY });
    expect(out.status).toBe('ok');
    const stored = (await h.store.getRun(h.runId))?.input_request?.question ?? '';
    expect(stored).not.toContain('Asha Verma');
    expect(stored).toContain('opened in May');
  });

  test('refuses when the run budget is exhausted', async () => {
    const h = await harness({ maxToolCalls: 1 });
    expect(h.budget.consumeToolCall('sql_select').ok).toBe(true);
    const out = await call(h.tool, { question: QUESTION, why: WHY });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('budget');
    expect((await h.store.getRun(h.runId))?.input_request).toBeNull();
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'budget: tool_calls' });
  });

  test('refuses a shape that does not fit, naming the fields only', async () => {
    const h = await harness();
    const out = await call(h.tool, { question: QUESTION, why: WHY, options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('options');
    const empty = await call(h.tool, { question: '   ', why: WHY });
    expect(empty.status).toBe('refused');
    expect(empty.message).toContain('question');
    const extra = await call(h.tool, { question: QUESTION, why: WHY, run_id: 'x' });
    expect(extra.status).toBe('refused');
    expect((await h.store.getRun(h.runId))?.input_request).toBeNull();
  });

  test('module: the triage mount only, unmounted when the limit is 0, and conforms', async () => {
    expect(toolModule.name).toBe(ASK_REQUESTER);
    expect(toolModule.mounts).toEqual(['triage']);
    expect(toolModule.entities).toBe('all');
    const on = makeToolContext({ entity: null, env: { TRIAGE_MAX_ASKS_PER_RUN: '2' } });
    expect(toolModule.enabled(on, 'triage')).toEqual({ on: true });
    const off = makeToolContext({ entity: null, env: { TRIAGE_MAX_ASKS_PER_RUN: '0' } });
    expect(toolModule.enabled(off, 'triage')).toEqual({ on: false, reason: 'TRIAGE_MAX_ASKS_PER_RUN is 0' });
    const tool = toolModule.create(on, 'triage');
    expect(conformanceProblems(toolModule, tool)).toEqual([]);
    expect(tool.description).toContain('stop');
    expect(tool.description).toContain('last four');
  });
});
