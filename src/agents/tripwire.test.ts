import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlueExecutionContext, FlueInstrumentation, FlueObservation } from '@flue/runtime';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../gate/audit-sink.ts';
import { BUDGET_EXHAUSTED_MESSAGE, createRunBudget, getRunBudget, releaseRunBudget } from '../gate/budget.ts';
import type { Entity } from '../types/core.ts';
import {
  ALLOWLIST_TARGET,
  allowedToolNames,
  createTripwire,
  FRAMEWORK_TOOL_NAMES,
  installedTripwire,
  installTripwire,
  runBudgetSource,
  runUsage,
  SANDBOX_TOOL_NAMES,
  type Tripwire,
  TripwireDeniedError,
  tripwireOptionsFor,
  UNKNOWN_RUN_ID,
} from './tripwire.ts';

const CODE_TOOLS = ['code_explore', 'code_node', 'code_impact', 'repo_read', 'repo_grep'] as const;

// A synthetic base64 key: only its presence matters to enabled().
const FAKE_FIELD_KEY = 'dGVzdC1rZXktbm90LXJlYWwtMDEyMzQ1Njc4OTAxMjM0NQ==';
const SSFB_FLAGS = { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true', SSFB_HARBOR_FIELD_ENC_KEY: FAKE_FIELD_KEY };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function home(entities: readonly Entity[], overrides: Record<string, string> = {}): TestHome {
  const h = makeTestHome({ entities, overrides });
  cleanups.push(h.cleanup);
  return h;
}

/** All three entities, SSFB flags on, code tools on. */
function fullHome(): TestHome {
  return home(['ssfb', 'atspl', 'rtl'], { ...SSFB_FLAGS, TRIAGE_REPOS_DIR: tempDir('tw-repos-') });
}

let runSeq = 0;
function freshRunId(): string {
  runSeq += 1;
  const id = `run_tripwire_${Date.now()}_${runSeq}`;
  cleanups.push(() => void releaseRunBudget(id));
  return id;
}

type Harness = { tripwire: Tripwire; audit: MemoryAuditSink; h: TestHome };

function harness(h: TestHome = fullHome()): Harness {
  const audit = createMemoryAuditSink();
  const tripwire = createTripwire(tripwireOptionsFor(h.config, h.registry, audit));
  return { tripwire, audit, h };
}

function ctxFor(runId: string): FlueExecutionContext {
  return { instanceId: runId, agentName: 'triage' };
}

async function callTool(t: Tripwire, toolName: string, runId: string): Promise<{ ran: boolean; error?: unknown }> {
  let ran = false;
  try {
    const out = await t.interceptor({ type: 'tool', toolCallId: `call_${toolName.length}`, toolName }, ctxFor(runId), async () => {
      ran = true;
      return 'result';
    });
    expect(out).toBe('result');
    return { ran };
  } catch (error) {
    return { ran, error };
  }
}

function taskStart(taskId: string, runId: string): FlueObservation {
  return { type: 'task_start', taskId, prompt: 'look at ssfb', instanceId: runId, v: 3, eventIndex: 0, timestamp: new Date().toISOString() } as unknown as FlueObservation;
}

function turn(runId: string, provider: string, model: string, input: number, output: number): FlueObservation {
  return {
    type: 'turn',
    turnId: `turn_${input}_${output}`,
    purpose: 'agent',
    durationMs: 1,
    isError: false,
    request: { providerId: provider, providerName: provider, requestedModel: model, api: 'test' },
    response: { usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: {} } },
    instanceId: runId,
    v: 3,
    eventIndex: 0,
    timestamp: new Date().toISOString(),
  } as unknown as FlueObservation;
}

async function delegate(t: Tripwire, runId: string, taskId: string): Promise<{ ran: boolean; error?: unknown }> {
  t.observe(taskStart(taskId, runId), { id: runId } as never);
  let ran = false;
  try {
    await t.interceptor({ type: 'task', taskId }, ctxFor(runId), async () => {
      ran = true;
    });
    return { ran };
  } catch (error) {
    return { ran, error };
  }
}

// ------------------------------------------------------------------ allowlist

