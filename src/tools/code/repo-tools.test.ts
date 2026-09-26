import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { releaseEscalation } from '../../agents/escalation.ts';
import { type Config, configFromRecord } from '../../config/env.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../../gate/budget.ts';
import { createMockLayer } from '../../mock/index.ts';
import type { FixtureStore } from '../../mock/store.ts';
import type { RunStore } from '../../runstore/types.ts';
import type { Entity } from '../../types/core.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../types/tool-result.ts';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { makeToolContext } from '../../../test/support/fake-tool-context.ts';
import { createToolDeps } from '../_lib/context.ts';
import { conformanceProblems } from '../index.ts';
import type { Mount, ToolContext, ToolModule } from '../types.ts';
import { codeToolEnabled, repoNamesFor } from './_lib/code-tool.ts';
import { compileGlob, grepRepo } from './_lib/grep.ts';
import { resolveInRepo, resolveRepoRoot } from './_lib/jail.ts';
import { toolModule as grepModule } from './repo-grep.tool.ts';
import { toolModule as readModule } from './repo-read.tool.ts';

// ------------------------------------------------------------------ synthetic repo

const REPO = 'harbor'; // pinned to ssfb in resources/repos.json
const MARKER = 'SECRET_MARKER_0xC0FFEE';
const FIXED_NOW = new Date('2026-09-23T10:00:00.000Z');

let base: string;
let reposDir: string;
let repoDir: string;
let home: TestHome;

function put(rel: string, text: string | Buffer): void {
  const path = join(repoDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'triage-repo-tools-'));
  reposDir = join(base, 'repos');
  repoDir = join(reposDir, REPO);
  mkdirSync(repoDir, { recursive: true });

  const app = Array.from({ length: 30 }, (_, i) => (i === 9 ? 'func HandleTransfer(ctx Context) error {' : `// line ${i + 1}`));
  put('src/app.go', `${app.join('\n')}\n`);
  put('src/util/strings.go', 'package util\n\nfunc HandleName() string { return "x" }\n');
  put('src/util/strings_test.go', 'package util\n\nfunc TestHandleName(t *T) {}\n');
  put('docs/readme.md', 'Handle with care\n');
  put('src/big.txt', Array.from({ length: 1000 }, (_, i) => `row ${i + 1} Handle`).join('\n'));

  // Everything below must never be read or matched.
  put('.git/config', `[remote "origin"]\n  url = ${MARKER}\n`);
  put('.env', `DB_PASSWORD=${MARKER}\n`);
  put('.github/workflows/ci.yml', `run: ${MARKER}\n`);
  put('src/.hidden.go', `// ${MARKER}\n`);
  put('bin/blob.bin', Buffer.concat([Buffer.from(`${MARKER}\n`), Buffer.from([0, 1, 2, 0])]));
  mkdirSync(join(base, 'outside'), { recursive: true });
  writeFileSync(join(base, 'outside', 'secret.txt'), `${MARKER}\n`);
  symlinkSync(join(base, 'outside', 'secret.txt'), join(repoDir, 'link-out.txt'));
  symlinkSync(join(repoDir, '.git', 'config'), join(repoDir, 'link-git.txt'));
  symlinkSync(join(base, 'outside'), join(repoDir, 'linkdir'));
  symlinkSync(join(repoDir, 'src', 'app.go'), join(repoDir, 'link-ok.go'));
  // A repo directory that is itself a symlink out of TRIAGE_REPOS_DIR.
  symlinkSync(join(base, 'outside'), join(reposDir, 'rhythm'));
  // A repo directory that is a symlink to another repo inside TRIAGE_REPOS_DIR.
  symlinkSync(repoDir, join(reposDir, 'guardian-link'));

  // Catastrophic backtracking bait for (a+)+$.
  const evil = Array.from({ length: 200 }, () => `${'a'.repeat(40)}b`).join('\n');
  for (let i = 0; i < 5; i++) put(`slow/evil${i}.txt`, evil);

  home = makeTestHome({ overrides: { TRIAGE_REPOS_DIR: reposDir } });
});

