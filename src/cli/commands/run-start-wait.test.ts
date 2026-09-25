// triage run, start, __worker, wait, status and ask, run through buildProgram
// and runCli with a test home (mock mode forced on), fake io, the folder run
// store in a temp dir, a fake spawnWorker and fake runSubmission/askRun. No
// real .env is read, no worker process is started and nothing reaches the
// network.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as v from 'valibot';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { loadConfig, type Config } from '../../config/env.ts';
import type { Registry } from '../../config/registry.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { WorkerSpawnError } from '../../ingress/detach.ts';
import { prepareDeps, prepareRequest, type PrepareInput, type PreparedSubmission } from '../../ingress/prepare.ts';
import { SlackFetchError, THREAD_FILE_HINT } from '../../ingress/slack.ts';
import type { AnswerInput, SubmissionResult } from '../../ingress/submit.ts';
import type { WorkerPayload } from '../../ingress/worker-payload.ts';
import { sampleClassification, sampleInputRequest, sampleReport, SYNTHETIC_PHONE } from '../../runstore/contract.ts';
import { createRunStore } from '../../runstore/index.ts';
import type { RunPhase, RunRecord, RunStore } from '../../runstore/types.ts';
import type { Entity } from '../../types/core.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import {
  AskOutputSchema,
  EXIT_NEEDS_INPUT,
  EXIT_WAIT_TIMEOUT,
  InputOutputSchema,
  StartOutputSchema,
  StatusOutputSchema,
  WaitOutputSchema,
} from '../lib/output-schemas.ts';
import { parseRequestArgs, UsageError } from '../lib/request-args.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { createAskCommand } from './ask.command.ts';
import { createInputCommand } from './input.command.ts';
import { createRunCommand } from './run.command.ts';
import { createStartCommand, type PrepareFn } from './start.command.ts';
import { createStatusCommand } from './status.command.ts';
import { createWaitCommand } from './wait.command.ts';
import { createWorkerCommand } from './worker.command.ts';

// All values below are synthetic.
const RUN_ID = '01J8ZQ7XK3PSEUDRUNAAAAAAAA';
const OTHER_RUN = '01J8ZQ7XK3PSEUDRUNBBBBBBBB';
const TEXT = 'Customer says the transfer is stuck since Monday';
const SLACK_URL = 'https://acme.slack.com/archives/C0SYNTH01/p1695460000123456';

// ------------------------------------------------------------------ harness

const homes: TestHome[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(entities?: readonly Entity[]): TestHome {
  const h = makeTestHome(entities !== undefined ? { entities } : {});
  homes.push(h);
  return h;
}

function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'triage-cwd-')));
  dirs.push(d);
  return d;
}

type Run = { code: number; out: string; err: string };

async function cli(
  cmds: readonly CliCommand[],
  argv: readonly string[],
  o: { config?: () => Config; stdin?: Readable; isTTY?: boolean } = {},
): Promise<Run> {
  let out = '';
  let err = '';
  const ctx: CliContext = {
    config: o.config ?? (() => {
      throw new Error('no config in this test');
    }),
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: o.stdin ?? Readable.from([]),
      isTTY: o.isTTY ?? false,
    },
    deps: {},
  };
  const code = await runCli(buildProgram(cmds, ctx), [...argv]);
  return { code, out, err };
}

type SpawnSpy = { calls: WorkerPayload[]; spawn: (p: WorkerPayload) => Promise<{ pid: number }> };

function spawnSpy(pid = 4242, fail?: Error): SpawnSpy {
  const spy: SpawnSpy = {
    calls: [],
    spawn: async (p) => {
      spy.calls.push(p);
      if (fail !== undefined) throw fail;
      return { pid };
    },
  };
  return spy;
}

const fixedUser = () => 'ops-reviewer';

/** The real prepare step for text and thread-file input; a Slack read that always fails. */
const prepareWithFailingSlack: PrepareFn = (input, config, registry) =>
  prepareRequest(input, {
    ...prepareDeps(config, registry, {
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    }),
    fetchThread: async () => {
      throw new SlackFetchError('no_token', 'no bot token is set');
    },
  });

async function prepared(h: TestHome, text = TEXT): Promise<PreparedSubmission> {
  const input: PrepareInput = { kind: 'text', text, interface: 'cli', requested_by: 'ops-reviewer' };
  return prepareRequest(input, { ...prepareDeps(h.config, h.registry), newId: () => RUN_ID });
}

/** Seeds a run in the folder store of the home. */
async function seed(
  h: TestHome,
  o: { runId?: string; phase?: RunPhase; pid?: number; reason?: string; report?: boolean; statement?: string } = {},
): Promise<RunStore> {
  const runId = o.runId ?? RUN_ID;
  const store = await createRunStore(h.config);
  const p = await prepareRequest(
    { kind: 'text', text: TEXT, interface: 'cli', requested_by: 'ops-reviewer' },
    { ...prepareDeps(h.config, h.registry), newId: () => runId },
  );
  await store.createRun(runId, redactPersisted(p.request));
  await store.putClassification(runId, redactPersisted({
    ...sampleClassification(),
    preflight_warnings: [{ entity: 'ssfb', step: 'tunnel', message: 'tunnel was down' }],
  }));
  const seq = await store.addSubmission(runId, redactPersisted({ kind: 'initial' as const }));
  if (o.report === true) {
    const report = sampleReport(runId, o.statement ?? 'the payout is waiting on the bank');
    await store.putReport(runId, seq, redactPersisted(report), redactPersisted('# Triage report\n\nthe payout is waiting on the bank\n'));
  }
  await store.setPhase(runId, o.phase ?? 'investigating', {
    ...(o.pid !== undefined ? { worker_pid: o.pid } : {}),
    ...(o.reason !== undefined ? { reason: o.reason } : {}),
  });
  return store;
}

function jsonLine(out: string): unknown {
  const lines = out.split('\n').filter((l) => l !== '');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string);
}

/** A store fake that answers getRun from a script and records every call by name; `allow` names other methods that may be called (they do nothing). */
function scriptedStore(records: readonly (RunRecord | null)[], allow: readonly string[] = []): { store: RunStore; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const store = new Proxy({} as RunStore, {
    get(_t, name: string) {
      if (name === 'then') return undefined;
      return async () => {
        calls.push(name);
        if (allow.includes(name)) return undefined;
        if (name !== 'getRun') throw new Error(`${name} must not be called`);
        const r = records[Math.min(i, records.length - 1)] ?? null;
        i++;
        return r;
      };
    },
  });
  return { store, calls };
}

function record(phase: RunPhase, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: RUN_ID,
    schema_version: 1,
    created_at: '2026-09-20T10:00:00.000Z',
    updated_at: '2026-09-20T10:00:00.000Z',
    phase,
    input_request: null,
    input_history: [],
    request: {} as RunRecord['request'],
    classification: null,
    evidence: {},
    submissions: [],
    report: null,
    report_md: null,
    feedback: [],
    feedback_latest: null,
    embeddings: [],
    ...extra,
  };
}

// ------------------------------------------------------------------ registration

