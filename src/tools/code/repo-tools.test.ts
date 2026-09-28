import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { releaseEscalation } from '../../agents/escalation.ts';
import { type Config, configFromRecord } from '../../config/env.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../gate/audit-sink.ts';
import { CODE_TOOLS, createRunBudget, releaseRunBudget } from '../../gate/budget.ts';
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
import { repoDocsFor } from './_lib/repo-docs.ts';
import { findPaths, toolModule as findModule } from './repo-find.tool.ts';
import { toolModule as grepModule } from './repo-grep.tool.ts';
import { readRange, toolModule as readModule } from './repo-read.tool.ts';
import { toolModule as treeModule } from './repo-tree.tool.ts';

const REPO_MODULES = [readModule, grepModule, findModule, treeModule];

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

function rig(
  opts: { entity?: Entity | null; config?: Config; maxToolCalls?: number; maxCodeCalls?: number; maxBytesPerRun?: number } = {},
): Rig {
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
      maxBytesPerRun: opts.maxBytesPerRun ?? 10_000_000,
      ...(opts.maxCodeCalls !== undefined ? { codeCap: { maxCalls: opts.maxCodeCalls, setting: 'TRIAGE_MAX_CODE_CALLS_PER_RUN' } } : {}),
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

type FindData = { paths: string[]; offset: number; next_offset: number | null; truncated: boolean; notes: string[] };
type TreeData = { path: string; depth: number; entries: { path: string; files?: number; dirs?: number }[]; truncated: boolean; notes: string[] };
type ReadData = { path: string; start_line: number; end_line: number; total_lines: number; text: string; truncated: boolean; note?: string };
type GrepData = {
  matches: { path: string; line: number; text: string; before?: string[]; after?: string[] }[];
  files?: string[];
  counts?: { path: string; count: number }[];
  total?: number;
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
    expect(resolveInRepo(reposDir, REPO, 'src/app.go', { expect: 'dir' })).toMatchObject({ ok: false, code: 'not_dir' });
    expect(resolveInRepo(reposDir, REPO, 'src/big.txt', { maxBytes: 100 })).toMatchObject({ ok: false, code: 'too_large' });
  });
});

// ------------------------------------------------------------------ module shape

