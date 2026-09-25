import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from '@flue/runtime/tool';
import { parse } from 'dotenv';
import * as v from 'valibot';
import { releaseEscalation } from '../../agents/escalation.ts';
import { configFromRecord, type Config } from '../../config/env.ts';
import { loadRegistry, type Registry } from '../../config/registry.ts';
import {
  checkQueryText,
  type CodegraphConnector,
  codegraphArgv,
  createCodegraphConnector,
} from '../../connectors/codegraph.ts';
import { createFakeRunner, type FakeRunner, type FakeStep } from '../../connectors/exec-fake.ts';
import { ConnectorError } from '../../connectors/types.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../gate/audit-sink.ts';
import { releaseRunBudget } from '../../gate/budget.ts';
import { FixtureMissError } from '../../mock/errors.ts';
import { keyHash, keyString, semanticKey } from '../../mock/key.ts';
import type { CodeQueryCommand } from '../../mock/types.ts';
import type { RunStore } from '../../runstore/types.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../types/tool-result.ts';
import { createToolDeps } from '../_lib/context.ts';
import type { Mount, ToolContext, ToolModule } from '../types.ts';
import { toolModule as explore } from './code-explore.tool.ts';
import { toolModule as impact } from './code-impact.tool.ts';
import { toolModule as node } from './code-node.tool.ts';
import { CODE_OUTPUT_MAX_CHARS, codeRepoNames } from './codegraph-tool.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const FIXED_NOW = new Date('2026-09-23T10:00:00.000Z');
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const TOOLS: readonly { module: ToolModule; command: CodeQueryCommand; field: 'query' | 'symbol'; value: string }[] = [
  { module: explore, command: 'explore', field: 'query', value: 'transfer reversal webhook' },
  { module: node, command: 'node', field: 'symbol', value: 'TransferService.Reverse' },
  { module: impact, command: 'impact', field: 'symbol', value: 'ReverseTransfer' },
];

// ------------------------------------------------------------------ setup

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let seq = 0;

type World = {
  root: string;
  reposDir: string;
  fixturesDir: string;
  config: Config;
  registry: Registry;
};

type WorldOptions = {
  mock?: boolean;
  env?: Record<string, string>;
  /** Repos to check out, with or without an index. */
  repos?: Record<string, boolean>;
};

function makeWorld(opts: WorldOptions = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'cg-tools-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  cpSync(join(ROOT, 'resources'), join(home, 'resources'), { recursive: true });
  const reposDir = join(root, 'repos');
  mkdirSync(reposDir);
  for (const [repo, indexed] of Object.entries(opts.repos ?? { harbor: true })) {
    mkdirSync(join(reposDir, repo, '.codegraph'), { recursive: true });
    if (indexed) writeFileSync(join(reposDir, repo, '.codegraph', 'codegraph.db'), '');
  }
  const fixturesDir = join(root, 'fixtures');
  mkdirSync(fixturesDir);
  const record: Record<string, string> = {
    ...parse(readFileSync(join(ROOT, '.env.example'), 'utf8')),
    TRIAGE_MOCK_MODE: opts.mock === true ? 'true' : 'false',
    TRIAGE_MOCK_STRICT: 'true',
    TRIAGE_RECORD_FIXTURES: 'false',
    TRIAGE_REPOS_DIR: reposDir,
    TRIAGE_FIXTURES_DIR: fixturesDir,
    CODEGRAPH_BIN: 'codegraph',
    CODEGRAPH_SYNC_BEFORE_QUERY: 'true',
    ...opts.env,
  };
  const config = configFromRecord(record, home);
  return { root, reposDir, fixturesDir, config, registry: loadRegistry(config) };
}

type Run = { ctx: ToolContext; audit: MemoryAuditSink };