describe('registration', () => {
  test('the generated list picks up all six commands', () => {
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    for (const p of ['run', 'start', 'worker', 'wait', 'status', 'ask']) expect(paths).toContain(p);
  });

  test('__worker is hidden from help but runs under that name', async () => {
    const help = await cli(generatedCommands as readonly CliCommand[], ['--help']);
    expect(help.code).toBe(EXIT.OK);
    expect(help.out).not.toContain('__worker');
    const r = await cli([createWorkerCommand()], ['__worker', RUN_ID], { stdin: Readable.from(['']) });
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain('payload is empty');
    const old = await cli([createWorkerCommand()], ['worker', RUN_ID]);
    expect(old.code).toBe(EXIT.USAGE);
  });
});

// ------------------------------------------------------------------ request-args

describe('request-args', () => {
  const registry = (entities: readonly Entity[] = ['ssfb', 'atspl', 'rtl']) => ({
    enabledEntities: () => entities,
    resolveEntity: (n: string): Entity | undefined =>
      n === 'shivalik' ? 'ssfb' : (['ssfb', 'atspl', 'rtl'] as const).find((e) => e === n),
  });
  const parse = (opts: Record<string, unknown>, entities?: readonly Entity[]) =>
    parseRequestArgs({ interface: 'cli', ...opts }, { registry: registry(entities), defaultRequestedBy: fixedUser });

  test('exactly one of --slack-url, --thread-file, --text', () => {
    const inputs = { slackUrl: SLACK_URL, threadFile: '/tmp/thread.json', text: TEXT };
    const keys = Object.keys(inputs) as (keyof typeof inputs)[];
    const subsets: (keyof typeof inputs)[][] = [[], ...keys.map((k) => [k]), [keys[0]!, keys[1]!], [keys[0]!, keys[2]!], [keys[1]!, keys[2]!], keys];
    for (const subset of subsets) {
      const opts = Object.fromEntries(subset.map((k) => [k, inputs[k]]));
      if (subset.length === 1) {
        const kind = parse(opts).kind;
        expect(kind).toBe(({ slackUrl: 'slack', threadFile: 'thread_file', text: 'text' } as const)[subset[0]!]);
      } else {
        expect(() => parse(opts)).toThrow(UsageError);
        expect(() => parse(opts)).toThrow('give exactly one of --slack-url, --thread-file, --text');
      }
    }
  });

  test('none or two input flags exit 2 through the CLI and start nothing', async () => {
    const h = home();
    for (const argv of [[], ['--text', TEXT, '--slack-url', SLACK_URL], ['--text', TEXT, '--thread-file', '/x.json']]) {
      const spy = spawnSpy();
      const r = await cli([createStartCommand({ spawn: spy.spawn })], ['start', '--json', ...argv], { config: () => h.config });
      expect(r.code).toBe(EXIT.USAGE);
      expect((jsonLine(r.out) as { error: { code: string } }).error.code).toBe('USAGE');
      expect(spy.calls).toHaveLength(0);
    }
  });

  test('--ids parses known key=value pairs and refuses the rest', () => {
    const input = parse({ text: TEXT, ids: ['customer_id=CUST-0001', 'user_id = USR-9'] });
    expect(input.hints?.ids).toEqual({ customer_id: 'CUST-0001', user_id: 'USR-9' });
    expect(() => parse({ text: TEXT, ids: ['customer_id'] })).toThrow("is missing '='");
    expect(() => parse({ text: TEXT, ids: ['shoe_size=9'] })).toThrow('is not a known id key');
    expect(() => parse({ text: TEXT, ids: ['customer_id='] })).toThrow('has an empty value');
    expect(() => parse({ text: TEXT, ids: ['customer_id=A', 'customer_id=B'] })).toThrow('more than once');
    // A value that is not key-like is never echoed.
    try {
      parse({ text: TEXT, ids: ['9876543210'] });
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('9876543210');
    }
  });

  test('--tier accepts cheap|mid|strong only', () => {
    for (const tier of ['cheap', 'mid', 'strong']) expect(parse({ text: TEXT, tier }).hints?.tier).toBe(tier as 'mid');
    expect(() => parse({ text: TEXT, tier: 'ultra' })).toThrow('--tier must be one of cheap, mid, strong');
    expect(() => parse({ text: TEXT, tier: '' })).toThrow(UsageError);
  });

  test('--entities takes registry ids and aliases, narrows and never widens', () => {
    expect(parse({ text: TEXT, entities: ['shivalik'] }).hints?.entities).toEqual(['ssfb']);
    expect(parse({ text: TEXT, entities: ['ssfb,atspl'] }).hints?.entities).toEqual(['ssfb', 'atspl']);
    expect(parse({ text: TEXT, entities: ['atspl', 'ATSPL'] }).hints?.entities).toEqual(['atspl']);
    expect(() => parse({ text: TEXT, entities: ['acme'] })).toThrow('is not a registry entity id or alias');
    expect(() => parse({ text: TEXT, entities: ['rtl'] }, ['ssfb', 'atspl'])).toThrow('never widen');
    expect(() => parse({ text: TEXT, entities: ['ssfb,'] })).toThrow('is empty');
  });

  test('--interface is cli or claude-code; --requested-by defaults to the OS user', () => {
    expect(parse({ text: TEXT, interface: 'claude-code' }).interface).toBe('claude-code');
    expect(() => parse({ text: TEXT, interface: 'http' })).toThrow('--interface must be one of cli, claude-code');
    expect(parse({ text: TEXT }).requested_by).toBe('ops-reviewer');
    expect(parse({ text: TEXT, requestedBy: 'lead@example.test' }).requested_by).toBe('lead@example.test');
    expect(() => parse({ text: TEXT, requestedBy: '  ' })).toThrow('--requested-by is empty');
  });

  test('--entities widening exits 2 through the CLI', async () => {
    const h = home(['ssfb', 'atspl']);
    const spy = spawnSpy();
    const r = await cli([createStartCommand({ spawn: spy.spawn })], ['start', '--text', TEXT, '--entities', 'rtl'], {
      config: () => h.config,
    });
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain('never widen');
    expect(spy.calls).toHaveLength(0);
  });

  test('there is no --env flag on any of the six commands', async () => {
    const h = home();
    const spy = spawnSpy();
    const cmds = [
      createRunCommand({ boot: async () => undefined }),
      createStartCommand({ spawn: spy.spawn }),
      createWorkerCommand(),
      createWaitCommand(),
      createStatusCommand(),
      createAskCommand({ spawn: spy.spawn }),
    ];
    const argvs = [
      ['run', '--env', 'prod', '--text', TEXT],
      ['start', '--env', 'prod', '--text', TEXT],
      ['__worker', RUN_ID, '--env', 'prod'],
      ['wait', RUN_ID, '--env', 'prod'],
      ['status', RUN_ID, '--env', 'prod'],
      ['ask', RUN_ID, 'why', '--env', 'prod'],
    ];
    for (const argv of argvs) {
      const r = await cli(cmds, [...argv, '--json'], { config: () => h.config });
      expect(r.code).toBe(EXIT.USAGE);
      const e = jsonLine(r.out) as { error: { code: string; message: string } };
      expect(e.error.code).toBe('USAGE');
      expect(e.error.message).toContain('--env');
    }
    expect(spy.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ start

describe('start', () => {
  test('--json writes exactly one JSON line {run_id} and returns before the worker finishes', async () => {
    const h = home();
    const spy = spawnSpy(31337);
    const r = await cli(
      [createStartCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })],
      ['start', '--text', TEXT, '--ids', 'customer_id=CUST-0001', '--tier', 'mid', '--interface', 'claude-code', '--json'],
      { config: () => h.config },
    );
    expect(r.code).toBe(EXIT.OK);
    expect(r.err).toBe('');
    expect(r.out.endsWith('\n')).toBe(true);
    expect(r.out.split('\n')).toHaveLength(2);
    const doc = jsonLine(r.out) as { run_id: string };
    expect(v.is(StartOutputSchema, doc)).toBe(true);
    expect(Object.keys(doc)).toEqual(['run_id']);

    expect(spy.calls).toHaveLength(1);
    const payload = spy.calls[0] as Extract<WorkerPayload, { kind: 'submit' }>;
    expect(payload.kind).toBe('submit');
    expect(payload.run_id).toBe(doc.run_id);
    expect(payload.request.request_id).toBe(doc.run_id);
    expect(payload.request.interface).toBe('claude-code');
    expect(payload.request.requested_by).toBe('ops-reviewer');
    expect(payload.request.hints).toMatchObject({ tier: 'mid', ids: { customer_id: 'CUST-0001' } });

    // The run exists, so wait and status find it straight away. Nothing has run it.
    const run = await (await createRunStore(h.config)).getRun(doc.run_id);
    expect(run?.phase).toBe('created');
    expect(run?.worker_pid).toBeUndefined();
  });

  test('a Slack fetch error exits non-zero with the --thread-file hint and spawns nothing', async () => {
    const h = home();
    for (const json of [false, true]) {
      const spy = spawnSpy();
      const r = await cli(
        [createStartCommand({ spawn: spy.spawn, prepare: prepareWithFailingSlack, defaultRequestedBy: fixedUser })],
        ['start', '--slack-url', SLACK_URL, ...(json ? ['--json'] : [])],
        { config: () => h.config },
      );
      expect(r.code).toBe(EXIT.ERROR);
      expect(json ? r.out : r.err).toContain(THREAD_FILE_HINT);
      expect(spy.calls).toHaveLength(0);
    }
    expect(await (await createRunStore(h.config)).listRuns()).toEqual([]);
  });

  test('a bad thread file or permalink is a usage error and spawns nothing', async () => {
    const h = home();
    const dir = tempDir();
    const bad = join(dir, 'thread.json');
    writeFileSync(bad, '{ not json');
    for (const argv of [['--thread-file', bad], ['--slack-url', 'https://example.test/archives/C0SYNTH01/p1695460000123456']]) {
      const spy = spawnSpy();
      const r = await cli([createStartCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })], ['start', ...argv], {
        config: () => h.config,
      });
      expect(r.code).toBe(EXIT.USAGE);
      expect(spy.calls).toHaveLength(0);
    }
  });

  test('a thread file with messages[] starts a run', async () => {
    const h = home();
    const file = join(tempDir(), 'thread.json');
    writeFileSync(file, JSON.stringify({ messages: [{ ts: '1695460000.123456', author: 'support', text: TEXT }] }));
    const spy = spawnSpy();
    const r = await cli([createStartCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })], ['start', '--thread-file', file], {
      config: () => h.config,
    });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('triage wait ');
    expect(spy.calls).toHaveLength(1);
  });

  test('a worker that cannot start marks the run failed and exits 1', async () => {
    const h = home();
    const spy = spawnSpy(1, new WorkerSpawnError('ENOENT'));
    const r = await cli([createStartCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })], ['start', '--text', TEXT, '--json'], {
      config: () => h.config,
    });
    expect(r.code).toBe(EXIT.ERROR);
    expect((jsonLine(r.out) as { error: { message: string } }).error.message).toContain('could not start the worker');
    const runs = await (await createRunStore(h.config)).listRuns();
    expect(runs).toHaveLength(1);
    const run = await (await createRunStore(h.config)).getRun(runs[0]!.run_id);
    expect(run?.phase).toBe('failed');
    expect(run?.phase_reason).toBe('WorkerSpawnError');
  });
});

