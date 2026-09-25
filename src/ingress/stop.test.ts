// stopRun against the real folder run store in a temp TRIAGE_HOME. No Flue:
// the abort is a fake.

import { afterEach, describe, expect, test } from 'bun:test';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { redactPersisted } from '../gate/redact.ts';
import { sampleBlock, sampleInputRequest, sampleRequest } from '../runstore/contract.ts';
import { createFolderRunStore } from '../runstore/folder.ts';
import { RunNotFoundError, type RunStore } from '../runstore/types.ts';
import { IngressInputError } from './normalise.ts';
import { RunNotRunningError, STOP_REASON, stopRun, type StopDeps } from './stop.ts';

const RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH1';
const UNKNOWN = '01J8ZQ7XK3PSEDRMNABCDEFGH9';
const NOW = new Date('2026-09-25T10:00:00.000Z');

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

type Env = { store: RunStore; deps: StopDeps; aborts: string[] };

async function env(o: { submissions?: number; abort?: StopDeps['abort'] } = {}): Promise<Env> {
  const h = makeTestHome();
  homes.push(h);
  const store = createFolderRunStore({ runsDir: h.config.paths.runsDir, dataDir: h.config.paths.dataDir });
  await store.createRun(RUN, redactPersisted(sampleRequest(RUN)));
  for (let i = 0; i < (o.submissions ?? 1); i++) await store.addSubmission(RUN, redactPersisted({ kind: 'initial' as const }));
  await store.setPhase(RUN, 'investigating');
  const aborts: string[] = [];
  const deps: StopDeps = {
    store,
    home: h.config.home,
    abort:
      o.abort ??
      (async (runId) => {
        aborts.push(runId);
      }),
    now: () => NOW,
  };
  return { store, deps, aborts };
}

describe('stopRun', () => {
  test('stops a running run, records the Cancel verdict with the phase it was in, and aborts the agent', async () => {
    const e = await env();
    const r = await stopRun(RUN, { by: 'ops-reviewer', interface: 'http' }, e.deps);
    expect(r).toMatchObject({ run_id: RUN, stopped_from: 'investigating', aborted: true, gaps: [] });
    expect(e.aborts).toEqual([RUN]);
    const run = await e.store.getRun(RUN);
    expect(run?.phase).toBe('stopped');
    expect(run?.phase_reason).toBe(STOP_REASON);
    expect(run?.feedback).toEqual([
      {
        verdict: 'wrong',
        given_by: 'ops-reviewer',
        given_at: NOW.toISOString(),
        interface: 'http',
        phase: 'investigating',
        submission_seq: 1,
        cancelled: true,
      },
    ]);
  });

  test('verdict false stops without a feedback entry', async () => {
    const e = await env();
    const r = await stopRun(RUN, { by: 'ops', interface: 'cli', verdict: false }, e.deps);
    expect(r.feedback).toBeNull();
    expect((await e.store.getRun(RUN))?.feedback).toEqual([]);
  });

  test('a run that never reached the agent is not aborted', async () => {
    const e = await env({ submissions: 0 });
    const r = await stopRun(RUN, { by: 'ops', interface: 'cli' }, e.deps);
    expect(r.aborted).toBe(false);
    expect(e.aborts).toEqual([]);
  });

  test('an open question is closed as cancelled', async () => {
    const e = await env();
    await e.store.putInputRequest(RUN, redactPersisted(sampleInputRequest('q1')));
    const r = await stopRun(RUN, { by: 'ops', interface: 'cli' }, e.deps);
    expect(r.stopped_from).toBe('needs_input');
    const run = await e.store.getRun(RUN);
    expect(run?.input_request).toBeNull();
    expect(run?.input_history.at(-1)).toMatchObject({ question_id: 'q1', status: 'cancelled', resolved_by: 'ops' });
  });

  test('an open block is closed as cancelled by the same person at the same time', async () => {
    const e = await env();
    await e.store.putBlock(RUN, redactPersisted(sampleBlock('b1')));
    const r = await stopRun(RUN, { by: 'ops', interface: 'cli' }, e.deps);
    expect(r.stopped_from).toBe('blocked');
    const run = await e.store.getRun(RUN);
    expect(run?.phase).toBe('stopped');
    expect(run?.block).toBeNull();
    expect(run?.block_history.at(-1)).toMatchObject({
      block_id: 'b1',
      status: 'cancelled',
      resolved_by: 'ops',
      resolved_at: NOW.toISOString(),
    });
  });

  test('a failed abort is a gap; the run is stopped anyway', async () => {
    const e = await env({
      abort: async () => {
        throw new TypeError('no runtime');
      },
    });
    const r = await stopRun(RUN, { by: 'ops', interface: 'cli' }, e.deps);
    expect(r.aborted).toBe(false);
    expect(r.gaps).toEqual(['the agent was not asked to abort (TypeError); the process running it stops on its next check']);
    expect((await e.store.getRun(RUN))?.phase).toBe('stopped');
  });

  test('a finished run is refused and nothing is written', async () => {
    const e = await env();
    await e.store.setPhase(RUN, 'completed');
    const err = await stopRun(RUN, { by: 'ops', interface: 'cli' }, e.deps).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(RunNotRunningError);
    expect((err as RunNotRunningError).phase).toBe('completed');
    const run = await e.store.getRun(RUN);
    expect(run?.phase).toBe('completed');
    expect(run?.feedback).toEqual([]);
    expect(e.aborts).toEqual([]);
    // A second stop on a stopped run is refused the same way.
    await e.store.setPhase(RUN, 'investigating');
    await stopRun(RUN, { by: 'ops', interface: 'cli' }, e.deps);
    await expect(stopRun(RUN, { by: 'ops', interface: 'cli' }, e.deps)).rejects.toBeInstanceOf(RunNotRunningError);
  });

  test('bad input and unknown runs are refused before anything is written', async () => {
    const e = await env();
    await expect(stopRun('../escape', { by: 'ops', interface: 'cli' }, e.deps)).rejects.toBeInstanceOf(IngressInputError);
    await expect(stopRun(RUN, { by: '  ', interface: 'cli' }, e.deps)).rejects.toBeInstanceOf(IngressInputError);
    await expect(stopRun(UNKNOWN, { by: 'ops', interface: 'cli' }, e.deps)).rejects.toBeInstanceOf(RunNotFoundError);
    expect((await e.store.getRun(RUN))?.phase).toBe('investigating');
  });
});
