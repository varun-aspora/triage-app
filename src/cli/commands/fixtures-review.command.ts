// triage fixtures review [--case <case_id>] [--reviewer <name>]
//
// Walks every item under fixtures/_unreviewed/ and evals/_unreviewed/, shows
// it and asks 'promote? [y/N/skip]'. y promotes, N or an empty answer
// declines (the item stays in _unreviewed/), skip moves on without a
// decision. Promotion needs a human reading each item (D27, D42), so the
// command refuses to run when stdin is not a terminal.
//
// Fixture files under _unreviewed/ were written through the persisted
// redaction profile by the recorder. The key and result are checked again
// before they are printed, and withheld with pattern names only if the check
// fails, so a hand-edited file cannot put raw ids on the screen. Config is
// never printed. Paths come from TRIAGE_HOME, never from the cwd.

import { userInfo } from 'node:os';
import { relative } from 'node:path';
import { createInterface } from 'node:readline';
import { checkEgress } from '../../gate/redact.ts';
import {
  decline,
  listUnreviewed,
  promote,
  reviewDirsFrom,
  type PromoteResult,
  type ReviewItem,
} from '../../mock/promote.ts';
import { UNREVIEWED_DIR } from '../../mock/store.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import type { CliCommand, CliContext, CliIo } from '../types.ts';

/** Asks one question and resolves to the answer line, or null when input has ended. */
export type ReviewPrompt = {
  ask(question: string): Promise<string | null>;
  close(): void;
};

export type FixturesReviewOptions = {
  /** Builds the prompt. The default reads lines from ctx.io.stdin. */
  readonly prompt?: (io: CliIo, write: (text: string) => void) => ReviewPrompt;
  /** The OS user name used when --reviewer is not given. */
  readonly osUser?: () => string | undefined;
};

export type Decision = 'promote' | 'decline' | 'skip';

type Outcome =
  | { readonly status: 'promoted' | 'unchanged'; readonly to: string }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'declined' }
  | { readonly status: 'skipped' };

type Counts = { promoted: number; unchanged: number; declined: number; refused: number; skipped: number };

// Same rule as src/mock/promote.ts, checked up front so a bad id is a usage error
// instead of one refusal per item.
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const QUESTION = 'promote? [y/N/skip] ';

/** Maps an answer to a decision, or null when it is not one of the choices. */
export function parseAnswer(answer: string): Decision | null {
  const a = answer.trim().toLowerCase();
  if (a === 'y' || a === 'yes') return 'promote';
  if (a === '' || a === 'n' || a === 'no') return 'decline';
  if (a === 's' || a === 'skip') return 'skip';
  return null;
}

export function createFixturesReviewCommand(options: FixturesReviewOptions = {}): CliCommand {
  const makePrompt = options.prompt ?? linePrompt;
  const osUser = options.osUser ?? defaultOsUser;

  return {
    path: ['fixtures', 'review'],
    summary: 'review fixtures and eval case drafts in _unreviewed/ and promote the ones you have read',
    configure(cmd) {
      cmd
        .option('--case <case_id>', 'promote fixtures to fixtures/cases/<case_id>/ and eval drafts to evals/cases/<case_id>/')
        .option('--reviewer <name>', 'name stamped as reviewed_by (default: the OS user name)');
    },
    async run(ctx, { opts }) {
      const { io } = ctx;
      const json = opts.json;
      if (!io.isTTY) {
        printError(
          io,
          json,
          'USAGE',
          'fixtures review needs an interactive terminal: each item must be read by a human before it is promoted. Run it from a shell, not a pipe or a coding agent.',
        );
        return EXIT.USAGE;
      }

      const caseId = optionalString(opts.case);
      if (caseId !== undefined && (!CASE_ID.test(caseId) || caseId === UNREVIEWED_DIR)) {
        printError(io, json, 'USAGE', '--case must match [A-Za-z0-9][A-Za-z0-9_.-]* (at most 128 characters)');
        return EXIT.USAGE;
      }
      const reviewer = optionalString(opts.reviewer) ?? optionalString(osUser());
      if (reviewer === undefined) {
        printError(io, json, 'USAGE', 'no reviewer name: pass --reviewer <name>');
        return EXIT.USAGE;
      }

      const config = ctx.config();
      const home = config.home;
      const items = await listUnreviewed(reviewDirsFrom(config));

      // Under --json, stdout carries only the final summary; the review itself goes to stderr.
      const write = json ? (text: string) => void io.stderr.write(text) : (text: string) => void io.stdout.write(text);
      const say = (lines: string | readonly string[]): void => printHuman({ stdout: { write } }, lines);

      const counts: Counts = { promoted: 0, unchanged: 0, declined: 0, refused: 0, skipped: 0 };
      const report: Record<string, unknown>[] = [];

      if (items.length === 0) {
        say('nothing to review');
      } else {
        say(`${items.length} item(s) to review as ${reviewer}${caseId !== undefined ? `, case ${caseId}` : ''}`);
        const prompt = makePrompt(io, write);
        try {
          let ended = false;
          for (const [index, item] of items.entries()) {
            let outcome: Outcome;
            if (ended) {
              outcome = { status: 'skipped' };
            } else {
              say('');
              say(describeItem(item, index, items.length, home));
              const decision = await ask(prompt, say);
              if (decision === null) {
                ended = true;
                say('input ended; the remaining items are left for a later review');
                outcome = { status: 'skipped' };
              } else {
                outcome = await apply(item, decision, reviewer, caseId);
                say(`  ${outcomeText(outcome, home)}`);
              }
            }
            counts[outcome.status]++;
            report.push(reportEntry(item, outcome, home));
          }
        } finally {
          prompt.close();
        }
      }

      const summary =
        `promoted ${counts.promoted}, declined ${counts.declined}, refused ${counts.refused}, skipped ${counts.skipped}` +
        (counts.unchanged > 0 ? `, already promoted ${counts.unchanged}` : '');
      if (json) {
        say(summary);
        printJson(io, { ...counts, items: report });
      } else {
        say(['', summary]);
        if (counts.promoted > 0) say('promoted files are not committed; review the diff and commit them yourself');
      }
      return EXIT.OK;
    },
  };
}

