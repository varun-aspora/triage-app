// triage doctor [--json] [--sort-by entity|check] [--check <id>...] [--errors-only]
//               [--list-checks]
//
// Runs the config checks, the probe checks and the mounted tools check
// (HLD §7 Doctor) and prints the table, or {checks, counts} with --json. Exit
// code is 1 when any row is fail, else 0. Rows name env keys, never values.
// --sort-by entity (the default) puts rows with no entity first, then ssfb,
// atspl, rtl; --sort-by check groups rows by check. --check runs only the
// named checks; it repeats and takes a comma-separated list. --list-checks
// prints the check ids and runs nothing. --errors-only leaves out the ok rows;
// the counts and the exit code still cover every row.
//
// The run itself, with its real deps, is doctorReport in src/ops/doctor/report.ts,
// shared with GET /doctor. Tests pass fakes through `deps`.

import { Option } from 'commander';
import type { Config } from '../../config/env.ts';
import { DOCTOR_CHECKS, doctorReport, type DoctorDeps } from '../../ops/doctor/report.ts';
import { DOCTOR_SORTS, doctorCheckIds, doctorExitCode, renderDoctorTable, type DoctorSort } from '../../ops/doctor/run.ts';
import type { CheckInput } from '../../ops/doctor/types.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export { DOCTOR_CHECKS, type DoctorDeps };

export type DoctorCommandOptions = {
  /** Checks to run. Defaults to DOCTOR_CHECKS. */
  readonly checks?: readonly CheckInput[];
  /** Replaces fields of the default context (runner, probes, ops, embedder, ...). */
  readonly deps?: (config: Config) => DoctorDeps;
};

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(',').map((v) => v.trim()).filter((v) => v !== '')];
}

export function createDoctorCommand(options: DoctorCommandOptions = {}): CliCommand {
  const checks = options.checks ?? DOCTOR_CHECKS;
  return {
    path: ['doctor'],
    summary: 'check config, reachability and mounted tools; never reads customer data',
    configure(cmd) {
      cmd.option('--json', 'print machine-readable JSON');
      cmd.addOption(new Option('--sort-by <order>', 'row order: by entity, or grouped by check').choices(DOCTOR_SORTS).default('entity'));
      cmd.option('--errors-only', 'print only the rows that are not ok');
      cmd.option('--list-checks', 'print the check ids and run nothing');
      cmd.option('--check <id>', `run only this check, repeatable or comma-separated: ${doctorCheckIds(checks).join(', ')}`, collect);
    },
    async run(ctx, { opts }) {
      if (opts.listChecks === true) {
        const ids = doctorCheckIds(checks);
        if (opts.json) printJson(ctx.io, { checks: ids });
        else printHuman(ctx.io, ids);
        return EXIT.OK;
      }
      const only = opts.check as string[] | undefined;
      if (only !== undefined) {
        const known = doctorCheckIds(checks);
        const unknown = only.filter((id) => !known.includes(id));
        if (unknown.length > 0 || only.length === 0) {
          const what = unknown.length > 0 ? `unknown check ${unknown.join(', ')}` : 'no check named';
          printError(ctx.io, opts.json, 'USAGE', `--check: ${what}; choose from ${known.join(', ')}`);
          return EXIT.USAGE;
        }
      }
      const report = await doctorReport(ctx.config(), {
        checks,
        ...(options.deps !== undefined ? { deps: options.deps } : {}),
        sortBy: opts.sortBy as DoctorSort,
        ...(only !== undefined ? { only } : {}),
      });
      const shown = opts.errorsOnly === true ? { ...report, checks: report.checks.filter((c) => c.status !== 'ok') } : report;
      if (opts.json) printJson(ctx.io, { checks: shown.checks, counts: shown.counts });
      else printHuman(ctx.io, renderDoctorTable(shown).trimEnd().split('\n'));
      return doctorExitCode(report) === 1 ? EXIT.ERROR : EXIT.OK;
    },
  };
}

export const command: CliCommand = createDoctorCommand();
