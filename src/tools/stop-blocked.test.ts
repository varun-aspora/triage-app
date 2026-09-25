// stop_blocked against the folder run store in a temp dir, a memory audit
// sink and a real run budget. No model and no network; every value is
// synthetic. Connector failures are recorded directly, as the tool pipeline
// does on a "did not answer" outcome (test/tools/pipeline.test.ts covers
// that side).
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
import { sampleBlock, sampleRequest } from '../runstore/contract.ts';
import { createFolderRunStore } from '../runstore/folder.ts';
import type { RunRecord, RunStore } from '../runstore/types.ts';
import type { ConnectorFailure } from '../types/block.ts';
import type { InputRequest } from '../types/input-request.ts';
import { ToolEnvelopeSchema, type ToolResult } from '../types/tool-result.ts';
import { makeToolContext } from '../../test/support/fake-tool-context.ts';
import { recordConnectorFailure, releaseConnectorFailures } from './_lib/connector-failures.ts';
import { conformanceProblems } from './index.ts';
import { BLOCKED_NOTE, STOP_BLOCKED, toolModule } from './stop-blocked.tool.ts';
import type { ToolDeps } from './types.ts';

const AT = '2026-09-01T10:00:00.000Z';
const EARLIER = '2026-09-01T09:59:00.000Z';
const HARBOR = 'ssfb:harbor';
const PACKAGE = 'atspl:package';
const REASON = 'The payout state lives in harbor and harbor did not answer; no other source shows whether the transfer left.';
// Synthetic: ten digits, which the egress check treats as an account number.
const ACCOUNT = '5555001234';

const failure = (system: string, code: ConnectorFailure['code'] = 'unreachable', at = AT, tool = 'sql_select'): ConnectorFailure => ({
  system,
  tool,
  code,
  at,
});

const question = (questionId: string): InputRequest => ({
  question_id: questionId,
  kind: 'provide',
  question: 'Which transfer is this about?',
  why: 'Two transfers match the thread.',
  options: [],
  free_text: true,
  asked_at: AT,
});

const fakeFixtures = (mockMode: boolean): MockLayer =>
  ({
    settings: { mockMode, strict: true, record: false, fixturesDir: '/triage-test/fixtures' },
    store: {},
    recorder: null,
    resolveIo: () => {
      throw new Error('stop_blocked does no fixture I/O');
    },
  }) as unknown as MockLayer;

/**
 * A store whose reads never show an open question or block, so the tool's
 * pre-checks pass and the store's own checks decide: what happens when
 * another process opened one between the tool's read and its write.
 */
function staleReads(store: RunStore): RunStore {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'getRun') {
        return async (id: string): Promise<RunRecord | null> => {
          const record = await target.getRun(id);
          return record === null ? null : { ...record, input_request: null, block: null };
        };
      }
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

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

type HarnessOptions = {
  /** Recorded before the call. Defaults to one unreachable ssfb:harbor. */
  readonly failures?: readonly ConnectorFailure[];
  readonly maxToolCalls?: number;
  readonly names?: string[];
  readonly mockMode?: boolean;
  /** false leaves the store without the run. */
  readonly created?: boolean;
  /** Wraps the store the tool sees; the harness still returns the real one. */
  readonly wrap?: (store: RunStore) => RunStore;
};

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  seq += 1;
  const runId = `run_block_${seq}_${Date.now().toString(36)}`;
  const dir = mkdtempSync(join(tmpdir(), 'triage-block-'));
  dirs.push(dir);
  const store = createFolderRunStore({ runsDir: join(dir, 'runs'), dataDir: join(dir, 'data') });
  if (o.created !== false) {
    await store.createRun(runId, redactPersisted(sampleRequest(runId)));
    await store.setPhase(runId, 'investigating', { worker_pid: 4242 });
  }
  for (const f of o.failures ?? [failure(HARBOR)]) recordConnectorFailure(runId, f);
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
    releaseConnectorFailures(runId);
  });
  const deps = {
    budget,
    audit,
    fixtures: fakeFixtures(o.mockMode ?? true),
    connectors: {},
    runStore: o.wrap !== undefined ? o.wrap(store) : store,
    escalation,
    run: { interface: 'cli', redactionNames: o.names ?? [] },
    now: () => new Date(AT),
    idChain: () => ({ ids: {}, hops: [], basic_state: [] }),
  } as unknown as ToolDeps;
  const ctx = makeToolContext({ entity: null, runId, deps });
  return { runId, store, audit, budget, tool: toolModule.create(ctx, 'triage') };
}