function makeRun(world: World, connector: CodegraphConnector | undefined, entity: ToolContext['entity'] = null): Run {
  seq += 1;
  const runId = `run_cg_${seq}_${Math.random().toString(36).slice(2, 8)}`;
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
  });
  const audit = createMemoryAuditSink();
  const deps = createToolDeps({
    runId,
    config: world.config,
    registry: world.registry,
    interface: 'cli',
    idChain: { ids: {}, hops: [], basic_state: [] },
    connectors: connector !== undefined ? { codegraph: connector } : {},
    runStore: {} as RunStore,
    audit,
    now: () => FIXED_NOW,
  });
  return { ctx: Object.freeze({ runId, entity, config: world.config, registry: world.registry, deps }), audit };
}

/** Wraps a connector to count createSyncOnce and ensureSynced calls. */
function counting(inner: CodegraphConnector): CodegraphConnector & { guards: number; syncs: string[] } {
  const spy = {
    guards: 0,
    syncs: [] as string[],
    createSyncOnce() {
      spy.guards += 1;
      const guard = inner.createSyncOnce();
      return {
        ensureSynced(repo: string) {
          spy.syncs.push(repo);
          return guard.ensureSynced(repo);
        },
      };
    },
    query: inner.query,
  };
  return spy;
}

const log = { info: () => {}, warn: () => {}, error: () => {} };

async function call(tool: ToolDefinition, data: Record<string, unknown>, signal?: AbortSignal): Promise<ToolEnvelope> {
  const result = await tool.run({ data, toolCallId: 'toolu_cg_1', log, ...(signal ? { signal } : {}) } as never);
  const env = result as ToolEnvelope;
  expect(v.is(ToolEnvelopeSchema, env)).toBe(true);
  return env;
}

function repoDir(world: World, repo = 'harbor'): string {
  return realpathSync(join(world.reposDir, repo));
}

function syncStep(dir: string): FakeStep {
  return { bin: 'codegraph', argv: ['sync', dir] };
}

function gitStep(dir: string): FakeStep {
  return { bin: 'git', argv: ['-C', dir, 'rev-parse', '--verify', 'HEAD'], result: { stdout: `${COMMIT}\n` } };
}

function queryStep(dir: string, command: string, value: string, stdout: string): FakeStep {
  return { bin: 'codegraph', argv: [command, '-p', dir, '--', value], result: { stdout } };
}

function data(env: ToolEnvelope): Record<string, unknown> {
  expect(env.output.status).toBe('ok');
  return env.output.data as Record<string, unknown>;
}

// ------------------------------------------------------------------ module shape

describe('module shape', () => {
  test('four tools, mounted on code_walker and investigator_deep, named after their files', () => {
    expect(TOOLS.map((t) => t.module.name)).toEqual(['code_explore', 'code_node', 'code_impact']);
    for (const { module } of TOOLS) {
      expect([...module.mounts]).toEqual(['code_walker', 'investigator_deep']);
      expect(module.entities).toBe('all');
    }
  });

  test('input is { repo, query|symbol } with no path, entity or run id field', () => {
    const world = makeWorld();
    const { ctx } = makeRun(world, undefined);
    for (const { module, field } of TOOLS) {
      const tool = module.create(ctx, 'code_walker');
      const entries = (tool.input as unknown as { entries: Record<string, unknown> }).entries;
      expect(Object.keys(entries).sort()).toEqual([field, 'repo'].sort());
      expect(tool.name).toBe(module.name);
    }
  });

  test('the repo picklist comes from resources/repos.json and narrows to the investigator entity', () => {
    const world = makeWorld();
    const pins = JSON.parse(readFileSync(join(ROOT, 'resources', 'repos.json'), 'utf8')) as { repo: string; entities: string[] }[];
    const enabled = world.registry.enabledEntities();
    const all = pins.filter((p) => p.entities.some((e) => enabled.includes(e as never))).map((p) => p.repo).sort();
    expect(codeRepoNames({ config: world.config, registry: world.registry, entity: null })).toEqual(all);

    const atspl = codeRepoNames({ config: world.config, registry: world.registry, entity: 'atspl' });
    expect(atspl).toContain('pulse-backend');
    expect(atspl).toContain('go-commons');
    expect(atspl).not.toContain('harbor');

    const { ctx } = makeRun(world, undefined, 'atspl');
    const tool = explore.create(ctx, 'investigator_deep');
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: 'pulse-backend', query: 'x' }).success).toBe(true);
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: 'harbor', query: 'x' }).success).toBe(false);
  });

  test('enabled() and create() never touch ctx.deps', () => {
    const world = makeWorld();
    const trap = new Proxy({}, { get: () => { throw new Error('deps read'); } });
    const ctx = Object.freeze({ runId: 'run_x', entity: null, config: world.config, registry: world.registry, deps: trap as never });
    for (const { module } of TOOLS) {
      for (const mount of ['code_walker', 'investigator_deep'] as Mount[]) {
        const c = mount === 'code_walker' ? ctx : { ...ctx, entity: 'ssfb' as const };
        expect(module.enabled(c, mount)).toEqual({ on: true });
        module.create(c, mount);
      }
    }
  });
});