afterAll(() => {
  home?.cleanup();
  if (base !== undefined) rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ contexts

const emptyStore: FixtureStore = {
  fixturesDir: '/triage-test/fixtures',
  async get() {
    return null;
  },
  async list() {
    return [];
  },
};

let seq = 0;

type Rig = { ctx: ToolContext; audit: MemoryAuditSink; runId: string };

function rig(opts: { entity?: Entity | null; config?: Config; maxToolCalls?: number } = {}): Rig {
  seq += 1;
  const runId = `run_repo_tools_${seq}`;
  const config = opts.config ?? home.config;
  const audit = createMemoryAuditSink();
  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: { ids: {}, hops: [], basic_state: [] },
    connectors: {},
    runStore: {} as RunStore,
    budget: createRunBudget({
      runId,
      maxToolCalls: opts.maxToolCalls ?? 50,
      maxTasks: 5,
      maxRowsPerCall: 200,
      maxBytesPerCall: 1_000_000,
      maxBytesPerRun: 10_000_000,
    }),
    audit,
    fixtures: createMockLayer(config, { store: emptyStore }),
    now: () => FIXED_NOW,
  });
  const ctx = makeToolContext({ config, registry: home.registry, runId, entity: opts.entity ?? null, deps });
  return { ctx, audit, runId };
}

afterAll(() => {
  for (let i = 1; i <= seq; i++) {
    releaseRunBudget(`run_repo_tools_${i}`);
    releaseEscalation(`run_repo_tools_${i}`);
  }
});

const log = { info() {}, warn() {}, error() {} };

async function call(module: ToolModule, r: Rig, data: unknown, mount: Mount = 'code_walker', signal?: AbortSignal): Promise<ToolEnvelope> {
  const tool = module.create(r.ctx, mount);
  const parsed = v.parse(tool.input as v.GenericSchema, data);
  const run = tool.run as (c: unknown) => Promise<ToolEnvelope>;
  const env = await run({ data: parsed, toolCallId: `call_${seq}`, log, ...(signal !== undefined ? { signal } : {}) });
  return v.parse(ToolEnvelopeSchema, env);
}

type ReadData = { path: string; start_line: number; end_line: number; total_lines: number; text: string; truncated: boolean; note?: string };
type GrepData = {
  matches: { path: string; line: number; text: string }[];
  files_scanned: number;
  files_skipped: { binary: number; too_large: number };
  truncated: boolean;
  notes: string[];
};

// ------------------------------------------------------------------ jail

