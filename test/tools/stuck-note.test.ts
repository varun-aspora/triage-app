// P6: the per-agent count of calls in a row that were refused or found
// nothing, and the note runIoTool adds when it reaches TRIAGE_STUCK_AFTER.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../../src/gate/budget.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import { semanticKey } from '../../src/mock/key.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import { releaseActions } from '../../src/runlog/actions.ts';
import { EVENTS_FILE, flushRunEventLog, installRunEventLog, uninstallRunEventLog } from '../../src/runlog/event-log.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { releaseConnectorFailures } from '../../src/tools/_lib/connector-failures.ts';
import { createToolDeps } from '../../src/tools/_lib/context.ts';
import { countStuck, type IoToolSpec, runIoTool, stuckNote } from '../../src/tools/_lib/pipeline.ts';
import type { ToolContext, ToolDeps } from '../../src/tools/types.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import { ok, type ToolEnvelope } from '../../src/types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../support/fake-tool-context.ts';

// Synthetic ids only.
const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const STRANGER = 'deadbeef-9999-4888-8777-666655554444';
const CHAIN: IdChain = { ids: { customer_id: CUSTOMER }, hops: [], basic_state: [] };
const NOW = new Date('2026-09-29T10:00:00.000Z');
const ROOT_TAIL = 'Stop trying variations: say what is missing and use ask_requester for it, or stop_blocked if nobody can give it.';
const DELEGATE_TAIL = 'Stop trying variations: return what is missing to the root.';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let seq = 0;
type Run = { runId: string; deps: ToolDeps; ctx: (agent?: string) => ToolContext };

function setup(env: Record<string, string> = {}, maxToolCalls = 100): Run {
  seq += 1;
  const runId = `run_stuck_${seq}_${Math.random().toString(36).slice(2, 8)}`;
  const config = makeTestConfig({ TRIAGE_MOCK_MODE: 'false', ...env });
  const store: FixtureStore = { fixturesDir: '/triage-test/fixtures', get: async () => null, list: async () => [] };
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseConnectorFailures(runId);
    releaseActions(runId);
  });
  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: CHAIN,
    connectors: {},
    runStore: {} as RunStore,
    budget: createRunBudget({ runId, maxToolCalls, maxTasks: 5, maxRowsPerCall: 200, maxBytesPerCall: 100_000, maxBytesPerRun: 1_000_000 }),
    audit: createMemoryAuditSink(),
    fixtures: createMockLayer(config, { store }),
    now: () => NOW,
  });
  const base = makeToolContext({ config, runId, entity: 'ssfb', deps });
  return {
    runId,
    deps,
    ctx: (agent) => Object.freeze({ ...base, ...(agent !== undefined ? { agent } : {}) }),
  };
}

type Kind = 'rows' | 'none' | 'refused' | 'gate' | 'error';

// One sql_select-shaped call: 'rows' finds a row, 'none' finds 0 rows,
// 'refused' is out of scope, 'gate' fails the tool gate, 'error' is an outage.
function spec(kind: Kind, extra: Partial<IoToolSpec<'sql_select', unknown[]>> = {}): IoToolSpec<'sql_select', unknown[]> {
  const params = [kind === 'refused' ? STRANGER : CUSTOMER];
  return {
    tool: 'sql_select',
    service: 'harbor',
    input: { service: 'harbor', sql: 'SELECT id FROM t WHERE id = $1', params },
    backing: { envName: 'SSFB_HARBOR_DB_URL', status: 'ok' },
    scope: {},
    gate: () => (kind === 'gate' ? { ok: false, message: 'Refused: only SELECT is allowed.', reason: 'not a SELECT' } : { ok: true }),
    fixture: () => ({ kind: 'sql_select', key: semanticKey('sql_select', { entity: 'ssfb', service: 'harbor', tables: ['t'], params }) }),
    real: async () => {
      if (kind === 'error') throw Object.assign(new Error('tunnel down'), { code: 'unreachable' });
      return kind === 'rows' ? [{ id: CUSTOMER }] : [];
    },
    render: (rows) => ({ rows, row_count: rows.length }),
    empty: (rows) => rows.length === 0,
    ...extra,
  };
}

async function call(run: Run, kind: Kind, agent?: string, extra: Partial<IoToolSpec<'sql_select', unknown[]>> = {}): Promise<ToolEnvelope> {
  return runIoTool(spec(kind, extra), { toolContext: run.ctx(agent), toolCallId: `toolu_${seq}`, log: { info() {}, warn() {}, error() {} } });
}

const noted = (env: ToolEnvelope): boolean => env.output.message?.includes('calls in a row were refused or found nothing') === true;