describe('tool modules', () => {
  test('mount on code_walker and investigator (deep inherits it) and pass the input-schema conformance rules', () => {
    for (const m of REPO_MODULES) {
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
    for (const m of REPO_MODULES) expect(m.enabled(ctx, 'code_walker').on).toBe(false);
  });

  test('every repo tool counts against the code cap (CODE_TOOLS)', () => {
    for (const m of REPO_MODULES) expect(CODE_TOOLS).toContain(m.name);
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
    for (const m of REPO_MODULES) {
      const tool = m.create(r.ctx, 'code_walker');
      const bad = v.safeParse(tool.input as v.GenericSchema, { repo: 'not-a-repo', path: 'x', pattern: 'x', glob: '*.go' });
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
    for (const m of REPO_MODULES) {
      const tool = m.create(rtl.ctx, 'investigator');
      expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, path: 'src', pattern: 'x', glob: '*.go' }).success).toBe(false);
      // Past the schema, run() refuses it too and audits the deny.
      const run = tool.run as (c: unknown) => Promise<ToolEnvelope>;
      const env = await run({ data: { repo: REPO, path: 'src', pattern: 'Handle', glob: '*.go' }, toolCallId: 'c', log });
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

  test('deny: the code cap refuses with its key and value, and the run goes on', async () => {
    const r = rig({ maxToolCalls: 1, maxCodeCalls: 2 });
    expect((await call(readModule, r, { repo: REPO, path: 'src/app.go' })).output.status).toBe('ok');
    expect((await call(grepModule, r, { repo: REPO, pattern: 'func' })).output.status).toBe('ok');
    const third = await call(readModule, r, { repo: REPO, path: 'src/app.go' });
    expect(third.output).toMatchObject({ status: 'refused' });
    expect(third.output.message).toContain('(TRIAGE_MAX_CODE_CALLS_PER_RUN=2)');
    expect(r.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'budget: tool_cap' });
    expect(r.ctx.deps.escalation.snapshot().budgetExhausted).toBe(false);
  });

  test('a spent run limit does not stop repo_read under the code cap', async () => {
    const r = rig({ maxToolCalls: 1, maxCodeCalls: 5 });
    expect(r.ctx.deps.budget.consumeToolCall('sql_select').ok).toBe(true);
    expect(r.ctx.deps.budget.consumeToolCall('sql_select')).toMatchObject({ ok: false, reason: 'tool_calls' });
    expect((await call(readModule, r, { repo: REPO, path: 'src/app.go' })).output.status).toBe('ok');
    expect(r.ctx.deps.escalation.snapshot().budgetExhausted).toBe(false);
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

describe('repo_grep modes', () => {
  test('files_only returns each matching path once, capped by max_matches', async () => {
    const r = rig();
    const d = (await call(grepModule, r, { repo: REPO, pattern: 'Handle', path_glob: 'src/**', files_only: true })).output.data as GrepData;
    expect(d.files).toEqual(['src/app.go', 'src/big.txt', 'src/util/strings.go', 'src/util/strings_test.go']);
    expect(new Set(d.files).size).toBe(4);
    expect(d.matches).toBeUndefined();
    const capped = (await call(grepModule, r, { repo: REPO, pattern: 'Handle', files_only: true, max_matches: 2 })).output.data as GrepData;
    expect(capped.files).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(capped.notes.join(' ')).toContain('stopped at 2 files');
  });

  test('count_only returns matches per file and the total', async () => {
    const r = rig();
    const d = (await call(grepModule, r, { repo: REPO, pattern: 'Handle', path_glob: 'src/**', count_only: true })).output.data as GrepData;
    expect(d.counts).toEqual([
      { path: 'src/app.go', count: 1 },
      { path: 'src/big.txt', count: 1000 },
      { path: 'src/util/strings.go', count: 1 },
      { path: 'src/util/strings_test.go', count: 1 },
    ]);
    expect(d.total).toBe(1003);
    const floor = await grepRepo({ reposDir, repo: REPO, pattern: 'row', glob: 'src/big.txt', mode: 'count', limits: { maxCountPerFile: 10 } });
    expect(floor.ok && floor.result.counts).toEqual([{ path: 'src/big.txt', count: 10 }]);
    if (floor.ok) expect(floor.result.notes.join(' ')).toContain('per-file count cap');
  });

  test('context_lines adds lines around a match and merges overlapping ranges', async () => {
    const r = rig();
    const one = (await call(grepModule, r, { repo: REPO, pattern: 'HandleTransfer', path_glob: 'src/*.go', context_lines: 2 })).output.data as GrepData;
    expect(one.matches).toEqual([
      { path: 'src/app.go', line: 10, text: 'func HandleTransfer(ctx Context) error {', before: ['// line 8', '// line 9'], after: ['// line 11', '// line 12'] },
    ]);
    const near = (await call(grepModule, r, { repo: REPO, pattern: '^row (3|5) ', path_glob: 'src/big.txt', context_lines: 2 })).output
      .data as GrepData;
    expect(near.matches.map((m) => [m.line, m.before, m.after])).toEqual([
      [3, ['row 1 Handle', 'row 2 Handle'], ['row 4 Handle']],
      [5, [], ['row 6 Handle', 'row 7 Handle']],
    ]);
    // No context by default, so the old shape holds.
    const plain = (await call(grepModule, r, { repo: REPO, pattern: 'HandleTransfer', path_glob: 'src/*.go' })).output.data as GrepData;
    expect(plain.matches[0]).toEqual({ path: 'src/app.go', line: 10, text: 'func HandleTransfer(ctx Context) error {' });
  });

  test('deny: context_lines over 5, both list modes, and context with a list mode are refused with the reason', async () => {
    const r = rig();
    const tool = grepModule.create(r.ctx, 'code_walker');
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, pattern: 'x', context_lines: 6 }).success).toBe(false);
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, pattern: 'x', context_lines: -1 }).success).toBe(false);
    const both = await call(grepModule, r, { repo: REPO, pattern: 'x', files_only: true, count_only: true });
    expect(both.output).toMatchObject({ status: 'refused' });
    expect(JSON.stringify(both.output)).toContain('files_only and count_only');
    const ctx = await call(grepModule, r, { repo: REPO, pattern: 'x', count_only: true, context_lines: 1 });
    expect(JSON.stringify(ctx.output)).toContain('context_lines applies to matching lines only');
    expect(r.audit.lines.slice(-2).map((l) => l.reason)).toEqual(['grep: both modes', 'grep: context with a list mode']);
  });
});