// ------------------------------------------------------------------ worker

describe('worker', () => {
  test('reads the stdin payload, records its pid, then calls runSubmission with it', async () => {
    const h = home();
    const p = await prepared(h);
    const store = await createRunStore(h.config);
    await store.createRun(RUN_ID, redactPersisted(p.request));
    const seen: { prepared: PreparedSubmission; pidAtCall: number | undefined }[] = [];
    let booted = 0;
    const payload: WorkerPayload = { kind: 'submit', run_id: RUN_ID, request: p.request, redaction_names: ['Asha Test'] };
    const worker = createWorkerCommand({
      boot: async () => {
        booted++;
      },
      deps: () => ({}) as never,
      pid: () => 777,
      runSubmission: async (prep) => {
        seen.push({ prepared: prep, pidAtCall: (await store.getRun(RUN_ID))?.worker_pid });
        return { run_id: RUN_ID, status: 'completed', submission_seq: 1, submission_id: 's1', gaps: [] };
      },
      askRun: async () => {
        throw new Error('askRun must not be called');
      },
    });
    // The payload arrives in two chunks, as a pipe may deliver it.
    const text = JSON.stringify(payload);
    const stdin = Readable.from([text.slice(0, 20), text.slice(20)]);
    const r = await cli([worker], ['__worker', RUN_ID], { config: () => h.config, stdin });
    expect(r.code).toBe(EXIT.OK);
    expect(booted).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prepared).toEqual({ run_id: RUN_ID, request: p.request, redaction_names: ['Asha Test'] });
    expect(seen[0]!.pidAtCall).toBe(777);
  });

  test('an ask payload calls askRun with the question and who asked', async () => {
    const h = home();
    await seed(h, { phase: 'dispatched', pid: 4242 });
    const calls: unknown[][] = [];
    const worker = createWorkerCommand({
      boot: async () => undefined,
      deps: () => ({}) as never,
      pid: () => 888,
      runSubmission: async () => {
        throw new Error('runSubmission must not be called');
      },
      askRun: async (...args) => {
        calls.push(args.slice(0, 3));
        return { run_id: RUN_ID, status: 'failed', submission_seq: 2, submission_id: 's2', error: 'AgentRunError', gaps: [] };
      },
    });
    const stdin = Readable.from([JSON.stringify({ kind: 'ask', run_id: RUN_ID, question: 'did the retry go out?', by: 'ops-reviewer' })]);
    const r = await cli([worker], ['__worker', RUN_ID], { config: () => h.config, stdin });
    expect(r.code).toBe(EXIT.ERROR);
    expect(calls).toEqual([[RUN_ID, 'did the retry go out?', 'ops-reviewer']]);
    expect((await (await createRunStore(h.config)).getRun(RUN_ID))?.worker_pid).toBe(888);
  });

  test('refuses a bad payload, a run_id mismatch and a run that already started', async () => {
    const h = home();
    const p = await prepared(h);
    let submitted = 0;
    const worker = createWorkerCommand({
      boot: async () => undefined,
      deps: () => ({}) as never,
      runSubmission: async () => {
        submitted++;
        throw new Error('not reached');
      },
    });
    const bad = await cli([worker], ['__worker', RUN_ID], { config: () => h.config, stdin: Readable.from(['{"kind":"submit"}']) });
    expect(bad.code).toBe(EXIT.USAGE);
    const payload = JSON.stringify({ kind: 'submit', run_id: RUN_ID, request: p.request });
    const mismatch = await cli([worker], ['__worker', OTHER_RUN], { config: () => h.config, stdin: Readable.from([payload]) });
    expect(mismatch.code).toBe(EXIT.USAGE);
    await seed(h, { phase: 'investigating' });
    const started = await cli([worker], ['__worker', RUN_ID], { config: () => h.config, stdin: Readable.from([payload]) });
    expect(started.code).toBe(EXIT.ERROR);
    expect(started.err).toContain('has already started');
    const unknownAsk = await cli([worker], ['__worker', OTHER_RUN], {
      config: () => h.config,
      stdin: Readable.from([JSON.stringify({ kind: 'ask', run_id: OTHER_RUN, question: 'q', by: 'me' })]),
    });
    expect(unknownAsk.code).toBe(EXIT.ERROR);
    expect(unknownAsk.err).toContain('run not found');
    expect(submitted).toBe(0);
  });

  test('a runtime that fails to start is recorded as failed with the error class name', async () => {
    const h = home();
    const p = await prepared(h);
    class BootFailure extends Error {}
    const worker = createWorkerCommand({
      boot: async () => {
        throw new BootFailure('secret detail that must not be stored');
      },
      pid: () => 999,
    });
    const r = await cli([worker], ['__worker', RUN_ID], {
      config: () => h.config,
      stdin: Readable.from([JSON.stringify({ kind: 'submit', run_id: RUN_ID, request: p.request })]),
    });
    expect(r.code).toBe(EXIT.ERROR);
    const run = await (await createRunStore(h.config)).getRun(RUN_ID);
    expect(run?.phase).toBe('failed');
    expect(run?.phase_reason).toBe('BootFailure');
    expect(run?.worker_pid).toBe(999);
  });
});

