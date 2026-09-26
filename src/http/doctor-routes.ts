// Doctor over HTTP, behind the same bearer auth as every route.
//
//   GET /doctor   runs the doctor checks against this server's config and
//                 answers 200 {checks, counts}, the shape of `triage doctor
//                 --json`, fail rows included: read counts.fail. Query:
//                   check=<id>[,<id>...]  run only these checks; repeatable
//                   errors_only=true      leave out the ok rows; counts still
//                                         cover every row
//                   sort_by=entity|check  row order, entity by default
//                 400 for an unknown check or a bad value.
//
// A run opens SQL pools and calls Quickwit and the embedding endpoint, so
// requests that arrive while the same run is going share it instead of
// starting another. Rows name env keys, never values, and no customer data
// is read. Preflight is not served here: in server mode it is a subset of
// these probes, and in local mode it would start the tunnel and logins.

import { type Context, Hono } from 'hono';
import type { Config } from '../config/env.ts';
import { DOCTOR_CHECKS, doctorReport, type DoctorReportOptions } from '../ops/doctor/report.ts';
import { DOCTOR_SORTS, doctorCheckIds, type DoctorSort } from '../ops/doctor/run.ts';
import type { CheckInput, DoctorReport } from '../ops/doctor/types.ts';
import { internalError } from './internal-error.ts';

export type DoctorRouteDeps = {
  readonly config: () => Config;
  /** Checks to run. Defaults to DOCTOR_CHECKS. */
  readonly checks?: readonly CheckInput[];
  /** Replaces doctorReport, for tests. */
  readonly report?: (config: Config, options: DoctorReportOptions) => Promise<DoctorReport>;
};

export function createDoctorRoutes(deps: DoctorRouteDeps): Hono {
  const app = new Hono();
  const checks = deps.checks ?? DOCTOR_CHECKS;
  const report = deps.report ?? doctorReport;
  const known = doctorCheckIds(checks);
  const inFlight = new Map<string, Promise<DoctorReport>>();

  app.onError(internalError);

  app.get('/doctor', async (c) => {
    const raw = c.req.queries('check');
    const only = raw?.flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');
    if (only !== undefined) {
      const unknown = only.filter((id) => !known.includes(id));
      if (unknown.length > 0 || only.length === 0) return c.json({ error: 'invalid request', fields: ['check'], valid_checks: known }, 400);
    }
    const errorsOnly = c.req.query('errors_only');
    if (errorsOnly !== undefined && errorsOnly !== 'true' && errorsOnly !== 'false') return invalid(c, ['errors_only'], 'is not true or false');
    const sortBy = c.req.query('sort_by') ?? 'entity';
    if (!(DOCTOR_SORTS as readonly string[]).includes(sortBy)) return invalid(c, ['sort_by'], `is not one of ${DOCTOR_SORTS.join(', ')}`);

    const options: DoctorReportOptions = { checks, sortBy: sortBy as DoctorSort, ...(only !== undefined ? { only: [...new Set(only)].sort() } : {}) };
    const key = JSON.stringify([options.sortBy, options.only ?? null]);
    let running = inFlight.get(key);
    if (running === undefined) {
      running = report(deps.config(), options).finally(() => inFlight.delete(key));
      inFlight.set(key, running);
    }
    const result = await running;
    const rows = errorsOnly === 'true' ? result.checks.filter((r) => r.status !== 'ok') : result.checks;
    return c.json({ checks: rows, counts: result.counts });
  });

  return app;
}

function invalid(c: Context, fields: readonly string[], reason: string): Response {
  return c.json({ error: 'invalid request', fields, reason }, 400);
}
