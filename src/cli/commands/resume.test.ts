// triage resume, run through buildProgram and runCli with a test home, the
// folder run store under it, fake io and a fake spawnWorker. No worker
// process is started: a test plays the worker's part by writing to the store
// from the command's sleep, the way resumeRun would. No real .env is read and
// nothing reaches the network.
import { afterEach, describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import * as v from 'valibot';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { WorkerSpawnError } from '../../ingress/detach.ts';
import { prepareDeps, prepareRequest } from '../../ingress/prepare.ts';
import { RESUME_HINTS } from '../../ingress/submit.ts';
import type { WorkerPayload } from '../../ingress/worker-payload.ts';
import { sampleBlock, sampleInputRequest, sampleReport } from '../../runstore/contract.ts';
import { createRunStore } from '../../runstore/index.ts';
import type { RunPhase, RunRecord, RunStore, Submission } from '../../runstore/types.ts';
import { MAX_RESUME_NOTE_CHARS } from '../../types/block.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { ResumeOutputSchema } from '../lib/output-schemas.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { createResumeCommand, takenOver, type ResumeCommandOptions } from './resume.command.ts';

// All values below are synthetic.
const RUN_ID = '01J8ZQ7XK3PSEUDRESUMEAAAAA';
const OTHER_RUN = '01J8ZQ7XK3PSEUDRESUMEBBBBB';
const TEXT = 'Customer says the payout is stuck since Monday';
const AT = '2026-09-20T10:00:00.000Z';

// ------------------------------------------------------------------ harness

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function home(): TestHome {
  const h = makeTestHome();
  homes.push(h);
  return h;
}

type Out = { code: number; out: string; err: string };

async function cli(cmd: CliCommand, argv: readonly string[], h: TestHome): Promise<Out> {
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
  const code = await runCli(buildProgram([cmd], ctx), [...argv]);
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

function jsonLine(out: string): unknown {
  const lines = out.split('\n').filter((l) => l !== '');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string);
}

/** The command with a worker that is always alive and a sleep that does nothing, unless a test says otherwise. */
function resumeCmd(o: ResumeCommandOptions = {}): CliCommand {
  return createResumeCommand({ isAlive: () => true, defaultRequestedBy: () => 'ops-reviewer', sleep: async () => undefined, ...o });
}

type Seed = {
  readonly phase: RunPhase;
  /** Submissions before the resume; 0 for a run that never started an investigation. */
  readonly submissions?: number;
  readonly block?: boolean;
  readonly question?: boolean;
  readonly reason?: string;
  readonly pid?: number;
};

/** Seeds a run in the folder store of the home. A block or a question moves the phase itself. */
async function seed(h: TestHome, o: Seed): Promise<RunStore> {
  const store = await createRunStore(h.config);
  const p = await prepareRequest(
    { kind: 'text', text: TEXT, interface: 'cli', requested_by: 'ops-reviewer' },
    { ...prepareDeps(h.config, h.registry), newId: () => RUN_ID },
  );
  await store.createRun(RUN_ID, redactPersisted(p.request));
  for (let i = 0; i < (o.submissions ?? 1); i++) {
    await store.addSubmission(RUN_ID, redactPersisted(i === 0 ? { kind: 'initial' as const } : { kind: 'ask' as const, question: 'and then?' }));
  }
  if (o.phase === 'completed') {
    await store.putReport(RUN_ID, 1, redactPersisted(sampleReport(RUN_ID, 'the payout is waiting on the bank')), redactPersisted('# r'));
  }
  await store.setPhase(RUN_ID, o.phase, {
    ...(o.pid !== undefined ? { worker_pid: o.pid } : {}),
    ...(o.reason !== undefined ? { reason: o.reason } : {}),
  });
  if (o.block === true) await store.putBlock(RUN_ID, redactPersisted(sampleBlock('b1')));
  if (o.question === true) await store.putInputRequest(RUN_ID, redactPersisted(sampleInputRequest('q1')));
  return store;
}

/** A store fake that answers getRun from a script and records every call by name; any other method throws. */
function scriptedStore(records: readonly (RunRecord | null)[]): { store: RunStore; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const store = new Proxy({} as RunStore, {
    get(_t, name: string) {
      if (name === 'then') return undefined;
      return async () => {
        calls.push(name);
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
    created_at: AT,
    updated_at: AT,
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
    usage: [],
    ...extra,
  };
}

const initial: Submission = { kind: 'initial', seq: 1, created_at: AT, report: null, report_md: null };

// ------------------------------------------------------------------ tests

describe('triage resume', () => {
  test('is registered', () => {
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('resume');
  });

  test('a blocked run: spawns one worker with the resume payload, waits for it to take the run over and prints {run_id, submission_id}', async () => {
    const h = home();
    const store = await seed(h, { phase: 'investigating', block: true, pid: 1111 });
    const spy = spawnSpy(5151);
    const sleeps: number[] = [];
    const cmd = resumeCmd({
      spawn: spy.spawn,
      pollMs: 10,
      // The worker's resumeRun: closes the block, adds the submission and moves the phase.
      sleep: async (ms) => {
        sleeps.push(ms);
        await store.resolveBlock(
          RUN_ID,
          'b1',
          redactPersisted({ status: 'resumed' as const, resolved_at: AT, resolved_by: 'ops-reviewer', note: 'harbor is back' }),
        );
        await store.addSubmission(RUN_ID, redactPersisted({ kind: 'resume' as const, block_id: 'b1', note: 'harbor is back' }));
        await store.setPhase(RUN_ID, 'dispatched', { worker_pid: 5151, resume: true });
      },
    });
    const r = await cli(cmd, ['resume', RUN_ID, '  harbor is back  ', '--json'], h);
    expect(r.code).toBe(EXIT.OK);
    expect(r.err).toBe('');
    const doc = jsonLine(r.out);
    expect(v.is(ResumeOutputSchema, doc)).toBe(true);
    expect(doc).toEqual({ run_id: RUN_ID, submission_id: 2 });
    expect(spy.calls).toEqual([{ kind: 'resume', run_id: RUN_ID, by: 'ops-reviewer', note: 'harbor is back' }]);
    expect(sleeps).toEqual([10]);
    const run = await store.getRun(RUN_ID);
    expect(run?.phase).toBe('dispatched');
    expect(run?.block).toBeNull();
    expect(run?.block_history.map((b) => [b.block_id, b.status])).toEqual([['b1', 'resumed']]);
  });

  test('reads the store and writes nothing: the worker moves the run', async () => {
    const block = sampleBlock('b1');
    const closed = { ...block, status: 'resumed' as const, resolved_at: AT, resolved_by: 'ops-reviewer' };
    const { store, calls } = scriptedStore([
      record('blocked', { block }),
      record('blocked', { block }),
      record('blocked', { block: null, block_history: [closed] }),
    ]);
    const c = clock();
    const spy = spawnSpy(5151);
    const cmd = resumeCmd({ openStore: async () => store, spawn: spy.spawn, now: c.now, sleep: (ms) => c.sleep(ms), pollMs: 250 });
    const r = await cli(cmd, ['resume', RUN_ID], home());
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain(`resumed run ${RUN_ID} (submission 1)`);
    expect(r.out).toContain(`follow it with: triage wait ${RUN_ID}`);
    expect(calls).toEqual(['getRun', 'getRun', 'getRun']);
    expect(c.sleeps).toEqual([250]);
    expect(spy.calls).toHaveLength(1);
  });

  test('a run that failed after it started, and a stopped run, are resumed; --requested-by names who', async () => {
    const h = home();
    const store = await seed(h, { phase: 'failed', reason: 'AgentRunError', submissions: 2, pid: 1111 });
    const spy = spawnSpy(6161);
    const cmd = resumeCmd({
      spawn: spy.spawn,
      sleep: async () => {
        await store.addSubmission(RUN_ID, redactPersisted({ kind: 'resume' as const }));
        await store.setPhase(RUN_ID, 'dispatched', { worker_pid: 6161, resume: true });
      },
    });
    const r = await cli(cmd, ['resume', RUN_ID, '--requested-by', 'lead@example.test'], h);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain(`resumed run ${RUN_ID} (submission 3)`);
    expect(spy.calls).toEqual([{ kind: 'resume', run_id: RUN_ID, by: 'lead@example.test' }]);

    const h2 = home();
    const store2 = await seed(h2, { phase: 'stopped', reason: 'cancelled' });
    const spy2 = spawnSpy(6262);
    const cmd2 = resumeCmd({
      spawn: spy2.spawn,
      // The phase moving on is a takeover too.
      sleep: async () => {
        await store2.setPhase(RUN_ID, 'dispatched', { worker_pid: 6262, resume: true });
      },
    });
    const r2 = await cli(cmd2, ['resume', RUN_ID, '--json'], h2);
    expect(r2.code).toBe(EXIT.OK);
    expect(jsonLine(r2.out)).toEqual({ run_id: RUN_ID, submission_id: 2 });
    expect(spy2.calls).toHaveLength(1);
  });

  test('refuses, with the same hints as resumeRun, and starts nothing', async () => {
    const spy = spawnSpy();
    const cmd = () => resumeCmd({ spawn: spy.spawn });
    const unknown = await cli(cmd(), ['resume', OTHER_RUN], home());
    expect(unknown.code).toBe(EXIT.ERROR);
    expect(unknown.err).toContain('run not found');

    const cases: { readonly seed: Seed; readonly hint: string }[] = [
      { seed: { phase: 'investigating', pid: 1111 }, hint: RESUME_HINTS.running },
      { seed: { phase: 'dispatched' }, hint: RESUME_HINTS.running },
      { seed: { phase: 'investigating', question: true }, hint: RESUME_HINTS.needs_input },
      { seed: { phase: 'completed' }, hint: RESUME_HINTS.completed },
      { seed: { phase: 'failed', submissions: 0, reason: 'WorkerSpawnError' }, hint: RESUME_HINTS.never_started },
      { seed: { phase: 'stopped', submissions: 0, reason: 'cancelled' }, hint: RESUME_HINTS.never_started },
    ];
    for (const { seed: s, hint } of cases) {
      const h = home();
      const store = await seed(h, s);
      const r = await cli(cmd(), ['resume', RUN_ID, '--json'], h);
      expect(r.code).toBe(EXIT.ERROR);
      const e = jsonLine(r.out) as { error: { code: string; message: string } };
      expect(e.error.code).toBe('ERROR');
      expect(e.error.message).toContain(`run ${RUN_ID} cannot be resumed (phase ${(await store.getRun(RUN_ID))?.phase})`);
      expect(e.error.message).toContain(hint);
    }
    expect(spy.calls).toHaveLength(0);
  });

  test('brings the SSFB tunnel back first and refuses, with the fix, when it does not come up; nothing starts', async () => {
    const h = home();
    const store = await seed(h, { phase: 'investigating', block: true, pid: 1111 });
    const spy = spawnSpy();
    const seen: { config: unknown; isTty: boolean }[] = [];
    const cmd = resumeCmd({
      spawn: spy.spawn,
      readiness: async (config, isTty) => {
        seen.push({ config, isTty });
        return {
          warnings: [
            {
              step: 'tunnel',
              entity: 'ssfb',
              message: 'SSFB DB tunnel did not start: the bastion is unreachable; the SSFB databases may be unreachable',
              fix: 'triage tunnel status, then triage tunnel up',
            },
          ],
        };
      },
    });
    const r = await cli(cmd, ['resume', RUN_ID, '--json'], h);
    expect(r.code).toBe(EXIT.ERROR);
    const e = jsonLine(r.out) as { error: { code: string; message: string } };
    expect(e.error.code).toBe('ERROR');
    expect(e.error.message).toContain(`run ${RUN_ID} cannot be resumed (phase blocked)`);
    expect(e.error.message).toContain('the bastion is unreachable');
    expect(e.error.message).toContain('triage tunnel status, then triage tunnel up');
    expect(seen).toEqual([{ config: h.config, isTty: false }]);
    expect(spy.calls).toHaveLength(0);
    const run = await store.getRun(RUN_ID);
    expect(run?.phase).toBe('blocked');
    expect(run?.block?.block_id).toBe('b1');
    expect(run?.block_history).toEqual([]);
  });

  test('a readiness check that warns about another step still starts the worker', async () => {
    const h = home();
    const store = await seed(h, { phase: 'investigating', block: true, pid: 1111 });
    const spy = spawnSpy(6161);
    const cmd = resumeCmd({
      spawn: spy.spawn,
      pollMs: 10,
      readiness: async () => ({ warnings: [{ step: 'preflight', message: 'the resume check could not finish; the run continues without it' }] }),
      sleep: async () => {
        await store.setPhase(RUN_ID, 'dispatched', { worker_pid: 6161, resume: true });
      },
    });
    const r = await cli(cmd, ['resume', RUN_ID, '--json'], h);
    expect(r.code).toBe(EXIT.OK);
    expect(spy.calls).toHaveLength(1);
  });

  test('usage errors exit 2 and start nothing', async () => {
    const h = home();
    await seed(h, { phase: 'investigating', block: true });
    const spy = spawnSpy();
    const cmd = () => resumeCmd({ spawn: spy.spawn });
    expect((await cli(cmd(), ['resume', '../x'], h)).code).toBe(EXIT.USAGE);
    const blank = await cli(cmd(), ['resume', RUN_ID, '   '], h);
    expect(blank.code).toBe(EXIT.USAGE);
    expect(blank.err).toContain('the message is empty');
    const long = await cli(cmd(), ['resume', RUN_ID, 'x'.repeat(MAX_RESUME_NOTE_CHARS + 1)], h);
    expect(long.code).toBe(EXIT.USAGE);
    expect(long.err).toContain(`the message must be at most ${MAX_RESUME_NOTE_CHARS} characters`);
    const nobody = await cli(resumeCmd({ spawn: spy.spawn, defaultRequestedBy: () => undefined }), ['resume', RUN_ID], h);
    expect(nobody.code).toBe(EXIT.USAGE);
    expect(nobody.err).toContain('--requested-by is required');
    expect(spy.calls).toHaveLength(0);
    expect((await (await createRunStore(h.config)).getRun(RUN_ID))?.phase).toBe('blocked');
  });

  test('a worker that exits before it took the run over: exit 1, the run as it was', async () => {
    const h = home();
    await seed(h, { phase: 'investigating', block: true });
    const spy = spawnSpy(7171);
    const r = await cli(resumeCmd({ spawn: spy.spawn, isAlive: () => false }), ['resume', RUN_ID], h);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain(`the worker exited before it resumed run ${RUN_ID} (phase blocked)`);
    expect(r.err).toContain(`triage logs ${RUN_ID}`);
    const run = await (await createRunStore(h.config)).getRun(RUN_ID);
    expect(run?.phase).toBe('blocked');
    expect(run?.block?.block_id).toBe('b1');
  });

  test('a worker that gave up before it sent the run on: exit 1 with the reason', async () => {
    const h = home();
    const store = await seed(h, { phase: 'investigating', block: true });
    const spy = spawnSpy(7272);
    const cmd = resumeCmd({
      spawn: spy.spawn,
      // The worker's runtime failed to start: it records the failure and exits.
      sleep: async () => {
        await store.setPhase(RUN_ID, 'failed', { reason: 'BootFailure', resume: true });
      },
    });
    const r = await cli(cmd, ['resume', RUN_ID, '--json'], h);
    expect(r.code).toBe(EXIT.ERROR);
    const e = jsonLine(r.out) as { error: { message: string } };
    expect(e.error.message).toContain(`the worker could not resume run ${RUN_ID} (phase failed: BootFailure)`);
  });

  test('a failed spawn exits 1 and leaves the run as it was; a slow worker returns after the takeover timeout', async () => {
    const h = home();
    await seed(h, { phase: 'investigating', block: true });
    const failing = spawnSpy(1, new WorkerSpawnError('EAGAIN'));
    const r = await cli(resumeCmd({ spawn: failing.spawn }), ['resume', RUN_ID], h);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('could not start the worker');
    expect((await (await createRunStore(h.config)).getRun(RUN_ID))?.phase).toBe('blocked');

    const c = clock();
    const spy = spawnSpy(7373);
    const slow = resumeCmd({ spawn: spy.spawn, now: c.now, sleep: (ms) => c.sleep(ms), pollMs: 250, takeoverMs: 1000 });
    const t = await cli(slow, ['resume', RUN_ID, '--json'], h);
    expect(t.code).toBe(EXIT.OK);
    expect(jsonLine(t.out)).toEqual({ run_id: RUN_ID, submission_id: 2 });
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe('takenOver', () => {
  test('a new submission, a moved phase or a closed block', () => {
    const before = record('blocked', { block: sampleBlock('b1'), submissions: [initial] });
    expect(takenOver(before, before)).toBe(false);
    expect(takenOver(before, record('blocked', { block: sampleBlock('b1'), submissions: [initial, { ...initial, kind: 'resume', seq: 2 }] }))).toBe(true);
    expect(takenOver(before, record('dispatched', { block: sampleBlock('b1'), submissions: [initial] }))).toBe(true);
    expect(takenOver(before, record('blocked', { block: null, submissions: [initial] }))).toBe(true);
    const failed = record('failed', { submissions: [initial] });
    expect(takenOver(failed, record('failed', { submissions: [initial] }))).toBe(false);
    expect(takenOver(failed, record('dispatched', { submissions: [initial] }))).toBe(true);
  });
});
