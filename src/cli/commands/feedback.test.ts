// triage feedback, run through buildProgram and runCli with a temp home, the
// folder run store under it and fake io. No real .env is read.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { sampleRequest } from '../../runstore/contract.ts';
import { createFolderRunStore } from '../../runstore/folder.ts';
import type { RunStore } from '../../runstore/types.ts';
import type { Report } from '../../types/report.ts';
import sampleReport from '../../report/__fixtures__/sample-report.json' with { type: 'json' };
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { command, createFeedbackCommand, type FeedbackCommandOptions } from './feedback.command.ts';

const RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH1';
const UNKNOWN_RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH9';

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

type Env = { h: TestHome; store: RunStore; storeBuilds: number };

async function env(): Promise<Env> {
  const h = makeTestHome();
  homes.push(h);
  const store = createFolderRunStore({ runsDir: h.config.paths.runsDir, dataDir: h.config.paths.dataDir });
  await store.createRun(RUN, redactPersisted(sampleRequest(RUN)));
  await store.addSubmission(RUN, redactPersisted({ kind: 'initial' as const }));
  const report = { ...(sampleReport as unknown as Report), run_id: RUN };
  await store.putReport(RUN, 1, redactPersisted(report), redactPersisted('# report\n'));
  return { h, store, storeBuilds: 0 };
}

type Run = { code: number; out: string; err: string };

async function feedback(e: Env, argv: string[], o: Partial<FeedbackCommandOptions> = {}): Promise<Run> {
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
  const cmd = createFeedbackCommand({
    store: async () => {
      e.storeBuilds++;
      return e.store;
    },
    osUser: () => 'os-user',
    now: () => new Date('2026-09-24T09:00:00.000Z'),
    ...o,
  });
  const program = buildProgram([cmd], ctx);
  const code = await runCli(program, ['feedback', ...argv]);
  return { code, out, err };
}

const draftDir = (e: Env) => join(e.h.config.home, 'evals', '_unreviewed', RUN);

async function nothingWritten(e: Env): Promise<void> {
  expect((await e.store.getRun(RUN))?.feedback).toHaveLength(0);
  expect(existsSync(join(e.h.config.home, 'evals'))).toBe(false);
}

describe('registration', () => {
  test('exports command at feedback and the generated list picks it up', () => {
    expect(command.path).toEqual(['feedback']);
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('feedback');
  });
});