// ------------------------------------------------------------------ wait

describe('wait', () => {
  function clock() {
    let t = 1_000_000;
    return {
      now: () => t,
      sleeps: [] as number[],
      sleep(ms: number) {
        this.sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    };
  }

  test('follows a phase sequence to completed and prints the report', async () => {
    const report = { ...sampleReport(RUN_ID, 'the payout is waiting on the bank') };
    const { store, calls } = scriptedStore([
      record('created'),
      record('investigating', { worker_pid: 4242 }),
      record('completed', { worker_pid: 4242, report, report_md: '# report' }),
    ]);
    const c = clock();
    const cmd = createWaitCommand({ openStore: async () => store, isAlive: () => true, now: c.now, sleep: (ms) => c.sleep(ms) });
    const h = home();
    const r = await cli([cmd], ['wait', RUN_ID, '--json'], { config: () => h.config });
    expect(r.code).toBe(EXIT.OK);
    const doc = jsonLine(r.out) as { status: string; report: { status: string } };
    expect(v.is(WaitOutputSchema, doc)).toBe(true);
    expect(Object.keys(doc).sort()).toEqual(['report', 'run_id', 'status']);
    expect(doc.status).toBe('completed');
    expect(doc.report.status).toBe('root_cause_confirmed');
    expect(calls).toEqual(['getRun', 'getRun', 'getRun']);
    expect(c.sleeps).toEqual([1000, 1000]);
  });

  test('--timeout 1 on a run still going prints timeout, exits 3 and does not touch the run', async () => {
    const { store, calls } = scriptedStore([record('investigating', { worker_pid: 4242 })]);
    const c = clock();
    const cmd = createWaitCommand({ openStore: async () => store, isAlive: () => true, now: c.now, sleep: (ms) => c.sleep(ms), pollMs: 300 });
    const h = home();
    const r = await cli([cmd], ['wait', RUN_ID, '--timeout', '1', '--json'], { config: () => h.config });
    expect(r.code).toBe(EXIT_WAIT_TIMEOUT);
    expect(r.code).toBe(3);
    const doc = jsonLine(r.out);
    expect(v.is(WaitOutputSchema, doc)).toBe(true);
    expect(doc).toEqual({ run_id: RUN_ID, status: 'timeout', phase: 'investigating' });
    // Only reads: no setPhase, no abort, nothing else on the store.
    expect(new Set(calls)).toEqual(new Set(['getRun']));
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  test('a timeout leaves a real stored run as it was', async () => {
    const h = home();
    await seed(h, { phase: 'investigating', pid: 4242 });
    const c = clock();
    const cmd = createWaitCommand({ isAlive: () => true, now: c.now, sleep: (ms) => c.sleep(ms) });
    const r = await cli([cmd], ['wait', RUN_ID, '--timeout', '1'], { config: () => h.config });
    expect(r.code).toBe(3);
    expect(r.out).toContain('it keeps running');
    const run = await (await createRunStore(h.config)).getRun(RUN_ID);
    expect(run?.phase).toBe('investigating');
    expect(run?.phase_reason).toBeUndefined();
  });

  test('a completed run prints the persisted-profile report from the store and exits 0', async () => {
    const h = home();
    await seed(h, { phase: 'completed', report: true, statement: `customer on ${SYNTHETIC_PHONE} was not paid` });
    const r = await cli([createWaitCommand()], ['wait', RUN_ID, '--json'], { config: () => h.config });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).not.toContain(SYNTHETIC_PHONE);
    const doc = jsonLine(r.out) as { status: string; report: { root_cause: { statement: string } } };
    expect(v.is(WaitOutputSchema, doc)).toBe(true);
    expect(doc.status).toBe('completed');
    expect(doc.report.root_cause.statement).toContain('was not paid');
    const md = await cli([createWaitCommand()], ['wait', RUN_ID], { config: () => h.config });
    expect(md.code).toBe(EXIT.OK);
    expect(md.out).toContain('# Triage report');
  });

  test('a failed run exits 1 with the failure reason', async () => {
    const h = home();
    await seed(h, { phase: 'failed', reason: 'SubmissionReadTimeoutError' });
    const r = await cli([createWaitCommand()], ['wait', RUN_ID, '--json'], { config: () => h.config });
    expect(r.code).toBe(EXIT.ERROR);
    const doc = jsonLine(r.out);
    expect(v.is(WaitOutputSchema, doc)).toBe(true);
    expect(doc).toEqual({ run_id: RUN_ID, status: 'failed', reason: 'SubmissionReadTimeoutError' });
    const human = await cli([createWaitCommand()], ['wait', RUN_ID], { config: () => h.config });
    expect(human.code).toBe(EXIT.ERROR);
    expect(human.err).toContain('failed: SubmissionReadTimeoutError');
  });

  test('a run whose worker is gone ends the wait as stalled', async () => {
    const h = home();
    await seed(h, { phase: 'investigating', pid: 4242 });
    const r = await cli([createWaitCommand({ isAlive: () => false })], ['wait', RUN_ID, '--json'], { config: () => h.config });
    expect(r.code).toBe(EXIT.ERROR);
    expect((jsonLine(r.out) as { status: string }).status).toBe('stalled');
  });

  test('unknown run, bad run id and bad --timeout', async () => {
    const h = home();
    const unknown = await cli([createWaitCommand()], ['wait', OTHER_RUN], { config: () => h.config });
    expect(unknown.code).toBe(EXIT.ERROR);
    expect(unknown.err).toContain('run not found');
    const badId = await cli([createWaitCommand()], ['wait', '../etc'], { config: () => h.config });
    expect(badId.code).toBe(EXIT.USAGE);
    for (const t of ['0', '-1', 'soon']) {
      const r = await cli([createWaitCommand()], ['wait', RUN_ID, '--timeout', t], { config: () => h.config });
      expect(r.code).toBe(EXIT.USAGE);
    }
  });
});

// ------------------------------------------------------------------ status

describe('status', () => {
  test('reports stalled when the phase is not terminal and the recorded pid is not alive', async () => {
    const h = home();
    await seed(h, { phase: 'investigating', pid: 4242 });
    const checked: number[] = [];
    const dead = createStatusCommand({
      isAlive: (pid) => {
        checked.push(pid);
        return false;
      },
    });
    const r = await cli([dead], ['status', RUN_ID, '--json'], { config: () => h.config });
    expect(r.code).toBe(EXIT.OK);
    const doc = jsonLine(r.out);
    expect(v.is(StatusOutputSchema, doc)).toBe(true);
    expect(doc).toEqual({
      run_id: RUN_ID,
      status: 'stalled',
      phase: 'investigating',
      tier_final: 'strong',
      submissions: 1,
      preflight_warnings: [{ entity: 'ssfb', step: 'tunnel', message: 'tunnel was down' }],
    });
    expect(checked).toEqual([4242]);

    const alive = await cli([createStatusCommand({ isAlive: () => true })], ['status', RUN_ID, '--json'], { config: () => h.config });
    expect((jsonLine(alive.out) as { status: string }).status).toBe('running');
    const human = await cli([dead], ['status', RUN_ID], { config: () => h.config });
    expect(human.out).toContain('stalled');
    expect(human.out).toContain('ssfb tunnel: tunnel was down');
  });

  test('terminal phases and runs without a pid are never stalled', async () => {
    const dead = () => false;
    const h = home();
    await seed(h, { phase: 'completed', pid: 4242, report: true });
    const done = await cli([createStatusCommand({ isAlive: dead })], ['status', RUN_ID, '--json'], { config: () => h.config });
    expect((jsonLine(done.out) as { status: string }).status).toBe('completed');
    await seed(h, { runId: OTHER_RUN, phase: 'identity' });
    const noPid = await cli([createStatusCommand({ isAlive: dead })], ['status', OTHER_RUN, '--json'], { config: () => h.config });
    expect((jsonLine(noPid.out) as { status: string }).status).toBe('running');
  });

  test('a run with no classification yet has tier_final null', async () => {
    const { store } = scriptedStore([record('created')]);
    const h = home();
    const r = await cli([createStatusCommand({ openStore: async () => store })], ['status', RUN_ID, '--json'], { config: () => h.config });
    const doc = jsonLine(r.out);
    expect(v.is(StatusOutputSchema, doc)).toBe(true);
    expect(doc).toMatchObject({ status: 'running', tier_final: null, submissions: 0, preflight_warnings: [] });
  });

  test('an unknown run exits 1', async () => {
    const h = home();
    const r = await cli([createStatusCommand()], ['status', OTHER_RUN, '--json'], { config: () => h.config });
    expect(r.code).toBe(EXIT.ERROR);
    expect((jsonLine(r.out) as { error: { message: string } }).error.message).toBe(`run not found: ${OTHER_RUN}`);
  });
});

// ------------------------------------------------------------------ ask

describe('ask', () => {
  test('an unknown run exits 1 with run not found and spawns nothing', async () => {
    const h = home();
    const spy = spawnSpy();
    const r = await cli([createAskCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })], ['ask', OTHER_RUN, 'why?'], {
      config: () => h.config,
    });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('run not found');
    expect(spy.calls).toHaveLength(0);
  });

  test('a known run spawns one worker with the ask payload and prints {run_id, submission_id}', async () => {
    const h = home();
    await seed(h, { phase: 'completed', pid: 4242, report: true });
    const spy = spawnSpy(5151);
    const r = await cli(
      [createAskCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser, isAlive: () => false })],
      ['ask', RUN_ID, '  did the retry on T3 go out?  ', '--json'],
      { config: () => h.config },
    );
    expect(r.code).toBe(EXIT.OK);
    const doc = jsonLine(r.out);
    expect(v.is(AskOutputSchema, doc)).toBe(true);
    expect(doc).toEqual({ run_id: RUN_ID, submission_id: 2 });
    expect(spy.calls).toEqual([{ kind: 'ask', run_id: RUN_ID, question: 'did the retry on T3 go out?', by: 'ops-reviewer' }]);
    // A wait right after this must not return the previous report.
    const run = await (await createRunStore(h.config)).getRun(RUN_ID);
    expect(run?.phase).toBe('dispatched');
    expect(run?.worker_pid).toBe(5151);
  });

  test('--requested-by wins over the OS user', async () => {
    const h = home();
    await seed(h, { phase: 'failed', reason: 'AgentRunError' });
    const spy = spawnSpy();
    const r = await cli(
      [createAskCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })],
      ['ask', RUN_ID, 'try again?', '--requested-by', 'lead@example.test'],
      { config: () => h.config },
    );
    expect(r.code).toBe(EXIT.OK);
    expect((spy.calls[0] as { by: string }).by).toBe('lead@example.test');
  });

  test('refuses a run that is still going, an empty question and a failed spawn', async () => {
    const h = home();
    await seed(h, { phase: 'investigating', pid: 4242 });
    const spy = spawnSpy();
    const busy = await cli([createAskCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser, isAlive: () => true })], ['ask', RUN_ID, 'why?'], {
      config: () => h.config,
    });
    expect(busy.code).toBe(EXIT.ERROR);
    expect(busy.err).toContain('still going');
    const empty = await cli([createAskCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })], ['ask', RUN_ID, '   '], {
      config: () => h.config,
    });
    expect(empty.code).toBe(EXIT.USAGE);
    expect(spy.calls).toHaveLength(0);

    const failing = spawnSpy(1, new WorkerSpawnError('EAGAIN'));
    const r = await cli(
      [createAskCommand({ spawn: failing.spawn, defaultRequestedBy: fixedUser, isAlive: () => false })],
      ['ask', RUN_ID, 'why?'],
      { config: () => h.config },
    );
    expect(r.code).toBe(EXIT.ERROR);
    // The stalled run keeps its phase when no worker started.
    expect((await (await createRunStore(h.config)).getRun(RUN_ID))?.phase).toBe('investigating');
  });
});