// ------------------------------------------------------------------ argv per tool

describe('argv shape per tool (fake runner)', () => {
  for (const t of TOOLS) {
    test(`${t.module.name} runs [${t.command}, -p, <repos dir>/harbor, --, value] and returns the commit`, async () => {
      const world = makeWorld();
      const dir = repoDir(world);
      const runner = createFakeRunner([
        syncStep(dir),
        queryStep(dir, t.command, t.value, `${dir}/internal/transfer/reverse.go:42 ReverseTransfer\n`),
        gitStep(dir),
      ]);
      const { ctx, audit } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
      const env = await call(t.module.create(ctx, 'code_walker'), { repo: 'harbor', [t.field]: t.value });

      expect(runner.calls.map((c) => [c.bin, ...c.argv])).toEqual([
        ['codegraph', 'sync', dir],
        ['codegraph', t.command, '-p', dir, '--', t.value],
        ['git', '-C', dir, 'rev-parse', '--verify', 'HEAD'],
      ]);
      const out = data(env);
      expect(out).toMatchObject({
        repo: 'harbor',
        command: t.command,
        [t.field]: t.value,
        commit: COMMIT,
        truncated: false,
        index_sync: 'ok',
      });
      // Absolute repo paths are cut out.
      expect(out['output']).toBe('internal/transfer/reverse.go:42 ReverseTransfer\n');
      expect(env.output.taken_at).toBe(FIXED_NOW.toISOString());

      expect(audit.lines).toHaveLength(1);
      expect(audit.lines[0]).toMatchObject({
        tool: t.module.name,
        decision: 'allow',
        service: 'code:harbor',
        target: 'CODEGRAPH_BIN',
        transport: 'real',
        exit: 'ok',
      });
    });
  }

  test('a non-zero exit comes back as data with the exit code', async () => {
    const world = makeWorld({ env: { CODEGRAPH_SYNC_BEFORE_QUERY: 'false' } });
    const dir = repoDir(world);
    const runner = createFakeRunner([
      { bin: 'codegraph', argv: ['node', '-p', dir, '--', 'Nope'], result: { exitCode: 1, stdout: 'symbol not found\n' } },
      gitStep(dir),
    ]);
    const { ctx } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
    const out = data(await call(node.create(ctx, 'code_walker'), { repo: 'harbor', symbol: 'Nope' }));
    expect(out).toMatchObject({ exit_code: 1, output: 'symbol not found\n' });
    expect(out['index_sync']).toBeUndefined();
  });

  test('output is capped for the model and marked truncated', async () => {
    const world = makeWorld({ env: { CODEGRAPH_SYNC_BEFORE_QUERY: 'false' } });
    const dir = repoDir(world);
    const big = 'x'.repeat(CODE_OUTPUT_MAX_CHARS + 5000);
    const runner = createFakeRunner([queryStep(dir, 'explore', 'q', big), gitStep(dir)]);
    const { ctx } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
    const out = data(await call(explore.create(ctx, 'code_walker'), { repo: 'harbor', query: 'q' }));
    expect((out['output'] as string).length).toBeLessThanOrEqual(CODE_OUTPUT_MAX_CHARS);
    expect(out['truncated']).toBe(true);
  });

  test('a spawn failure is unreachable, and git failing leaves commit null', async () => {
    const world = makeWorld({ env: { CODEGRAPH_SYNC_BEFORE_QUERY: 'false' } });
    const dir = repoDir(world);
    const enoent = createFakeRunner([{ bin: 'codegraph', argv: ['impact', '-p', dir, '--', 'X'], result: { exitCode: null, spawnError: 'ENOENT' } }]);
    const r1 = makeRun(world, createCodegraphConnector({ config: world.config, runner: enoent }));
    const env = await call(impact.create(r1.ctx, 'code_walker'), { repo: 'harbor', symbol: 'X' });
    expect(env.output.status).toBe('unreachable');

    const noGit = createFakeRunner([
      queryStep(dir, 'impact', 'X', 'ok\n'),
      { bin: 'git', argv: ['-C', dir, 'rev-parse', '--verify', 'HEAD'], result: { exitCode: 128 } },
    ]);
    const r2 = makeRun(world, createCodegraphConnector({ config: world.config, runner: noGit }));
    expect(data(await call(impact.create(r2.ctx, 'code_walker'), { repo: 'harbor', symbol: 'X' }))['commit']).toBeNull();
  });

  test('an aborted signal throws before anything runs', async () => {
    const world = makeWorld();
    const runner = createFakeRunner([]);
    const { ctx } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
    const ac = new AbortController();
    ac.abort();
    await expect(call(explore.create(ctx, 'code_walker'), { repo: 'harbor', query: 'q' }, ac.signal)).rejects.toThrow();
    expect(runner.calls).toHaveLength(0);
    expect(runner.unscripted).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ deny paths

const BAD_VALUES: readonly [string, string][] = [
  ['leading dash', '--output=/etc/x'],
  ['leading dash after spaces', '  -rf'],
  ['semicolon', 'a;rm'],
  ['pipe', 'a|b'],
  ['command substitution', '$(x)'],
  ['backtick', '`x`'],
  ['newline', 'a\nb'],
  ['carriage return', 'a\rb'],
  ['NUL', 'a\u0000b'],
  ['ampersand', 'a&b'],
  ['tab (control character)', 'a\tb'],
  ['blank', '   '],
];

describe('deny: query and symbol charset', () => {
  for (const [label, value] of BAD_VALUES) {
    test(`${label} is refused before any exec`, async () => {
      const world = makeWorld();
      const runner = createFakeRunner([]);
      const connector = counting(createCodegraphConnector({ config: world.config, runner }));
      const { ctx, audit } = makeRun(world, connector);
      for (const { module, field } of TOOLS) {
        const env = await call(module.create(ctx, 'code_walker'), { repo: 'harbor', [field]: value });
        expect(env.output.status).toBe('refused');
        expect(env.output.message).toContain(`Refused: ${field}`);
      }
      expect(runner.calls).toHaveLength(0);
      expect(runner.unscripted).toHaveLength(0);
      expect(connector.syncs).toHaveLength(0);
      expect(audit.lines.map((l) => l.decision)).toEqual(TOOLS.map(() => 'deny'));
    });
  }

  test('checkQueryText accepts plain phrases and symbols', () => {
    for (const ok of ['transfer reversal webhook', 'TransferService.Reverse', 'a-b', 'pkg/transfer.Reverse', 'x > 1', 'Foo$Bar']) {
      expect(checkQueryText(ok)).toEqual({ ok: true });
    }
    expect(checkQueryText('x'.repeat(301)).ok).toBe(false);
    expect(checkQueryText(42).ok).toBe(false);
  });

  test('the refusal reason never echoes the value', () => {
    const r = checkQueryText('secret;value');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain('secret');
  });

  test('codegraphArgv refuses a bad value itself', () => {
    expect(() => codegraphArgv('explore', '/repos/harbor', '-x')).toThrow(ConnectorError);
    expect(codegraphArgv('explore', '/repos/harbor', 'q')).toEqual(['explore', '-p', '/repos/harbor', '--', 'q']);
  });
});

describe('deny: unknown repo', () => {
  test('the picklist refuses a repo outside resources/repos.json and a path', () => {
    const world = makeWorld();
    const { ctx } = makeRun(world, undefined);
    const tool = explore.create(ctx, 'code_walker');
    for (const repo of ['not-a-repo', '../harbor', '/etc', 'harbor/../../x']) {
      expect(v.safeParse(tool.input as v.GenericSchema, { repo, query: 'q' }).success).toBe(false);
    }
    expect(v.safeParse(tool.input as v.GenericSchema, { repo: 'harbor', query: 'q', path: '/etc' }).output).not.toHaveProperty('path');
  });

  test('run() refuses an unknown repo that got past the schema, with no exec', async () => {
    const world = makeWorld();
    const runner = createFakeRunner([]);
    const { ctx, audit } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
    for (const { module, field } of TOOLS) {
      const env = await call(module.create(ctx, 'code_walker'), { repo: '../../etc', [field]: 'x' });
      expect(env.output.status).toBe('refused');
      expect(env.output.message).not.toContain('etc');
    }
    expect(runner.calls).toHaveLength(0);
    expect(audit.lines.every((l) => l.decision === 'deny' && l.service === 'code:unknown')).toBe(true);
  });

  test('a repo of another entity is refused on investigator_deep', async () => {
    const world = makeWorld();
    const runner = createFakeRunner([]);
    const { ctx } = makeRun(world, createCodegraphConnector({ config: world.config, runner }), 'rtl');
    const env = await call(explore.create(ctx, 'investigator_deep'), { repo: 'harbor', query: 'q' });
    expect(env.output.status).toBe('refused');
    expect(runner.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ sync once

describe('sync once per repo per run', () => {
  test('two queries on one repo call ensureSynced once and run sync once', async () => {
    const world = makeWorld();
    const dir = repoDir(world);
    const runner = createFakeRunner([
      syncStep(dir),
      queryStep(dir, 'explore', 'q', 'a\n'),
      queryStep(dir, 'impact', 'ReverseTransfer', 'b\n'),
      gitStep(dir),
    ]);
    const connector = counting(createCodegraphConnector({ config: world.config, runner }));
    const { ctx } = makeRun(world, connector);
    await call(explore.create(ctx, 'code_walker'), { repo: 'harbor', query: 'q' });
    await call(impact.create(ctx, 'code_walker'), { repo: 'harbor', symbol: 'ReverseTransfer' });

    expect(connector.syncs).toEqual(['harbor']);
    expect(connector.guards).toBe(1);
    expect(runner.calls.filter((c) => c.argv[0] === 'sync')).toHaveLength(1);
  });

  test('concurrent first queries share one sync', async () => {
    const world = makeWorld();
    const dir = repoDir(world);
    const runner = createFakeRunner([syncStep(dir), queryStep(dir, 'node', 'A', 'a'), queryStep(dir, 'impact', 'A', 'b'), gitStep(dir)]);
    const connector = counting(createCodegraphConnector({ config: world.config, runner }));
    const { ctx } = makeRun(world, connector);
    await Promise.all([
      call(node.create(ctx, 'code_walker'), { repo: 'harbor', symbol: 'A' }),
      call(impact.create(ctx, 'code_walker'), { repo: 'harbor', symbol: 'A' }),
    ]);
    expect(connector.syncs).toEqual(['harbor']);
    expect(runner.calls.filter((c) => c.argv[0] === 'sync')).toHaveLength(1);
  });

  test('each repo syncs once, and a new run syncs again', async () => {
    const world = makeWorld({ repos: { harbor: true, rhythm: true } });
    const h = repoDir(world, 'harbor');
    const r = repoDir(world, 'rhythm');
    const runner = createFakeRunner([
      syncStep(h),
      syncStep(r),
      queryStep(h, 'explore', 'q', 'a'),
      queryStep(r, 'explore', 'q', 'b'),
      gitStep(h),
      gitStep(r),
    ]);
    const connector = counting(createCodegraphConnector({ config: world.config, runner }));
    const run1 = makeRun(world, connector);
    await call(explore.create(run1.ctx, 'code_walker'), { repo: 'harbor', query: 'q' });
    await call(explore.create(run1.ctx, 'code_walker'), { repo: 'rhythm', query: 'q' });
    await call(explore.create(run1.ctx, 'code_walker'), { repo: 'harbor', query: 'q' });
    expect(connector.syncs).toEqual(['harbor', 'rhythm']);

    const run2 = makeRun(world, connector);
    await call(explore.create(run2.ctx, 'code_walker'), { repo: 'harbor', query: 'q' });
    expect(connector.syncs).toEqual(['harbor', 'rhythm', 'harbor']);
    expect(runner.calls.filter((c) => c.argv[0] === 'sync').map((c) => c.argv[1])).toEqual([h, r, h]);
  });

  test('CODEGRAPH_SYNC_BEFORE_QUERY=false never calls ensureSynced', async () => {
    const world = makeWorld({ env: { CODEGRAPH_SYNC_BEFORE_QUERY: 'false' } });
    const dir = repoDir(world);
    const runner = createFakeRunner([queryStep(dir, 'explore', 'q', 'a'), gitStep(dir)]);
    const connector = counting(createCodegraphConnector({ config: world.config, runner }));
    const { ctx } = makeRun(world, connector);
    await call(explore.create(ctx, 'code_walker'), { repo: 'harbor', query: 'q' });
    expect(connector.syncs).toHaveLength(0);
    expect(runner.calls.some((c) => c.argv[0] === 'sync')).toBe(false);
  });
});

// ------------------------------------------------------------------ mock mode

function writeFixture(world: World, repo: string, command: CodeQueryCommand, query: string, result: unknown): void {
  const key = semanticKey('code_query', { repo, command, query });
  const dir = join(world.fixturesDir, 'shared', 'code_query', 'global');
  mkdirSync(dir, { recursive: true });
  const body = {
    schema: 1,
    kind: 'code_query',
    entity: 'global',
    key,
    key_string: keyString(key),
    result,
    meta: { source: 'hand', recorded_at: '2026-09-23T10:00:00.000Z' },
  };
  writeFileSync(join(dir, `${keyHash(key)}.json`), JSON.stringify(body));
}

describe('mock mode', () => {
  test('answers from the fixture keyed by repo, command and query, with no exec and no sync', async () => {
    const world = makeWorld({ mock: true });
    writeFixture(world, 'harbor', 'impact', 'ReverseTransfer', {
      output: 'internal/transfer/handler.go:88 HandleReversal\n',
      truncated: false,
      commit: COMMIT,
    });
    const runner = createFakeRunner([]);
    const connector = counting(createCodegraphConnector({ config: world.config, runner }));
    const { ctx, audit } = makeRun(world, connector);

    // Surrounding spaces normalise to the same key.
    const out = data(await call(impact.create(ctx, 'code_walker'), { repo: 'harbor', symbol: ' ReverseTransfer ' }));
    expect(out).toMatchObject({
      repo: 'harbor',
      command: 'impact',
      commit: COMMIT,
      output: 'internal/transfer/handler.go:88 HandleReversal\n',
    });
    expect(runner.calls).toHaveLength(0);
    expect(runner.unscripted).toHaveLength(0);
    expect(connector.guards).toBe(0);
    expect(connector.syncs).toHaveLength(0);
    expect(audit.lines[0]).toMatchObject({ transport: 'mock', decision: 'allow' });
  });

  test('mock mode does not need TRIAGE_REPOS_DIR or a checkout', async () => {
    const world = makeWorld({ mock: true, env: { TRIAGE_REPOS_DIR: '' }, repos: {} });
    writeFixture(world, 'rhythm', 'explore', 'q', { output: 'x' });
    const runner = createFakeRunner([]);
    const { ctx } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
    const out = data(await call(explore.create(ctx, 'code_walker'), { repo: 'rhythm', query: 'q' }));
    expect(out).toMatchObject({ output: 'x', commit: null, truncated: false });
    expect(runner.calls).toHaveLength(0);
  });

  test('a strict miss throws and names the fixture kind', async () => {
    const world = makeWorld({ mock: true });
    const runner = createFakeRunner([]);
    const { ctx } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
    await expect(call(node.create(ctx, 'code_walker'), { repo: 'harbor', symbol: 'Missing' })).rejects.toThrow(FixtureMissError);
    expect(runner.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ not configured

describe('not configured', () => {
  for (const mock of [true, false]) {
    test(`blank CODEGRAPH_BIN answers not configured for code:<repo> (${mock ? 'mock' : 'real'} mode)`, async () => {
      const world = makeWorld({ mock, env: { CODEGRAPH_BIN: '' } });
      const runner = createFakeRunner([]);
      const connector = counting(createCodegraphConnector({ config: world.config, runner }));
      const { ctx, audit } = makeRun(world, connector);
      for (const { module, field, value } of TOOLS) {
        const env = await call(module.create(ctx, 'code_walker'), { repo: 'harbor', [field]: value });
        expect(env.output.status).toBe('not_configured');
        expect(env.output.message).toBe('not configured for code:harbor');
      }
      expect(runner.calls).toHaveLength(0);
      expect(connector.syncs).toHaveLength(0);
      expect(audit.lines.every((l) => l.exit === 'not_configured' && l.target === 'CODEGRAPH_BIN')).toBe(true);
    });
  }

  test('a repo without an index answers not configured and runs no query', async () => {
    const world = makeWorld({ repos: { harbor: false } });
    const runner = createFakeRunner([]);
    const { ctx } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
    const env = await call(explore.create(ctx, 'code_walker'), { repo: 'harbor', query: 'q' });
    expect(env.output).toMatchObject({ status: 'not_configured', message: 'not configured for code:harbor' });
    expect(runner.calls).toHaveLength(0);
  });

  test('a repo that is not checked out answers not configured', async () => {
    const world = makeWorld({ repos: {} });
    const runner = createFakeRunner([]);
    const { ctx } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
    const env = await call(node.create(ctx, 'code_walker'), { repo: 'harbor', symbol: 'X' });
    expect(env.output.status).toBe('not_configured');
    expect(runner.calls).toHaveLength(0);
  });

  test('blank TRIAGE_REPOS_DIR in real mode answers not configured', async () => {
    const world = makeWorld({ env: { TRIAGE_REPOS_DIR: '' } });
    const runner = createFakeRunner([]);
    const { ctx, audit } = makeRun(world, createCodegraphConnector({ config: world.config, runner }));
    const env = await call(impact.create(ctx, 'code_walker'), { repo: 'harbor', symbol: 'X' });
    expect(env.output).toMatchObject({ status: 'not_configured', message: 'not configured for code:harbor' });
    expect(audit.lines[0]?.target).toBe('TRIAGE_REPOS_DIR');
    expect(runner.calls).toHaveLength(0);
  });

  test('a run without a codegraph connector answers not configured in real mode', async () => {
    const world = makeWorld();
    const { ctx } = makeRun(world, undefined);
    const env = await call(impact.create(ctx, 'code_walker'), { repo: 'harbor', symbol: 'X' });
    expect(env.output.status).toBe('not_configured');
  });
});