describe('resolveInRepo', () => {
  test('allows a plain file and reports its path relative to the repo', () => {
    const r = resolveInRepo(reposDir, REPO, 'src/app.go');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rel).toBe('src/app.go');
  });

  test.each([
    ['../x', 'escape'],
    ['a/../../b', 'escape'],
    ['src/../../../etc/passwd', 'escape'],
    ['/etc/passwd', 'absolute'],
    ['\\etc\\passwd', 'absolute'],
    ['C:/Windows', 'absolute'],
    ['src/app.go\0.txt', 'nul'],
    ['src\\app.go', 'bad_path'],
    ['.git/config', 'dotfile'],
    ['.env', 'dotfile'],
    ['src/.hidden.go', 'dotfile'],
    ['.github/workflows/ci.yml', 'dotfile'],
    ['./src/app.go', 'dotfile'],
  ])('refuses %j as %s', (path, code) => {
    const r = resolveInRepo(reposDir, REPO, path);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code as string).toBe(code);
      // Messages are fixed texts; '.env' is named in the dotfile message itself.
      if (path !== '.env') expect(r.message).not.toContain(path);
    }
  });

  test('refuses a symlink that points outside the repo, after realpath', () => {
    const r = resolveInRepo(reposDir, REPO, 'link-out.txt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('outside');
    const viaDir = resolveInRepo(reposDir, REPO, 'linkdir/secret.txt');
    expect(viaDir.ok).toBe(false);
    if (!viaDir.ok) expect(viaDir.code).toBe('outside');
  });

  test('refuses a symlink inside the repo that lands on .git/config', () => {
    const r = resolveInRepo(reposDir, REPO, 'link-git.txt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('dotfile');
  });

  test('allows a symlink that stays inside the repo', () => {
    const r = resolveInRepo(reposDir, REPO, 'link-ok.go');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rel).toBe('src/app.go');
  });

  test('refuses a repo directory that is a symlink out of TRIAGE_REPOS_DIR', () => {
    const r = resolveRepoRoot(reposDir, 'rhythm');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('outside');
  });

  test('refuses a repo directory that is a symlink to another repo under TRIAGE_REPOS_DIR', () => {
    expect(resolveRepoRoot(reposDir, 'guardian-link')).toMatchObject({ ok: false, code: 'outside' });
    expect(resolveInRepo(reposDir, 'guardian-link', 'src/app.go')).toMatchObject({ ok: false, code: 'outside' });
    expect(resolveRepoRoot(reposDir, REPO).ok).toBe(true);
  });

  test('refuses bad repo names, a missing repo and a blank repos dir', () => {
    expect(resolveRepoRoot(reposDir, '../harbor')).toMatchObject({ ok: false, code: 'bad_repo' });
    expect(resolveRepoRoot(reposDir, '.git')).toMatchObject({ ok: false, code: 'bad_repo' });
    expect(resolveRepoRoot(reposDir, 'guardian')).toMatchObject({ ok: false, code: 'repo_missing' });
    expect(resolveRepoRoot('', REPO)).toMatchObject({ ok: false, code: 'not_configured' });
    expect(resolveRepoRoot(undefined, REPO)).toMatchObject({ ok: false, code: 'not_configured' });
  });

  test('refuses a directory when a file is expected, a missing file and a file over the size cap', () => {
    expect(resolveInRepo(reposDir, REPO, 'src')).toMatchObject({ ok: false, code: 'not_file' });
    expect(resolveInRepo(reposDir, REPO, 'src/nope.go')).toMatchObject({ ok: false, code: 'not_found' });
    expect(resolveInRepo(reposDir, REPO, 'src/big.txt', { maxBytes: 100 })).toMatchObject({ ok: false, code: 'too_large' });
  });
});

// ------------------------------------------------------------------ module shape

