// Repo sync over HTTP (D47), behind the same bearer auth as every route.
//
//   POST /repos/sync            body {} or {"repo": "<name>"}. Starts a sync in
//                               the background: 202 {sync_id, status: "running"}.
//                               409 when this process is already syncing, 400
//                               for a repo that is not in resources/repos.json.
//   GET  /repos/sync/:sync_id   the sync: running, done, busy (another process
//                               held the lock) or failed, with per-repo results.
//   GET  /repos                 each checkout's branch, commit and drift, the
//                               last sync record and when the next one is due.
//
// A sync id lives in this process's memory only, like a Flue dispatch
// receipt: nothing is written to the database, and a restart forgets it. The
// last MAX_SYNC_JOBS are kept. The sync itself goes through the sync lock and
// record in src/ops/repos-autosync.ts, as `triage repos sync` does.

import { type Context, Hono } from 'hono';
import * as v from 'valibot';
import type { Config } from '../config/env.ts';
import { RepoNameSchema } from '../config/registry.ts';
import type { ExecRunner } from '../connectors/exec.ts';
import { newRunId } from '../ingress/ulid.ts';
import {
  type AutoSyncResult,
  readSyncState,
  syncDue,
  syncInFlight,
  syncNow,
  timerOffReason,
} from '../ops/repos-autosync.ts';
import { type RepoSyncResult, repoStatus, type syncRepos, UnknownRepoError } from '../ops/repos.ts';

export const MAX_SYNC_JOBS = 20;

export type SyncJobStatus = 'running' | 'done' | 'busy' | 'failed';

export type SyncJob = {
  readonly sync_id: string;
  readonly repo: string | null;
  status: SyncJobStatus;
  readonly started_at: string;
  finished_at?: string;
  results?: readonly RepoSyncResult[];
  ok?: readonly string[];
  skipped?: readonly string[];
  failed?: readonly string[];
  /** Why the sync did not run or did not finish. Fixed text or an error class name. */
  reason?: string;
};

export type ReposRouteDeps = {
  readonly config: () => Config;
  readonly runner: () => ExecRunner;
  /** Defaults to Date.now. */
  readonly now?: () => number;
  /** Defaults to a ULID. */
  readonly newId?: () => string;
  /** Replaces syncRepos, for tests. */
  readonly syncRepos?: typeof syncRepos;
};

const SyncBodySchema = v.strictObject({ repo: v.optional(RepoNameSchema) });

export function createReposRoutes(deps: ReposRouteDeps): Hono {
  const app = new Hono();
  const jobs = new Map<string, SyncJob>();
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? newRunId;
  const iso = (): string => new Date(now()).toISOString();

  app.onError((err, c) => {
    console.error(`triage http: ${c.req.method} ${c.req.routePath} failed (${err instanceof Error ? err.name : 'error'})`);
    return c.json({ error: 'internal error' }, 500);
  });

  app.post('/repos/sync', async (c) => {
    const body = await readBody(c);
    if (body === NOT_JSON) return invalid(c, ['body'], 'is not valid JSON');
    const parsed = v.safeParse(SyncBodySchema, body);
    if (!parsed.success) return invalid(c, [v.getDotPath(parsed.issues[0]) ?? 'body']);
    const repo = parsed.output.repo;

    const config = deps.config();
    if (syncInFlight(config)) {
      const running = [...jobs.values()].find((j) => j.status === 'running');
      return c.json({ error: 'a sync is already running', ...(running !== undefined ? { sync_id: running.sync_id } : {}) }, 409);
    }

    let pending: Promise<AutoSyncResult>;
    try {
      pending = syncNow('http', repo !== undefined ? { repo } : {}, {
        config,
        runner: deps.runner(),
        ...(deps.syncRepos !== undefined ? { syncRepos: deps.syncRepos } : {}),
      });
    } catch (err) {
      if (err instanceof UnknownRepoError) return c.json({ error: 'invalid request', fields: ['repo'], valid_repos: err.validNames }, 400);
      throw err;
    }

    const job: SyncJob = { sync_id: newId(), repo: repo ?? null, status: 'running', started_at: iso() };
    remember(jobs, job);
    void pending.then(
      (result) => settle(job, result, iso()),
      (err: unknown) => {
        job.status = 'failed';
        job.reason = err instanceof Error ? err.name : 'error';
        job.finished_at = iso();
      },
    );
    return c.json({ sync_id: job.sync_id, status: job.status }, 202);
  });

  app.get('/repos/sync/:sync_id', (c) => {
    const job = jobs.get(c.req.param('sync_id'));
    if (job === undefined) return c.json({ error: 'sync not found' }, 404);
    return c.json(job);
  });

  app.get('/repos', async (c) => {
    const config = deps.config();
    const dir = config.paths.reposDir;
    const state = dir === undefined || dir.trim() === '' ? undefined : readSyncState(dir);
    const due = syncDue(state, config.repos.syncIntervalMs, now());
    const status = await repoStatus({ config, runner: deps.runner() });
    const timerOff = timerOffReason(config);
    return c.json({
      sync: {
        interval_ms: config.repos.syncIntervalMs,
        interfaces: config.repos.syncInterfaces,
        timer: timerOff === undefined ? { on: true } : { on: false, reason: timerOff },
        running: syncInFlight(config),
        last: state ?? null,
        due: due.due,
        ...(due.due ? {} : { next_at: due.next_at }),
      },
      ...(status.status === 'ok' ? { repos: status.repos } : { repos: [], not_configured: { key: status.key, message: status.message } }),
    });
  });

  return app;
}

function settle(job: SyncJob, result: AutoSyncResult, at: string): void {
  job.finished_at = at;
  switch (result.status) {
    case 'synced': {
      const report = result.report;
      if (report.status !== 'done') {
        job.status = 'failed';
        job.reason = report.message;
        return;
      }
      job.status = 'done';
      job.results = report.results;
      job.ok = report.ok;
      job.skipped = report.skipped;
      job.failed = report.failed;
      return;
    }
    case 'busy':
      job.status = 'busy';
      job.reason = result.reason;
      return;
    case 'not_configured':
      job.status = 'failed';
      job.reason = result.message;
      return;
    case 'not_due':
      // syncNow never checks the interval; kept for completeness.
      job.status = 'done';
      return;
  }
}

/** Keeps the newest MAX_SYNC_JOBS; a running job is never dropped. */
function remember(jobs: Map<string, SyncJob>, job: SyncJob): void {
  jobs.set(job.sync_id, job);
  for (const [id, old] of jobs) {
    if (jobs.size <= MAX_SYNC_JOBS) break;
    if (old.status !== 'running') jobs.delete(id);
  }
}

const NOT_JSON = Symbol('not json');

/** An empty body is {}. */
async function readBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function invalid(c: Context, fields: readonly string[], reason?: string): Response {
  return c.json({ error: 'invalid request', fields, ...(reason !== undefined ? { reason } : {}) }, 400);
}