describe('stuck note (P6)', () => {
  test('the note comes at TRIAGE_STUCK_AFTER and again at twice that, not in between', async () => {
    const run = setup();
    const seen: boolean[] = [];
    for (let i = 1; i <= 9; i += 1) seen.push(noted(await call(run, i % 2 === 0 ? 'refused' : 'none')));
    expect(seen).toEqual([false, false, false, true, false, false, false, true, false]);
  });

  test('refusals and empty results share one streak; the note follows the refusal text', async () => {
    const run = setup();
    await call(run, 'refused');
    await call(run, 'gate');
    await call(run, 'none');
    const fourth = await call(run, 'refused');
    expect(fourth.output.status).toBe('refused');
    expect(fourth.output.message).toStartWith('Refused: scope: ');
    expect(fourth.output.message).toEndWith(`4 calls in a row were refused or found nothing. ${ROOT_TAIL}`);
  });

  test('an empty ok result keeps its data and gets the note as its message', async () => {
    const run = setup({ TRIAGE_STUCK_AFTER: '2' });
    await call(run, 'none');
    const second = await call(run, 'none');
    expect(second.output).toMatchObject({ status: 'ok', data: { rows: [], row_count: 0 }, message: stuckNote(2, true) });
  });

  test('a result with something in it resets the streak', async () => {
    const run = setup();
    for (let i = 0; i < 3; i += 1) await call(run, 'refused');
    expect(noted(await call(run, 'rows'))).toBe(false);
    for (let i = 0; i < 3; i += 1) expect(noted(await call(run, 'none'))).toBe(false);
    expect(noted(await call(run, 'refused'))).toBe(true);
  });

  test('budget refusals, outages and a tool without an empty test leave the streak as it is', async () => {
    const run = setup();
    for (let i = 0; i < 3; i += 1) await call(run, 'none');
    // An outage neither adds nor resets.
    expect(noted(await call(run, 'error'))).toBe(false);
    expect(noted(await call(run, 'none'))).toBe(true);
    // A tool with no empty test counts an ok result as found.
    const other = setup({ TRIAGE_STUCK_AFTER: '2' });
    await call(other, 'none');
    const { empty: _empty, ...withoutEmpty } = spec('none');
    await runIoTool(withoutEmpty, { toolContext: other.ctx(), toolCallId: 'toolu_x', log: { info() {}, warn() {}, error() {} } });
    expect(noted(await call(other, 'none'))).toBe(false);
    // A budget refusal does not add to the streak.
    const spent = setup({ TRIAGE_STUCK_AFTER: '2' }, 1);
    await call(spent, 'none');
    const refusedByBudget = await call(spent, 'none');
    expect(refusedByBudget.output.status).toBe('refused');
    expect(noted(refusedByBudget)).toBe(false);
  });

  test('each agent of the run has its own count', async () => {
    const run = setup();
    for (let i = 0; i < 3; i += 1) {
      await call(run, 'refused', 'triage');
      await call(run, 'refused', 'investigate_ssfb');
      await call(run, 'refused', 'worker');
    }
    // A found result for the worker resets only the worker.
    await call(run, 'rows', 'worker');
    expect(noted(await call(run, 'refused', 'worker'))).toBe(false);
    expect(noted(await call(run, 'refused', 'investigate_ssfb'))).toBe(true);
    expect(noted(await call(run, 'refused', 'triage'))).toBe(true);
    // A context without an agent name is the root.
    const bare = setup({ TRIAGE_STUCK_AFTER: '2' });
    await call(bare, 'none', 'triage');
    expect((await call(bare, 'none')).output.message).toBe(stuckNote(2, true));
    // Another run starts from zero.
    expect(noted(await call(setup(), 'refused', 'triage'))).toBe(false);
  });

  test('a tool with its own pipeline (locate) shares the streak through countStuck', async () => {
    const run = setup({ TRIAGE_STUCK_AFTER: '2' });
    await call(run, 'none');
    const located = countStuck(run.ctx(), 'locate', ok({ found: [] }, () => NOW), 'empty');
    expect(located.output).toMatchObject({ status: 'ok', data: { found: [] }, message: stuckNote(2, true) });
  });

  test('investigators and workers are told to return what is missing to the root', async () => {
    const run = setup({ TRIAGE_STUCK_AFTER: '2' });
    for (const agent of ['investigate_ssfb', 'worker']) {
      await call(run, 'none', agent);
      const env = await call(run, 'none', agent);
      expect(env.output.message).toBe(`2 calls in a row were refused or found nothing. ${DELEGATE_TAIL}`);
      expect(env.output.message).not.toContain('ask_requester');
    }
    expect(stuckNote(4, true)).toBe(`4 calls in a row were refused or found nothing. ${ROOT_TAIL}`);
  });

  test('an exact repeat of an empty call counts as empty, and the cached result carries no note', async () => {
    const run = setup({ TRIAGE_STUCK_AFTER: '2' });
    const repeat = { repeat: () => ({ same: true }) };
    await call(run, 'none', 'triage', repeat);
    const second = await call(run, 'none', 'triage', repeat);
    expect(second.output.message).toContain('Already run by triage');
    expect(noted(second)).toBe(true);
    const third = await call(run, 'none', 'triage', repeat);
    expect(noted(third)).toBe(false);
  });

  test('the run log gets one stuck event per note, with names and counts only', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'triage-stuck-'));
    installRunEventLog({ runsDir, observe: () => () => {} });
    cleanups.push(() => {
      uninstallRunEventLog();
      rmSync(runsDir, { recursive: true, force: true });
    });
    const run = setup({ TRIAGE_STUCK_AFTER: '2' });
    for (let i = 0; i < 5; i += 1) await call(run, 'refused', 'worker');
    await flushRunEventLog();
    const events = readFileSync(join(runsDir, run.runId, EVENTS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; data: unknown });
    expect(events.filter((e) => e.type === 'stuck').map((e) => e.data)).toEqual([
      { agent: 'worker', tool: 'sql_select', calls: 2, after: 2 },
      { agent: 'worker', tool: 'sql_select', calls: 4, after: 2 },
    ]);
    expect(JSON.stringify(events)).not.toContain(STRANGER);
  });
});