async function call(tool: ToolDefinition, data: unknown): Promise<ToolResult> {
  return v.parse(ToolEnvelopeSchema, await tool.run({ data } as never)).output;
}

describe('stop_blocked', () => {
  test('parks the run in blocked with b1, the failures of the named systems, and tells the model to stop', async () => {
    const h = await harness({
      failures: [failure(HARBOR, 'unreachable', EARLIER), failure(PACKAGE, 'timeout'), failure(HARBOR, 'error', AT, 'http_call')],
    });
    const out = await call(h.tool, { systems: [HARBOR], reason: REASON });
    expect(out.status).toBe('ok');
    expect(out.data).toEqual({ block_id: 'b1', status: 'blocked', note: BLOCKED_NOTE });
    expect(out.taken_at).toBe(AT);

    const run = await h.store.getRun(h.runId);
    expect(run?.phase).toBe('blocked');
    expect(run?.phase_reason).toBeUndefined();
    expect(run?.worker_pid).toBe(4242);
    expect(run?.block).toEqual({
      block_id: 'b1',
      systems: [HARBOR],
      failures: [
        { system: HARBOR, tool: 'sql_select', code: 'unreachable', at: EARLIER },
        { system: HARBOR, tool: 'http_call', code: 'error', at: AT },
      ],
      reason: REASON,
      blocked_at: AT,
      submission_seq: 1,
    });
    expect(run?.block_history).toEqual([]);
    expect(run?.input_request).toBeNull();

    const line = h.audit.lines.at(-1);
    expect(line).toMatchObject({ tool: STOP_BLOCKED, decision: 'allow', entity: null, service: 'block', target: 'TRIAGE_RUNS_DIR', transport: 'mock', exit: 'ok' });
    expect(line?.summary_redacted).toContain('b1');
    expect(JSON.stringify(h.audit.lines)).not.toContain('payout state');
  });

  test('blocks on several systems at once, each once, with their failures in recorded order', async () => {
    const h = await harness({ failures: [failure(HARBOR), failure(PACKAGE, 'timeout'), failure('rtl:core')] });
    const out = await call(h.tool, { systems: [PACKAGE, HARBOR, HARBOR], reason: REASON });
    expect(out.status).toBe('ok');
    const block = (await h.store.getRun(h.runId))?.block;
    expect(block?.systems).toEqual([PACKAGE, HARBOR]);
    expect(block?.failures.map((f) => f.system)).toEqual([HARBOR, PACKAGE]);
  });

  test('refuses a system with no recorded failure, names it and the systems that did fail, and stores nothing', async () => {
    const h = await harness({ failures: [failure(HARBOR)] });
    const out = await call(h.tool, { systems: [HARBOR, 'rtl:core'], reason: REASON });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('no tool result in this run said rtl:core did not answer');
    expect(out.message).toContain(`Systems that did not answer in this run: ${HARBOR}.`);
    expect(out.message).toContain('Record the gap and finish with finish_report');
    const run = await h.store.getRun(h.runId);
    expect(run?.phase).toBe('investigating');
    expect(run?.block).toBeNull();
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'no recorded failure: rtl:core' });

    // With no failure at all there is no list to offer.
    const none = await harness({ failures: [] });
    const empty = await call(none.tool, { systems: [HARBOR], reason: REASON });
    expect(empty.status).toBe('refused');
    expect(empty.message).toContain(`${HARBOR} did not answer`);
    expect(empty.message).not.toContain('Systems that did not answer');
    expect((await none.store.getRun(none.runId))?.block).toBeNull();
  });

  test('a system must be named exactly as the tool result named it', async () => {
    const h = await harness();
    for (const system of ['harbor', 'SSFB:harbor', 'ssfb:harbor-db', 'ssfb']) {
      const out = await call(h.tool, { systems: [system], reason: REASON });
      expect(out.status).toBe('refused');
      expect(out.message).toContain(`${system} did not answer`);
    }
    expect((await h.store.getRun(h.runId))?.block).toBeNull();
  });

  test('refuses while a question is open', async () => {
    const h = await harness();
    await h.store.putInputRequest(h.runId, redactPersisted(question('q1')));
    const out = await call(h.tool, { systems: [HARBOR], reason: REASON });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('question q1');
    const run = await h.store.getRun(h.runId);
    expect(run?.phase).toBe('needs_input');
    expect(run?.block).toBeNull();
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'question open' });
  });

  test('refuses while a block is open', async () => {
    const h = await harness();
    expect((await call(h.tool, { systems: [HARBOR], reason: REASON })).status).toBe('ok');
    const again = await call(h.tool, { systems: [HARBOR], reason: 'Still nothing from harbor.' });
    expect(again.status).toBe('refused');
    expect(again.message).toContain('b1 is already open');
    expect(again.message).toContain(BLOCKED_NOTE);
    const run = await h.store.getRun(h.runId);
    expect(run?.block?.reason).toBe(REASON);
    expect(run?.block_history).toEqual([]);
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'already open' });
  });

  test('a block or question opened between the read and the write is refused the same way', async () => {
    const blocked = await harness({ wrap: staleReads });
    await blocked.store.putBlock(blocked.runId, redactPersisted(sampleBlock('b1')));
    const out = await call(blocked.tool, { systems: [HARBOR], reason: REASON });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('b1 is already open');
    expect(blocked.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'already open' });
    expect((await blocked.store.getRun(blocked.runId))?.block?.reason).toBe(sampleBlock('b1').reason);

    const asked = await harness({ wrap: staleReads });
    await asked.store.putInputRequest(asked.runId, redactPersisted(question('q1')));
    const second = await call(asked.tool, { systems: [HARBOR], reason: REASON });
    expect(second.status).toBe('refused');
    expect(second.message).toContain('question q1');
    expect(asked.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'question open' });
    expect((await asked.store.getRun(asked.runId))?.block).toBeNull();
  });

  test('numbers blocks from the history and records the latest submission', async () => {
    const h = await harness();
    await h.store.addSubmission(h.runId, redactPersisted({ kind: 'initial' }));
    await h.store.addSubmission(h.runId, redactPersisted({ kind: 'ask', question: 'And the fee?' }));
    const first = await call(h.tool, { systems: [HARBOR], reason: REASON });
    expect(first.data).toMatchObject({ block_id: 'b1' });
    expect((await h.store.getRun(h.runId))?.block?.submission_seq).toBe(2);

    // A resume closes the block and sends the run on; the same system fails again.
    await h.store.resolveBlock(h.runId, 'b1', redactPersisted({ status: 'resumed', resolved_at: AT, resolved_by: 'ops' }));
    await h.store.addSubmission(h.runId, redactPersisted({ kind: 'resume', block_id: 'b1' }));
    await h.store.setPhase(h.runId, 'investigating');
    const second = await call(h.tool, { systems: [HARBOR], reason: REASON });
    expect(second.status).toBe('ok');
    expect(second.data).toMatchObject({ block_id: 'b2' });
    const run = await h.store.getRun(h.runId);
    expect(run?.phase).toBe('blocked');
    expect(run?.block).toMatchObject({ block_id: 'b2', submission_seq: 3 });
    expect(run?.block_history.map((b) => [b.block_id, b.status])).toEqual([['b1', 'resumed']]);
  });

  test('refuses an unmasked identifier in the reason and stores nothing', async () => {
    const h = await harness();
    const out = await call(h.tool, { systems: [HARBOR], reason: `harbor did not answer for account ${ACCOUNT}; the payout state is unknown.` });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('unmasked');
    expect(out.message).toContain('without identifiers');
    expect(out.message).not.toContain(ACCOUNT);
    const run = await h.store.getRun(h.runId);
    expect(run?.phase).toBe('investigating');
    expect(run?.block).toBeNull();
    expect(JSON.stringify(h.audit.lines)).not.toContain(ACCOUNT);
    expect(h.audit.lines.at(-1)?.decision).toBe('deny');
    expect(h.audit.lines.at(-1)?.reason).toMatch(/^unmasked: /);
  });

  test('masks ingress names in the stored reason', async () => {
    const h = await harness({ names: ['Asha Verma'] });
    const out = await call(h.tool, { systems: [HARBOR], reason: 'The account Asha Verma opened lives in harbor and harbor did not answer.' });
    expect(out.status).toBe('ok');
    const stored = (await h.store.getRun(h.runId))?.block?.reason ?? '';
    expect(stored).not.toContain('Asha Verma');
    expect(stored).toContain('lives in harbor');
  });

  test('refuses when the run budget is exhausted', async () => {
    const h = await harness({ maxToolCalls: 1 });
    expect(h.budget.consumeToolCall('sql_select').ok).toBe(true);
    const out = await call(h.tool, { systems: [HARBOR], reason: REASON });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('budget');
    expect((await h.store.getRun(h.runId))?.block).toBeNull();
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'budget: tool_calls' });
  });

  test('refuses a shape that does not fit, naming the fields only', async () => {
    const h = await harness({ maxToolCalls: 10 });
    const cases: [unknown, string | null][] = [
      [{ systems: [], reason: REASON }, 'systems'],
      [{ systems: [HARBOR, 'a:b', 'c:d', 'e:f', 'g:h', 'i:j', 'k:l'], reason: REASON }, 'systems'],
      [{ systems: [HARBOR, ''], reason: REASON }, 'systems'],
      [{ systems: HARBOR, reason: REASON }, 'systems'],
      [{ reason: REASON }, 'systems'],
      [{ systems: [HARBOR], reason: '   ' }, 'reason'],
      [{ systems: [HARBOR], reason: 'x'.repeat(301) }, 'reason'],
      [{ systems: [HARBOR] }, 'reason'],
      [{ systems: [HARBOR], reason: REASON, run_id: 'x' }, null],
    ];
    for (const [data, field] of cases) {
      const out = await call(h.tool, data);
      expect(out.status).toBe('refused');
      expect(out.message).toContain('does not fit');
      if (field !== null) expect(out.message).toContain(field);
    }
    expect((await h.store.getRun(h.runId))?.block).toBeNull();
    expect(h.audit.lines.filter((l) => l.decision === 'deny')).toHaveLength(cases.length);
  });

  test('refuses a run the store does not know', async () => {
    const h = await harness({ created: false });
    const out = await call(h.tool, { systems: [HARBOR], reason: REASON });
    expect(out.status).toBe('refused');
    expect(out.message).toContain('not in the run store');
    expect(h.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'run not found' });
  });

  test('real mode audits transport real', async () => {
    const h = await harness({ mockMode: false });
    expect((await call(h.tool, { systems: [HARBOR], reason: REASON })).status).toBe('ok');
    expect(h.audit.lines.at(-1)).toMatchObject({ transport: 'real', exit: 'ok' });
  });

  test('module: the triage mount only, always on, and conforms', () => {
    expect(toolModule.name).toBe(STOP_BLOCKED);
    expect(toolModule.mounts).toEqual(['triage']);
    expect(toolModule.entities).toBe('all');
    const ctx = makeToolContext({ entity: null });
    expect(toolModule.enabled(ctx, 'triage')).toEqual({ on: true });
    expect(toolModule.enabled(makeToolContext({ entity: null, env: { TRIAGE_MAX_ASKS_PER_RUN: '0' } }), 'triage')).toEqual({ on: true });
    const tool = toolModule.create(ctx, 'triage');
    expect(conformanceProblems(toolModule, tool)).toEqual([]);
    expect(tool.description).toContain('stop');
    expect(tool.description).toContain('did not answer');
    expect(tool.description).toContain('gap');
  });
});
