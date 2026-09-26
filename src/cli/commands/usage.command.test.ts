// triage usage, run through buildProgram and runCli with a test home (mock
// mode forced on), fake io and a small store fake, plus one run through the
// folder run store in the home. No real .env is read and nothing reaches the
// network. All values are synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import * as v from 'valibot';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { sampleRequest } from '../../runstore/contract.ts';
import { createRunStore } from '../../runstore/index.ts';
import type { RunPhase, RunRecord } from '../../runstore/types.ts';
import type { SubmissionUsage, UsageRow } from '../../types/usage.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { UsageOutputSchema } from '../lib/output-schemas.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { command, createUsageCommand, type UsageCommandOptions } from './usage.command.ts';

const RUN_ID = '01J8ZQ7XK3PSEUDRUNAAAAAAAA';
const OTHER_RUN = '01J8ZQ7XK3PSEUDRUNBBBBBBBB';
const UPDATED = '2026-09-20T10:00:00.000Z';

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function home(): TestHome {
  const h = makeTestHome();
  homes.push(h);
  return h;
}

type Run = { code: number; out: string; err: string };

async function cli(cmd: CliCommand, argv: readonly string[], h: TestHome): Promise<Run> {
  let out = '';
  let err = '';
  const ctx: CliContext = {
    config: () => h.config,
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from([]),
      isTTY: false,
    },
    deps: {},
  };
  const code = await runCli(buildProgram([cmd], ctx), ['usage', ...argv]);
  return { code, out, err };
}

function row(over: Partial<UsageRow>): UsageRow {
  return {
    model: 'anthropic/claude-sonnet-4-5',
    agent: 'triage',
    purpose: 'agent',
    calls: 1,
    failed_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    usd: 0,
    ...over,
  };
}

/** Totals: $0.42 (partial), 37 calls (1 failed), 120k in / 90k cache read / 4k cache write / 8k out. */
function usage(final = true): SubmissionUsage[] {
  return [
    {
      seq: 0,
      final: true,
      updated_at: UPDATED,
      rows: [row({ model: 'anthropic/claude-haiku-4-5-20251001', agent: 'classifier', purpose: 'classify', input_tokens: 800, output_tokens: 50, usd: 0.001 })],
    },
    {
      seq: 1,
      final,
      updated_at: UPDATED,
      rows: [
        row({ calls: 30, failed_calls: 1, input_tokens: 110_000, output_tokens: 7000, cache_read_tokens: 90_000, cache_write_tokens: 4000, usd: 0.419 }),
        row({ model: 'typesafe/jev-1', agent: 'synthesis', calls: 6, input_tokens: 9200, output_tokens: 950, usd: null }),
      ],
    },
  ];
}

function record(phase: RunPhase, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: RUN_ID,
    schema_version: 1,
    created_at: UPDATED,
    updated_at: UPDATED,
    phase,
    input_request: null,
    input_history: [],
    block: null,
    block_history: [],
    request: {} as RunRecord['request'],
    classification: null,
    evidence: {},
    submissions: [],
    report: null,
    report_md: null,
    feedback: [],
    feedback_latest: null,
    embeddings: [],
    usage: usage(),
    ...extra,
  };
}

function withRecord(run: RunRecord, extra: Omit<UsageCommandOptions, 'openStore'> = {}): CliCommand {
  return createUsageCommand({
    openStore: async () => ({ getRun: async (id: string) => (id === run.run_id ? run : null) }),
    isAlive: () => true,
    ...extra,
  });
}

const TOTAL = '$0.42 (partial) · 37 calls (1 failed) · 120k in / 90k cache read / 4k cache write / 8k out';

