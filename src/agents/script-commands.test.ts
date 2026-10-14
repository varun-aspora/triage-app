import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox } from '@flue/runtime';
import type { Config } from '../config/env.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../gate/budget.ts';
import { releaseObservedIds } from '../gate/scope.ts';
import { createMockLayer } from '../mock/index.ts';
import type { FixtureStore } from '../mock/store.ts';
import { actionLine, actionsFor, logActions, releaseActions } from '../runlog/actions.ts';
import type { RunStore } from '../runstore/types.ts';
import { createToolDeps } from '../tools/_lib/context.ts';
import { allToolNames, toolsFor } from '../tools/index.ts';
import type { ToolContext, ToolDeps } from '../tools/types.ts';
import type { IdChain } from '../types/id-chain.ts';
import { REPO_ROOT } from '../../test/support/home.ts';
import { makeTestConfig, makeToolContext } from '../../test/support/fake-tool-context.ts';
import { releaseEscalation } from './escalation.ts';
import { type DelegateHooks, investigatorMounts, mountAll } from './delegates/investigator.ts';
import { workerMounts } from './delegates/worker.ts';
import { sandboxFactory } from './sandbox.ts';
import { bindRootTools, createScriptScope, releaseRootTools, runInTaskScope, SCRIPT_COMMANDS } from './script-commands.ts';
import { loadKnowledge } from './skills.ts';

// Synthetic ids, no real data.
const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const USER = 'c0ffee00-1111-4222-8333-777788889999';
const ACCOUNT = 'c0ffee00-1111-4222-8333-aaaabbbbcccc';
const STRANGER = 'deadbeef-9999-4888-8777-666655554444';
const DEVICE = 'c0ffee00-1111-4222-8333-00000000d001';
const CHAIN: IdChain = { ids: { customer_id: CUSTOMER, aspora_user_id: USER, account_id: ACCOUNT }, hops: [], basic_state: [] };
const FIXED_NOW = new Date('2026-09-24T10:00:00.000Z');
const FAKE_DSN = 'postgresql://triage_ro:not-a-password@package-db.internal.example:5432/package_db';
const BY_REF = 'SELECT id, device_id FROM delivery_requests WHERE external_ref_id = $1';
const ROWS = [{ id: 'row-1', device_id: DEVICE }];

const TEMP = mkdtempSync(join(tmpdir(), 'triage-script-commands-test-'));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const knowledge = loadKnowledge(join(REPO_ROOT, 'knowledge'));
const NO_HOOKS: DelegateHooks = { useTool: () => {}, useSkill: () => {} };

type H = {
  readonly runId: string;
  readonly config: Config;
  readonly deps: ToolDeps;
  readonly audit: MemoryAuditSink;
  readonly rootCtx: ToolContext;
  readonly sandbox: Sandbox;
  /** Fixture lookups made, one per call that reached the mock layer. */
  readonly lookups: () => number;
};

let seq = 0;

async function setup(opts: { maxToolCalls?: number; env?: Record<string, string>; rows?: readonly unknown[] } = {}): Promise<H> {
  seq += 1;
  const runId = `run_script_cmd_${seq}_${Date.now().toString(36)}`;
  const config = makeTestConfig({ ATSPL_PACKAGE_DB_URL: FAKE_DSN, TRIAGE_AGENT_SHAPE: 'single', ...opts.env });
  const budget = createRunBudget({
    runId,
    maxToolCalls: opts.maxToolCalls ?? 20,
    maxTasks: 5,
    maxRowsPerCall: config.sql.maxRows,
    maxBytesPerCall: 100_000,
    maxBytesPerRun: 1_000_000,
  });
  let lookups = 0;
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get(kind) {
      lookups += 1;
      return { scope: 'shared', path: '/triage-test/fixtures/x.json', hash: '0123456789abcdef', fixture: { kind, result: { rows: opts.rows ?? ROWS, columns: ['id', 'device_id'] } } as never };
    },
    async list() {
      return [];
    },
  };
  const audit = createMemoryAuditSink();
  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: CHAIN,
    connectors: {},
    runStore: {} as RunStore,
    budget,
    audit,
    fixtures: createMockLayer(config, { store }),
    now: () => FIXED_NOW,
  });
  const rootCtx = Object.freeze({ ...makeToolContext({ config, runId, deps }), agent: 'triage' });
  bindRootTools(runId, logActions(toolsFor('agent', rootCtx), rootCtx));
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
    releaseActions(runId);
    releaseObservedIds(runId);
    releaseRootTools(runId);
  });
  // bun cannot run just-bash's defense-in-depth patches; Node (the app runtime) can.
  const sandbox = await sandboxFactory(config, { defenseInDepth: false, runsDir: join(TEMP, 'runs') }).createSandbox({ id: runId });
  return { runId, config, deps, audit, rootCtx, sandbox, lookups: () => lookups };
}

