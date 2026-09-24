import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeRunner } from '../connectors/exec-fake.ts';
import { SYNC_LOCK_DIR, SYNC_STATE_FILE } from '../ops/repos-autosync.ts';
import type { SyncReport } from '../ops/repos.ts';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { createReposRoutes, MAX_SYNC_JOBS, type ReposRouteDeps } from './repos-routes.ts';

let home: TestHome;
let reposDir: string;

beforeEach(() => {
  reposDir = realpathSync(mkdtempSync(join(tmpdir(), 'triage-repos-http-')));
  home = makeTestHome({ overrides: { TRIAGE_REPOS_DIR: reposDir } });
});

afterEach(() => {
  home.cleanup();
  rmSync(reposDir, { recursive: true, force: true });
});

const DONE: SyncReport = {
  status: 'done',
  results: [{ repo: 'harbor', status: 'ok', action: 'updated', branch: 'main', warnings: [], line: 'harbor: ok' }],
  ok: ['harbor'],
  skipped: [],
  failed: [],
};

function routes(over: Partial<ReposRouteDeps> = {}) {
  let n = 0;
  return createReposRoutes({
    config: () => home.config,
    runner: () => createFakeRunner([]),
    newId: () => `sync-${++n}`,
    syncRepos: async () => DONE,
    ...over,
  });
}

/** A syncRepos that waits until release() is called. */
function gated() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const seen: unknown[] = [];
  return {
    seen,
    release: () => release(),
    syncRepos: async (sel: unknown) => {
      seen.push(sel);
      await gate;
      return DONE;
    },
  };
}

const post = (body?: string) => ({ method: 'POST', ...(body !== undefined ? { body, headers: { 'content-type': 'application/json' } } : {}) });

async function settled(app: ReturnType<typeof routes>, id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const job = (await (await app.request(`/repos/sync/${id}`)).json()) as Record<string, unknown>;
    if (job['status'] !== 'running') return job;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('the sync did not settle');
}