describe('registration', () => {
  test('exports command at usage and the generated list picks it up', () => {
    expect(command.path).toEqual(['usage']);
    expect((generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '))).toContain('usage');
  });
});

describe('usage', () => {
  test('--by model is the default: the total, then one line per model', async () => {
    const h = home();
    const cmd = withRecord(record('completed'));
    const r = await cli(cmd, [RUN_ID], h);
    expect(r.code).toBe(EXIT.OK);
    expect(r.err).toBe('');
    expect(r.out).toBe(
      [
        `run ${RUN_ID}: completed`,
        `cost: ${TOTAL}`,
        'by model:',
        '  - anthropic/claude-haiku-4-5-20251001: <$0.01 · 1 call · 800 in / 0 cache read / 0 cache write / 50 out',
        '  - anthropic/claude-sonnet-4-5: $0.42 · 30 calls (1 failed) · 110k in / 90k cache read / 4k cache write / 7k out',
        '  - typesafe/jev-1: no price · 6 calls · 9.2k in / 0 cache read / 0 cache write / 950 out',
        '',
      ].join('\n'),
    );
    expect((await cli(cmd, [RUN_ID, '--by', 'model'], h)).out).toBe(r.out);
  });

  test('--by agent and --by submission; submission 0 is the intake', async () => {
    const h = home();
    const cmd = withRecord(record('completed'));
    const agent = await cli(cmd, [RUN_ID, '--by', 'agent'], h);
    expect(agent.out.split('\n').slice(2)).toEqual([
      'by agent:',
      '  - classifier: <$0.01 · 1 call · 800 in / 0 cache read / 0 cache write / 50 out',
      '  - synthesis: no price · 6 calls · 9.2k in / 0 cache read / 0 cache write / 950 out',
      '  - triage: $0.42 · 30 calls (1 failed) · 110k in / 90k cache read / 4k cache write / 7k out',
      '',
    ]);
    const sub = await cli(cmd, [RUN_ID, '--by', 'submission'], h);
    expect(sub.out.split('\n').slice(2)).toEqual([
      'by submission:',
      '  - intake: <$0.01 · 1 call · 800 in / 0 cache read / 0 cache write / 50 out',
      '  - submission 1: $0.42 (partial) · 36 calls (1 failed) · 119k in / 90k cache read / 4k cache write / 8k out',
      '',
    ]);
  });

  test('--json prints one strict document with the whole view, whatever --by says', async () => {
    const h = home();
    const cmd = withRecord(record('completed'));
    const r = await cli(cmd, [RUN_ID, '--json', '--by', 'agent'], h);
    expect(r.code).toBe(EXIT.OK);
    const lines = r.out.trim().split('\n');
    expect(lines).toHaveLength(1);
    const doc = v.parse(UsageOutputSchema, JSON.parse(lines[0] as string));
    expect(doc.status).toBe('completed');
    expect(doc.usage.pricing).toBe('partial');
    expect(doc.usage.total.calls).toBe(37);
    expect(doc.usage.total.unpriced_models).toEqual(['typesafe/jev-1']);
    expect(Object.keys(doc.usage.by_submission)).toEqual(['0', '1']);
    expect(Object.keys(doc.usage.by_agent)).toEqual(['classifier', 'synthesis', 'triage']);
  });

  test('a running run with a non-final submission is live; a stalled one is incomplete', async () => {
    const h = home();
    const running = record('investigating', { worker_pid: 4242, usage: usage(false) });
    const now = () => Date.parse(UPDATED) + 4000;
    const live = await cli(withRecord(running, { now }), [RUN_ID], h);
    expect(live.out.split('\n')[1]).toBe(
      'cost: $0.42 (partial) (live, updated 4s ago) · 37 calls (1 failed) · 120k in / 90k cache read / 4k cache write / 8k out',
    );
    const stalled = await cli(withRecord(running, { now, isAlive: () => false }), [RUN_ID, '--json'], h);
    const doc = v.parse(UsageOutputSchema, JSON.parse(stalled.out));
    expect(doc.status).toBe('stalled');
    expect(doc.usage.live).toBe(false);
    expect(doc.usage.incomplete).toBe(true);
    const human = await cli(withRecord(running, { now, isAlive: () => false }), [RUN_ID], h);
    expect(human.out).toContain('(incomplete: the worker ended before the final count)');
    expect(human.out).not.toContain('live');
  });

  test('a run with nothing counted says not recorded, never $0', async () => {
    const h = home();
    const cmd = withRecord(record('completed', { usage: [] }));
    const r = await cli(cmd, [RUN_ID], h);
    expect(r.out).toBe(`run ${RUN_ID}: completed\nusage: not recorded\n`);
    expect(r.out).not.toContain('$');
    const json = await cli(cmd, [RUN_ID, '--json'], h);
    const doc = v.parse(UsageOutputSchema, JSON.parse(json.out));
    expect(doc.usage.recorded).toBe(false);
  });

  test('reads the rows a real folder store holds', async () => {
    const h = home();
    const store = await createRunStore(h.config);
    await store.createRun(RUN_ID, redactPersisted(sampleRequest(RUN_ID)));
    for (const s of usage()) await store.putUsage(RUN_ID, s.seq, s.rows, s.final);
    await store.setPhase(RUN_ID, 'completed');
    const r = await cli(createUsageCommand(), [RUN_ID, '--json'], h);
    expect(r.code).toBe(EXIT.OK);
    const doc = v.parse(UsageOutputSchema, JSON.parse(r.out));
    expect(doc.usage.total.calls).toBe(37);
    expect(doc.usage.pricing).toBe('partial');
  });

  test('an unknown run exits 1, a bad run id and a bad --by exit 2', async () => {
    const h = home();
    const cmd = withRecord(record('completed'));
    const unknown = await cli(cmd, [OTHER_RUN, '--json'], h);
    expect(unknown.code).toBe(EXIT.ERROR);
    expect(JSON.parse(unknown.out)).toEqual({ error: { code: 'ERROR', message: `run not found: ${OTHER_RUN}` } });
    const human = await cli(cmd, [OTHER_RUN], h);
    expect(human.err).toContain('run not found');

    const badId = await cli(cmd, ['../etc'], h);
    expect(badId.code).toBe(EXIT.USAGE);
    for (const by of ['tier', 'Model', '']) {
      const r = await cli(cmd, [RUN_ID, '--by', by, '--json'], h);
      expect(r.code).toBe(EXIT.USAGE);
      expect(JSON.parse(r.out).error.message).toBe('--by must be one of model, agent, submission');
    }
  });
});
