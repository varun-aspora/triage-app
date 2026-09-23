// triage repos sync [--repo <name>] [--json]
//
// Brings each pin in resources/repos.json (or the one named) to its pinned
// branch and refreshes its codegraph index (D37, T11.4). Prints one line per
// repo; a repo's warnings are on its line. Exits 1 when any repo failed, when --repo
// names an unknown repo (the message lists the valid names) or when
// TRIAGE_REPOS_DIR is blank.
//
// --json prints {results, ok, skipped, failed}, or {results: [],
// not_configured: {key, message}} when TRIAGE_REPOS_DIR is blank.
//
// Real wiring: the ExecRunner for git and codegraph. Tests pass a fake.

import { createExecRunner, type ExecRunner } from '../../connectors/exec.ts';
import { UnknownRepoError, syncRepos, type ReposDeps, type SyncReport } from '../../ops/repos.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export type ReposSyncCommandOptions = {
  /** Defaults to the real ExecRunner. */
  readonly runner?: ExecRunner;
  /** Replaces syncRepos. */
  readonly sync?: typeof syncRepos;
  /** Extra deps such as a repos list or a clock. */
  readonly deps?: Partial<Omit<ReposDeps, 'config' | 'runner'>>;
};

function exitCode(report: SyncReport): number {
  if (report.status !== 'done') return EXIT.ERROR;
  return report.failed.length > 0 ? EXIT.ERROR : EXIT.OK;
}

export function createReposSyncCommand(options: ReposSyncCommandOptions = {}): CliCommand {
  const sync = options.sync ?? syncRepos;
  return {
    path: ['repos', 'sync'],
    summary: 'check out the branches pinned in resources/repos.json and refresh codegraph indexes',
    configure(cmd) {
      cmd.option('--repo <name>', 'sync only this repo from resources/repos.json').option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { opts }) {
      const { io } = ctx;
      const repo = typeof opts.repo === 'string' ? opts.repo : undefined;
      let report: SyncReport;
      try {
        report = await sync(repo !== undefined ? { repo } : {}, {
          ...options.deps,
          config: ctx.config(),
          runner: options.runner ?? createExecRunner(),
        });
      } catch (err) {
        if (!(err instanceof UnknownRepoError)) throw err;
        // The message lists the valid names and never echoes the value given.
        printError(io, opts.json, 'ERROR', err.message);
        return EXIT.ERROR;
      }

      if (report.status !== 'done') {
        if (opts.json) printJson(io, { results: [], not_configured: { key: report.key, message: report.message } });
        else printHuman(io, report.message);
        return exitCode(report);
      }
      if (opts.json) {
        printJson(io, { results: report.results, ok: report.ok, skipped: report.skipped, failed: report.failed });
      } else {
        printHuman(io, report.results.length === 0 ? ['no repos pinned in resources/repos.json'] : report.results.map((r) => r.line));
      }
      return exitCode(report);
    },
  };
}

export const command: CliCommand = createReposSyncCommand();
