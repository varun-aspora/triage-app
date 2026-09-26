import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlueEventContext, FlueObservation } from '@flue/runtime';
import {
  activeRuns,
  EVENTS_FILE,
  flushRunEventLog,
  flushRunEventLogSync,
  installRunEventLog,
  logRunEvent,
  runRedactionNames,
  setRunRedactionNames,
  uninstallRunEventLog,
} from './event-log.ts';
import { readRunEvents } from './read.ts';

const RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH1';
const PHONE = '+91 98765 43210';
const ACCOUNT = '918020012345678';

const dirs: string[] = [];
afterEach(() => {
  uninstallRunEventLog();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Subscriber = (o: FlueObservation, ctx: FlueEventContext) => void;

function setup(): { runsDir: string; emit: (event: Record<string, unknown>, ctxId?: string) => void; subscribers: Subscriber[] } {
  const runsDir = mkdtempSync(join(tmpdir(), 'triage-runlog-'));
  dirs.push(runsDir);
  const subscribers: Subscriber[] = [];
  installRunEventLog({
    runsDir,
    now: () => new Date('2026-09-25T10:00:00.000Z'),
    observe: (s) => {
      subscribers.push(s);
      return () => subscribers.splice(subscribers.indexOf(s), 1);
    },
  });
  const emit = (event: Record<string, unknown>, ctxId = RUN) => {
    for (const s of subscribers) s(Object.freeze({ v: 3, eventIndex: 0, timestamp: '2026-09-25T10:00:01.000Z', ...event }) as never, { id: ctxId } as never);
  };
  return { runsDir, emit, subscribers };
}

function lines(runsDir: string): any[] {
  return readFileSync(join(runsDir, RUN, EVENTS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

describe('run event log', () => {
  test('flue events and pipeline lines land in order, one JSON line each, redacted', async () => {
    const { runsDir, emit } = setup();
    setRunRedactionNames(RUN, ['Asha Verma']);
    logRunEvent(RUN, 'phase', { phase: 'investigating' });
    emit({ type: 'tool_start', instanceId: RUN, toolName: 'sql_select', toolCallId: 'c1', args: { sql: `select * from t where phone = '${PHONE}'` } });
    emit({ type: 'text_delta', instanceId: RUN, text: 'partial' });
    emit({
      type: 'tool',
      instanceId: RUN,
      toolName: 'sql_select',
      toolCallId: 'c1',
      isError: false,
      durationMs: 12,
      effectiveResult: { rows: [{ account: ACCOUNT, name: 'Asha Verma' }] },
    });
    logRunEvent(RUN, 'failed', { error: new Error(`timeout for ${PHONE}`) });
    await flushRunEventLog();

    const got = lines(runsDir);
    expect(got.map((l) => `${l.source}:${l.type}`)).toEqual(['pipeline:phase', 'flue:tool_start', 'flue:tool', 'pipeline:failed']);
    expect(got[1]).toMatchObject({ ts: '2026-09-25T10:00:01.000Z', data: { toolName: 'sql_select', toolCallId: 'c1' } });
    expect(got[1].data.v).toBeUndefined();
    expect(got[3].data.error.message).toContain('timeout for');
    expect(typeof got[3].data.error.stack).toBe('string');
    const text = readFileSync(join(runsDir, RUN, EVENTS_FILE), 'utf8');
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain('Asha Verma');
  });

  test('the run id comes from the event, else the context; anything that is not a run id is dropped', async () => {
    const { runsDir, emit } = setup();
    emit({ type: 'log', level: 'info', message: 'from ctx' });
    emit({ type: 'log', level: 'info', message: 'bad', instanceId: '../escape' }, '../escape');
    logRunEvent('../escape', 'phase', {});
    await flushRunEventLog();
    expect(lines(runsDir).map((l) => l.data.message)).toEqual(['from ctx']);
  });

  test('the system prompt is written once per session until it changes', async () => {
    const { runsDir, emit } = setup();
    const turn = (system: string, session = 's1') => ({
      type: 'turn_request',
      instanceId: RUN,
      session,
      request: { requestedModel: 'm', input: { systemPrompt: system, messages: [] } },
    });
    emit(turn('prompt A'));
    emit(turn('prompt A'));
    emit(turn('prompt A', 's2'));
    emit({ type: 'submission_settled', instanceId: RUN, submissionId: 'x', outcome: 'completed' });
    emit(turn('prompt A'));
    await flushRunEventLog();
    const inputs = lines(runsDir)
      .filter((l) => l.type === 'turn_request')
      .map((l) => l.data.request.input.systemPrompt ?? 'unchanged');
    // A settled submission forgets the prompt, so the next one writes it again.
    expect(inputs).toEqual(['prompt A', 'unchanged', 'prompt A', 'prompt A']);
  });

  test('runRedactionNames returns the names set for the run, even before install, and none otherwise', () => {
    expect(runRedactionNames(RUN)).toEqual([]);
    setRunRedactionNames(RUN, ['Asha Verma']);
    setRunRedactionNames('01J8ZQ7XK3PSEDRMNABCDEFGH2', []);
    expect(runRedactionNames(RUN)).toEqual(['Asha Verma']);
    expect(runRedactionNames('01J8ZQ7XK3PSEDRMNABCDEFGH2')).toEqual([]);
  });

  test('nothing is written before the log is installed', async () => {
    uninstallRunEventLog();
    logRunEvent(RUN, 'phase', {});
    await flushRunEventLog();
    // No runs dir exists for it to write to; this only checks it does not throw.
    expect(true).toBe(true);
  });
});

describe('readRunEvents', () => {
  test('pages by line number, and a missing file is an empty log', async () => {
    const { runsDir } = setup();
    expect(await readRunEvents(runsDir, RUN)).toEqual({ events: [], next: 0, more: false });
    for (let i = 0; i < 5; i++) logRunEvent(RUN, 'phase', { i });
    await flushRunEventLog();
    const first = await readRunEvents(runsDir, RUN, { limit: 2 });
    expect(first.events.map((e) => [e.index, (e.data as { i: number }).i])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(first).toMatchObject({ next: 2, more: true });
    const rest = await readRunEvents(runsDir, RUN, { after: first.next });
    expect(rest.events.map((e) => e.index)).toEqual([2, 3, 4]);
    expect(rest).toMatchObject({ next: 5, more: false });
    expect((await readRunEvents(runsDir, RUN, { after: 5 })).events).toEqual([]);
  });

  test('a partial last line is left for the next read', async () => {
    const { runsDir } = setup();
    logRunEvent(RUN, 'phase', { i: 0 });
    await flushRunEventLog();
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(runsDir, RUN, EVENTS_FILE), '{"ts":"2026-09-25T10:00:00.000Z","source":"pipel');
    const page = await readRunEvents(runsDir, RUN);
    expect(page.events).toHaveLength(1);
    expect(page).toMatchObject({ next: 1, more: false });
  });

  test('a bad run id is refused', async () => {
    await expect(readRunEvents('/tmp', '../escape')).rejects.toThrow('run_id');
  });
});

describe('active runs', () => {
  test('a run is active from submission_running until its submissions settle, with its last phase and attempt', () => {
    const { emit } = setup();
    expect(activeRuns()).toEqual([]);
    logRunEvent(RUN, 'phase', { phase: 'identity' });
    logRunEvent(RUN, 'phase', { phase: 'investigating' });
    emit({ type: 'submission_running', instanceId: RUN, submissionId: 's1', kind: 'dispatch', attemptCount: 1, maxAttempts: 10 });
    emit({ type: 'submission_running', instanceId: RUN, submissionId: 's1', kind: 'dispatch', attemptCount: 3, maxAttempts: 10 });
    expect(activeRuns()).toEqual([{ runId: RUN, attempt: 3, phase: 'investigating' }]);
    emit({ type: 'submission_settled', instanceId: RUN, submissionId: 's1', outcome: 'aborted' });
    expect(activeRuns()).toEqual([]);
  });

  test('flushRunEventLogSync writes the queued lines before returning', () => {
    const { runsDir } = setup();
    logRunEvent(RUN, 'phase', { phase: 'investigating' });
    flushRunEventLogSync();
    expect(lines(runsDir).map((l) => l.type)).toEqual(['phase']);
  });
});
