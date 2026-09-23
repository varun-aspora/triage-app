// Test world for the SSFB gated tools (T05.7): a temp TRIAGE_HOME with the
// repo's resources/ copied in, config from the blanked .env.example record
// plus overrides, an in-memory fixture store, a memory audit sink and a log
// that keeps every line. Nothing here reaches a real system: hosts and
// credentials are blank, and a test that runs in real mode injects fakes.

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@flue/runtime/tool';
import { releaseEscalation } from '../../src/agents/escalation.ts';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { loadRegistry, type Registry } from '../../src/config/registry.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { releaseRunBudget } from '../../src/gate/budget.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import { keyString, semanticKey, type SemanticKeyFacts } from '../../src/mock/key.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import type { FixtureKind } from '../../src/mock/types.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { createToolDeps, type ToolConnectors } from '../../src/tools/_lib/context.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import type { ToolEnvelope } from '../../src/types/tool-result.ts';
import { REPO_ROOT, testEnvRecord } from './home.ts';

export const FIXED_NOW = new Date('2026-09-23T10:00:00.000Z');

export type SsfbWorld = {
  readonly root: string;
  readonly home: string;
  readonly config: Config;
  readonly registry: Registry;
  cleanup(): void;
};

export type SsfbWorldOptions = {
  readonly mock: boolean;
  /** Applied over the blanked .env.example record. */
  readonly env?: Readonly<Record<string, string>>;
  /** Written to <home>/resources/ssfb.api.rules.json instead of the shipped file. */
  readonly rules?: unknown;
};

export function makeSsfbWorld(opts: SsfbWorldOptions): SsfbWorld {
  const root = mkdtempSync(join(tmpdir(), 'ssfb-tools-'));
  const home = join(root, 'home');
  cpSync(join(REPO_ROOT, 'resources'), join(home, 'resources'), { recursive: true });
  if (opts.rules !== undefined) {
    writeFileSync(join(home, 'resources', 'ssfb.api.rules.json'), JSON.stringify(opts.rules));
  }
  // testEnvRecord blanks every host and credential from .env.example.
  const record: Record<string, string> = {
    ...testEnvRecord(),
    TRIAGE_ENTITIES: 'ssfb',
    TRIAGE_MOCK_MODE: opts.mock ? 'true' : 'false',
    TRIAGE_MOCK_STRICT: 'true',
    TRIAGE_RECORD_FIXTURES: 'false',
    TRIAGE_FIXTURES_DIR: join(root, 'fixtures'),
    ...opts.env,
  };
  const config = configFromRecord(record, home);
  return {
    root,
    home,
    config,
    registry: loadRegistry(config),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export type MemoryFixtures = {
  readonly store: FixtureStore;
  add<K extends FixtureKind>(kind: K, facts: SemanticKeyFacts[K], result: unknown): void;
  readonly gets: number;
};

/** A fixture store that answers by key string. Any entity folder matches. */
export function memoryFixtures(): MemoryFixtures {
  const byKey = new Map<string, { kind: FixtureKind; result: unknown }>();
  let gets = 0;
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get(kind, _entity, key) {
      gets += 1;
      const hit = byKey.get(`${kind} ${keyString(key)}`);
      if (hit === undefined) return null;
      return {
        scope: 'shared',
        path: '/triage-test/fixtures/memory.json',
        hash: '0123456789abcdef',
        fixture: { kind, result: hit.result } as never,
      };
    },
    async list() {
      return [];
    },
  };
  return {
    store,
    add(kind, facts, result) {
      byKey.set(`${kind} ${keyString(semanticKey(kind, facts))}`, { kind, result });
    },
    get gets() {
      return gets;
    },
  };
}

export type LogLine = { readonly level: string; readonly message: string; readonly attrs?: unknown };

export type SsfbRun = {
  readonly ctx: ToolContext;
  readonly audit: MemoryAuditSink;
  readonly logs: LogLine[];
  call(tool: ToolDefinition, data: Record<string, unknown>): Promise<ToolEnvelope>;
};

let seq = 0;

export type SsfbRunOptions = {
  readonly idChain?: IdChain;
  readonly connectors?: ToolConnectors;
  readonly fixtures?: MemoryFixtures;
};

export function makeSsfbRun(world: SsfbWorld, opts: SsfbRunOptions = {}): SsfbRun & { release(): void } {
  seq += 1;
  const runId = `run_ssfb_${seq}_${Math.random().toString(36).slice(2, 8)}`;
  const audit = createMemoryAuditSink();
  const fixtures = opts.fixtures ?? memoryFixtures();
  const deps = createToolDeps({
    runId,
    config: world.config,
    registry: world.registry,
    interface: 'cli',
    idChain: opts.idChain ?? { ids: {}, hops: [], basic_state: [] },
    connectors: opts.connectors ?? {},
    runStore: {} as RunStore,
    audit,
    fixtures: createMockLayer(world.config, { store: fixtures.store }),
    now: () => FIXED_NOW,
  });
  const ctx: ToolContext = Object.freeze({ runId, entity: 'ssfb', config: world.config, registry: world.registry, deps });
  const logs: LogLine[] = [];
  const log = {
    info: (message: string, attrs?: unknown) => logs.push({ level: 'info', message, attrs }),
    warn: (message: string, attrs?: unknown) => logs.push({ level: 'warn', message, attrs }),
    error: (message: string, attrs?: unknown) => logs.push({ level: 'error', message, attrs }),
  };
  let calls = 0;
  return {
    ctx,
    audit,
    logs,
    async call(tool, data) {
      calls += 1;
      return (await tool.run({ data, toolCallId: `toolu_ssfb_${calls}`, log } as never)) as ToolEnvelope;
    },
    release() {
      releaseRunBudget(runId);
      releaseEscalation(runId);
    },
  };
}