// ------------------------------------------------------------------ run

describe('run', () => {
  /** A fake runSubmission that stores a report the way the real pipeline would. */
  function fakeSubmit(h: TestHome, status: 'completed' | 'failed', order: string[]) {
    return async (p: PreparedSubmission): Promise<SubmissionResult> => {
      order.push('submit');
      const store = await createRunStore(h.config);
      await store.createRun(p.run_id, redactPersisted(p.request, { names: [...p.redaction_names] }));
      const seq = await store.addSubmission(p.run_id, redactPersisted({ kind: 'initial' as const }));
      if (status === 'completed') {
        await store.putReport(
          p.run_id,
          seq,
          redactPersisted(sampleReport(p.run_id, 'the payout is waiting on the bank')),
          redactPersisted('# Triage report\n\nthe payout is waiting on the bank\n'),
        );
        await store.setPhase(p.run_id, 'completed');
        return { run_id: p.run_id, status, submission_seq: seq, submission_id: 's1', reply_text: 'done', gaps: [] };
      }
      await store.setPhase(p.run_id, 'failed', { reason: 'AgentRunError' });
      return { run_id: p.run_id, status, submission_seq: seq, submission_id: 's1', error: 'AgentRunError', gaps: [] };
    };
  }

  function runCmd(h: TestHome, status: 'completed' | 'failed', order: string[]): CliCommand {
    return createRunCommand({
      boot: async () => {
        order.push('boot');
      },
      prepare: async (input, config, registry: Registry) => {
        order.push('prepare');
        return prepareRequest(input, { ...prepareDeps(config, registry), newId: () => RUN_ID });
      },
      submit: fakeSubmit(h, status, order),
      defaultRequestedBy: fixedUser,
    });
  }

  test('runs in process and prints the report Markdown', async () => {
    const h = home();
    const order: string[] = [];
    const r = await cli([runCmd(h, 'completed', order)], ['run', '--text', TEXT], { config: () => h.config });
    expect(r.code).toBe(EXIT.OK);
    expect(order).toEqual(['boot', 'prepare', 'submit']);
    expect(r.out).toContain('# Triage report');
    expect(r.out).toContain('the payout is waiting on the bank');
  });

  test('--json prints {run_id, status, report} in the wait shape', async () => {
    const h = home();
    const r = await cli([runCmd(h, 'completed', [])], ['run', '--text', TEXT, '--json'], { config: () => h.config });
    expect(r.code).toBe(EXIT.OK);
    const doc = jsonLine(r.out) as { run_id: string; status: string; report: { run_id: string } };
    expect(v.is(WaitOutputSchema, doc)).toBe(true);
    expect(doc.run_id).toBe(RUN_ID);
    expect(doc.status).toBe('completed');
    expect(doc.report.run_id).toBe(RUN_ID);
  });

  test('a failed run exits 1 with the reason in both forms', async () => {
    const h = home();
    const json = await cli([runCmd(h, 'failed', [])], ['run', '--text', TEXT, '--json'], { config: () => h.config });
    expect(json.code).toBe(EXIT.ERROR);
    expect(jsonLine(json.out)).toEqual({ run_id: RUN_ID, status: 'failed', reason: 'AgentRunError' });
    const h2 = home();
    const human = await cli([runCmd(h2, 'failed', [])], ['run', '--text', TEXT], { config: () => h2.config });
    expect(human.code).toBe(EXIT.ERROR);
    expect(human.err).toContain('failed: AgentRunError');
  });

  test('input errors stop before anything runs', async () => {
    const h = home();
    const order: string[] = [];
    const r = await cli([runCmd(h, 'completed', order)], ['run', '--text', TEXT, '--tier', 'ultra'], { config: () => h.config });
    expect(r.code).toBe(EXIT.USAGE);
    expect(order).toEqual([]);
  });
});