describe('tool modules', () => {
  test('mount on code_walker and investigator (deep inherits it) and pass the input-schema conformance rules', () => {
    for (const m of [readModule, grepModule]) {
      expect(m.mounts).toEqual(['code_walker', 'investigator']);
      const ctx = makeToolContext({ config: home.config, registry: home.registry });
      expect(m.enabled(ctx, 'code_walker')).toEqual({ on: true });
      // create() must not touch deps: the default fake deps throw on any access.
      const tool: ToolDefinition = m.create(ctx, 'code_walker');
      expect(conformanceProblems(m, tool)).toEqual([]);
      const inv = makeToolContext({ config: home.config, registry: home.registry, entity: 'ssfb' });
      expect(conformanceProblems(m, m.create(inv, 'investigator'))).toEqual([]);
      expect(conformanceProblems(m, m.create(inv, 'investigator_deep'))).toEqual([]);
    }
  });

  test('are off when TRIAGE_REPOS_DIR is blank', () => {
    const ctx = makeToolContext({ env: { TRIAGE_REPOS_DIR: '' } });
    expect(codeToolEnabled(ctx)).toEqual({ on: false, reason: 'TRIAGE_REPOS_DIR is blank' });
    expect(readModule.enabled(ctx, 'code_walker').on).toBe(false);
    expect(grepModule.enabled(ctx, 'code_walker').on).toBe(false);
  });

  test('the repo picklist comes from repos.json and narrows to the investigator entity', () => {
    const walker = repoNamesFor(makeToolContext({ config: home.config, registry: home.registry }));
    expect(walker).toContain('harbor');
    expect(walker).toContain('banking-service');
    const ssfb = repoNamesFor(makeToolContext({ config: home.config, registry: home.registry, entity: 'ssfb' }));
    expect(ssfb).toContain('harbor');
    expect(ssfb).not.toContain('banking-service');
  });

  test('deny: an unknown repo is refused by the picklist', () => {
    const r = rig();
    for (const m of [readModule, grepModule]) {
      const tool = m.create(r.ctx, 'code_walker');
      const bad = v.safeParse(tool.input as v.GenericSchema, { repo: 'not-a-repo', path: 'x', pattern: 'x' });
      expect(bad.success).toBe(false);
    }
    // An investigator for atspl does not get ssfb repos.
    const atspl = rig({ entity: 'atspl' });
    const tool = readModule.create(atspl.ctx, 'investigator_deep');
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, path: 'src/app.go' }).success).toBe(false);
  });

  test('an investigator reads its own entity repo and is refused a repo of another entity', async () => {
    // harbor is pinned to ssfb only.
    const ssfb = rig({ entity: 'ssfb' });
    const own = await call(readModule, ssfb, { repo: REPO, path: 'src/app.go', start_line: 10, end_line: 10 }, 'investigator');
    expect(own.output.status).toBe('ok');

    const rtl = rig({ entity: 'rtl' });
    for (const m of [readModule, grepModule]) {
      const tool = m.create(rtl.ctx, 'investigator');
      expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, path: 'src/app.go', pattern: 'x' }).success).toBe(false);
      // Past the schema, run() refuses it too and audits the deny.
      const run = tool.run as (c: unknown) => Promise<ToolEnvelope>;
      const env = await run({ data: { repo: REPO, path: 'src/app.go', pattern: 'Handle' }, toolCallId: 'c', log });
      expect(env.output.status).toBe('refused');
      expect(rtl.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'unknown repo', entity: 'rtl' });
    }
  });

  test('deny: a repo that slips past the schema is refused in run() too', async () => {
    const r = rig();
    const tool = readModule.create(r.ctx, 'code_walker');
    const run = tool.run as (c: unknown) => Promise<ToolEnvelope>;
    const env = await run({ data: { repo: 'not-a-repo', path: 'src/app.go' }, toolCallId: 'c', log });
    expect(env.output.status).toBe('refused');
    expect(r.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'unknown repo' });
  });
});

// ------------------------------------------------------------------ repo_read