describe('repo_find', () => {
  test('allow: a name glob finds paths anywhere, in path order, skipping dot paths and outside links', async () => {
    const r = rig();
    const env = await call(findModule, r, { repo: REPO, glob: '*.go' });
    expect(env.output.status).toBe('ok');
    const d = env.output.data as FindData;
    expect(d.paths).toEqual(['link-ok.go', 'src/app.go', 'src/util/strings.go', 'src/util/strings_test.go']);
    expect(d).toMatchObject({ offset: 0, next_offset: null, truncated: false });
    const all = (await call(findModule, r, { repo: REPO, glob: '**', limit: 200 })).output.data as FindData;
    for (const p of all.paths) {
      expect(p.split('/').some((s) => s.startsWith('.'))).toBe(false);
      expect(p.startsWith('linkdir')).toBe(false);
      expect(['link-out.txt', 'link-git.txt']).not.toContain(p);
    }
    expect(JSON.stringify(all)).not.toContain(MARKER);
    expect(r.audit.lines[0]).toMatchObject({ tool: 'repo_find', decision: 'allow', transport: 'mock' });
  });

  test('pages with offset and limit, and says where the next page starts', async () => {
    const r = rig();
    const first = (await call(findModule, r, { repo: REPO, glob: 'src/**/*.go', limit: 2 })).output.data as FindData;
    expect(first).toMatchObject({ paths: ['src/app.go', 'src/util/strings.go'], next_offset: 2, truncated: true });
    expect(first.notes.join(' ')).toContain('offset 2');
    const second = (await call(findModule, r, { repo: REPO, glob: 'src/**/*.go', limit: 2, offset: 2 })).output.data as FindData;
    expect(second).toMatchObject({ paths: ['src/util/strings_test.go'], next_offset: null, truncated: false });
    const tool = findModule.create(r.ctx, 'code_walker');
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, glob: '*', limit: 201 }).success).toBe(false);
  });

  test('a walk cap marks the result truncated with the reason', async () => {
    const out = await findPaths(reposDir, { repo: REPO, glob: '**' }, undefined, { maxWalkEntries: 3 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const d = out.data as FindData;
    expect(d.truncated).toBe(true);
    expect(d.next_offset).toBeNull();
    expect(d.notes.join(' ')).toContain('3 directory entries');
  });

  test('deny: a glob into a dot-directory, with .. or absolute is refused; a missing directory says so', async () => {
    const r = rig();
    for (const glob of ['.git/**', '**/.env', '../**', '/etc/*', 'src/*;rm']) {
      const env = await call(findModule, r, { repo: REPO, glob });
      expect(env.output.status).toBe('refused');
      // The refusal names this tool's input, not repo_grep's path_glob.
      expect(env.output.message).toMatch(/^glob /);
    }
    expect(r.audit.lines.every((l) => l.decision === 'deny')).toBe(true);
    const missing = (await call(findModule, r, { repo: REPO, glob: 'nope/**/*.go' })).output.data as FindData;
    expect(missing.paths).toEqual([]);
    expect(missing.notes.join(' ')).toContain('repo_tree');
  });

  test('a glob with no wildcard that matches nothing says it matches whole names', async () => {
    const d = (await call(findModule, rig(), { repo: REPO, glob: 'strings' })).output.data as FindData;
    expect(d.paths).toEqual([]);
    expect(d.notes.join(' ')).toContain("try '*strings*'");
  });
});