describe('POST /repos/sync', () => {
  test('starts a sync in the background and GET shows it running, then done', async () => {
    const g = gated();
    const app = routes({ syncRepos: g.syncRepos as ReposRouteDeps['syncRepos'] });
    const res = await app.request('/repos/sync', post('{}'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sync_id: 'sync-1', status: 'running' });

    const running = (await (await app.request('/repos/sync/sync-1')).json()) as Record<string, unknown>;
    expect(running).toMatchObject({ sync_id: 'sync-1', repo: null, status: 'running' });

    g.release();
    const job = await settled(app, 'sync-1');
    expect(job).toMatchObject({ status: 'done', ok: ['harbor'], failed: [], skipped: [] });
    expect(typeof job['finished_at']).toBe('string');
    expect(g.seen).toEqual([{}]);
  });

  test('an empty body is a full sync; {"repo"} syncs one pinned repo', async () => {
    const g = gated();
    g.release();
    const app = routes({ syncRepos: g.syncRepos as ReposRouteDeps['syncRepos'] });
    expect((await app.request('/repos/sync', post())).status).toBe(202);
    await settled(app, 'sync-1');
    const one = await app.request('/repos/sync', post('{"repo":"harbor"}'));
    expect(one.status).toBe(202);
    const job = await settled(app, 'sync-2');
    expect(job['repo']).toBe('harbor');
    expect(g.seen).toEqual([{}, { repo: 'harbor' }]);
  });

  test('a second sync while one runs is 409 with the running id', async () => {
    const g = gated();
    const app = routes({ syncRepos: g.syncRepos as ReposRouteDeps['syncRepos'] });
    await app.request('/repos/sync', post('{}'));
    const again = await app.request('/repos/sync', post('{}'));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'a sync is already running', sync_id: 'sync-1' });
    g.release();
    await settled(app, 'sync-1');
  });

  test('a repo outside resources/repos.json is 400 with the valid names; a bad name or body is 400', async () => {
    const app = routes();
    const unknown = await app.request('/repos/sync', post('{"repo":"no-such-repo"}'));
    expect(unknown.status).toBe(400);
    const body = (await unknown.json()) as { fields: string[]; valid_repos: string[] };
    expect(body.fields).toEqual(['repo']);
    expect(body.valid_repos).toContain('harbor');
    expect(JSON.stringify(body)).not.toContain('no-such-repo');

    expect((await app.request('/repos/sync', post('{"repo":"../x"}'))).status).toBe(400);
    expect((await app.request('/repos/sync', post('{"branch":"main"}'))).status).toBe(400);
    const notJson = await app.request('/repos/sync', post('{nope'));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'invalid request', fields: ['body'], reason: 'is not valid JSON' });
  });

  test('a lock held by another process ends the sync as busy', async () => {
    mkdirSync(join(reposDir, SYNC_LOCK_DIR));
    writeFileSync(
      join(reposDir, SYNC_LOCK_DIR, 'owner.json'),
      JSON.stringify({ pid: process.pid, token: 'other', started_at: new Date().toISOString() }),
    );
    const app = routes();
    expect((await app.request('/repos/sync', post('{}'))).status).toBe(202);
    expect(await settled(app, 'sync-1')).toMatchObject({ status: 'busy', reason: 'another process is syncing the repos' });
  });

  test(`keeps the last ${MAX_SYNC_JOBS} syncs in memory`, async () => {
    const app = routes();
    for (let i = 1; i <= MAX_SYNC_JOBS + 2; i++) {
      expect((await app.request('/repos/sync', post('{}'))).status).toBe(202);
      await settled(app, `sync-${i}`);
    }
    expect((await app.request('/repos/sync/sync-1')).status).toBe(404);
    expect((await app.request('/repos/sync/sync-2')).status).toBe(404);
    expect((await app.request(`/repos/sync/sync-${MAX_SYNC_JOBS + 2}`)).status).toBe(200);
  });

  test('an unknown sync id is 404', async () => {
    const res = await routes().request('/repos/sync/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'sync not found' });
  });
});

describe('GET /repos', () => {
  test('shows the sync settings, no record yet and each pin as not checked out', async () => {
    const res = await routes().request('/repos');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sync: Record<string, unknown>;
      repos: { repo: string; present: boolean }[];
    };
    expect(body.sync).toEqual({
      interval_ms: 24 * 60 * 60 * 1000,
      interfaces: ['cli', 'http', 'claude-code', 'slack'],
      timer: { on: false, reason: 'mock mode' },
      running: false,
      last: null,
      due: true,
    });
    expect(body.repos.find((r) => r.repo === 'harbor')).toMatchObject({ present: false });
  });

  test('after a sync, shows the record and when the next one is due', async () => {
    const app = routes();
    await app.request('/repos/sync', post('{}'));
    await settled(app, 'sync-1');
    const body = (await (await app.request('/repos')).json()) as { sync: { last: Record<string, unknown>; due: boolean; next_at: string } };
    expect(body.sync.last).toMatchObject({ trigger: 'http', ok: ['harbor'] });
    expect(body.sync.due).toBe(false);
    expect(typeof body.sync.next_at).toBe('string');
    expect(existsSync(join(reposDir, SYNC_STATE_FILE))).toBe(true);
  });

  test('a blank TRIAGE_REPOS_DIR says not configured', async () => {
    const blank = makeTestHome({ overrides: { TRIAGE_REPOS_DIR: '' } });
    try {
      const body = (await (await routes({ config: () => blank.config }).request('/repos')).json()) as Record<string, unknown>;
      expect(body['repos']).toEqual([]);
      expect(body['not_configured']).toEqual({ key: 'TRIAGE_REPOS_DIR', message: 'repos not configured: TRIAGE_REPOS_DIR is blank' });
    } finally {
      blank.cleanup();
    }
  });
});