const sqlInput = (id: string, entity: string | null = 'atspl'): string =>
  JSON.stringify({ ...(entity !== null ? { entity } : {}), service: 'package', sql: BY_REF, params: [id] });

describe('script commands: JSON in, JSON out', () => {
  test('the four commands are real tool names', () => {
    for (const name of SCRIPT_COMMANDS) expect(allToolNames()).toContain(name);
  });

  test('sql_select with a JSON argument prints the fixture rows', async () => {
    const h = await setup();
    const r = await h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}'`);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ service: 'package', columns: ['id', 'device_id'], rows: ROWS });
  });

  test('sql_select reads the JSON from stdin', async () => {
    const h = await setup();
    const r = await h.sandbox.exec(`q='${sqlInput(USER)}'; echo "$q" | sql_select | jq -c '.rows'`);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(ROWS);
  });

  test('an id out of scope exits 1 with the scope refusal on stderr', async () => {
    const h = await setup();
    const r = await h.sandbox.exec(`sql_select '${sqlInput(STRANGER)}'`);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^sql_select: Refused: /);
    expect(h.lookups()).toBe(0);
  });

  test('invalid JSON, a missing input and input that does not fit the tool exit 1 with the usage', async () => {
    const h = await setup();
    for (const cmd of [`sql_select '{"entity":'`, "printf '' | sql_select", `sql_select '{"entity":"atspl"}'`]) {
      const r = await h.sandbox.exec(cmd);
      expect(r.exitCode, cmd).toBe(1);
      expect(r.stderr, cmd).toContain("usage: sql_select '<json>'");
    }
    expect(h.lookups()).toBe(0);
  });

  test('curl to a URL still fails: the sandbox has no network', async () => {
    const h = await setup();
    const r = await h.sandbox.exec('curl -s https://example.com/');
    expect(r.exitCode).not.toBe(0);
  });
});

describe('script commands: the same gated path as the tool', () => {
  test('a call counts against the budget and writes an audit line and an action log line marked as a script', async () => {
    const h = await setup();
    const before = h.deps.budget.state();
    const r = await h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}' > /data/rows.json`);
    expect(r.exitCode).toBe(0);
    expect(h.deps.budget.state().calls).toBe(before.calls + 1);
    expect(h.audit.lines.map((l) => [l.tool, l.entity, l.decision, l.exit])).toEqual([['sql_select', 'atspl', 'allow', 'ok']]);
    const [action] = actionsFor(h.runId);
    expect(action).toMatchObject({ agent: 'triage', tool: 'sql_select', entity: 'atspl', script: true });
    expect(actionLine(action!)).toContain(' triage (script) sql_select {"entity":"atspl"');
    // The full result was staged as for a model call, and the script's own file holds it too.
    expect(action!.toolCallId).toMatch(/^script_/);
    expect(JSON.parse(await h.sandbox.readFile(`/data/${action!.toolCallId}.json`)).rows).toEqual(ROWS);
    expect(JSON.parse(await h.sandbox.readFile('/data/rows.json')).rows).toEqual(ROWS);
  });

  test('a spent run budget exits 2', async () => {
    const h = await setup({ maxToolCalls: 1 });
    expect((await h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}'`)).exitCode).toBe(0);
    const r = await h.sandbox.exec(`sql_select '${sqlInput(USER)}'`);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('budget exhausted');
  });

  test('a loop over 3 ids from a /data file makes 3 calls', async () => {
    const h = await setup();
    await h.sandbox.writeFile('/data/ids.json', JSON.stringify([CUSTOMER, USER, ACCOUNT]));
    const script = [
      `jq -r '.[]' /data/ids.json | while read -r id; do`,
      `  jq -nc --arg id "$id" '{entity: "atspl", service: "package", sql: "${BY_REF}", params: [$id]}' \\`,
      '    | sql_select > "/data/pkg-$id.json" || echo "$id refused" >&2',
      'done',
      'ls /data | grep -c "^pkg-"',
    ].join('\n');
    const r = await h.sandbox.exec(script);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('3');
    expect(h.lookups()).toBe(3);
    expect(actionsFor(h.runId).filter((a) => a.script === true)).toHaveLength(3);
  });

  test('a note on an ok result goes to stderr: a reused result, then the stuck note', async () => {
    const h = await setup({ rows: [], env: { TRIAGE_STUCK_AFTER: '2' } });
    const first = await h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}'`);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe('');
    // The exact repeat is reused with its note, and its second empty result is the second in a row.
    const again = await h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}'`);
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout).rows).toEqual([]);
    expect(again.stderr).toMatch(/^sql_select: Already run by triage at .*result reused, nothing new was queried/);
    expect(again.stderr).toContain('2 calls in a row were refused or found nothing');
    expect(h.lookups()).toBe(1);
  });

  test('a result cut at TRIAGE_SQL_MAX_ROWS says truncated on stdout', async () => {
    const h = await setup({ rows: [ROWS[0], { id: 'row-2', device_id: DEVICE }], env: { TRIAGE_SQL_MAX_ROWS: '1' } });
    const r = await h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}' | jq -c '.truncated'`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('true');
  });

  test("ids in a script's result become derived leads the next call may use (D97)", async () => {
    const h = await setup();
    const early = await h.sandbox.exec(`sql_select '${sqlInput(DEVICE)}'`);
    expect(early.exitCode).toBe(1);
    expect((await h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}'`)).exitCode).toBe(0);
    expect(h.deps.idChain().leads?.find((l) => l.value === DEVICE)).toMatchObject({ source: 'derived', status: 'derived' });
    const r = await h.sandbox.exec(`sql_select '${sqlInput(DEVICE)}' | jq -r '.rows[0].id'`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('row-1');
  });
});

