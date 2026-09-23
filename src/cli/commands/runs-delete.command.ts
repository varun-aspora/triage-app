// triage runs delete <run_id> [--json]
//
// Removes one run from the configured run store (folder or postgres) and
// prints what the erasure does not reach: Flue's conversation stream, the
// global audit log and other runs that got this run as a prior case (D43).
// An unknown run id exits non-zero with 'run not found' and deletes nothing.

import * as v from 'valibot';
import type { Config } from '../../config/env.ts';
import { createRunStore } from '../../runstore/index.ts';
import { eraseRun } from '../../runstore/retention.ts';
import { RunNotFoundError, type RunStore } from '../../runstore/types.ts';
import { RunIdSchema } from '../../types/core.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export type RunsDeleteOptions = {
  /** Builds the run store. Defaults to createRunStore(config). */
  readonly openStore?: (config: Config) => Promise<RunStore>;
};

export function createRunsDeleteCommand(options: RunsDeleteOptions = {}): CliCommand {
  const openStore = options.openStore ?? ((config: Config) => createRunStore(config));
  return {
    path: ['runs', 'delete'],
    summary: 'delete one run from the run store (Flue stream and audit log are not reached)',
    configure(cmd) {
      cmd.argument('<run_id>', 'the run to delete').option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;
      const runId = args[0];
      if (typeof runId !== 'string' || !v.is(RunIdSchema, runId)) {
        printError(io, json, 'USAGE', 'run_id must be 1 to 64 letters, digits, _ or -');
        return EXIT.USAGE;
      }

      const store = await openStore(ctx.config());
      let result;
      try {
        result = await eraseRun(store, runId);
      } catch (err) {
        if (err instanceof RunNotFoundError) {
          printError(io, json, 'ERROR', `run not found: ${runId}`);
          return EXIT.ERROR;
        }
        throw err;
      }

      if (json) {
        printJson(io, result);
      } else {
        printHuman(io, [
          `deleted run ${result.run_id} from the ${result.provider} run store`,
          'not reached by this delete:',
          ...result.not_reached.map((line) => `  - ${line}`),
        ]);
      }
      return EXIT.OK;
    },
  };
}

export const command: CliCommand = createRunsDeleteCommand();
