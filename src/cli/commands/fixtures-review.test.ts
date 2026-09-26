// triage fixtures review, run through buildProgram and runCli with a test
// home, fake io and a scripted prompt. No real .env is read.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { keyHash, keyString, semanticKey } from '../../mock/key.ts';
import { listUnreviewed, reviewDirsFrom, type EvalCaseReviewItem } from '../../mock/promote.ts';
import { recordFeedback } from '../../report/feedback.ts';
import sampleReport from '../../report/__fixtures__/sample-report.json' with { type: 'json' };
import { sampleRequest } from '../../runstore/contract.ts';
import { createFolderRunStore } from '../../runstore/folder.ts';
import type { Report } from '../../types/report.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import {
  command,
  createFixturesReviewCommand,
  parseAnswer,
  type FixturesReviewOptions,
  type ReviewPrompt,
} from './fixtures-review.command.ts';

const homes: TestHome[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(overrides?: Record<string, string>): TestHome {
  const h = makeTestHome(overrides !== undefined ? { overrides } : {});
  homes.push(h);
  return h;
}

function key(param: string) {
  return semanticKey('sql_select', { entity: 'atspl', service: 'package', tables: ['delivery_requests'], params: [param] });
}

function body(k: unknown, runId: string, result: unknown = { rows: [{ status: 'SETTLED', ref: 'ref-1' }] }) {
  return {
    schema: 1,
    kind: 'sql_select',
    entity: 'atspl',
    key: k,
    key_string: keyString(k),
    result,
    meta: { source: 'recorded', recorded_at: '2026-09-20T10:00:00.000Z', run_id: runId },
  };
}

/** Writes fixtures/_unreviewed/<runId>/sql_select/atspl/<hash>.json and returns its path. */
function seed(h: TestHome, runId: string, param: string, result?: unknown): string {
  const k = key(param);
  const path = join(h.config.paths.fixturesDir, '_unreviewed', runId, 'sql_select', 'atspl', `${keyHash(k)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body(k, runId, result), null, 2));
  return path;
}

function reviewed(h: TestHome, scope: string[], param: string): string {
  return join(h.config.paths.fixturesDir, ...scope, 'sql_select', 'atspl', `${keyHash(key(param))}.json`);
}

type Run = { code: number; out: string; err: string; asked: string[]; configCalls: number };

type RunOptions = {
  answers?: (string | null)[];
  tty?: boolean;
  stdin?: string[];
  osUser?: () => string | undefined;
  /** Use the default stdin prompt instead of a scripted one. */
  defaultPrompt?: boolean;
};

async function review(h: TestHome, argv: string[], o: RunOptions = {}): Promise<Run> {
  let out = '';
  let err = '';
  let configCalls = 0;
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  // Writes the question where the command says, like the default prompt does.
  const scripted = (_io: unknown, write: (text: string) => void): ReviewPrompt => ({
    ask: async (q) => {
      asked.push(q);
      write(q);
      return answers.length > 0 ? (answers.shift() as string | null) : null;
    },
    close: () => {},
  });
  const options: FixturesReviewOptions = {
    osUser: o.osUser ?? (() => 'os-user'),
    ...(o.defaultPrompt === true ? {} : { prompt: scripted }),
  };
  const ctx: CliContext = {
    config: () => {
      configCalls++;
      return h.config;
    },
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from(o.stdin ?? []),
      isTTY: o.tty ?? true,
    },
    deps: {},
  };
  const program = buildProgram([createFixturesReviewCommand(options)], ctx);
  const code = await runCli(program, ['fixtures', 'review', ...argv]);
  return { code, out, err, asked, configCalls };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('registration', () => {
  test('exports command at fixtures review and the generated list picks it up', () => {
    expect(command.path).toEqual(['fixtures', 'review']);
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('fixtures review');
  });
});

describe('non-TTY refusal', () => {
  test('exits non-zero with a message, promotes nothing and never asks', async () => {
    const h = home();
    const source = seed(h, 'run-a', 'p-1');
    const r = await review(h, [], { tty: false, answers: ['y'] });
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain('needs an interactive terminal');
    expect(r.asked).toEqual([]);
    expect(r.configCalls).toBe(0);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(h.config.paths.fixturesDir, 'shared'))).toBe(false);
  });

  test('with --json the refusal is a JSON error on stdout', async () => {
    const h = home();
    seed(h, 'run-a', 'p-1');
    const r = await review(h, ['--json'], { tty: false });
    expect(r.code).toBe(EXIT.USAGE);
    expect(JSON.parse(r.out).error.code).toBe('USAGE');
  });
});

describe('answers', () => {
  test('y promotes, N declines and skip leaves the item undecided over three items', async () => {
    const h = home();
    const a = seed(h, 'run-a', 'p-1');
    const b = seed(h, 'run-b', 'p-2');
    const c = seed(h, 'run-c', 'p-3');
    const r = await review(h, ['--reviewer', 'reviewer-a'], { answers: ['y', 'N', 'skip'] });
    expect(r.code).toBe(EXIT.OK);
    expect(r.asked).toEqual(['promote? [y/N/skip] ', 'promote? [y/N/skip] ', 'promote? [y/N/skip] ']);

    const promoted = reviewed(h, ['shared'], 'p-1');
    expect(existsSync(a)).toBe(false);
    expect(readJson(promoted).meta.reviewed_by).toBe('reviewer-a');
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
    expect(existsSync(reviewed(h, ['shared'], 'p-2'))).toBe(false);
    expect(existsSync(reviewed(h, ['shared'], 'p-3'))).toBe(false);
    expect(r.out).toContain('promoted 1, declined 1, refused 0, skipped 1');
  });

  test('an empty answer declines and an unknown answer asks again', async () => {
    const h = home();
    const a = seed(h, 'run-a', 'p-1');
    const b = seed(h, 'run-b', 'p-2');
    const r = await review(h, [], { answers: ['maybe', '', 'yes'] });
    expect(r.asked).toHaveLength(3);
    expect(r.out).toContain('answer y, n (or empty) or skip');
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
    expect(r.out).toContain('promoted 1, declined 1, refused 0, skipped 0');
  });

  test('when input ends the rest are skipped, not declined or promoted', async () => {
    const h = home();
    const a = seed(h, 'run-a', 'p-1');
    const b = seed(h, 'run-b', 'p-2');
    const r = await review(h, [], { answers: [null] });
    expect(r.asked).toHaveLength(1);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(r.out).toContain('promoted 0, declined 0, refused 0, skipped 2');
  });

  test('parseAnswer maps each choice and nothing else', () => {
    expect(parseAnswer('y')).toBe('promote');
    expect(parseAnswer(' Y ')).toBe('promote');
    expect(parseAnswer('N')).toBe('decline');
    expect(parseAnswer('')).toBe('decline');
    expect(parseAnswer('skip')).toBe('skip');
    expect(parseAnswer('yy')).toBeNull();
    expect(parseAnswer('promote')).toBeNull();
  });

  test('the default prompt reads one stdin line per item', async () => {
    const h = home();
    const a = seed(h, 'run-a', 'p-1');
    const b = seed(h, 'run-b', 'p-2');
    const r = await review(h, [], { defaultPrompt: true, stdin: ['n\ny\n'] });
    expect(r.code).toBe(EXIT.OK);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
    expect(r.out).toContain('promote? [y/N/skip] ');
  });

  test('nothing to review is not an error', async () => {
    const h = home();
    const r = await review(h, []);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('nothing to review');
    expect(r.asked).toEqual([]);
  });
});

describe('--case', () => {
  test('routes promoted fixtures to fixtures/cases/<case_id>/', async () => {
    const h = home();
    seed(h, 'run-a', 'p-1');
    const r = await review(h, ['--case', 'case-42'], { answers: ['y'] });
    expect(r.code).toBe(EXIT.OK);
    expect(existsSync(reviewed(h, ['cases', 'case-42'], 'p-1'))).toBe(true);
    expect(existsSync(reviewed(h, ['shared'], 'p-1'))).toBe(false);
    expect(r.out).toContain(join('fixtures', 'cases', 'case-42'));
  });

  test('routes an eval case draft to evals/cases/<case_id>/', async () => {
    const h = home();
    const draft = join(h.home, 'evals', '_unreviewed', 'run-e');
    mkdirSync(draft, { recursive: true });
    writeFileSync(join(draft, 'feedback.md'), '# verdict: correct\n');
    const r = await review(h, ['--case', 'case-7'], { answers: ['y'] });
    expect(r.out).toContain('eval case draft, run run-e');
    expect(r.out).toContain('feedback.md');
    expect(existsSync(join(h.home, 'evals', 'cases', 'case-7', 'feedback.md'))).toBe(true);
    expect(existsSync(draft)).toBe(false);
  });

  test('a bad case id is a usage error and nothing is asked', async () => {
    const h = home();
    const source = seed(h, 'run-a', 'p-1');
    for (const bad of ['../x', '_unreviewed', '-x']) {
      const r = await review(h, ['--case', bad], { answers: ['y'] });
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.asked).toEqual([]);
    }
    expect(existsSync(source)).toBe(true);
  });
});

describe('refusals', () => {
  test('a refused item is reported and the next item is still offered', async () => {
    const h = home();
    // Mask token still in the key.
    const masked = seed(h, 'run-a', '****1234');
    // Redaction miss: an unmasked phone in the result.
    const phone = '+91 98765 43210';
    const leaky = seed(h, 'run-b', 'p-2', { rows: [{ mobile: phone }] });
    // Conflict: a reviewed file with different content already sits at the target.
    const conflict = seed(h, 'run-c', 'p-3');
    const target = reviewed(h, ['shared'], 'p-3');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(body(key('p-3'), 'run-c', { rows: [] })));
    const good = seed(h, 'run-d', 'p-4');

    const r = await review(h, [], { answers: ['y', 'y', 'y', 'y'] });
    expect(r.code).toBe(EXIT.OK);
    expect(r.asked).toHaveLength(4);
    expect(r.out).toContain("refused: the key still contains the mask token '****'");
    expect(r.out).toContain('refused: fails the persisted redaction check: phone');
    expect(r.out).toContain('refused: target exists with different content');
    expect(r.out).toContain('promoted 1, declined 0, refused 3, skipped 0');
    expect(existsSync(masked)).toBe(true);
    expect(existsSync(leaky)).toBe(true);
    expect(existsSync(conflict)).toBe(true);
    expect(existsSync(good)).toBe(false);
    expect(existsSync(reviewed(h, ['shared'], 'p-4'))).toBe(true);

    // The unmasked value is withheld from the screen; only the pattern name shows.
    expect(r.out).not.toContain('98765');
    expect(r.out).toContain('withheld: they fail the persisted redaction check (phone)');
  });

  test('--json prints a stable summary on stdout and the review on stderr', async () => {
    const h = home();
    seed(h, 'run-a', '****1234');
    seed(h, 'run-b', 'p-2');
    const r = await review(h, ['--json'], { answers: ['y', 'y'] });
    expect(r.code).toBe(EXIT.OK);
    const summary = JSON.parse(r.out);
    expect(summary).toMatchObject({ promoted: 1, unchanged: 0, declined: 0, refused: 1, skipped: 0 });
    expect(summary.items.map((i: { status: string }) => i.status)).toEqual(['refused', 'promoted']);
    expect(summary.items[1].to).toBe(join('fixtures', 'shared', 'sql_select', 'atspl', `${keyHash(key('p-2'))}.json`));
    expect(r.err).toContain('promote? [y/N/skip]');
  });
});

describe('reviewer', () => {
  test('defaults to the OS user name', async () => {
    const h = home();
    seed(h, 'run-a', 'p-1');
    await review(h, [], { answers: ['y'], osUser: () => 'os-name' });
    expect(readJson(reviewed(h, ['shared'], 'p-1')).meta.reviewed_by).toBe('os-name');
  });

  test('without --reviewer or an OS user name it refuses to start', async () => {
    const h = home();
    const source = seed(h, 'run-a', 'p-1');
    const r = await review(h, [], { answers: ['y'], osUser: () => undefined });
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain('--reviewer');
    expect(existsSync(source)).toBe(true);
  });
});

describe('output and paths', () => {
  test('prints kind, entity, key_string and result, and no .env value', async () => {
    const secrets = {
      SLACK_BOT_TOKEN: 'xoxb-fake-seeded-secret-7c1d',
      TRIAGE_HTTP_AUTH_TOKEN: 'fake-bearer-seeded-9e2a',
    };
    const h = home(secrets);
    expect(h.env.SLACK_BOT_TOKEN).toBe(secrets.SLACK_BOT_TOKEN);
    seed(h, 'run-a', 'p-1');
    seed(h, 'run-b', 'p-2');
    const human = await review(h, [], { answers: ['n', 'y'] });
    expect(human.out).toContain('fixture sql_select atspl, run run-a');
    expect(human.out).toContain(`key: ${keyString(key('p-1'))}`);
    expect(human.out).toContain('"status": "SETTLED"');

    seed(h, 'run-c', 'p-3');
    const json = await review(h, ['--json'], { answers: ['y', 'y'] });
    for (const r of [human, json]) {
      for (const value of Object.values(secrets)) {
        expect(r.out).not.toContain(value);
        expect(r.err).not.toContain(value);
      }
    }
  });

  test('works from any cwd because paths resolve through TRIAGE_HOME', async () => {
    const h = home();
    seed(h, 'run-a', 'p-1');
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'triage-review-cwd-')));
    dirs.push(elsewhere);
    const saved = process.cwd();
    process.chdir(elsewhere);
    try {
      const r = await review(h, [], { answers: ['y'] });
      expect(r.code).toBe(EXIT.OK);
    } finally {
      process.chdir(saved);
    }
    expect(existsSync(reviewed(h, ['shared'], 'p-1'))).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe('eval draft cost', () => {
  // A valid ULID with no run of 6+ digits, so the persisted profile leaves it alone.
  const RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH1';

  // Keys that would carry token counts or spend: cost, usd*, *tokens*, at any depth.
  function usageKeys(value: unknown, path = ''): string[] {
    if (Array.isArray(value)) return value.flatMap((item, i) => usageKeys(item, `${path}[${i}]`));
    if (value === null || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([k, item]) => {
      const at = path === '' ? k : `${path}.${k}`;
      return k === 'cost' || k.startsWith('usd') || k.includes('tokens') ? [at] : usageKeys(item, at);
    });
  }

  /** A draft as feedback.ts wrote it before D59: report.json still carries cost. */
  function oldDraft(h: TestHome, runId: string): { dir: string; report: Record<string, unknown> } {
    const dir = join(h.home, 'evals', '_unreviewed', runId);
    mkdirSync(dir, { recursive: true });
    const report = { ...(sampleReport as Record<string, unknown>), run_id: runId };
    writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(dir, 'feedback.md'), '---\nid: x\n---\n');
    return { dir, report };
  }

  test('a draft written by recordFeedback is promoted with no cost, usd or tokens key', async () => {
    const h = home();
    const store = createFolderRunStore({ runsDir: h.config.paths.runsDir, dataDir: h.config.paths.dataDir });
    await store.createRun(RUN, redactPersisted(sampleRequest(RUN)));
    await store.addSubmission(RUN, redactPersisted({ kind: 'initial' as const }));
    const rep: Report = { ...(sampleReport as unknown as Report), run_id: RUN };
    await store.putReport(RUN, 1, redactPersisted(rep), redactPersisted('# report\n'));
    const fb = await recordFeedback(RUN, { verdict: 'correct', given_by: 'reviewer-a', interface: 'cli' }, { store, home: h.home });
    expect(usageKeys(readJson(fb.draft_files!.report_json))).toEqual([]);

    const r = await review(h, [], { answers: ['y'] });
    expect(r.out).toContain('promoted 1, declined 0, refused 0, skipped 0');
    const promoted = join(h.home, 'evals', 'cases', RUN, 'report.json');
    expect(usageKeys(readJson(promoted))).toEqual([]);
    expect(readJson(promoted).run_id).toBe(RUN);
  });

  test('promoting a draft from before the change drops its cost and keeps everything else', async () => {
    const h = home();
    const { dir, report } = oldDraft(h, 'run-old');
    const feedbackBefore = readFileSync(join(dir, 'feedback.md'), 'utf8');
    const r = await review(h, [], { answers: ['y'] });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('promoted 1, declined 0, refused 0, skipped 0');

    const target = join(h.home, 'evals', 'cases', 'run-old');
    const promoted = readJson(join(target, 'report.json'));
    expect(Object.hasOwn(promoted, 'cost')).toBe(false);
    expect(usageKeys(promoted)).toEqual([]);
    const { cost: _cost, ...rest } = report;
    expect(promoted).toEqual(rest);
    expect(readFileSync(join(target, 'feedback.md'), 'utf8')).toBe(feedbackBefore);
    expect(existsSync(dir)).toBe(false);
  });

  test('a declined or skipped draft is left as it was, cost included', async () => {
    const h = home();
    const a = oldDraft(h, 'run-a');
    const b = oldDraft(h, 'run-b');
    const before = [readFileSync(join(a.dir, 'report.json'), 'utf8'), readFileSync(join(b.dir, 'report.json'), 'utf8')];
    const r = await review(h, [], { answers: ['n', 'skip'] });
    expect(r.out).toContain('promoted 0, declined 1, refused 0, skipped 1');
    expect(readFileSync(join(a.dir, 'report.json'), 'utf8')).toBe(before[0] as string);
    expect(readFileSync(join(b.dir, 'report.json'), 'utf8')).toBe(before[1] as string);
    expect(existsSync(join(h.home, 'evals', 'cases'))).toBe(false);
  });

  test('an old draft matches a case already promoted without cost', async () => {
    const h = home();
    const first = oldDraft(h, 'run-a');
    await review(h, [], { answers: ['y'] });
    oldDraft(h, 'run-a');
    const r = await review(h, [], { answers: ['y'] });
    expect(r.out).toContain('already promoted with the same content');
    expect(existsSync(first.dir)).toBe(false);
  });

  test('y on a draft whose report.json is not an object with cost keeps its bytes (not JSON, an array, no cost)', async () => {
    const h = home();
    const cases: [string, string][] = [
      ['array', '[{"cost":1}]'],
      ['no-cost', '{"run_id":"x"}'],
      ['not-json', '{ not json'],
    ];
    for (const [runId, text] of cases) {
      const dir = join(h.home, 'evals', '_unreviewed', runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'report.json'), text);
    }
    const items = (await listUnreviewed(reviewDirsFrom(h.config))) as EvalCaseReviewItem[];
    expect(items.map((i) => i.runId)).toEqual(['array', 'no-cost', 'not-json']);
    await review(h, [], { answers: ['y', 'y', 'y'] });
    // Each is promoted or refused as promote decides; none is rewritten.
    for (const [runId, text] of cases) {
      const moved = join(h.home, 'evals', 'cases', runId, 'report.json');
      const left = join(h.home, 'evals', '_unreviewed', runId, 'report.json');
      expect(readFileSync(existsSync(moved) ? moved : left, 'utf8')).toBe(text);
    }
  });
});
