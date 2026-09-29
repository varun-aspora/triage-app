import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { releaseEscalation } from '../../src/agents/escalation.ts';
import { createMemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../../src/gate/budget.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { createToolDeps } from '../../src/tools/_lib/context.ts';
import { modelBytes } from '../../src/tools/_lib/pipeline.ts';
import { conformanceProblems } from '../../src/tools/index.ts';
import { cutToBytes, type ReadHarness, ReadStagedInputSchema, readStagedTool, toolModule } from '../../src/tools/read-staged.tool.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../support/fake-tool-context.ts';

const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const FILE = '/data/toolu_01ABCdef.json';
const STAGED = {
  groups: [
    { key: 'timeout calling ledger', count: 40 },
    { key: 'duplicate request', count: 12 },
    { key: 'bad signature', count: 3 },
  ],
  num_hits: 55,
  owner: 'priya.sharma@example.com',
  customer_id: CUSTOMER,
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let seq = 0;

function setup(files: Record<string, string> = { [FILE]: JSON.stringify(STAGED) }, maxToolCalls = 10, env: Record<string, string> = {}) {
  seq += 1;
  const runId = `run_read_staged_${seq}_${Math.random().toString(36).slice(2, 8)}`;
  const config = makeTestConfig(env);
  const budget = createRunBudget({ runId, maxToolCalls, maxTasks: 1, maxRowsPerCall: 10, maxBytesPerCall: 100_000, maxBytesPerRun: 1_000_000 });
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
  });
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get() {
      return null;
    },
    async list() {
      return [];
    },
  };
  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: { ids: { customer_id: CUSTOMER }, hops: [], basic_state: [] },
    connectors: {},
    runStore: {} as RunStore,
    budget,
    audit: createMemoryAuditSink(),
    fixtures: createMockLayer(config, { store }),
    now: () => new Date('2026-09-23T10:00:00.000Z'),
  });
  const ctx = makeToolContext({ config, runId, entity: 'ssfb', deps });
  // bun cannot run just-bash's defense-in-depth patches; Node (the app runtime) can.
  const tool = readStagedTool(ctx, { defenseInDepth: false });
  const reads: string[] = [];
  const harness: ReadHarness = {
    sandbox: {
      async readFile(path: string) {
        reads.push(path);
        const text = files[path];
        if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
        return text;
      },
    },
  };
  return {
    budget,
    reads,
    cap: config.budgets.maxModelBytesPerCall,
    // useHarness: false passes none; an object replaces the fake harness.
    async call(input: unknown, useHarness: boolean | object = true): Promise<ToolEnvelope> {
      const data = v.parse(ReadStagedInputSchema, input);
      const given = useHarness === true ? harness : useHarness === false ? undefined : useHarness;
      const out = await tool.run({ data, toolCallId: 'toolu_read_1', log: { info() {}, warn() {}, error() {} }, ...(given !== undefined ? { harness: given } : {}) } as never);
      return v.parse(ToolEnvelopeSchema, out);
    },
  };
}

type Result = { file: string; bytes_total: number; bytes_returned: number; truncated: boolean; lines_total?: number; result: string; note?: string };

function resultOf(env: ToolEnvelope): Result {
  expect(env.output.status).toBe('ok');
  return env.output.data as Result;
}

function refusal(env: ToolEnvelope): string {
  expect(env.output.status).toBe('refused');
  return String(env.output.message);
}

describe('read_staged module', () => {
  test('conforms, is a harness tool on the investigator mount, and has no entity input', () => {
    const ctx = makeToolContext({ entity: 'rtl' });
    const tool = toolModule.create(ctx, 'investigator');
    expect(conformanceProblems(toolModule, tool)).toEqual([]);
    expect(tool.name).toBe('read_staged');
    expect(tool.harness).toBe(true);
    expect(toolModule.mounts).toEqual(['investigator', 'agent']);
    expect(toolModule.entities).toBe('all');
  });

  test('is off when the sandbox is never staged into', () => {
    // Config refuses local (D45); the tool stays off even if it got through.
    const base = makeToolContext({ entity: 'rtl' });
    const ctx = { ...base, config: { ...base.config, sandbox: { ...base.config.sandbox, provider: 'local' as const } } };
    expect(toolModule.enabled(ctx, 'investigator')).toMatchObject({ on: false });
  });
});

