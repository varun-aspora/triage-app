// triage runs prune [--json]
//
// Applies TRIAGE_RUNS_RETENTION_DAYS once: deletes runs created before the
// window and clears expired idempotency claims (D43). Flue has no scheduler,
// so an operator or an external cron runs this; the HTTP server also prunes
// on a daily timer. Blank retention deletes no run.

import type { Config } from '../../config/env.ts';
import { createRunStore } from '../../runstore/index.ts';
import { pruneExpired } from '../../runstore/retention.ts';
import type { RunStore } from '../../runstore/types.ts';
import { EXIT, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export type RunsPruneOptions = {
  /** Builds the run store. Defaults to createRunStore(config). */
  readonly openStore?: (config: Config) => Promise<RunStore>;
  /** Epoch milliseconds. Tests pass a fake clock. */
  readonly now?: () => number;
};

export function createRunsPruneCommand(options: RunsPruneOptions = {}): CliCommand {
  const openStore = options.openStore ?? ((config: Config) => createRunStore(config));
  const now = options.now ?? Date.now;
  return {
    path: ['runs', 'prune'],
    summary: 'delete runs older than TRIAGE_RUNS_RETENTION_DAYS and clear expired idempotency keys',
    configure(cmd) {
      cmd.option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { opts }) {
      const { io } = ctx;
      const config = ctx.config();
      const store = await openStore(config);
      const result = await pruneExpired(store, config, now());

      if (opts.json) {
        printJson(io, { deleted: result.deleted, idempotency_cleared: result.idempotency_cleared });
      } else {
        const runsLine =
          result.retention_days === null
            ? 'retention is off (TRIAGE_RUNS_RETENTION_DAYS is blank); no runs deleted'
            : `deleted ${result.deleted} run(s) created before ${result.cutoff} (${result.retention_days} day window)`;
        printHuman(io, [runsLine, `cleared ${result.idempotency_cleared} expired idempotency key(s)`]);
      }
      return EXIT.OK;
    },
  };
}

export const command: CliCommand = createRunsPruneCommand();
