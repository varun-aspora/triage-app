// triage repos sync [--repo <name>] [--if-stale] [--json]
//
// Brings each pin in resources/repos.json (or the one named) to its pinned
// branch and refreshes its codegraph index (D37, T11.4). Prints one line per
// repo; a repo's warnings are on its line. Exits 1 when any repo failed, when --repo
// names an unknown repo (the message lists the valid names), when
// TRIAGE_REPOS_DIR is blank or when another process is syncing.
//
// It takes the sync lock (D47), so it never runs beside the server's timer or
// a run's sync, and a full sync is recorded in
// <TRIAGE_REPOS_DIR>/.triage-sync.json, which the timer and runs read.
// --if-stale syncs only when the last good sync is older than
// TRIAGE_REPOS_SYNC_INTERVAL, for cron or launchd; it syncs every repo, so it
// does not take --repo.
//
// --json prints {results, ok, skipped, failed}; {results: [], not_configured:
// {key, message}} when TRIAGE_REPOS_DIR is blank; {results: [], not_due:
// {reason, next_at, last_ok_at}} when --if-stale found nothing due; and
// {results: [], busy: {reason}} when another process holds the lock.
//
// Real wiring: the ExecRunner for git and codegraph. Tests pass a fake.

import { createExecRunner, type ExecRunner } from '../../connectors/exec.ts';
import { type AutoSyncDeps, type AutoSyncResult, syncIfDue, syncNow } from '../../ops/repos-autosync.ts';
import { UnknownRepoError, syncRepos, type SyncReport } from '../../ops/repos.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export type ReposSyncCommandOptions = {
  /** Defaults to the real ExecRunner. */
  readonly runner?: ExecRunner;
  /** Replaces syncRepos. */
  readonly sync?: typeof syncRepos;
  /** Extra deps such as a repos list or a clock. */
  readonly deps?: Partial<Omit<AutoSyncDeps, 'config' | 'runner' | 'syncRepos'>>;
};

function exitCode(report: SyncReport): number {
  if (report.status !== 'done') return EXIT.ERROR;
  return report.failed.length > 0 ? EXIT.ERROR : EXIT.OK;
}

export function createReposSyncCommand(options: ReposSyncCommandOptions = {}): CliCommand {
  return {
    path: ['repos', 'sync'],
    summary: 'check out the branches pinned in resources/repos.json and refresh codegraph indexes',
    configure(cmd) {
      cmd
        .option('--repo <name>', 'sync only this repo from resources/repos.json')
        .option('--if-stale', 'sync only when the last good sync is older than TRIAGE_REPOS_SYNC_INTERVAL')
        .option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { opts }) {
      const { io } = ctx;
      const repo = typeof opts.repo === 'string' ? opts.repo : undefined;
      const ifStale = opts.ifStale === true;
      if (ifStale && repo !== undefined) {
        printError(io, opts.json, 'USAGE', '--if-stale syncs every repo; leave out --repo');
        return EXIT.USAGE;
      }
      const deps: AutoSyncDeps = {
        ...options.deps,
        config: ctx.config(),
        runner: options.runner ?? createExecRunner(),
        ...(options.sync !== undefined ? { syncRepos: options.sync } : {}),
      };
      let result: AutoSyncResult;
      try {
        result = ifStale ? await syncIfDue('cli', deps) : await syncNow('cli', repo !== undefined ? { repo } : {}, deps);
      } catch (err) {
        if (!(err instanceof UnknownRepoError)) throw err;
        // The message lists the valid names and never echoes the value given.
        printError(io, opts.json, 'ERROR', err.message);
        return EXIT.ERROR;
      }

      switch (result.status) {
        case 'not_configured':
          if (opts.json) printJson(io, { results: [], not_configured: { key: result.key, message: result.message } });
          else printHuman(io, result.message);
          return EXIT.ERROR;
        case 'busy':
          if (opts.json) printJson(io, { results: [], busy: { reason: result.reason } });
          else printHuman(io, `not synced: ${result.reason}`);
          return EXIT.ERROR;
        case 'not_due': {
          const last = result.state?.last_ok_at ?? null;
          if (opts.json) {
            printJson(io, { results: [], not_due: { reason: result.due.reason, next_at: result.due.next_at, last_ok_at: last } });
          } else if (result.due.reason === 'fresh') {
            printHuman(io, `repos are up to date: last synced ${last ?? 'never'}; next sync after ${result.due.next_at}`);
          } else {
            printHuman(io, `the last sync failed at ${result.state?.last_attempt_at ?? 'an unknown time'}; next try after ${result.due.next_at}`);
          }
          return EXIT.OK;
        }
        case 'synced': {
          const report = result.report;
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
        }
      }
    },
  };
}

export const command: CliCommand = createReposSyncCommand();
