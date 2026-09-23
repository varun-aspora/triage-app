import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { RegistryError } from '../../src/config/registry.ts';
import { parseRepos, RemoteUrlSchema, type RepoPin } from '../../src/config/repos.ts';
import { createFakeRunner, type FakeStep } from '../../src/connectors/exec-fake.ts';
import * as git from '../../src/ops/git.ts';
import { addIndexExclude, currentCommit, repoStatus, syncRepos, UnknownRepoError } from '../../src/ops/repos.ts';
import { makeTestHome, testEnvRecord } from '../support/home.ts';

const GIT = 'git';
const CG = 'codegraph';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REMOTE = 'git@github.com:example-org/harbor.git';

let scratch: string;
let reposDir: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'triage-repos-')));
  reposDir = join(scratch, 'repos');
  mkdirSync(reposDir);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function configWith(overrides: Record<string, string> = {}): Config {
  return configFromRecord(
    { ...testEnvRecord(), TRIAGE_MOCK_MODE: 'false', TRIAGE_REPOS_DIR: reposDir, CODEGRAPH_BIN: CG, ...overrides },
    join(scratch, 'home'),
  );
}

/** A checkout under the repos dir with a .git directory, optionally with a codegraph index. */
function makeRepo(name: string, indexed = true): string {
  const dir = join(reposDir, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  if (indexed) {
    mkdirSync(join(dir, '.codegraph'), { recursive: true });
    writeFileSync(join(dir, '.codegraph', 'codegraph.db'), '');
  }
  return dir;
}

const pin = (repo: string, extra: Partial<RepoPin> = {}): RepoPin => ({ repo, entities: ['ssfb'], ...extra });

function deps(steps: readonly FakeStep[], repos: readonly RepoPin[], overrides: Record<string, string> = {}) {
  const runner = createFakeRunner(steps);
  return { runner, d: { config: configWith(overrides), runner, repos } };
}

/** The steps for a clean checkout that syncs to `branch` and has an index. */
function cleanSyncSteps(dir: string, branch: string, sha: string): FakeStep[] {
  return [
    { bin: GIT, argv: git.statusPorcelain(dir), result: { stdout: '' } },
    { bin: GIT, argv: git.fetchBranch(dir, branch) },
    { bin: GIT, argv: git.checkoutFetched(dir, branch) },
    { bin: GIT, argv: git.revParseHead(dir), result: { stdout: `${sha}\n` } },
    { bin: CG, argv: ['sync', dir], result: { stdout: 'Synced 3 changed files\n' } },
  ];
}

// ------------------------------------------------------------ git.ts

describe('git argv builders', () => {
  const dir = '/r/harbor';

  test('every builder starts with -C <dir> and has the expected argv', () => {
    expect(git.revParseHead(dir)).toEqual(['-C', dir, 'rev-parse', '--verify', 'HEAD']);
    expect(git.currentBranch(dir)).toEqual(['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    expect(git.statusPorcelain(dir)).toEqual(['-C', dir, 'status', '--porcelain', '--untracked-files=normal']);
    expect(git.fetchBranch(dir, 'main')).toEqual(['-C', dir, 'fetch', '--no-tags', 'origin', 'main']);
    expect(git.checkoutFetched(dir, 'main')).toEqual(['-C', dir, 'checkout', '-B', 'main', 'FETCH_HEAD']);
    expect(git.remoteDefaultBranch(dir)).toEqual(['-C', dir, 'ls-remote', '--symref', 'origin', 'HEAD']);
    expect(git.localDefaultBranch(dir)).toEqual(['-C', dir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    expect(git.remoteDefaultBranchOf('/r', REMOTE)).toEqual(['-C', '/r', 'ls-remote', '--symref', REMOTE, 'HEAD']);
    expect(git.cloneBranch('/r', REMOTE, 'release/1.2', 'harbor')).toEqual([
      '-C', '/r', 'clone', '--branch', 'release/1.2', '--single-branch', '--depth=1', '--no-tags', '--', REMOTE, 'harbor',
    ]);
  });

  test('no builder produces a pull', () => {
    const all = [
      git.revParseHead(dir), git.currentBranch(dir), git.statusPorcelain(dir), git.fetchBranch(dir, 'main'),
      git.checkoutFetched(dir, 'main'), git.remoteDefaultBranch(dir), git.localDefaultBranch(dir),
      git.cloneBranch('/r', REMOTE, 'main', 'harbor'),
    ];
    for (const argv of all) expect(argv).not.toContain('pull');
  });

  test("branch names 'main;rm', '-x' and '../x' are refused", () => {
    for (const bad of ['main;rm', '-x', '../x', 'a b', 'main\n', '', 'x.lock', 'x/']) {
      expect(() => git.branchArg(bad)).toThrow(git.GitArgError);
      expect(() => git.fetchBranch(dir, bad)).toThrow(git.GitArgError);
      expect(() => git.checkoutFetched(dir, bad)).toThrow(git.GitArgError);
      expect(() => git.cloneBranch('/r', REMOTE, bad, 'harbor')).toThrow(git.GitArgError);
    }
    expect(() => git.branchArg(42)).toThrow(git.GitArgError);
  });

  test('refusal messages do not echo the value', () => {
    try {
      git.branchArg('main;rm');
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as Error).message).not.toContain('main;rm');
    }
  });

  test('bad repo names, relative dirs and bad remotes are refused', () => {
    for (const bad of ['../x', '-x', 'a/b', '.hidden', '']) {
      expect(() => git.cloneBranch('/r', REMOTE, 'main', bad)).toThrow(git.GitArgError);
    }
    expect(() => git.revParseHead('relative/dir')).toThrow(git.GitArgError);
    expect(() => git.revParseHead('/r/x\nrm')).toThrow(git.GitArgError);
    for (const bad of [
      'ext::sh -c touch% /tmp/x',
      'file:///etc/passwd',
      'https://user:secret@github.com/org/repo.git',
      '-uhack',
      'git@github.com:org/../repo.git',
      'git@github.com:org/repo.git;rm',
      'http://github.com/org/repo.git',
    ]) {
      expect(() => git.remoteArg(bad)).toThrow(git.GitArgError);
      expect(v.is(RemoteUrlSchema, bad)).toBe(false);
    }
    for (const good of [REMOTE, 'ssh://git@github.com/org/repo.git', 'https://github.com/org/repo.git']) {
      expect(git.remoteArg(good)).toBe(good);
    }
  });

  test('output parsers', () => {
    expect(git.parseDefaultBranch(`ref: refs/heads/develop\tHEAD\n${SHA_A}\tHEAD\n`)).toBe('develop');
    expect(git.parseDefaultBranch(`ref: refs/heads/-x\tHEAD\n`)).toBeUndefined();
    expect(git.parseDefaultBranch(`ref: refs/heads/a;b\tHEAD\n`)).toBeUndefined();
    expect(git.parseDefaultBranch(`${SHA_A}\tHEAD\n`)).toBeUndefined();
    expect(git.parseLocalDefaultBranch('origin/main\n')).toBe('main');
    expect(git.parseLocalDefaultBranch('upstream/main\n')).toBeUndefined();
    expect(git.parseBranch('pre-prod\n')).toBe('pre-prod');
    expect(git.parseCommit(`${SHA_A}\n`)).toBe(SHA_A);
    expect(git.parseCommit('not-a-sha')).toBeUndefined();
    expect(git.isDirty('')).toBe(false);
    expect(git.isDirty('?? .codegraph/\n')).toBe(false);
    expect(git.isDirty(' M main.go\n')).toBe(true);
    expect(git.isDirty('?? notes.txt\n')).toBe(true);
  });
});

// ------------------------------------------------------------ sync

describe('syncRepos', () => {
  test('a clean repo on the wrong branch gives fetch, checkout -B, then codegraph sync, in order', async () => {
    const dir = makeRepo('harbor');
    const { runner, d } = deps(cleanSyncSteps(dir, 'main', SHA_A), [pin('harbor', { branch: 'main' })]);
    const report = await syncRepos({}, d);
    expect(report.status).toBe('done');
    if (report.status !== 'done') return;

    const seq = runner.calls.map((c) => `${c.bin} ${c.argv.filter((a) => a !== '-C' && a !== dir).join(' ')}`);
    expect(seq).toEqual([
      'git status --porcelain --untracked-files=normal',
      'git fetch --no-tags origin main',
      'git checkout -B main FETCH_HEAD',
      'git rev-parse --verify HEAD',
      "codegraph sync",
    ]);
    for (const c of runner.calls.filter((c) => c.bin === GIT)) expect(c.argv.slice(0, 2)).toEqual(['-C', dir]);
    expect(report.results[0]).toMatchObject({ repo: 'harbor', status: 'ok', action: 'updated', branch: 'main', commit: SHA_A, index: 'sync' });
    expect(report.results[0]!.line).toBe(`harbor: ok, updated to main at ${SHA_A.slice(0, 12)}, codegraph sync`);
    expect(report.ok).toEqual(['harbor']);
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.codegraph/\n');
  });

  test('branch absent in the pin gives a default-branch lookup, then that branch is used', async () => {
    const dir = makeRepo('harbor');
    const steps: FakeStep[] = [
      { bin: GIT, argv: git.statusPorcelain(dir), result: { stdout: '' } },
      { bin: GIT, argv: git.remoteDefaultBranch(dir), result: { stdout: `ref: refs/heads/develop\tHEAD\n${SHA_B}\tHEAD\n` } },
      ...cleanSyncSteps(dir, 'develop', SHA_B).slice(1),
    ];
    const { runner, d } = deps(steps, [pin('harbor')]);
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    const subcommands = runner.calls.map((c) => c.argv[c.bin === GIT ? 2 : 0]);
    expect(subcommands).toEqual(['status', 'ls-remote', 'fetch', 'checkout', 'rev-parse', 'sync']);
    expect(runner.calls[2]!.argv).toEqual(git.fetchBranch(dir, 'develop'));
    expect(runner.calls[3]!.argv).toEqual(git.checkoutFetched(dir, 'develop'));
    expect(report.results[0]).toMatchObject({ status: 'ok', branch: 'develop' });
  });

  test('a default branch that is not a plain name fails the repo before fetch', async () => {
    const dir = makeRepo('harbor');
    const { runner, d } = deps(
      [
        { bin: GIT, argv: git.statusPorcelain(dir), result: { stdout: '' } },
        { bin: GIT, argv: git.remoteDefaultBranch(dir), result: { stdout: `ref: refs/heads/-x\tHEAD\n` } },
      ],
      [pin('harbor')],
    );
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results[0]).toMatchObject({ status: 'failed' });
    expect(runner.calls.map((c) => c.argv[2])).toEqual(['status', 'ls-remote']);
  });

  test('a dirty tree gives skipped: dirty, with no fetch or checkout calls', async () => {
    const dir = makeRepo('harbor');
    const { runner, d } = deps(
      [{ bin: GIT, argv: git.statusPorcelain(dir), result: { stdout: ' M internal/sim.go\n?? scratch.txt\n' } }],
      [pin('harbor', { branch: 'main' })],
    );
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results[0]).toMatchObject({ repo: 'harbor', status: 'skipped', reason: 'dirty' });
    expect(report.results[0]!.line).toStartWith('harbor: skipped: dirty');
    expect(report.results[0]!.warnings.length).toBe(1);
    expect(report.skipped).toEqual(['harbor']);
    expect(runner.calls.map((c) => c.argv[2])).toEqual(['status']);
    expect(runner.calls.some((c) => c.argv.includes('fetch') || c.argv.includes('checkout') || c.argv.includes('reset'))).toBe(false);
    expect(existsSync(join(dir, '.git', 'info', 'exclude'))).toBe(false);
  });

  test("missing dir with no remote gives 'not checked out' and no clone", async () => {
    const { runner, d } = deps([], [pin('harbor', { branch: 'main' })]);
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results[0]).toMatchObject({ repo: 'harbor', status: 'skipped', reason: 'not checked out' });
    expect(report.results[0]!.line).toBe('harbor: skipped: not checked out');
    expect(runner.calls).toEqual([]);
    expect(existsSync(join(reposDir, 'harbor'))).toBe(false);
  });

  test('missing dir with a remote gives clone --branch, then codegraph init', async () => {
    const dir = join(reposDir, 'harbor');
    const steps: FakeStep[] = [
      {
        bin: GIT,
        argv: git.cloneBranch(reposDir, REMOTE, 'main', 'harbor'),
        result: () => {
          mkdirSync(join(dir, '.git'), { recursive: true });
          return {};
        },
      },
      { bin: GIT, argv: git.revParseHead(dir), result: { stdout: `${SHA_A}\n` } },
      { bin: CG, argv: ['init', dir], result: { stdout: 'Indexed 619 files\n' } },
    ];
    const { runner, d } = deps(steps, [pin('harbor', { branch: 'main', remote: REMOTE })]);
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(runner.calls[0]!.argv).toEqual([
      '-C', reposDir, 'clone', '--branch', 'main', '--single-branch', '--depth=1', '--no-tags', '--', REMOTE, 'harbor',
    ]);
    expect(runner.calls.map((c) => c.bin)).toEqual([GIT, GIT, CG]);
    expect(report.results[0]).toMatchObject({ status: 'ok', action: 'cloned', branch: 'main', commit: SHA_A, index: 'init' });
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toBe('.codegraph/\n');
  });

  test('missing dir with a remote and no branch looks up the remote default first', async () => {
    const dir = join(reposDir, 'harbor');
    const steps: FakeStep[] = [
      { bin: GIT, argv: git.remoteDefaultBranchOf(reposDir, REMOTE), result: { stdout: `ref: refs/heads/trunk\tHEAD\n` } },
      {
        bin: GIT,
        argv: git.cloneBranch(reposDir, REMOTE, 'trunk', 'harbor'),
        result: () => {
          mkdirSync(join(dir, '.git'), { recursive: true });
          return {};
        },
      },
      { bin: GIT, argv: git.revParseHead(dir), result: { stdout: `${SHA_A}\n` } },
      { bin: CG, argv: ['init', dir] },
    ];
    const { runner, d } = deps(steps, [pin('harbor', { remote: REMOTE })]);
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(runner.calls.map((c) => c.argv[c.bin === GIT ? 2 : 0])).toEqual(['ls-remote', 'clone', 'rev-parse', 'init']);
    expect(report.results[0]).toMatchObject({ status: 'ok', action: 'cloned', branch: 'trunk' });
  });

  test("branch names 'main;rm', '-x' and '../x' in a pin fail that repo with no git call", async () => {
    for (const bad of ['main;rm', '-x', '../x']) {
      makeRepo('harbor');
      const { runner, d } = deps([], [pin('harbor', { branch: bad })]);
      const report = await syncRepos({}, d);
      if (report.status !== 'done') throw new Error('expected done');
      expect(report.results[0]).toMatchObject({ status: 'failed' });
      expect(report.results[0]!.reason).not.toContain(bad);
      expect(runner.calls).toEqual([]);
    }
  });

  test('an unsafe remote in a pin fails that repo with no git call', async () => {
    const { runner, d } = deps([], [pin('harbor', { branch: 'main', remote: 'ext::sh -c id' })]);
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results[0]).toMatchObject({ status: 'failed' });
    expect(runner.calls).toEqual([]);
  });

  test('a repo name outside the jail is refused', async () => {
    const { runner, d } = deps([], [pin('..', { branch: 'main' })]);
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results[0]).toMatchObject({ status: 'failed' });
    expect(runner.calls).toEqual([]);
  });

  test('a failure in repo A still lets repo B sync', async () => {
    const a = makeRepo('a');
    const b = makeRepo('b');
    const steps: FakeStep[] = [
      { bin: GIT, argv: git.statusPorcelain(a), result: { stdout: '' } },
      { bin: GIT, argv: git.fetchBranch(a, 'main'), result: { exitCode: 128, stderr: 'fatal: could not read from remote repository\n' } },
      ...cleanSyncSteps(b, 'main', SHA_B),
    ];
    const { runner, d } = deps(steps, [pin('a', { branch: 'main' }), pin('b', { branch: 'main' })]);
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results.map((r) => [r.repo, r.status])).toEqual([
      ['a', 'failed'],
      ['b', 'ok'],
    ]);
    expect(report.results[0]!.reason).toContain('git fetch exited with code 128');
    expect(report.ok).toEqual(['b']);
    expect(report.failed).toEqual(['a']);
    expect(report.skipped).toEqual([]);
    expect(runner.calls.some((c) => c.argv.includes('checkout') && c.argv.includes(a))).toBe(false);
  });

  test('a thrown error in repo A (git not found, unscripted call) still lets repo B sync', async () => {
    const a = makeRepo('a');
    const b = makeRepo('b');
    const steps: FakeStep[] = [
      { bin: GIT, argv: git.statusPorcelain(a), result: { exitCode: null, spawnError: 'ENOENT' } },
      ...cleanSyncSteps(b, 'main', SHA_B),
    ];
    const { d } = deps(steps, [pin('a', { branch: 'main' }), pin('c', { branch: 'main' }), pin('b', { branch: 'main' })]);
    makeRepo('c');
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results.map((r) => [r.repo, r.status])).toEqual([
      ['a', 'failed'],
      ['c', 'failed'],
      ['b', 'ok'],
    ]);
    expect(report.results[0]!.reason).toContain('could not start git (ENOENT)');
  });

  test('--repo limits sync to one pin', async () => {
    makeRepo('a');
    const b = makeRepo('b');
    const { runner, d } = deps(cleanSyncSteps(b, 'main', SHA_B), [pin('a', { branch: 'main' }), pin('b', { branch: 'main' })]);
    const report = await syncRepos({ repo: 'b' }, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results.map((r) => r.repo)).toEqual(['b']);
    expect(runner.calls.every((c) => c.argv.includes(b))).toBe(true);
  });

  test('an unknown --repo is an error that lists the valid names', async () => {
    const { runner, d } = deps([], [pin('a'), pin('b')]);
    const err = await syncRepos({ repo: 'nope' }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownRepoError);
    expect((err as UnknownRepoError).validNames).toEqual(['a', 'b']);
    expect((err as Error).message).toContain('valid names: a, b');
    expect(runner.calls).toEqual([]);
  });

  test('a busy codegraph lock reports skipped with the reason', async () => {
    const dir = makeRepo('harbor');
    writeFileSync(join(dir, '.codegraph', '.triage-sync.lock'), '{"token":"other"}\n');
    const { d } = deps(cleanSyncSteps(dir, 'main', SHA_A).slice(0, 4), [pin('harbor', { branch: 'main' })]);
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results[0]).toMatchObject({ status: 'skipped', reason: 'another codegraph writer holds the sync lock' });
  });

  test('a codegraph error fails the repo', async () => {
    const dir = makeRepo('harbor');
    const steps = cleanSyncSteps(dir, 'main', SHA_A).slice(0, 4);
    steps.push({ bin: CG, argv: ['sync', dir], result: { exitCode: 1, stderr: 'boom' } });
    const { d } = deps(steps, [pin('harbor', { branch: 'main' })]);
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results[0]).toMatchObject({ status: 'failed', reason: 'codegraph sync exited with code 1' });
  });

  test('a blank CODEGRAPH_BIN keeps the git update and warns', async () => {
    const dir = makeRepo('harbor');
    const { runner, d } = deps(cleanSyncSteps(dir, 'main', SHA_A).slice(0, 4), [pin('harbor', { branch: 'main' })], { CODEGRAPH_BIN: '' });
    const report = await syncRepos({}, d);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.results[0]).toMatchObject({ status: 'ok', action: 'updated' });
    expect(report.results[0]!.warnings[0]).toContain('CODEGRAPH_BIN');
    expect(runner.calls.some((c) => c.bin === CG)).toBe(false);
  });

  test('a blank TRIAGE_REPOS_DIR answers not configured and runs nothing', async () => {
    const { runner, d } = deps([], [pin('harbor')], { TRIAGE_REPOS_DIR: '' });
    expect(await syncRepos({}, d)).toMatchObject({ status: 'not_configured', key: 'TRIAGE_REPOS_DIR' });
    expect(await repoStatus(d)).toMatchObject({ status: 'not_configured', key: 'TRIAGE_REPOS_DIR' });
    expect(runner.calls).toEqual([]);
  });
});