// ------------------------------------------------------------------ cwd

describe('config comes only from TRIAGE_HOME', () => {
  test('every command works with cwd set to an unrelated temp dir', async () => {
    const h = home();
    const cwd = tempDir();
    const before = process.cwd();
    const saved = process.env.TRIAGE_HOME;
    process.chdir(cwd);
    process.env.TRIAGE_HOME = h.home;
    try {
      const config = () => loadConfig();
      const spy = spawnSpy(6161);
      const start = await cli([createStartCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })], ['start', '--text', TEXT, '--json'], {
        config,
      });
      expect(start.code).toBe(EXIT.OK);
      const runId = (jsonLine(start.out) as { run_id: string }).run_id;

      const payload = spy.calls[0] as WorkerPayload;
      const worker = createWorkerCommand({
        boot: async () => undefined,
        deps: () => ({}) as never,
        pid: () => 6161,
        runSubmission: async (p) => {
          const store = await createRunStore(loadConfig());
          const seq = await store.addSubmission(p.run_id, redactPersisted({ kind: 'initial' as const }));
          await store.putReport(p.run_id, seq, redactPersisted(sampleReport(p.run_id, 'ok')), redactPersisted('# r'));
          await store.setPhase(p.run_id, 'completed');
          return { run_id: p.run_id, status: 'completed', submission_seq: seq, submission_id: 's1', gaps: [] };
        },
      });
      const w = await cli([worker], ['__worker', runId], { config, stdin: Readable.from([JSON.stringify(payload)]) });
      expect(w.code).toBe(EXIT.OK);

      const status = await cli([createStatusCommand()], ['status', runId, '--json'], { config });
      expect((jsonLine(status.out) as { status: string }).status).toBe('completed');
      const wait = await cli([createWaitCommand()], ['wait', runId, '--json'], { config });
      expect(wait.code).toBe(EXIT.OK);
      const ask = await cli([createAskCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })], ['ask', runId, 'and now?', '--json'], {
        config,
      });
      expect(ask.code).toBe(EXIT.OK);
      const order: string[] = [];
      const run = await cli([runCmd2(order)], ['run', '--text', TEXT, '--json'], { config });
      expect(run.code).toBe(EXIT.OK);

      // Nothing was written under the cwd; the run folders live under the home.
      expect(existsSync(join(cwd, '.data'))).toBe(false);
      expect(h.config.paths.runsDir.startsWith(h.home)).toBe(true);
    } finally {
      process.chdir(before);
      if (saved === undefined) delete process.env.TRIAGE_HOME;
      else process.env.TRIAGE_HOME = saved;
    }

    function runCmd2(order: string[]): CliCommand {
      return createRunCommand({
        boot: async () => undefined,
        prepare: async (input, config, registry) => {
          order.push('prepare');
          return prepareRequest(input, { ...prepareDeps(config, registry), newId: () => OTHER_RUN });
        },
        submit: async (p) => {
          const store = await createRunStore(loadConfig());
          await store.createRun(p.run_id, redactPersisted(p.request));
          await store.setPhase(p.run_id, 'completed');
          return { run_id: p.run_id, status: 'completed', submission_seq: 1, submission_id: 's1', gaps: [] };
        },
        defaultRequestedBy: fixedUser,
      });
    }
  });
});

// ------------------------------------------------------------------ questions for the requester