describe('repo_tree', () => {
  test('depth 1 is ls: directories end in / with counts, dot names and outside links are left out', async () => {
    const r = rig();
    const env = await call(treeModule, r, { repo: REPO, depth: 1 });
    expect(env.output.status).toBe('ok');
    const d = env.output.data as TreeData;
    expect(d.entries.map((e) => e.path)).toEqual(['bin/', 'docs/', 'link-ok.go', 'slow/', 'src/']);
    expect(d.entries.find((e) => e.path === 'src/')).toEqual({ path: 'src/', files: 2, dirs: 1 });
    expect(d.truncated).toBe(false);
    expect(JSON.stringify(env)).not.toContain(MARKER);
    expect(r.audit.lines[0]).toMatchObject({ tool: 'repo_tree', decision: 'allow' });
  });

  test('depth reaches down from path, and paths stay relative to the repo root', async () => {
    const r = rig();
    const two = (await call(treeModule, r, { repo: REPO, path: 'src' })).output.data as TreeData;
    expect(two.depth).toBe(2);
    expect(two.entries.map((e) => e.path)).toEqual(['src/app.go', 'src/big.txt', 'src/util/', 'src/util/strings.go', 'src/util/strings_test.go']);
    const one = (await call(treeModule, r, { repo: REPO, path: 'src', depth: 1 })).output.data as TreeData;
    expect(one.entries.map((e) => e.path)).toEqual(['src/app.go', 'src/big.txt', 'src/util/']);
    const tool = treeModule.create(r.ctx, 'code_walker');
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, depth: 5 }).success).toBe(false);
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: REPO, depth: 0 }).success).toBe(false);
  });

  test('the entry cap keeps the shallow levels and says how to see the rest', async () => {
    const r = rig();
    const d = (await call(treeModule, r, { repo: REPO, depth: 4, limit: 5 })).output.data as TreeData;
    expect(d.entries.map((e) => e.path)).toEqual(['bin/', 'docs/', 'link-ok.go', 'slow/', 'src/']);
    expect(d.truncated).toBe(true);
    expect(d.notes.join(' ')).toContain('raise limit (up to 500)');
  });

  test('deny: .., dot paths and a file are refused with a pointer to the right tool', async () => {
    const r = rig();
    for (const path of ['..', 'src/../..', '.git', '.github/workflows', '/etc', 'linkdir']) {
      expect((await call(treeModule, r, { repo: REPO, path })).output.status).toBe('refused');
    }
    const file = await call(treeModule, r, { repo: REPO, path: 'src/app.go' });
    expect(JSON.stringify(file.output)).toContain('repo_read');
    expect(r.audit.lines.every((l) => l.decision === 'deny')).toBe(true);
    const missing = await call(readModule, r, { repo: REPO, path: 'src/nope.go' });
    expect(JSON.stringify(missing.output)).toContain('repo_find');
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

// ------------------------------------------------------------------ repo docs (W11, D83)

describe('repo docs', () => {
  const DOCS_REPO = 'audit';
  const docsRepo = (): string => join(reposDir, DOCS_REPO);
  const putDoc = (rel: string, text: string): void => {
    const path = join(docsRepo(), rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  // 91-byte lines: each file cuts to 8,189 bytes, so two leave no room for the root file.
  const line = 'x'.repeat(90);

  beforeAll(() => {
    putDoc('AGENTS.md', 'root agents\n');
    putDoc('a/AGENTS.md', 'a agents\n');
    putDoc('a/b/CLAUDE.md', 'a/b claude\n');
    putDoc('a/b/x.go', 'needle one\n');
    putDoc('a/c/AGENTS.md', 'sibling agents\n');
    putDoc('a/c/y.go', 'needle two\n');
    putDoc('sym/AGENTS.md', 'sym agents\n');
    symlinkSync(join(docsRepo(), 'sym', 'AGENTS.md'), join(docsRepo(), 'sym', 'CLAUDE.md'));
    putDoc('sym/z.go', 'z\n');
    putDoc('imp/CLAUDE.md', '@AGENTS.md\n');
    putDoc('imp/AGENTS.md', 'imp agents\n');
    putDoc('imp/f.go', 'f\n');
    putDoc('big/AGENTS.md', `${Array.from({ length: 120 }, () => line).join('\n')}\n`);
    putDoc('big/deep/AGENTS.md', `${Array.from({ length: 120 }, () => line).join('\n')}\n`);
    putDoc('big/deep/f.go', 'f\n');
    mkdirSync(join(docsRepo(), 'rf'), { recursive: true });
    symlinkSync(join(base, 'outside', 'secret.txt'), join(docsRepo(), 'rf', 'AGENTS.md'));
    putDoc('rf/f.go', 'f\n');
  });

  type Docs = { repo_docs?: { path: string; text: string; truncated: boolean }[]; docs_to_read?: string[]; repo_docs_notes?: string[] };
  const docsOf = async (module: ToolModule, r: Rig, data: unknown): Promise<Docs> => {
    const env = await call(module, r, { repo: DOCS_REPO, ...(data as object) });
    expect(env.output.status).toBe('ok');
    return env.output.data as Docs;
  };
  const paths = (d: Docs): string[] | undefined => d.repo_docs?.map((x) => x.path);

  test('a first read attaches the chain root first, a second attaches nothing, a new delegate gets them again', async () => {
    const r = rig();
    const first = await docsOf(readModule, r, { path: 'a/b/x.go' });
    expect(paths(first)).toEqual(['AGENTS.md', 'a/AGENTS.md', 'a/b/CLAUDE.md']);
    expect(first.repo_docs?.[0]).toEqual({ path: 'AGENTS.md', text: 'root agents\n', truncated: false });
    expect(JSON.stringify(first)).not.toContain('sibling agents');
    expect((await docsOf(readModule, r, { path: 'a/b/x.go' })).repo_docs).toBeUndefined();
    // The sibling gets only its own file; the shared chain was sent already.
    expect(paths(await docsOf(readModule, r, { path: 'a/c/y.go' }))).toEqual(['a/c/AGENTS.md']);
    expect(paths(await docsOf(readModule, rig(), { path: 'a/b/x.go' }))).toEqual(['AGENTS.md', 'a/AGENTS.md', 'a/b/CLAUDE.md']);
  });

  test('repo_tree and repo_find attach the chain of their base directory', async () => {
    const r = rig();
    expect(paths(await docsOf(treeModule, r, { path: 'a', depth: 1 }))).toEqual(['AGENTS.md', 'a/AGENTS.md']);
    expect(paths(await docsOf(findModule, r, { glob: 'a/b/**' }))).toEqual(['a/b/CLAUDE.md']);
    // A name glob has no leading directory, so only the root chain applies.
    expect(paths(await docsOf(findModule, rig(), { glob: '*.go' }))).toEqual(['AGENTS.md']);
  });

  test('repo_grep attaches only the root file and lists the doc files on the matched chains', async () => {
    const r = rig();
    const d = await docsOf(grepModule, r, { pattern: 'needle' });
    expect(paths(d)).toEqual(['AGENTS.md']);
    expect(d.docs_to_read).toEqual(['a/AGENTS.md', 'a/b/CLAUDE.md', 'a/c/AGENTS.md']);
    expect(JSON.stringify(d)).not.toContain('a agents');
    expect((await docsOf(grepModule, r, { pattern: 'needle', files_only: true })).repo_docs).toBeUndefined();
  });

  test('repo_read of a listed doc file leaves it out of repo_docs and marks it sent', async () => {
    const r = rig();
    await docsOf(grepModule, r, { pattern: 'needle' });
    const d = (await docsOf(readModule, r, { path: 'a/b/CLAUDE.md' })) as Docs & ReadData;
    expect(d.text).toContain('a/b claude');
    expect(paths(d)).toEqual(['a/AGENTS.md']);
    expect((await docsOf(readModule, r, { path: 'a/b/x.go' })).repo_docs).toBeUndefined();
  });

  test('a doc file the jail refuses is noted once per task', async () => {
    const r = rig();
    const first = await docsOf(readModule, r, { path: 'rf/f.go' });
    expect((first.repo_docs_notes ?? []).join(' ')).toContain('rf/AGENTS.md not attached');
    expect(JSON.stringify(first)).not.toContain(MARKER);
    expect((await docsOf(readModule, r, { path: 'rf/f.go' })).repo_docs_notes).toBeUndefined();
  });

  test('a result the byte budget refuses leaves its docs unsent', async () => {
    const plain = await readRange(reposDir, { repo: DOCS_REPO, path: 'a/b/x.go' });
    if (!plain.ok) throw new Error('plain read failed');
    const r = rig({ maxBytesPerRun: Buffer.byteLength(JSON.stringify(plain.data)) + 20 });
    const env = await call(readModule, r, { repo: DOCS_REPO, path: 'a/b/x.go' });
    expect(env.output.status).toBe('refused');
    expect(r.audit.lines.at(-1)).toMatchObject({ decision: 'deny', reason: 'budget: bytes' });
    const again = await repoDocsFor(r.ctx, { repo: DOCS_REPO, dir: 'a/b' });
    expect((again.fields.repo_docs as { path: string }[]).map((x) => x.path)).toEqual(['AGENTS.md', 'a/AGENTS.md', 'a/b/CLAUDE.md']);
  });

  test('a symlinked CLAUDE.md counts once, and one that only imports AGENTS.md is skipped', async () => {
    const r = rig();
    expect(paths(await docsOf(readModule, r, { path: 'sym/z.go' }))).toEqual(['AGENTS.md', 'sym/AGENTS.md']);
    expect(paths(await docsOf(readModule, r, { path: 'imp/f.go' }))).toEqual(['imp/AGENTS.md']);
  });

  test('caps: 8 KB per file and 16 KB per result, nearest first; a pending file comes with the next call', async () => {
    const r = rig();
    const d = await docsOf(readModule, r, { path: 'big/deep/f.go' });
    expect(paths(d)).toEqual(['big/AGENTS.md', 'big/deep/AGENTS.md']);
    for (const doc of d.repo_docs ?? []) {
      expect(doc.truncated).toBe(true);
      expect(Buffer.byteLength(doc.text)).toBeLessThanOrEqual(8 * 1024);
    }
    const notes = (d.repo_docs_notes ?? []).join(' ');
    expect(notes).toContain('cut at 8 KB');
    expect(notes).toContain('not attached');
    expect(notes).toContain('AGENTS.md;');
    expect(paths(await docsOf(treeModule, r, { depth: 1 }))).toEqual(['AGENTS.md']);
  });
});