// ------------------------------------------------------------ status

describe('repoStatus', () => {
  function statusSteps(dir: string, o: { branch?: string | null; porcelain?: string; localDefault?: string | null }): FakeStep[] {
    const steps: FakeStep[] = [
      { bin: GIT, argv: git.revParseHead(dir), result: { stdout: `${SHA_A}\n` } },
      {
        bin: GIT,
        argv: git.currentBranch(dir),
        result: o.branch === null ? { exitCode: 1 } : { stdout: `${o.branch ?? 'main'}\n` },
      },
      { bin: GIT, argv: git.statusPorcelain(dir), result: { stdout: o.porcelain ?? '' } },
    ];
    if (o.localDefault !== undefined) {
      steps.push({
        bin: GIT,
        argv: git.localDefaultBranch(dir),
        result: o.localDefault === null ? { exitCode: 1 } : { stdout: `origin/${o.localDefault}\n` },
      });
    }
    return steps;
  }

  const readOnly = new Set(['rev-parse', 'symbolic-ref', 'status']);

  test("reports drift for a repo on 'pre-prod' when the pin says 'main'", async () => {
    const dir = makeRepo('harbor');
    const before = readdirSync(join(dir, '.git'));
    const { runner, d } = deps(statusSteps(dir, { branch: 'pre-prod' }), [pin('harbor', { branch: 'main' })]);
    const report = await repoStatus(d);
    if (report.status !== 'ok') throw new Error('expected ok');
    expect(report.repos).toEqual([
      {
        repo: 'harbor',
        expectedBranch: 'main',
        actualBranch: 'pre-prod',
        commit: SHA_A,
        dirty: false,
        drift: true,
        indexed: true,
        present: true,
      },
    ]);
    expect(runner.calls.every((c) => readOnly.has(c.argv[2]!))).toBe(true);
    expect(readdirSync(join(dir, '.git'))).toEqual(before);
  });

  test('no drift on the pinned branch; dirty and unindexed are reported', async () => {
    const dir = makeRepo('harbor', false);
    const { d } = deps(statusSteps(dir, { branch: 'main', porcelain: ' M a.go\n' }), [pin('harbor', { branch: 'main' })]);
    const report = await repoStatus(d);
    if (report.status !== 'ok') throw new Error('expected ok');
    expect(report.repos[0]).toMatchObject({ drift: false, dirty: true, indexed: false, present: true });
  });

  test('a pin without a branch compares against the locally recorded default, offline', async () => {
    const dir = makeRepo('harbor');
    const { runner, d } = deps(statusSteps(dir, { branch: 'pre-prod', localDefault: 'main' }), [pin('harbor')]);
    const report = await repoStatus(d);
    if (report.status !== 'ok') throw new Error('expected ok');
    expect(report.repos[0]).toMatchObject({ expectedBranch: 'main', actualBranch: 'pre-prod', drift: true });
    expect(runner.calls.some((c) => c.argv.includes('ls-remote') || c.argv.includes('fetch'))).toBe(false);
  });

  test('an unknown default branch leaves drift null with a problem', async () => {
    const dir = makeRepo('harbor');
    const { d } = deps(statusSteps(dir, { localDefault: null }), [pin('harbor')]);
    const report = await repoStatus(d);
    if (report.status !== 'ok') throw new Error('expected ok');
    expect(report.repos[0]).toMatchObject({ expectedBranch: null, drift: null });
    expect(report.repos[0]!.problem).toContain('default branch');
  });

  test('a detached HEAD counts as drift', async () => {
    const dir = makeRepo('harbor');
    const { d } = deps(statusSteps(dir, { branch: null }), [pin('harbor', { branch: 'main' })]);
    const report = await repoStatus(d);
    if (report.status !== 'ok') throw new Error('expected ok');
    expect(report.repos[0]).toMatchObject({ actualBranch: null, drift: true });
  });

  test('a missing checkout is present: false with no git call', async () => {
    const { runner, d } = deps([], [pin('harbor', { branch: 'main' })]);
    const report = await repoStatus(d);
    if (report.status !== 'ok') throw new Error('expected ok');
    expect(report.repos[0]).toMatchObject({ repo: 'harbor', present: false, drift: null, commit: null, indexed: false });
    expect(runner.calls).toEqual([]);
  });

  test('--repo limits status to one pin, and an unknown name lists the valid names', async () => {
    const b = makeRepo('b');
    const { d } = deps(statusSteps(b, {}), [pin('a', { branch: 'main' }), pin('b', { branch: 'main' })]);
    const report = await repoStatus(d, { repo: 'b' });
    if (report.status !== 'ok') throw new Error('expected ok');
    expect(report.repos.map((r) => r.repo)).toEqual(['b']);
    const err = await repoStatus(d, { repo: 'zzz' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownRepoError);
    expect((err as UnknownRepoError).validNames).toEqual(['a', 'b']);
  });
});

// ------------------------------------------------------------ current commit

describe('currentCommit', () => {
  test('returns the checked-out commit', async () => {
    const dir = makeRepo('harbor');
    const { d } = deps([{ bin: GIT, argv: git.revParseHead(dir), result: { stdout: `${SHA_B}\n` } }], [pin('harbor')]);
    expect(await currentCommit('harbor', d)).toEqual({ status: 'ok', repo: 'harbor', commit: SHA_B });
  });

  test('a name outside the manifest is unavailable, runs nothing and is not echoed', async () => {
    const { runner, d } = deps([], [pin('harbor')]);
    const res = await currentCommit('../../etc', d);
    expect(res.status).toBe('unavailable');
    if (res.status === 'unavailable') expect(res.reason).not.toContain('etc');
    expect(runner.calls).toEqual([]);
  });

  test('a missing checkout or a failed rev-parse is unavailable', async () => {
    const { d } = deps([], [pin('harbor')]);
    expect((await currentCommit('harbor', d)).status).toBe('unavailable');
    const dir = makeRepo('harbor');
    const { d: d2 } = deps([{ bin: GIT, argv: git.revParseHead(dir), result: { exitCode: 128 } }], [pin('harbor')]);
    expect(await currentCommit('harbor', d2)).toMatchObject({ status: 'unavailable', reason: 'git rev-parse exited with code 128' });
  });
});

describe('addIndexExclude', () => {
  test('adds .codegraph/ once and keeps existing lines', () => {
    const dir = makeRepo('harbor');
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '# local\n*.swp');
    expect(addIndexExclude(dir)).toBeUndefined();
    expect(addIndexExclude(dir)).toBeUndefined();
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toBe('# local\n*.swp\n.codegraph/\n');
  });

  test('warns when .git is not a directory', () => {
    const dir = join(reposDir, 'wt');
    mkdirSync(dir);
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n');
    expect(addIndexExclude(dir)).toContain('.git is not a directory');
  });
});

describe('repos.json remote field', () => {
  test('a pin may carry a remote; a remote with credentials or another transport is refused', () => {
    const home = makeTestHome();
    try {
      const pins = parseRepos([{ repo: 'harbor', entities: ['ssfb'], branch: 'main', remote: REMOTE }], home.registry);
      expect(pins[0]).toEqual({ repo: 'harbor', entities: ['ssfb'], branch: 'main', remote: REMOTE });
      expect(parseRepos([{ repo: 'harbor', entities: ['ssfb'] }], home.registry)[0]).not.toHaveProperty('remote');
      for (const bad of ['https://user:pw@github.com/org/harbor.git', 'ext::sh -c id', 'file:///tmp/harbor']) {
        expect(() => parseRepos([{ repo: 'harbor', entities: ['ssfb'], remote: bad }], home.registry)).toThrow(RegistryError);
      }
    } finally {
      home.cleanup();
    }
  });
});