describe('allowlist', () => {
  test('snapshot for TRIAGE_ENTITIES=ssfb,atspl,rtl with SSFB flags on', () => {
    const { config, registry } = fullHome();
    expect(allowedToolNames({ config, registry })).toEqual([
      'activate_skill',
      'ask_requester',
      'bash',
      'cbs_call',
      'code_explore',
      'code_impact',
      'code_node',
      'decrypt_fields',
      'detect_silent_reversals',
      'edit',
      'encrypt_lookup_value',
      'finish',
      'finish_report',
      'get_account_statement',
      'glob',
      'grep',
      'http_call',
      'logs_search',
      'note_evidence',
      'read',
      'read_skill_resource',
      'repo_grep',
      'repo_read',
      'resolve_identity',
      'sql_select',
      'task',
      'write',
    ]);
  });

  test('always holds the six sandbox tools and the four framework tools, never give_up', () => {
    const names = allowedToolNames(home(['rtl']));
    for (const n of [...SANDBOX_TOOL_NAMES, ...FRAMEWORK_TOOL_NAMES]) expect(names).toContain(n);
    expect(names).not.toContain('give_up');
  });

  test('SSFB-only tools drop out when ssfb is not enabled', () => {
    const names = allowedToolNames(home(['atspl', 'rtl'], SSFB_FLAGS));
    for (const n of ['get_account_statement', 'detect_silent_reversals', 'cbs_call', 'decrypt_fields', 'encrypt_lookup_value']) {
      expect(names).not.toContain(n);
    }
  });

  test('flag-gated SSFB tools drop out when their flags are off', () => {
    const names = allowedToolNames(home(['ssfb']));
    expect(names).toContain('get_account_statement');
    for (const n of ['cbs_call', 'decrypt_fields', 'encrypt_lookup_value']) expect(names).not.toContain(n);
  });
});

// ------------------------------------------------------------------ deny and allow

describe('tool names', () => {
  const DENY = [
    'curl',
    'psql',
    'git',
    'gh',
    'kubectl',
    'ssh',
    'qw',
    'slack_post',
    'local',
    'shell',
    'exec',
    'http_get',
    'deep_investigator',
    'bash_host',
    'give_up',
    'SQL_SELECT',
    'sql_select_',
    ' sql_select',
    'sql_select ',
    '',
  ];

  test('every name on the deny list is refused with one audit deny line naming it', async () => {
    const { tripwire, audit } = harness();
    const runId = freshRunId();
    for (const name of DENY) {
      const before = audit.lines.length;
      const { ran, error } = await callTool(tripwire, name, runId);
      expect(ran).toBe(false);
      expect(error).toBeInstanceOf(TripwireDeniedError);
      expect(audit.lines.length).toBe(before + 1);
      const line = audit.lines.at(-1)!;
      expect(line.decision).toBe('deny');
      expect(line.run_id).toBe(runId);
      expect(line.target).toBe(ALLOWLIST_TARGET);
      expect(line.transport).toBe('mock');
      expect(line.entity).toBeNull();
      expect(line.tool).toBe(/^[a-z_]+$/i.test(name) ? name : JSON.stringify(name));
      expect(line.reason).toContain('allowlist');
    }
    expect(audit.lines.length).toBe(DENY.length);
  });

  test("an SSFB-only tool is refused when ssfb is not in TRIAGE_ENTITIES", async () => {
    const { tripwire, audit } = harness(home(['atspl', 'rtl'], SSFB_FLAGS));
    for (const name of ['get_account_statement', 'detect_silent_reversals', 'cbs_call', 'decrypt_fields']) {
      const { ran, error } = await callTool(tripwire, name, freshRunId());
      expect(ran).toBe(false);
      expect(error).toBeInstanceOf(TripwireDeniedError);
      expect(audit.lines.at(-1)?.tool).toBe(name);
    }
    expect(audit.lines).toHaveLength(4);
  });

  test('every allowlisted name passes and writes nothing', async () => {
    const h = fullHome();
    const { tripwire, audit } = harness(h);
    const runId = freshRunId();
    for (const name of allowedToolNames(h)) {
      const { ran, error } = await callTool(tripwire, name, runId);
      expect(error).toBeUndefined();
      expect(ran).toBe(true);
    }
    expect(audit.lines).toHaveLength(0);
  });

  test('the model sees a short refusal that points back to its own tools', async () => {
    const { tripwire } = harness();
    const { error } = await callTool(tripwire, 'curl', freshRunId());
    expect((error as Error).message).toBe('tool curl is not available here; use the tools you were given');
  });

  test('model, agent and task operations are not tool-name checked', async () => {
    const { tripwire, audit } = harness();
    const runId = freshRunId();
    const ctx = ctxFor(runId);
    expect(await tripwire.interceptor({ type: 'model', turnId: 't1' }, ctx, async () => 1)).toBe(1);
    expect(
      await tripwire.interceptor({ type: 'agent', operationId: 'o1', operationKind: 'prompt' }, ctx, async () => 2),
    ).toBe(2);
    expect(audit.lines).toHaveLength(0);
  });

  test('a run id that does not fit the schema is audited as unknown_run', async () => {
    const { tripwire, audit } = harness();
    const { error } = await callTool(tripwire, 'psql', '../../etc');
    expect(error).toBeInstanceOf(TripwireDeniedError);
    expect(audit.lines[0]?.run_id).toBe(UNKNOWN_RUN_ID);
  });

  test('the call is still refused when the audit write fails', async () => {
    const h = fullHome();
    const failing = {
      write() {
        throw new Error('disk full');
      },
    };
    const tripwire = createTripwire(tripwireOptionsFor(h.config, h.registry, failing));
    const { ran, error } = await callTool(tripwire, 'kubectl', freshRunId());
    expect(ran).toBe(false);
    expect(error).toBeInstanceOf(TripwireDeniedError);
    expect(((error as Error).cause as Error).message).toBe('disk full');
  });
});