describe('read_staged', () => {
  test('jq: runs the filter on the staged file and returns compact lines', async () => {
    const s = setup();
    const out = resultOf(await s.call({ file: FILE, jq: '.groups[] | select(.count > 10) | .key' }));
    expect(out).toMatchObject({ file: FILE, truncated: false });
    expect(out.result).toBe('"timeout calling ledger"\n"duplicate request"\n');
    expect(out.bytes_total).toBe(out.bytes_returned);
    expect(s.reads).toEqual([FILE]);
    expect(s.budget.state().calls).toBe(1);
  });

  test('lines: slices the pretty-printed file', async () => {
    const s = setup();
    const pretty = JSON.stringify(STAGED, null, 1).split('\n');
    const out = resultOf(await s.call({ file: FILE, lines: { from: 2, to: 4 } }));
    expect(out.result).toBe(pretty.slice(1, 4).join('\n'));
    expect(out.lines_total).toBe(pretty.length);
  });

  test('jq and lines: the range applies to the jq output', async () => {
    const s = setup();
    const out = resultOf(await s.call({ file: FILE, jq: '.groups[] | .count', lines: { from: 2, to: 3 } }));
    expect(out.result).toBe('12\n3');
    expect(out.lines_total).toBe(3);
  });

  test('the result follows TRIAGE_MODEL_REDACTION (D107): raw when off, masked when on', async () => {
    const raw = resultOf(await setup().call({ file: FILE, jq: '{owner, customer_id}' }));
    expect(raw.result).toContain('priya.sharma@');
    const masked = resultOf(
      await setup(undefined, 10, { TRIAGE_MODEL_REDACTION: 'on' }).call({ file: FILE, jq: '{owner, customer_id}' }),
    );
    expect(masked.result).not.toContain('priya.sharma@');
    expect(masked.result).toContain(CUSTOMER);
  });

  test('max_bytes cuts the result and says so; it never goes over the cap', async () => {
    const big = { hits: Array.from({ length: 2000 }, (_, i) => ({ i, message: `line ${i} ${'x'.repeat(80)}` })) };
    const s = setup({ [FILE]: JSON.stringify(big) });
    const small = resultOf(await s.call({ file: FILE, jq: '.hits[]', max_bytes: 500 }));
    expect(small.truncated).toBe(true);
    expect(small.bytes_returned).toBeLessThanOrEqual(500);
    expect(small.bytes_total).toBeGreaterThan(100_000);
    expect(small.note).toContain('Cut to max_bytes');
    const capped = await s.call({ file: FILE, jq: '.hits[]', max_bytes: 10_000_000 });
    const data = resultOf(capped);
    expect(data.truncated).toBe(true);
    expect(modelBytes(capped.output.data)).toBeLessThanOrEqual(s.cap);
  });

  test('jq handles a group_by-sized file (5,000 and 20,000 groups)', async () => {
    for (const n of [5000, 20_000]) {
      const groups = Array.from({ length: n }, (_, i) => ({ key: `error ${i} ${'x'.repeat(200)}`, count: i % 50 }));
      const s = setup({ [FILE]: JSON.stringify({ groups }) });
      const top = resultOf(await s.call({ file: FILE, jq: '[.groups[] | {key, count}] | .[0:50]' }));
      expect(top.truncated).toBe(false);
      expect((JSON.parse(top.result) as unknown[]).length).toBe(50);
      const keys = resultOf(await s.call({ file: FILE, jq: '[.groups[] | select(.count > 48) | .key] | length' }));
      expect(keys.result).toBe(`${n / 50}\n`);
      const sum = resultOf(await s.call({ file: FILE, jq: '[.groups[].count] | add' }));
      expect(sum.result).toBe(`${(n / 50) * ((49 * 50) / 2)}\n`);
    }
  });

  test('a filter that hits the jq work limit is told to slice, not to fix the filter', async () => {
    const s = setup();
    const message = refusal(await s.call({ file: FILE, jq: '[range(100000000)] | length' }));
    expect(message).toContain('hit the work limit');
    expect(message).toContain('Slice first');
    expect(message).not.toContain('Fix the filter');
  });

  test('a bad path is refused before the sandbox is read', async () => {
    const s = setup();
    for (const file of ['/etc/passwd', '/data/../etc/x.json', '/data/sub/x.json', 'data/x.json', '/data/x.txt']) {
      expect(refusal(await s.call({ file, jq: '.' }))).toContain('staged file path');
    }
    expect(s.reads).toEqual([]);
  });

  test('a missing file is refused with the reason', async () => {
    const s = setup();
    const message = refusal(await s.call({ file: '/data/toolu_gone.json', jq: '.' }));
    expect(message).toContain('No staged file at /data/toolu_gone.json (ENOENT)');
  });

  test('a bad jq filter is refused with the jq error', async () => {
    const s = setup();
    const message = refusal(await s.call({ file: FILE, jq: '.groups[' }));
    expect(message).toContain('the jq filter failed');
    expect(message).toContain('parse error');
  });

  test('neither jq nor lines, or a reversed range, is refused', async () => {
    const s = setup();
    expect(refusal(await s.call({ file: FILE }))).toContain('give a jq filter');
    expect(refusal(await s.call({ file: FILE, lines: { from: 5, to: 2 } }))).toContain('lines.to');
  });

  test('no harness, or a harness whose sandbox getter throws, is refused', async () => {
    const s = setup();
    expect(refusal(await s.call({ file: FILE, jq: '.' }, false))).toContain('no sandbox');
    // Flue's getter throws when the agent declared no sandbox.
    const noSandbox = {
      get sandbox(): never {
        throw new Error('[flue] This agent has no sandbox.');
      },
    };
    expect(refusal(await s.call({ file: FILE, jq: '.' }, noSandbox))).toContain('no sandbox');
  });

  test('a spent budget is refused', async () => {
    const s = setup(undefined, 1);
    resultOf(await s.call({ file: FILE, jq: '.num_hits' }));
    expect(refusal(await s.call({ file: FILE, jq: '.num_hits' }))).not.toBe('');
  });

  test('the schema caps the jq length', () => {
    expect(v.safeParse(ReadStagedInputSchema, { file: FILE, jq: '.'.repeat(501) }).success).toBe(false);
  });
});

describe('cutToBytes', () => {
  test('keeps whole characters and measures the escaped text', () => {
    expect(cutToBytes('abc', 10)).toBe('abc');
    expect(cutToBytes('abcdef', 3)).toBe('abc');
    expect(cutToBytes('""""', 4)).toBe('""');
    expect(cutToBytes('a😀b', 3)).toBe('a');
  });
});