export const command: CliCommand = createFixturesReviewCommand();

// ------------------------------------------------------------------ steps

async function ask(prompt: ReviewPrompt, say: (line: string) => void): Promise<Decision | null> {
  for (;;) {
    const answer = await prompt.ask(QUESTION);
    if (answer === null) return null;
    const decision = parseAnswer(answer);
    if (decision !== null) return decision;
    say('  answer y, n (or empty) or skip');
  }
}

async function apply(item: ReviewItem, decision: Decision, reviewer: string, caseId: string | undefined): Promise<Outcome> {
  if (decision === 'skip') return { status: 'skipped' };
  if (decision === 'decline') {
    decline(item);
    return { status: 'declined' };
  }
  const result: PromoteResult = await promote(item, caseId !== undefined ? { reviewer, caseId } : { reviewer });
  if (result.status === 'refused') return { status: 'refused', reason: result.reason };
  return { status: result.status, to: result.to };
}

function describeItem(item: ReviewItem, index: number, total: number, home: string): string[] {
  const head = `[${index + 1}/${total}]`;
  if (item.type === 'eval_case') {
    return [
      `${head} eval case draft, run ${item.runId}`,
      `  folder: ${rel(home, item.path)}`,
      `  files: ${item.files.length > 0 ? item.files.join(', ') : '(none)'}`,
      '  open the files in the folder and read them before answering',
    ];
  }
  const lines = [`${head} fixture ${item.kind} ${item.entity}, run ${item.runId}`, `  file: ${rel(home, item.path)}`];
  const f = item.fixture;
  if (f !== null) {
    const shown = { key_string: f.key_string, result: f.result };
    const checked = checkEgress(shown);
    if (checked.ok) {
      lines.push(`  key: ${f.key_string}`, '  result:', ...indent(JSON.stringify(f.result, null, 2), '    '));
    } else {
      lines.push(`  key and result withheld: they fail the persisted redaction check (${checked.unmasked.join(', ')})`);
    }
  }
  if (item.problem !== undefined) lines.push(`  problem: ${item.problem}`);
  return lines;
}

function outcomeText(outcome: Outcome, home: string): string {
  switch (outcome.status) {
    case 'promoted':
      return `promoted to ${rel(home, outcome.to)}`;
    case 'unchanged':
      return `already promoted with the same content at ${rel(home, outcome.to)}; removed the unreviewed copy`;
    case 'refused':
      return `refused: ${outcome.reason}`;
    case 'declined':
      return `declined; left in ${UNREVIEWED_DIR}/`;
    case 'skipped':
      return 'skipped';
  }
}

function reportEntry(item: ReviewItem, outcome: Outcome, home: string): Record<string, unknown> {
  const base: Record<string, unknown> = { type: item.type, run_id: item.runId, path: rel(home, item.path) };
  if (item.type === 'fixture') {
    base.kind = item.kind;
    base.entity = item.entity;
  }
  base.status = outcome.status;
  if (outcome.status === 'promoted' || outcome.status === 'unchanged') base.to = rel(home, outcome.to);
  if (outcome.status === 'refused') base.reason = outcome.reason;
  return base;
}

// ------------------------------------------------------------------ helpers

/** The default prompt: one line of ctx.io.stdin per question. */
function linePrompt(io: CliIo, write: (text: string) => void): ReviewPrompt {
  const rl = createInterface({ input: io.stdin, crlfDelay: Infinity, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question) {
      write(question);
      const next = await lines.next();
      return next.done === true ? null : String(next.value);
    },
    close() {
      rl.close();
    },
  };
}

function defaultOsUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function rel(home: string, path: string): string {
  const r = relative(home, path);
  return r === '' || r.startsWith('..') ? path : r;
}

function indent(text: string, pad: string): string[] {
  return text.split('\n').map((line) => `${pad}${line}`);
}