describe('repo_read', () => {
  test('allow: reads a line range with line numbers, taken_at and a mock audit line', async () => {
    const r = rig();
    const env = await call(readModule, r, { repo: REPO, path: 'src/app.go', start_line: 9, end_line: 11 });
    expect(env.output.status).toBe('ok');
    expect(env.output.taken_at).toBe(FIXED_NOW.toISOString());
    const d = env.output.data as ReadData;
    expect(d).toMatchObject({ path: 'src/app.go', start_line: 9, end_line: 11, total_lines: 30, truncated: false });
    expect(d.text).toBe('9\t// line 9\n10\tfunc HandleTransfer(ctx Context) error {\n11\t// line 11');
    expect(r.audit.lines).toHaveLength(1);
    expect(r.audit.lines[0]).toMatchObject({
      tool: 'repo_read',
      decision: 'allow',
      target: 'TRIAGE_REPOS_DIR',
      transport: 'mock',
      entity: null,
      exit: 'ok',
    });
  });

  test('output is capped at the line limit and says how to get the rest', async () => {
    const r = rig();
    const env = await call(readModule, r, { repo: REPO, path: 'src/big.txt' });
    const d = env.output.data as ReadData;
    expect(d.start_line).toBe(1);
    expect(d.end_line).toBe(400);
    expect(d.total_lines).toBe(1000);
    expect(d.truncated).toBe(true);
    expect(d.note).toContain('start_line 401');
    expect(d.text.split('\n')).toHaveLength(400);
  });

  test.each([
    ['../x'],
    ['a/../../b'],
    ['/etc/passwd'],
    ['src/app.go\0'],
    ['.git/config'],
    ['.env'],
    ['link-out.txt'],
    ['link-git.txt'],
  ])('deny: %j is refused and audited as a deny', async (path) => {
    const r = rig();
    const env = await call(readModule, r, { repo: REPO, path });
    expect(env.output.status).toBe('refused');
    expect(JSON.stringify(env)).not.toContain(MARKER);
    expect(r.audit.lines).toHaveLength(1);
    expect(r.audit.lines[0]).toMatchObject({ decision: 'deny', transport: 'mock', target: 'TRIAGE_REPOS_DIR' });
    expect(r.audit.lines[0]?.reason).toStartWith('jail: ');
  });

  test('deny: a binary file and a bad range are refused', async () => {
    const r = rig();
    expect((await call(readModule, r, { repo: REPO, path: 'bin/blob.bin' })).output.status).toBe('refused');
    expect((await call(readModule, r, { repo: REPO, path: 'src/app.go', start_line: 99 })).output.status).toBe('refused');
    expect((await call(readModule, r, { repo: REPO, path: 'src/app.go', start_line: 5, end_line: 2 })).output.status).toBe('refused');
  });

  test('deny: the budget refuses once the run has used its tool calls', async () => {
    const r = rig({ maxToolCalls: 1 });
    expect((await call(readModule, r, { repo: REPO, path: 'src/app.go' })).output.status).toBe('ok');
    const second = await call(readModule, r, { repo: REPO, path: 'src/app.go' });
    expect(second.output.status).toBe('refused');
    expect(r.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'budget: tool_calls' });
  });

  test('an aborted signal throws before any work', async () => {
    const r = rig();
    const ac = new AbortController();
    ac.abort();
    await expect(call(readModule, r, { repo: REPO, path: 'src/app.go' }, 'code_walker', ac.signal)).rejects.toThrow();
    expect(r.audit.lines).toHaveLength(0);
  });

  test('outside mock mode the audit line says transport real', async () => {
    // Real mode here only changes the audit transport: the tool reads local disk either way.
    const config = configFromRecord({ ...home.env, TRIAGE_MOCK_MODE: 'false', TRIAGE_REPOS_DIR: reposDir }, home.home);
    const r = rig({ config, entity: 'ssfb' });
    const env = await call(readModule, r, { repo: REPO, path: 'src/app.go', end_line: 1 }, 'investigator_deep');
    expect(env.output.status).toBe('ok');
    expect(r.audit.lines[0]).toMatchObject({ transport: 'real', entity: 'ssfb' });
  });
});

// ------------------------------------------------------------------ repo_grep

