import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { createFakeRunner, type FakeStep, UnscriptedExecError } from '../../src/connectors/exec-fake.ts';
import {
  codegraphIndex,
  codegraphStatus,
  codegraphVersion,
  createSyncOnce,
  hasIndex,
  LOCK_STALE_MS,
  lockPath,
  resolveRepoDir,
  tryAcquireSyncLock,
  type CodegraphResult,
} from '../../src/ops/codegraph.ts';
import { makeTestHome, testEnvRecord } from '../support/home.ts';

const BIN = 'codegraph';

let scratch: string;
let reposDir: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'triage-codegraph-')));
  reposDir = join(scratch, 'repos');
  mkdirSync(reposDir);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function configWith(overrides: Record<string, string> = {}): Config {
  const record = {
    ...testEnvRecord(),
    TRIAGE_MOCK_MODE: 'false',
    TRIAGE_REPOS_DIR: reposDir,
    CODEGRAPH_SYNC_BEFORE_QUERY: 'true',
    ...overrides,
  };
  return configFromRecord(record, join(scratch, 'home'));
}

/** Creates <reposDir>/<name>, with a codegraph.db when indexed. Returns the dir. */
function makeRepo(name: string, indexed: boolean): string {
  const dir = join(reposDir, name);
  mkdirSync(dir, { recursive: true });
  if (indexed) {
    mkdirSync(join(dir, '.codegraph'), { recursive: true });
    writeFileSync(join(dir, '.codegraph', 'codegraph.db'), '');
  }
  return dir;
}

const manifest = (...names: string[]) => names.map((repo) => ({ repo }));

describe('hasIndex', () => {
  test('is true only when .codegraph/codegraph.db is a file', () => {
    expect(hasIndex(makeRepo('a', true))).toBe(true);
    expect(hasIndex(makeRepo('b', false))).toBe(false);
    const c = makeRepo('c', false);
    mkdirSync(join(c, '.codegraph', 'codegraph.db'), { recursive: true });
    expect(hasIndex(c)).toBe(false);
  });
});