// ------------------------------------------------------------------ code tools

describe('code tool names', () => {
  test('allowed when the code tool modules are enabled', async () => {
    const { tripwire, audit } = harness(fullHome());
    for (const name of CODE_TOOLS) {
      const { ran, error } = await callTool(tripwire, name, freshRunId());
      expect(error).toBeUndefined();
      expect(ran).toBe(true);
    }
    expect(audit.lines).toHaveLength(0);
  });

  test('denied, each with an audit line, when the code tools are disabled', async () => {
    // CODEGRAPH_BIN blank falls back to its default in keys.ts, so what turns
    // the modules off is what their enabled() reads: a blank TRIAGE_REPOS_DIR
    // (repo_read, repo_grep) and no repo pins (the codegraph tools).
    const h = home(['ssfb', 'atspl', 'rtl'], { ...SSFB_FLAGS, CODEGRAPH_BIN: '', TRIAGE_REPOS_DIR: '' });
    writeFileSync(join(h.home, 'resources', 'repos.json'), '[]\n');
    expect(allowedToolNames(h)).not.toContain('code_explore');
    const { tripwire, audit } = harness(h);
    for (const name of CODE_TOOLS) {
      const before = audit.lines.length;
      const { ran, error } = await callTool(tripwire, name, freshRunId());
      expect(ran).toBe(false);
      expect(error).toBeInstanceOf(TripwireDeniedError);
      expect(audit.lines.length).toBe(before + 1);
      expect(audit.lines.at(-1)).toMatchObject({ decision: 'deny', tool: name });
    }
  });
});

// ------------------------------------------------------------------ task budget

describe('task budget', () => {
  test('tasks 1 to 12 pass and task 13 is denied through observe() and consumeTask', async () => {
    const { tripwire, audit, h } = harness();
    expect(h.config.budgets.maxTasksPerRun).toBe(12);
    const runId = freshRunId();
    for (let i = 1; i <= 12; i++) {
      const { ran, error } = await delegate(tripwire, runId, `task_${i}`);
      expect(error).toBeUndefined();
      expect(ran).toBe(true);
    }
    expect(getRunBudget(runId)?.state().tasks).toBe(12);
    expect(audit.lines).toHaveLength(0);

    const { ran, error } = await delegate(tripwire, runId, 'task_13');
    expect(ran).toBe(false);
    expect(error).toBeInstanceOf(TripwireDeniedError);
    expect((error as Error).message).toBe(BUDGET_EXHAUSTED_MESSAGE);
    expect(audit.lines).toHaveLength(1);
    expect(audit.lines[0]).toMatchObject({
      run_id: runId,
      tool: 'task',
      decision: 'deny',
      target: 'TRIAGE_MAX_TASKS_PER_RUN',
      transport: 'mock',
    });
    expect(getRunBudget(runId)?.state()).toMatchObject({ tasks: 12, exhausted: true, exhaustedReason: 'tasks' });
  });

  test('each task_start consumes exactly one task, and the interceptor does not charge it again', async () => {
    const { tripwire } = harness();
    const runId = freshRunId();
    await delegate(tripwire, runId, 'a');
    await delegate(tripwire, runId, 'b');
    expect(getRunBudget(runId)?.state().tasks).toBe(2);
  });

  test('a task operation without a task_start is still charged', async () => {
    const { tripwire } = harness();
    const runId = freshRunId();
    await tripwire.interceptor({ type: 'task', taskId: 'no-start' }, ctxFor(runId), async () => undefined);
    expect(getRunBudget(runId)?.state().tasks).toBe(1);
  });

  test('budgets are per run', async () => {
    const { tripwire } = harness();
    const a = freshRunId();
    const b = freshRunId();
    for (let i = 0; i < 12; i++) await delegate(tripwire, a, `a_${i}`);
    expect((await delegate(tripwire, a, 'a_last')).error).toBeInstanceOf(TripwireDeniedError);
    expect((await delegate(tripwire, b, 'b_first')).error).toBeUndefined();
  });

  test('uses the budget createToolDeps registered first, and a run exhausted on tool calls refuses tasks', async () => {
    const { tripwire, audit, h } = harness();
    const runId = freshRunId();
    const budget = createRunBudget({
      runId,
      maxToolCalls: 1,
      maxTasks: 12,
      maxRowsPerCall: 10,
      maxBytesPerCall: 1000,
      maxBytesPerRun: 10000,
    });
    expect(runBudgetSource(h.config, h.registry)(runId)).toBe(budget);
    budget.consumeToolCall('sql_select');
    expect(budget.consumeToolCall('sql_select').ok).toBe(false);
    const { error } = await delegate(tripwire, runId, 'late');
    expect((error as Error).message).toBe(BUDGET_EXHAUSTED_MESSAGE);
    expect(audit.lines[0]?.target).toBe('TRIAGE_MAX_TOOL_CALLS_PER_RUN');
  });
});