describe('repo_grep', () => {
  test('allow: finds matches, skips dot paths, binaries and outside symlinks', async () => {
    const r = rig();
    const env = await call(grepModule, r, { repo: REPO, pattern: `Handle|${MARKER}` });
    expect(env.output.status).toBe('ok');
    expect(env.output.taken_at).toBe(FIXED_NOW.toISOString());
    const d = env.output.data as GrepData;
    const paths = new Set(d.matches.map((m) => m.path));
    expect(paths.has('src/app.go')).toBe(true);
    expect(paths.has('link-ok.go')).toBe(true);
    for (const p of paths) {
      expect(p.split('/').some((s) => s.startsWith('.'))).toBe(false);
      expect(p.startsWith('linkdir')).toBe(false);
      expect(p).not.toBe('link-out.txt');
      expect(p).not.toBe('link-git.txt');
      expect(p).not.toBe('bin/blob.bin');
    }
    expect(JSON.stringify(env)).not.toContain(MARKER);
    expect(d.files_skipped.binary).toBe(1);
    expect(r.audit.lines[0]).toMatchObject({ tool: 'repo_grep', decision: 'allow', transport: 'mock', target: 'TRIAGE_REPOS_DIR' });
  });

  test('deny: grep never reports matches inside .git, .env or other dot paths', async () => {
    const r = rig();
    const env = await call(grepModule, r, { repo: REPO, pattern: MARKER });
    const d = env.output.data as GrepData;
    expect(d.matches).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(MARKER);
  });

  test('allow: path_glob narrows the files and max_matches caps the result', async () => {
    const r = rig();
    const byName = (await call(grepModule, r, { repo: REPO, pattern: 'Handle', path_glob: '*_test.go' })).output.data as GrepData;
    expect(byName.matches.map((m) => m.path)).toEqual(['src/util/strings_test.go']);

    const byPath = (await call(grepModule, r, { repo: REPO, pattern: 'func Handle', path_glob: 'src/**/*.go' })).output
      .data as GrepData;
    expect(byPath.matches.map((m) => `${m.path}:${m.line}`)).toEqual(['src/app.go:10', 'src/util/strings.go:3']);

    const capped = (await call(grepModule, r, { repo: REPO, pattern: 'row \\d+', path_glob: 'src/*.txt', max_matches: 5 })).output
      .data as GrepData;
    expect(capped.matches).toHaveLength(5);
    expect(capped.truncated).toBe(true);
    expect(capped.notes.join(' ')).toContain('stopped at 5 matches');
  });

  test('deny: a path_glob into a dot-directory, with .. or absolute is refused', async () => {
    const r = rig();
    for (const glob of ['.git/**', '**/.env', '../**', '/etc/*', 'src/*;rm']) {
      const env = await call(grepModule, r, { repo: REPO, pattern: 'x', path_glob: glob });
      expect(env.output.status).toBe('refused');
    }
    expect(r.audit.lines.every((l) => l.decision === 'deny')).toBe(true);
  });

  test('deny: an invalid regex and an over-long pattern are refused', async () => {
    const r = rig();
    expect((await call(grepModule, r, { repo: REPO, pattern: '(unclosed' })).output.status).toBe('refused');
    const tool = grepModule.create(r.ctx, 'code_walker');
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, pattern: 'a'.repeat(201) }).success).toBe(false);
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, pattern: 'a', max_matches: 1000 }).success).toBe(false);
  });

  test('deny: (a+)+$ stops at the time budget with a truncated note', async () => {
    const budget = 150;
    const started = Date.now();
    const out = await grepRepo({ reposDir, repo: REPO, pattern: '(a+)+$', glob: 'slow/*.txt', limits: { timeBudgetMs: budget } });
    const elapsed = Date.now() - started;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.notes.join(' ')).toContain('time budget');
    // The budget plus worker start-up and teardown, far below a hang.
    expect(elapsed).toBeLessThan(budget + 1500);
  });

  test('deny: (a+)+$ through the tool returns within the default budget', async () => {
    const r = rig();
    const started = Date.now();
    const env = await call(grepModule, r, { repo: REPO, pattern: '(a+)+$', path_glob: 'slow/*.txt' });
    const elapsed = Date.now() - started;
    expect(env.output.status).toBe('ok');
    const d = env.output.data as GrepData;
    expect(d.truncated).toBe(true);
    expect(d.notes.join(' ')).toContain('time budget');
    expect(elapsed).toBeLessThan(3000 + 1500);
  }, 15_000);

  test('output bytes and file count are capped', async () => {
    const bytes = await grepRepo({ reposDir, repo: REPO, pattern: 'row', limits: { maxOutputBytes: 300, maxMatches: 200 }, maxMatches: 200 });
    expect(bytes.ok && bytes.result.truncated).toBe(true);
    if (bytes.ok) expect(bytes.result.notes.join(' ')).toContain('byte output cap');

    const files = await grepRepo({ reposDir, repo: REPO, pattern: 'zzz_never', limits: { maxFiles: 2 } });
    expect(files.ok && files.result.truncated).toBe(true);
    if (files.ok) expect(files.result.files_scanned).toBe(2);
  });

  test('an aborted signal stops the grep', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(grepRepo({ reposDir, repo: REPO, pattern: 'x', signal: ac.signal })).rejects.toThrow();
  });
});

describe('compileGlob', () => {
  test('matches names without a slash and paths with one', () => {
    const name = compileGlob('*.{go,ts}');
    const path = compileGlob('src/**/*.go');
    if ('ok' in name || 'ok' in path) throw new Error('glob did not compile');
    expect(name.test('a/b/c.go')).toBe(true);
    expect(name.test('a/b/c.ts')).toBe(true);
    expect(name.test('a/b/c.md')).toBe(false);
    expect(path.test('src/app.go')).toBe(true);
    expect(path.test('src/util/strings.go')).toBe(true);
    expect(path.test('docs/app.go')).toBe(false);
    expect(path.baseDir).toBe('src');
  });
});