describe('codegraphIndex', () => {
  test('missing index: init is called with the repo dir', async () => {
    const dir = makeRepo('harbor', false);
    const runner = createFakeRunner([{ bin: BIN, argv: ['init', dir], result: { stdout: 'Indexed 12 files\n' } }]);
    const res = await codegraphIndex('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(res).toMatchObject({ status: 'ok', command: 'init', repo: 'harbor', output: 'Indexed 12 files' });
    expect(runner.calls.map((c) => c.argv)).toEqual([['init', dir]]);
  });

  test('existing index: sync is called', async () => {
    const dir = makeRepo('harbor', true);
    const runner = createFakeRunner([{ bin: BIN, argv: ['sync', dir] }]);
    const res = await codegraphIndex('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(res).toMatchObject({ status: 'ok', command: 'sync', repo: 'harbor' });
    expect(runner.calls).toHaveLength(1);
  });

  test('uses CODEGRAPH_BIN as the binary', async () => {
    const dir = makeRepo('harbor', true);
    const runner = createFakeRunner([{ bin: 'cg-custom', argv: ['sync', dir] }]);
    const res = await codegraphIndex('harbor', {
      config: configWith({ CODEGRAPH_BIN: 'cg-custom' }),
      runner,
      repos: manifest('harbor'),
    });
    expect(res.status).toBe('ok');
  });

  test('the lock is held while codegraph runs and removed afterwards', async () => {
    const dir = makeRepo('harbor', true);
    let heldDuringRun = false;
    const runner = createFakeRunner([
      {
        bin: BIN,
        argv: ['sync', dir],
        result: () => {
          heldDuringRun = existsSync(lockPath(dir));
          return {};
        },
      },
    ]);
    await codegraphIndex('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(heldDuringRun).toBe(true);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  test('a held lock gives busy with a reason and no runner call', async () => {
    const dir = makeRepo('harbor', true);
    const first = tryAcquireSyncLock(dir);
    expect(first.ok).toBe(true);
    const runner = createFakeRunner([]);
    const res = await codegraphIndex('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(res).toMatchObject({ status: 'busy', repo: 'harbor' });
    if (res.status === 'busy') expect(res.reason.length).toBeGreaterThan(0);
    expect(runner.calls).toHaveLength(0);
    if (first.ok) first.lock.release();
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  test('a stale lock older than 10 minutes is taken over', async () => {
    const dir = makeRepo('harbor', true);
    const path = lockPath(dir);
    writeFileSync(path, '{"token":"left-behind"}\n');
    const old = (Date.now() - LOCK_STALE_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    const runner = createFakeRunner([{ bin: BIN, argv: ['sync', dir] }]);
    const res = await codegraphIndex('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(res.status).toBe('ok');
    expect(runner.calls).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
  });

  test('a lock just under 10 minutes old is not taken over', async () => {
    const dir = makeRepo('harbor', true);
    const path = lockPath(dir);
    writeFileSync(path, '{"token":"other"}\n');
    const recent = (Date.now() - LOCK_STALE_MS + 60_000) / 1000;
    utimesSync(path, recent, recent);
    const runner = createFakeRunner([]);
    const res = await codegraphIndex('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(res.status).toBe('busy');
    expect(readFileSync(path, 'utf8')).toContain('other');
  });

  test('non-zero exit gives an error result with a trimmed stderr tail, no throw, lock released', async () => {
    const dir = makeRepo('harbor', true);
    const noise = 'x'.repeat(5000);
    const runner = createFakeRunner([
      { bin: BIN, argv: ['sync', dir], result: { exitCode: 2, stderr: `${noise}\nfatal: database is locked\n\n  ` } },
    ]);
    const res = await codegraphIndex('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res).toMatchObject({ command: 'sync', repo: 'harbor', exitCode: 2, timedOut: false });
    expect(res.message).toContain('exited with code 2');
    expect(res.stderrTail.endsWith('fatal: database is locked')).toBe(true);
    expect(res.stderrTail.length).toBeLessThanOrEqual(1000);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  test('a timeout and a missing binary are error results', async () => {
    const dir = makeRepo('harbor', true);
    const timeout = createFakeRunner([{ bin: BIN, argv: ['sync', dir], result: { exitCode: null, timedOut: true } }]);
    const r1 = await codegraphIndex('harbor', { config: configWith(), runner: timeout, repos: manifest('harbor') });
    expect(r1).toMatchObject({ status: 'error', timedOut: true });

    const enoent = createFakeRunner([{ bin: BIN, argv: ['sync', dir], result: { exitCode: null, spawnError: 'ENOENT' } }]);
    const r2 = await codegraphIndex('harbor', { config: configWith(), runner: enoent, repos: manifest('harbor') });
    expect(r2.status).toBe('error');
    if (r2.status === 'error') expect(r2.message).toContain('CODEGRAPH_BIN');
  });

  test('a repo in the manifest but not checked out is missing, with no runner call', async () => {
    const runner = createFakeRunner([]);
    const res = await codegraphIndex('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(res.status).toBe('missing');
    expect(runner.calls).toHaveLength(0);
  });

  test('passes the signal and a timeout to the runner', async () => {
    const dir = makeRepo('harbor', true);
    const seen: unknown[] = [];
    const runner = createFakeRunner([{ bin: BIN, argv: ['sync', dir] }]);
    const spy = {
      run: (bin: string, argv: readonly string[], opts: Parameters<typeof runner.run>[2]) => {
        seen.push(opts);
        return runner.run(bin, argv, opts);
      },
    };
    const controller = new AbortController();
    await codegraphIndex('harbor', { config: configWith(), runner: spy, repos: manifest('harbor'), signal: controller.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ signal: controller.signal });
    expect((seen[0] as { timeoutMs: number }).timeoutMs).toBeLessThan(LOCK_STALE_MS);
  });
});

describe('codegraphStatus and codegraphVersion', () => {
  test('status runs `status <dir>` for an indexed repo', async () => {
    const dir = makeRepo('harbor', true);
    const runner = createFakeRunner([{ bin: BIN, argv: ['status', dir], result: { stdout: 'Files: 619\n' } }]);
    const res = await codegraphStatus('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(res).toMatchObject({ status: 'ok', command: 'status', output: 'Files: 619' });
  });

  test('status on a repo without an index answers no_index and runs nothing', async () => {
    makeRepo('harbor', false);
    const runner = createFakeRunner([]);
    const res = await codegraphStatus('harbor', { config: configWith(), runner, repos: manifest('harbor') });
    expect(res.status).toBe('no_index');
    expect(runner.calls).toHaveLength(0);
  });

  test('version runs --version', async () => {
    const runner = createFakeRunner([{ bin: BIN, argv: ['--version'], result: { stdout: '1.6.0\n' } }]);
    const res = await codegraphVersion({ config: configWith(), runner });
    expect(res).toMatchObject({ status: 'ok', command: 'version', output: '1.6.0' });
  });

  test('version failure is an error result, not a throw', async () => {
    const runner = createFakeRunner([{ bin: BIN, argv: ['--version'], result: { exitCode: 127, stderr: '  not found \n' } }]);
    const res = await codegraphVersion({ config: configWith(), runner });
    expect(res).toMatchObject({ status: 'error', command: 'version', exitCode: 127, stderrTail: 'not found' });
  });
});

describe('not configured', () => {
  test('a blank CODEGRAPH_BIN makes every function answer not configured with the key name', async () => {
    makeRepo('harbor', true);
    const config = configWith({ CODEGRAPH_BIN: '' });
    const runner = createFakeRunner([]);
    const deps = { config, runner, repos: manifest('harbor') };
    const results: CodegraphResult[] = [
      await codegraphVersion(deps),
      await codegraphStatus('harbor', deps),
      await codegraphIndex('harbor', deps),
      await createSyncOnce(deps).ensureSynced('harbor'),
    ];
    for (const res of results) {
      expect(res).toMatchObject({ status: 'not_configured', key: 'CODEGRAPH_BIN' });
      if (res.status === 'not_configured') expect(res.message).toBe('codegraph not configured: CODEGRAPH_BIN is blank');
    }
    expect(runner.calls).toHaveLength(0);
  });

  test('a blank TRIAGE_REPOS_DIR answers not configured with that key', async () => {
    const runner = createFakeRunner([]);
    const deps = { config: configWith({ TRIAGE_REPOS_DIR: '' }), runner, repos: manifest('harbor') };
    expect(await codegraphIndex('harbor', deps)).toMatchObject({ status: 'not_configured', key: 'TRIAGE_REPOS_DIR' });
    expect(await createSyncOnce(deps).ensureSynced('harbor')).toMatchObject({
      status: 'not_configured',
      key: 'TRIAGE_REPOS_DIR',
    });
    expect(runner.calls).toHaveLength(0);
  });
});

describe('repo refusals', () => {
  test("repo 'x/../../etc' and an unknown repo name are refused", async () => {
    makeRepo('harbor', true);
    const runner = createFakeRunner([]);
    const deps = { config: configWith(), runner, repos: manifest('harbor') };
    for (const repo of ['x/../../etc', 'unknown-repo', '../harbor', '/etc', '']) {
      expect((await codegraphIndex(repo, deps)).status).toBe('refused');
      expect((await codegraphStatus(repo, deps)).status).toBe('refused');
      expect((await createSyncOnce(deps).ensureSynced(repo)).status).toBe('refused');
    }
    expect(runner.calls).toHaveLength(0);
  });

  test('a traversal name that is in the manifest is still refused', () => {
    const res = resolveRepoDir('x/../../etc', { config: configWith(), repos: manifest('x/../../etc') });
    expect(res.status).toBe('refused');
  });

  test('refusal messages do not echo the repo name', async () => {
    const res = await codegraphIndex('secret-looking-name', {
      config: configWith(),
      runner: createFakeRunner([]),
      repos: manifest('harbor'),
    });
    expect(res.status).toBe('refused');
    expect(JSON.stringify(res)).not.toContain('secret-looking-name');
  });

  test('a manifest repo whose directory is a symlink out of TRIAGE_REPOS_DIR is refused', async () => {
    const outside = join(scratch, 'outside');
    mkdirSync(join(outside, '.codegraph'), { recursive: true });
    writeFileSync(join(outside, '.codegraph', 'codegraph.db'), '');
    symlinkSync(outside, join(reposDir, 'escape'));
    const runner = createFakeRunner([]);
    const res = await codegraphIndex('escape', { config: configWith(), runner, repos: manifest('escape') });
    expect(res).toMatchObject({ status: 'refused' });
    if (res.status === 'refused') expect(res.message).toContain('outside TRIAGE_REPOS_DIR');
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(join(outside, '.codegraph', '.triage-sync.lock'))).toBe(false);
  });

  test('a symlink that stays inside TRIAGE_REPOS_DIR resolves to the real dir', () => {
    const real = makeRepo('harbor', true);
    symlinkSync(real, join(reposDir, 'harbor-link'));
    const res = resolveRepoDir('harbor-link', { config: configWith(), repos: manifest('harbor-link') });
    expect(res).toMatchObject({ status: 'ok', dir: real, present: true });
  });
});

describe('createSyncOnce / ensureSynced', () => {
  const syncSteps = (...dirs: string[]): FakeStep[] => dirs.map((dir) => ({ bin: BIN, argv: ['sync', dir] }));

  test('called twice for the same repo gives one runner call; two repos give two calls', async () => {
    const a = makeRepo('harbor', true);
    const b = makeRepo('rhythm', true);
    const runner = createFakeRunner(syncSteps(a, b));
    const once = createSyncOnce({ config: configWith(), runner, repos: manifest('harbor', 'rhythm') });
    expect((await once.ensureSynced('harbor')).status).toBe('ok');
    expect((await once.ensureSynced('harbor')).status).toBe('ok');
    expect(runner.calls).toHaveLength(1);
    await once.ensureSynced('rhythm');
    await once.ensureSynced('rhythm');
    expect(runner.calls.map((c) => c.argv)).toEqual([
      ['sync', a],
      ['sync', b],
    ]);
  });

  test('concurrent calls for one repo share one sync', async () => {
    const a = makeRepo('harbor', true);
    const runner = createFakeRunner(syncSteps(a));
    const once = createSyncOnce({ config: configWith(), runner, repos: manifest('harbor') });
    const results = await Promise.all([once.ensureSynced('harbor'), once.ensureSynced('harbor'), once.ensureSynced('harbor')]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect(runner.calls).toHaveLength(1);
  });

  test('a new instance syncs again', async () => {
    const a = makeRepo('harbor', true);
    const runner = createFakeRunner(syncSteps(a));
    const deps = { config: configWith(), runner, repos: manifest('harbor') };
    await createSyncOnce(deps).ensureSynced('harbor');
    await createSyncOnce(deps).ensureSynced('harbor');
    expect(runner.calls).toHaveLength(2);
  });

  test('a failed sync is not retried within the instance', async () => {
    const a = makeRepo('harbor', true);
    const runner = createFakeRunner([{ bin: BIN, argv: ['sync', a], result: { exitCode: 1, stderr: 'boom' } }]);
    const once = createSyncOnce({ config: configWith(), runner, repos: manifest('harbor') });
    expect((await once.ensureSynced('harbor')).status).toBe('error');
    expect((await once.ensureSynced('harbor')).status).toBe('error');
    expect(runner.calls).toHaveLength(1);
  });

  test('mock mode gives zero runner calls', async () => {
    makeRepo('harbor', true);
    const runner = createFakeRunner([]);
    const once = createSyncOnce({ config: configWith({ TRIAGE_MOCK_MODE: 'true' }), runner, repos: manifest('harbor') });
    expect(await once.ensureSynced('harbor')).toMatchObject({ status: 'skipped' });
    expect(runner.calls).toHaveLength(0);
    expect(runner.unscripted).toHaveLength(0);
  });

  test('mock mode in a standard test home gives zero runner calls', async () => {
    const home = makeTestHome();
    try {
      const runner = createFakeRunner([]);
      const once = createSyncOnce({ config: home.config, runner, repos: manifest('harbor') });
      expect((await once.ensureSynced('harbor')).status).toBe('skipped');
      expect(runner.calls).toHaveLength(0);
    } finally {
      home.cleanup();
    }
  });

  test('CODEGRAPH_SYNC_BEFORE_QUERY=false gives zero runner calls', async () => {
    makeRepo('harbor', true);
    const runner = createFakeRunner([]);
    const once = createSyncOnce({
      config: configWith({ CODEGRAPH_SYNC_BEFORE_QUERY: 'false' }),
      runner,
      repos: manifest('harbor'),
    });
    expect(await once.ensureSynced('harbor')).toMatchObject({ status: 'skipped' });
    expect(runner.calls).toHaveLength(0);
  });

  test('never runs init: a repo without an index answers no_index', async () => {
    makeRepo('harbor', false);
    const runner = createFakeRunner([]);
    const once = createSyncOnce({ config: configWith(), runner, repos: manifest('harbor') });
    expect((await once.ensureSynced('harbor')).status).toBe('no_index');
    expect(runner.calls).toHaveLength(0);
  });

  test('a held lock gives busy with no runner call, and a later call may sync', async () => {
    const a = makeRepo('harbor', true);
    const held = tryAcquireSyncLock(a);
    if (!held.ok) throw new Error('expected to take the lock');
    const runner = createFakeRunner(syncSteps(a));
    const once = createSyncOnce({ config: configWith(), runner, repos: manifest('harbor') });
    expect(await once.ensureSynced('harbor')).toMatchObject({ status: 'busy', repo: 'harbor' });
    expect(runner.calls).toHaveLength(0);
    held.lock.release();
    expect((await once.ensureSynced('harbor')).status).toBe('ok');
    expect((await once.ensureSynced('harbor')).status).toBe('ok');
    expect(runner.calls).toHaveLength(1);
  });

  test('an unscripted runner call still throws loudly', async () => {
    makeRepo('harbor', true);
    const once = createSyncOnce({ config: configWith(), runner: createFakeRunner([]), repos: manifest('harbor') });
    await expect(once.ensureSynced('harbor')).rejects.toBeInstanceOf(UnscriptedExecError);
    expect(existsSync(lockPath(join(reposDir, 'harbor')))).toBe(false);
  });
});

describe('tryAcquireSyncLock', () => {
  test('is exclusive and release only removes its own lock', () => {
    const dir = makeRepo('harbor', false);
    const a = tryAcquireSyncLock(dir);
    expect(a.ok).toBe(true);
    expect(tryAcquireSyncLock(dir).ok).toBe(false);
    if (!a.ok) return;
    // Another process took the lock over after ours went stale.
    writeFileSync(a.lock.path, '{"token":"someone-else"}\n');
    a.lock.release();
    expect(existsSync(a.lock.path)).toBe(true);
  });

  test('uses the injected clock for staleness', () => {
    const dir = makeRepo('harbor', false);
    const a = tryAcquireSyncLock(dir);
    expect(a.ok).toBe(true);
    const later = () => Date.now() + LOCK_STALE_MS + 1000;
    const b = tryAcquireSyncLock(dir, later);
    expect(b.ok).toBe(true);
    if (b.ok) b.lock.release();
  });
});
