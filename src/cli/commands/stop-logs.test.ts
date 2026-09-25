// triage stop and triage logs, run through buildProgram and runCli with a
// temp home, the folder run store under it and fake io. No Flue runtime: the
// abort is a fake.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { flushRunEventLog, uninstallRunEventLog } from '../../runlog/event-log.ts';
import { sampleRequest } from '../../runstore/contract.ts';
import { createFolderRunStore } from '../../runstore/folder.ts';
import type { RunStore } from '../../runstore/types.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { createLogsCommand } from './logs.command.ts';
import { createStopCommand } from './stop.command.ts';

const RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH1';
const UNKNOWN = '01J8ZQ7XK3PSEDRMNABCDEFGH9';

const homes: TestHome[] = [];
afterEach(async () => {
  await flushRunEventLog();
  uninstallRunEventLog();
  for (const h of homes.splice(0)) h.cleanup();
});

type Env = { h: TestHome; store: RunStore; aborts: string[] };

async function env(phase: 'investigating' | 'completed' = 'investigating'): Promise<Env> {
  const h = makeTestHome();
  homes.push(h);
  const store = createFolderRunStore({ runsDir: h.config.paths.runsDir, dataDir: h.config.paths.dataDir });
  await store.createRun(RUN, redactPersisted(sampleRequest(RUN)));
  await store.addSubmission(RUN, redactPersisted({ kind: 'initial' as const }));
  await store.setPhase(RUN, phase);
  return { h, store, aborts: [] };
}

type Out = { code: number; out: string; err: string };

async function cli(e: Env, cmd: CliCommand, argv: string[]): Promise<Out> {
  let out = '';
  let err = '';
  const ctx: CliContext = {
    config: () => e.h.config,
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from([]),
      isTTY: false,
    },
    deps: {},
  };
  const code = await runCli(buildProgram([cmd], ctx), argv);
  return { code, out, err };
}

const stopCmd = (e: Env) =>
  createStopCommand({
    store: async () => e.store,
    abort: async (id) => void e.aborts.push(id),
    osUser: () => 'os-user',
    now: () => new Date('2026-09-25T10:00:00.000Z'),
  });

describe('triage stop', () => {
  test('is registered', () => {
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('stop');
    expect(paths).toContain('logs');
  });

  test('stops a running run, records the Cancel verdict and aborts the agent', async () => {
    const e = await env();
    const r = await cli(e, stopCmd(e), ['stop', RUN, '--json']);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toEqual({ run_id: RUN, stopped_from: 'investigating', aborted: true, feedback_count: 1, gaps: [] });
    expect(e.aborts).toEqual([RUN]);
    const run = await e.store.getRun(RUN);
    expect(run?.phase).toBe('stopped');
    expect(run?.feedback[0]).toMatchObject({ verdict: 'wrong', cancelled: true, given_by: 'os-user', interface: 'cli' });
  });

  test('--no-verdict stops without feedback; the human form says how to resume', async () => {
    const e = await env();
    const r = await cli(e, stopCmd(e), ['stop', RUN, '--no-verdict', '--given-by', 'reviewer']);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain(`stopped run ${RUN} (it was in phase investigating)`);
    expect(r.out).toContain(`triage ask ${RUN}`);
    expect((await e.store.getRun(RUN))?.feedback).toEqual([]);
  });

  test('a finished run, an unknown run and a bad id are refused', async () => {
    const e = await env('completed');
    const done = await cli(e, stopCmd(e), ['stop', RUN]);
    expect(done.code).toBe(EXIT.ERROR);
    expect(done.err).toContain('is not running (phase completed)');
    expect((await cli(e, stopCmd(e), ['stop', UNKNOWN])).code).toBe(EXIT.ERROR);
    expect((await cli(e, stopCmd(e), ['stop', '../x'])).code).toBe(EXIT.USAGE);
    expect(e.aborts).toEqual([]);
    expect((await e.store.getRun(RUN))?.phase).toBe('completed');
  });
});

describe('triage logs', () => {
  function writeLog(e: Env, lines: object[]): void {
    const dir = join(e.h.config.paths.runsDir, RUN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }
  const at = '2026-09-25T10:00:00.123Z';

  test('prints one summary line per event, --type filters, --after skips, --json keeps the stored line', async () => {
    const e = await env('completed');
    writeLog(e, [
      { ts: at, source: 'pipeline', type: 'phase', data: { phase: 'investigating' } },
      { ts: at, source: 'flue', type: 'tool', data: { toolName: 'sql_select', isError: false, durationMs: 12, effectiveResult: { rows: 1 } } },
      { ts: at, source: 'flue', type: 'turn', data: { durationMs: 900, request: { requestedModel: 'm1' }, response: { finishReason: 'stop', usage: { input: 10, output: 5 } } } },
    ]);
    const logs = createLogsCommand({ openStore: async () => e.store });
    const human = await cli(e, logs, ['logs', RUN]);
    expect(human.code).toBe(EXIT.OK);
    const rows = human.out.trim().split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('10:00:00.123 pipeline phase');
    expect(rows[1]).toContain('sql_select ok in 12ms');
    expect(rows[2]).toContain('m1 stop 10 in / 5 out in 900ms');

    const only = await cli(e, logs, ['logs', RUN, '--type', 'tool']);
    expect(only.out.trim().split('\n')).toHaveLength(1);
    const after = await cli(e, logs, ['logs', RUN, '--after', '2', '--json']);
    expect(after.out.trim().split('\n').map((l) => JSON.parse(l).index)).toEqual([2]);
  });

  test('--follow reads until the run has finished', async () => {
    const e = await env();
    writeLog(e, [{ ts: at, source: 'pipeline', type: 'phase', data: { phase: 'investigating' } }]);
    let sleeps = 0;
    const logs = createLogsCommand({
      openStore: async () => e.store,
      sleep: async () => {
        sleeps++;
        const dir = join(e.h.config.paths.runsDir, RUN, 'events.jsonl');
        writeFileSync(dir, `${JSON.stringify({ ts: at, source: 'pipeline', type: 'phase', data: { phase: 'investigating' } })}\n${JSON.stringify({ ts: at, source: 'pipeline', type: 'settled', data: { status: 'completed' } })}\n`);
        await e.store.setPhase(RUN, 'completed');
      },
    });
    const r = await cli(e, logs, ['logs', RUN, '--follow']);
    expect(r.code).toBe(EXIT.OK);
    expect(sleeps).toBe(1);
    expect(r.out.trim().split('\n')).toHaveLength(2);
    expect(r.out).toContain('settled');
  });

  test('an unknown run and a bad --after are refused', async () => {
    const e = await env();
    const logs = createLogsCommand({ openStore: async () => e.store });
    expect((await cli(e, logs, ['logs', UNKNOWN])).code).toBe(EXIT.ERROR);
    expect((await cli(e, logs, ['logs', RUN, '--after', 'x'])).code).toBe(EXIT.USAGE);
  });
});
