import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlueEventContext, FlueObservation } from '@flue/runtime';
import { EVENTS_FILE, installRunEventLog, logRunEvent, uninstallRunEventLog } from '../runlog/event-log.ts';
import { summariseEvent } from '../runlog/summary.ts';
import type { ServerConfig } from './boot.ts';
import { runServer } from './main.ts';
import { flushBeforeExit, noteShutdown } from './shutdown.ts';

const RUN_A = '01J8ZQ7XK3PSEDRMNABCDEFGH1';
const RUN_B = '01J8ZQ7XK3PSEDRMNABCDEFGH2';
const RUN_DONE = '01J8ZQ7XK3PSEDRMNABCDEFGH3';

type Subscriber = (o: FlueObservation, ctx: FlueEventContext) => void;

const dirs: string[] = [];
afterEach(() => {
  uninstallRunEventLog();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real event log in a temp dir, fed by a fake observe(). */
function setup() {
  const runsDir = mkdtempSync(join(tmpdir(), 'triage-shutdown-'));
  dirs.push(runsDir);
  const subscribers: Subscriber[] = [];
  installRunEventLog({ runsDir, observe: (s) => (subscribers.push(s), () => {}) });
  const emit = (runId: string, event: Record<string, unknown>) => {
    for (const s of subscribers) s({ v: 3, eventIndex: 0, timestamp: '2026-09-26T10:00:00.000Z', instanceId: runId, ...event } as never, { id: runId } as never);
  };
  const lines = (runId: string): any[] => {
    const file = join(runsDir, runId, EVENTS_FILE);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  };
  return { emit, lines };
}

describe('noteShutdown', () => {
  test('writes the stderr line and one server_shutdown line per active run, on disk before it returns', () => {
    const { emit, lines } = setup();
    logRunEvent(RUN_A, 'phase', { phase: 'investigating' });
    emit(RUN_A, { type: 'submission_running', submissionId: 's1', kind: 'dispatch', attemptCount: 2, maxAttempts: 10 });
    emit(RUN_B, { type: 'submission_running', submissionId: 's2', kind: 'dispatch', attemptCount: 1, maxAttempts: 10 });
    emit(RUN_DONE, { type: 'submission_running', submissionId: 's3', kind: 'dispatch', attemptCount: 1, maxAttempts: 10 });
    emit(RUN_DONE, { type: 'submission_settled', submissionId: 's3', outcome: 'completed' });

    const stderr: string[] = [];
    expect(noteShutdown('SIGTERM', { write: (l) => void stderr.push(l) })).toBe(2);

    // No await: the lines must already be written.
    expect(stderr).toEqual(['triage-server: SIGTERM received, stopping with 2 active runs\n']);
    const a = lines(RUN_A).filter((l) => l.type === 'server_shutdown');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ source: 'pipeline', data: { signal: 'SIGTERM', active_runs: 2, attempt: 2, phase: 'investigating' } });
    const b = lines(RUN_B).filter((l) => l.type === 'server_shutdown');
    expect(b).toHaveLength(1);
    expect(b[0].data).toEqual({ signal: 'SIGTERM', active_runs: 2, attempt: 1 });
    expect(lines(RUN_DONE).some((l) => l.type === 'server_shutdown')).toBe(false);
    expect(summariseEvent(a[0])).toBe('server stopped (SIGTERM) · 2 active runs · in investigating · attempt 2');
  });

  test('no active runs: the stderr line says 0 and no run is written to', () => {
    setup();
    const stderr: string[] = [];
    expect(noteShutdown('SIGINT', { write: (l) => void stderr.push(l) })).toBe(0);
    expect(stderr).toEqual(['triage-server: SIGINT received, stopping with 0 active runs\n']);
  });

  test('a failure to log does not throw, so stop() still runs', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    expect(noteShutdown('SIGTERM', { activeRuns: boom, write: boom, flush: boom })).toBe(0);
    expect(() => flushBeforeExit(boom)).not.toThrow();

    const steps: string[] = [];
    const server = await runServer({
      loadConfig: () => ({}) as unknown as ServerConfig,
      prepareServer: async () => ({ port: 1, stop: () => void steps.push('timers.stop') }),
      startRuntime: async () => ({ stop: async () => void steps.push('runtime.stop') }),
      listen: async (port) => ({ port, close: async () => void steps.push('listener.close') }),
    });
    noteShutdown('SIGTERM', { activeRuns: () => [{ runId: RUN_A, attempt: 1 }], write: boom, flush: boom });
    await server.stop();
    expect(steps).toEqual(['listener.close', 'runtime.stop', 'timers.stop']);
  });
});