describe('script commands: the calling agent', () => {
  test("in a task scope the command runs the split investigator's tool, with its fixed entity", async () => {
    const h = await setup({ env: { TRIAGE_AGENT_SHAPE: 'split' } });
    const env = { config: h.config, registry: h.rootCtx.registry, deps: h.deps, knowledge };
    const r = await runInTaskScope(async () => {
      mountAll(investigatorMounts('atspl', h.runId as never, { env }), NO_HOOKS);
      return h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER, null)}'`);
    });
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(h.audit.lines[0]).toMatchObject({ tool: 'sql_select', entity: 'atspl' });
    expect(actionsFor(h.runId)[0]).toMatchObject({ agent: 'investigate_atspl', entity: 'atspl', script: true });
    // The investigator's input has no entity; one in the JSON is dropped by its schema and the call stays on atspl.
    const named = await runInTaskScope(async () => {
      mountAll(investigatorMounts('atspl', h.runId as never, { env }), NO_HOOKS);
      return h.sandbox.exec(`sql_select '${sqlInput(USER, 'rtl')}'`);
    });
    expect(named.exitCode).toBe(0);
    expect(h.audit.lines.map((l) => l.entity)).toEqual(['atspl', 'atspl']);
  });

  test("the worker's command counts against its per-task cap", async () => {
    const h = await setup({ env: { TRIAGE_MAX_TOOL_CALLS_PER_WORKER: '1' } });
    const env = { config: h.config, registry: h.rootCtx.registry, deps: h.deps, knowledge };
    const [first, second] = await runInTaskScope(async () => {
      mountAll(workerMounts(h.runId as never, { env }), NO_HOOKS);
      return [await h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}'`), await h.sandbox.exec(`sql_select '${sqlInput(USER)}'`)];
    });
    expect(first!.exitCode).toBe(0);
    expect(second!.exitCode).toBe(1);
    expect(second!.stderr).toContain('TRIAGE_MAX_TOOL_CALLS_PER_WORKER');
    expect(actionsFor(h.runId).map((a) => [a.agent, a.script])).toEqual([
      ['worker', true],
      ['worker', true],
    ]);
  });

  test('a command the agent has not mounted exits 1: the split root has no data tools', async () => {
    const h = await setup({ env: { TRIAGE_AGENT_SHAPE: 'split' } });
    bindRootTools(h.runId, toolsFor('triage', h.rootCtx));
    const r = await h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}'`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('sql_select: not available to the agent that ran this script\n');
    expect(h.lookups()).toBe(0);
  });

  test('the interceptor opens a scope per task call and an empty one for a task bash call outside any', async () => {
    const h = await setup();
    const { interceptor } = createScriptScope();
    const exec = (): Promise<{ exitCode: number; stderr: string }> => h.sandbox.exec(`sql_select '${sqlInput(CUSTOMER)}'`);
    const task = { type: 'tool', toolCallId: 'toolu_task', toolName: 'task' } as const;
    const bash = { type: 'tool', toolCallId: 'toolu_bash', toolName: 'bash' } as const;
    // Inside a task call before the delegate binds anything: nothing is mounted.
    expect((await interceptor(task, {}, exec)).exitCode).toBe(1);
    // A task session's bash call with no task scope (a child resumed after a restart) does not run as the root.
    expect((await interceptor(bash, { taskId: 'task_1' }, exec)).stderr).toContain('not set up in this session');
    // The root's own bash call uses the root's tools.
    expect((await interceptor(bash, {}, exec)).exitCode).toBe(0);
  });

  test('--help prints the usage', async () => {
    const h = await setup();
    const r = await h.sandbox.exec('locate --help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("usage: locate '<json>'");
  });
});