describe('usage deny paths', () => {
  test('missing --verdict exits non-zero and writes nothing', async () => {
    const e = await env();
    const r = await feedback(e, [RUN]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain('--verdict');
    expect(e.storeBuilds).toBe(0);
    await nothingWritten(e);
  });

  test('missing run_id exits non-zero', async () => {
    const e = await env();
    const r = await feedback(e, ['--verdict', 'correct']);
    expect(r.code).toBe(EXIT.USAGE);
    await nothingWritten(e);
  });

  for (const [label, verdict] of [
    ['empty', ''],
    ['uppercase', 'CORRECT'],
    ['capitalised', 'Wrong'],
    ['unknown', 'maybe'],
  ] as const) {
    test(`verdict ${label} is refused before the store is built`, async () => {
      const e = await env();
      const r = await feedback(e, [RUN, '--verdict', verdict]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.err).toContain('--verdict must be one of accept, reject, correct, partial, wrong, pending');
      expect(e.storeBuilds).toBe(0);
      await nothingWritten(e);
    });
  }

  test('a bad verdict under --json prints a machine-stable error', async () => {
    const e = await env();
    const r = await feedback(e, [RUN, '--verdict', 'nope', '--json']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(JSON.parse(r.out)).toEqual({
      error: { code: 'USAGE', message: '--verdict must be one of accept, reject, correct, partial, wrong, pending' },
    });
  });

  test('a run_id that is not a ULID is a usage error', async () => {
    const e = await env();
    const r = await feedback(e, ['../../etc', '--verdict', 'correct']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain('ULID');
    await nothingWritten(e);
  });

  test('no OS user and no --given-by is a usage error', async () => {
    const e = await env();
    const r = await feedback(e, [RUN, '--verdict', 'correct'], { osUser: () => undefined });
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain('--given-by');
    await nothingWritten(e);
  });
});

describe('run refusals', () => {
  test('an unknown run_id refuses with a clear message', async () => {
    const e = await env();
    const r = await feedback(e, [UNKNOWN_RUN, '--verdict', 'correct']);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toBe(`triage: no run ${UNKNOWN_RUN} in the run store\n`);
    expect(existsSync(join(e.h.config.home, 'evals'))).toBe(false);
  });
});

describe('a valid call', () => {
  test('records the verdict and prints the draft path', async () => {
    const e = await env();
    const r = await feedback(e, [
      RUN,
      '--verdict',
      'wrong',
      '--actual-root-cause',
      'the ledger posted twice for account 123456789012',
      '--faster-path',
      'check the ledger first',
    ]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.err).toBe('');
    expect(r.out).toContain(`recorded verdict wrong for run ${RUN} (1 feedback entry)`);
    expect(r.out).toContain(`eval draft: ${draftDir(e)}`);
    expect(r.out).not.toContain('123456789012');

    const run = await e.store.getRun(RUN);
    expect(run?.feedback).toHaveLength(1);
    expect(run?.feedback[0]).toMatchObject({ verdict: 'wrong', interface: 'cli', given_by: 'os-user' });
    expect(run?.feedback[0]?.actual_root_cause).not.toContain('123456789012');
    expect(existsSync(join(draftDir(e), 'feedback.md'))).toBe(true);
    expect(existsSync(join(draftDir(e), 'report.json'))).toBe(true);
    expect(readFileSync(join(draftDir(e), 'feedback.md'), 'utf8')).toContain('verdict: wrong');
    expect(existsSync(join(e.h.config.home, 'evals', 'cases'))).toBe(false);
  });

  test('--json prints the draft path and files', async () => {
    const e = await env();
    const r = await feedback(e, [RUN, '--verdict', 'correct', '--given-by', 'reviewer-a', '--json']);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toEqual({
      run_id: RUN,
      verdict: 'correct',
      feedback_count: 1,
      draft_dir: draftDir(e),
      draft_files: {
        feedback_md: join(draftDir(e), 'feedback.md'),
        report_json: join(draftDir(e), 'report.json'),
      },
    });
    expect((await e.store.getRun(RUN))?.feedback[0]?.given_by).toBe('reviewer-a');
  });

  test('a second call appends and counts two entries', async () => {
    const e = await env();
    await feedback(e, [RUN, '--verdict', 'pending']);
    const r = await feedback(e, [RUN, '--verdict', 'correct']);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('(2 feedback entries)');
    expect((await e.store.getRun(RUN))?.feedback.map((f) => f.verdict)).toEqual(['pending', 'correct']);
  });
});

describe('accept, reject, notes and finding verdicts', () => {
  test('accept and reject are stored as correct and wrong, with notes and finding verdicts', async () => {
    const e = await env();
    expect((await feedback(e, [RUN, '--verdict', 'accept'])).code).toBe(EXIT.OK);
    const r = await feedback(e, [RUN, '--verdict', 'reject', '--notes', 'wrong customer', '--finding', 'root_cause=reject']);
    expect(r.code).toBe(EXIT.OK);
    const run = await e.store.getRun(RUN);
    expect(run?.feedback.map((f) => f.verdict)).toEqual(['correct', 'wrong']);
    expect(run?.feedback[1]).toMatchObject({
      notes: 'wrong customer',
      findings: [{ id: 'root_cause', verdict: 'wrong', text: (sampleReport as unknown as Report).root_cause?.statement }],
    });
  });

  for (const [label, flag, message] of [
    ['no =', 'root_cause', '--finding must be <id>=<verdict>'],
    ['a bad verdict', 'root_cause=maybe', '--finding verdict must be one of'],
  ] as const) {
    test(`--finding with ${label} is a usage error and writes nothing`, async () => {
      const e = await env();
      const r = await feedback(e, [RUN, '--verdict', 'reject', '--finding', flag]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.err).toContain(message);
      expect(e.storeBuilds).toBe(0);
      await nothingWritten(e);
    });
  }

  test('a finding the run does not have is a usage error and writes nothing', async () => {
    const e = await env();
    const r = await feedback(e, [RUN, '--verdict', 'reject', '--finding', 'ssfb.v1.e1=wrong']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain('findings.0.id names findings the run does not have');
    await nothingWritten(e);
  });
});