// ------------------------------------------------------------------ usage

describe('runUsage', () => {
  test('sums input and output tokens per model for that run only', () => {
    const { tripwire } = harness();
    const a = freshRunId();
    const b = freshRunId();
    cleanups.push(() => tripwire.forgetRun(a), () => tripwire.forgetRun(b));
    const ctx = { id: a } as never;
    tripwire.observe(turn(a, 'anthropic', 'claude-sonnet-4-5', 100, 20), ctx);
    tripwire.observe(turn(a, 'anthropic', 'claude-sonnet-4-5', 50, 5), ctx);
    tripwire.observe(turn(a, 'openai', 'gpt-5-mini', 7, 3), ctx);
    tripwire.observe(turn(b, 'anthropic', 'claude-sonnet-4-5', 1000, 1000), ctx);
    // An operation roll-up repeats the turn totals, so it is not counted again.
    tripwire.observe({ type: 'operation', usage: { input: 999, output: 999 }, instanceId: a } as unknown as FlueObservation, ctx);
    // A turn without usage is skipped.
    tripwire.observe({ ...turn(a, 'x', 'y', 0, 0), response: {} } as unknown as FlueObservation, ctx);

    expect(runUsage(a)).toEqual({
      'anthropic/claude-sonnet-4-5': { input_tokens: 150, output_tokens: 25, calls: 2 },
      'openai/gpt-5-mini': { input_tokens: 7, output_tokens: 3, calls: 1 },
    });
    expect(runUsage(b)).toEqual({ 'anthropic/claude-sonnet-4-5': { input_tokens: 1000, output_tokens: 1000, calls: 1 } });
    expect(runUsage(freshRunId())).toEqual({});
  });

  test('forgetRun drops a finished run', () => {
    const { tripwire } = harness();
    const a = freshRunId();
    tripwire.observe(turn(a, 'anthropic', 'claude-haiku-4-5', 1, 1), { id: a } as never);
    tripwire.forgetRun(a);
    expect(runUsage(a)).toEqual({});
  });
});

// ------------------------------------------------------------------ install

describe('installTripwire', () => {
  test('installing twice does not throw and installs once', async () => {
    const h = fullHome();
    const installs: FlueInstrumentation[] = [];
    let disposed = 0;
    const counting = (i: FlueInstrumentation) => {
      installs.push(i);
      return async () => {
        disposed += 1;
      };
    };
    const opts = tripwireOptionsFor(h.config, h.registry, createMemoryAuditSink());
    const first = installTripwire(opts, { instrument: counting });
    const second = installTripwire(opts, { instrument: counting });
    expect(second).toBe(first);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.key).toBe(Symbol.for('triage-app.tripwire'));
    expect(installedTripwire()).toBe(first.tripwire);
    await first.dispose();
    expect(disposed).toBe(1);
    expect(installedTripwire()).toBeUndefined();
  });

  test("with Flue's instrument(), a second install does not throw", async () => {
    const h = fullHome();
    const opts = tripwireOptionsFor(h.config, h.registry, createMemoryAuditSink());
    const first = installTripwire(opts);
    try {
      expect(() => installTripwire(opts)).not.toThrow();
      expect(installTripwire(opts)).toBe(first);
    } finally {
      await first.dispose();
    }
  });
});