describe('a run waiting on a question', () => {
  const question = () => sampleInputRequest('q1');

  /** A real stored run parked on q1, the way ask_requester leaves it. */
  async function parked(h: TestHome): Promise<RunStore> {
    const store = await seed(h, { phase: 'investigating', pid: 4242 });
    await store.putInputRequest(RUN_ID, redactPersisted(question()));
    return store;
  }

  test('status reports needs_input with the question, whether or not a worker is alive', async () => {
    const h = home();
    await parked(h);
    for (const alive of [true, false]) {
      const r = await cli([createStatusCommand({ isAlive: () => alive })], ['status', RUN_ID, '--json'], { config: () => h.config });
      expect(r.code).toBe(EXIT.OK);
      const doc = jsonLine(r.out) as { status: string; phase: string; input_request?: { question_id: string } };
      expect(v.is(StatusOutputSchema, doc)).toBe(true);
      expect(doc.status).toBe('needs_input');
      expect(doc.phase).toBe('needs_input');
      expect(doc.input_request?.question_id).toBe('q1');
    }
    const human = await cli([createStatusCommand({ isAlive: () => false })], ['status', RUN_ID], { config: () => h.config });
    expect(human.code).toBe(EXIT.OK);
    expect(human.out).toContain('needs an answer');
    expect(human.out).toContain('1. 2 Sep, 5,000');
    expect(human.out).toContain(`triage input ${RUN_ID}`);
  });

  test('wait without a terminal prints the question, exits 4 and starts nothing', async () => {
    const h = home();
    await parked(h);
    const spy = spawnSpy();
    const r = await cli([createWaitCommand({ spawn: spy.spawn, isAlive: () => false })], ['wait', RUN_ID, '--json'], { config: () => h.config });
    expect(r.code).toBe(EXIT_NEEDS_INPUT);
    expect(r.code).toBe(4);
    const doc = jsonLine(r.out) as { status: string; phase: string; input_request: { question_id: string; options: string[] } };
    expect(v.is(WaitOutputSchema, doc)).toBe(true);
    expect(doc.status).toBe('needs_input');
    expect(doc.phase).toBe('needs_input');
    expect(doc.input_request.options).toEqual(['2 Sep, 5,000', '3 Sep, 12,000']);
    expect(spy.calls).toHaveLength(0);

    const human = await cli([createWaitCommand({ spawn: spy.spawn, isAlive: () => false })], ['wait', RUN_ID], { config: () => h.config });
    expect(human.code).toBe(4);
    expect(human.out).toContain('needs an answer');
    expect(human.out).toContain(`triage input ${RUN_ID} "<answer>"`);
    expect(spy.calls).toHaveLength(0);
    expect((await (await createRunStore(h.config)).getRun(RUN_ID))?.phase).toBe('needs_input');
  });

  test('wait at a terminal asks, starts the worker with the answer and keeps waiting', async () => {
    const report = { ...sampleReport(RUN_ID, 'the second transfer bounced') };
    const { store, calls } = scriptedStore(
      [
        record('needs_input', { input_request: question() }),
        record('dispatched', { worker_pid: 5151 }),
        record('completed', { worker_pid: 5151, report, report_md: '# report' }),
      ],
      ['setPhase'],
    );
    const spy = spawnSpy(5151);
    const prompts: string[] = [];
    const answers = ['', '2'];
    const cmd = createWaitCommand({
      openStore: async () => store,
      isAlive: () => true,
      spawn: spy.spawn,
      prompt: () => async (q) => {
        prompts.push(q);
        return answers.shift() ?? null;
      },
      defaultRequestedBy: fixedUser,
      sleep: async () => undefined,
    });
    const h = home();
    const r = await cli([cmd], ['wait', RUN_ID], { config: () => h.config, isTTY: true });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('needs an answer');
    expect(r.out).toContain('answered question q1');
    expect(r.out).toContain('# report');
    // The blank line asked again; the number picked the second option.
    expect(prompts).toHaveLength(2);
    expect(spy.calls).toEqual([{ kind: 'answer', run_id: RUN_ID, question_id: 'q1', by: 'ops-reviewer', answer: '3 Sep, 12,000' }]);
    expect(calls).toEqual(['getRun', 'setPhase', 'getRun', 'getRun']);
  });

  test('wait at a terminal: s skips, --requested-by names the answerer, EOF prints how to answer later', async () => {
    const report = { ...sampleReport(RUN_ID, 'x') };
    const { store } = scriptedStore(
      [record('needs_input', { input_request: question() }), record('completed', { report, report_md: '# report' })],
      ['setPhase'],
    );
    const spy = spawnSpy(5151);
    const cmd = createWaitCommand({
      openStore: async () => store,
      isAlive: () => true,
      spawn: spy.spawn,
      prompt: () => async () => 's',
      defaultRequestedBy: fixedUser,
      sleep: async () => undefined,
    });
    const r = await cli([cmd], ['wait', RUN_ID, '--requested-by', 'lead@example.test'], { config: () => home().config, isTTY: true });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('skipped question q1');
    expect(spy.calls).toEqual([{ kind: 'answer', run_id: RUN_ID, question_id: 'q1', by: 'lead@example.test', skip: true }]);

    const { store: eof } = scriptedStore([record('needs_input', { input_request: question() })]);
    const quiet = spawnSpy();
    const e = await cli(
      [createWaitCommand({ openStore: async () => eof, isAlive: () => true, spawn: quiet.spawn, prompt: () => async () => null, defaultRequestedBy: fixedUser })],
      ['wait', RUN_ID],
      { config: () => home().config, isTTY: true },
    );
    expect(e.code).toBe(4);
    expect(quiet.calls).toHaveLength(0);
    expect(e.out).toContain(`triage input ${RUN_ID}`);
  });

  test('ask refuses a run waiting on a question and points at input', async () => {
    const h = home();
    await parked(h);
    const spy = spawnSpy();
    const r = await cli([createAskCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser, isAlive: () => false })], ['ask', RUN_ID, 'why?'], {
      config: () => h.config,
    });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('waiting for an answer to question q1');
    expect(r.err).toContain(`triage input ${RUN_ID}`);
    expect(spy.calls).toHaveLength(0);
  });

  test('input starts one worker with the answer payload, records its pid and prints the JSON shape', async () => {
    const h = home();
    await parked(h);
    const spy = spawnSpy(6161);
    const r = await cli(
      [createInputCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })],
      ['input', RUN_ID, '  the one on 3 Sep  ', '--ids', 'customer_id=CUST-0042', '--json'],
      { config: () => h.config },
    );
    expect(r.code).toBe(EXIT.OK);
    const doc = jsonLine(r.out);
    expect(v.is(InputOutputSchema, doc)).toBe(true);
    expect(doc).toEqual({ run_id: RUN_ID, question_id: 'q1', submission_id: 2, skipped: false });
    expect(spy.calls).toEqual([
      { kind: 'answer', run_id: RUN_ID, question_id: 'q1', by: 'ops-reviewer', answer: 'the one on 3 Sep', ids: { customer_id: 'CUST-0042' } },
    ]);
    const run = await (await createRunStore(h.config)).getRun(RUN_ID);
    expect(run?.phase).toBe('dispatched');
    expect(run?.worker_pid).toBe(6161);
    // The question itself is closed by the worker (answerRun), not here.
    expect(run?.input_request?.question_id).toBe('q1');
  });

  test('input --skip, --question and --requested-by', async () => {
    const h = home();
    await parked(h);
    const spy = spawnSpy(6262);
    const r = await cli(
      [createInputCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser })],
      ['input', RUN_ID, '--skip', '--question', 'q1', '--requested-by', 'lead@example.test'],
      { config: () => h.config },
    );
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('skipped question q1');
    expect(r.out).toContain(`triage wait ${RUN_ID}`);
    expect(spy.calls).toEqual([{ kind: 'answer', run_id: RUN_ID, question_id: 'q1', by: 'lead@example.test', skip: true }]);
  });

  test('input refuses bad input, an unknown run, a run that is not waiting and another question, starting nothing', async () => {
    const h = home();
    const spy = spawnSpy();
    const cmd = () => createInputCommand({ spawn: spy.spawn, defaultRequestedBy: fixedUser });
    const cfg = { config: () => h.config };
    expect((await cli([cmd()], ['input', RUN_ID], cfg)).code).toBe(EXIT.USAGE);
    expect((await cli([cmd()], ['input', RUN_ID, 'x', '--skip'], cfg)).code).toBe(EXIT.USAGE);
    expect((await cli([cmd()], ['input', RUN_ID, 'x', '--question', 'first'], cfg)).code).toBe(EXIT.USAGE);
    expect((await cli([cmd()], ['input', RUN_ID, 'x', '--ids', 'shoe_size=9'], cfg)).code).toBe(EXIT.USAGE);
    expect((await cli([cmd()], ['input', OTHER_RUN, 'x'], cfg)).code).toBe(EXIT.ERROR);
    await seed(h, { phase: 'completed', report: true });
    const notWaiting = await cli([cmd()], ['input', RUN_ID, 'x'], cfg);
    expect(notWaiting.code).toBe(EXIT.ERROR);
    expect(notWaiting.err).toContain('is not waiting for an answer');
    const store = await createRunStore(h.config);
    await store.putInputRequest(RUN_ID, redactPersisted(question()));
    const other = await cli([cmd()], ['input', RUN_ID, 'x', '--question', 'q2'], cfg);
    expect(other.code).toBe(EXIT.ERROR);
    expect(other.err).toContain('waiting on question q1, not q2');
    expect(spy.calls).toHaveLength(0);
    expect((await store.getRun(RUN_ID))?.phase).toBe('needs_input');

    const failing = spawnSpy(1, new WorkerSpawnError('EAGAIN'));
    const f = await cli([createInputCommand({ spawn: failing.spawn, defaultRequestedBy: fixedUser })], ['input', RUN_ID, 'x'], cfg);
    expect(f.code).toBe(EXIT.ERROR);
    expect((await store.getRun(RUN_ID))?.phase).toBe('needs_input');
  });

  test('the worker calls answerRun with the answer payload; a parked result is not a failure', async () => {
    const h = home();
    await parked(h);
    const calls: unknown[][] = [];
    const worker = createWorkerCommand({
      boot: async () => undefined,
      deps: () => ({}) as never,
      pid: () => 999,
      runSubmission: async () => {
        throw new Error('runSubmission must not be called');
      },
      askRun: async () => {
        throw new Error('askRun must not be called');
      },
      answerRun: async (...args) => {
        calls.push(args.slice(0, 2));
        return { run_id: RUN_ID, status: 'needs_input', submission_seq: 2, submission_id: 's2', input_request: question(), gaps: [] };
      },
    });
    const payload = { kind: 'answer', run_id: RUN_ID, question_id: 'q1', answer: 'the second', ids: { customer_id: 'CUST-1' }, by: 'ops-reviewer' };
    const r = await cli([worker], ['__worker', RUN_ID], { config: () => h.config, stdin: Readable.from([JSON.stringify(payload)]) });
    expect(r.code).toBe(EXIT.OK);
    expect(calls).toEqual([[RUN_ID, { question_id: 'q1', answer: 'the second', ids: { customer_id: 'CUST-1' }, by: 'ops-reviewer' }]]);
    expect((await (await createRunStore(h.config)).getRun(RUN_ID))?.worker_pid).toBe(999);
    // Both an answer and skip, or neither, is refused before anything runs.
    for (const bad of [{ answer: 'x', skip: true }, {}]) {
      const stdin = Readable.from([JSON.stringify({ kind: 'answer', run_id: RUN_ID, question_id: 'q1', by: 'ops-reviewer', ...bad })]);
      const b = await cli([worker], ['__worker', RUN_ID], { config: () => h.config, stdin });
      expect(b.code).toBe(EXIT.USAGE);
    }
    expect(calls).toHaveLength(1);
  });

  /** `triage run` with a fake pipeline that parks the run once, and a fake answerRun that finishes it. */
  function runHarness(h: TestHome) {
    const order: string[] = [];
    const answers: AnswerInput[] = [];
    const submitParked = async (p: PreparedSubmission): Promise<SubmissionResult> => {
      order.push('submit');
      const store = await createRunStore(h.config);
      await store.createRun(p.run_id, redactPersisted(p.request, { names: [...p.redaction_names] }));
      await store.addSubmission(p.run_id, redactPersisted({ kind: 'initial' as const }));
      await store.putInputRequest(p.run_id, redactPersisted(question()));
      return { run_id: p.run_id, status: 'needs_input', submission_seq: 1, submission_id: 's1', input_request: question(), gaps: [] };
    };
    const answer = async (runId: string, input: AnswerInput): Promise<SubmissionResult> => {
      order.push('answer');
      answers.push(input);
      const store = await createRunStore(h.config);
      await store.resolveInputRequest(runId, 'q1', redactPersisted({ status: 'answered', resolved_at: '2026-09-20T10:00:00.000Z', resolved_by: input.by }));
      const seq = await store.addSubmission(runId, redactPersisted({ kind: 'answer' as const, question_id: 'q1', answer: input.answer ?? '' }));
      await store.putReport(
        runId,
        seq,
        redactPersisted(sampleReport(runId, 'the payout is waiting on the bank')),
        redactPersisted('# Triage report\n\nthe payout is waiting on the bank\n'),
      );
      await store.setPhase(runId, 'completed');
      return { run_id: runId, status: 'completed', submission_seq: seq, submission_id: 's2', gaps: [] };
    };
    const cmd = (prompt: () => Promise<string | null>): CliCommand =>
      createRunCommand({
        boot: async () => {
          order.push('boot');
        },
        prepare: async (input, config, registry: Registry) => {
          order.push('prepare');
          return prepareRequest(input, { ...prepareDeps(config, registry), newId: () => RUN_ID });
        },
        submit: submitParked,
        answer,
        prompt: () => prompt,
        defaultRequestedBy: fixedUser,
      });
    return { cmd, order, answers };
  }

  test('run at a terminal asks, resumes in process and prints the report', async () => {
    const h = home();
    const t = runHarness(h);
    const r = await cli([t.cmd(async () => '1')], ['run', '--text', TEXT], { config: () => h.config, isTTY: true });
    expect(r.code).toBe(EXIT.OK);
    expect(t.order).toEqual(['boot', 'prepare', 'submit', 'answer']);
    expect(t.answers).toEqual([{ question_id: 'q1', answer: '2 Sep, 5,000', by: 'ops-reviewer' }]);
    expect(r.out).toContain('needs an answer');
    expect(r.out).toContain('# Triage report');
  });

  test('run without a terminal prints the question in the wait shape and exits 4', async () => {
    const h = home();
    const t = runHarness(h);
    const r = await cli([t.cmd(async () => null)], ['run', '--text', TEXT, '--json'], { config: () => h.config });
    expect(r.code).toBe(4);
    const doc = jsonLine(r.out) as { status: string; phase: string; input_request: { question_id: string } };
    expect(v.is(WaitOutputSchema, doc)).toBe(true);
    expect(doc).toMatchObject({ run_id: RUN_ID, status: 'needs_input', phase: 'needs_input' });
    expect(doc.input_request.question_id).toBe('q1');
    expect(t.order).toEqual(['boot', 'prepare', 'submit']);
    expect((await (await createRunStore(h.config)).getRun(RUN_ID))?.phase).toBe('needs_input');
  });
});
