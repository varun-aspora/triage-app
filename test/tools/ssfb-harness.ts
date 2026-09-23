// Shared set-up for the SSFB statement tool tests. Everything is synthetic:
// ids, UTRs and narrations are made up, and no socket is ever opened. The
// HTTP connector gets a fake fetch and the SQL connector a scripted pg pool.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@flue/runtime/tool';
import { releaseEscalation } from '../../src/agents/escalation.ts';
import { parse } from 'dotenv';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { createHttpConnector, type FetchLike } from '../../src/connectors/http/client.ts';
import { createSqlConnector } from '../../src/connectors/sql/pg-client.ts';
import { fakePg, type FakePg, type Respond } from '../../src/connectors/sql/pg-fake.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../../src/gate/budget.ts';
import type { ApiRule } from '../../src/gate/rules.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import { keyHash, semanticKey, type SemanticKeyFacts } from '../../src/mock/key.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import type { FixtureKind } from '../../src/mock/types.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { createToolDeps, type ToolConnectors } from '../../src/tools/_lib/context.ts';
import type { StagingHarness } from '../../src/tools/_lib/pipeline.ts';
import type { ToolContext, ToolModule } from '../../src/tools/types.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import type { ToolEnvelope } from '../../src/types/tool-result.ts';
import { EXAMPLE_ENV, RESOURCES_DIR } from '../support/home.ts';
import { makeToolContext } from '../support/fake-tool-context.ts';

export const ACCOUNT = 'a0a0a0a0-1111-4222-8333-000000000001';
export const CUSTOMER = 'c0c0c0c0-1111-4222-8333-000000000002';
export const STRANGER = 'dededede-9999-4888-8777-000000000003';
export const FIXED_NOW = new Date('2026-09-20T10:00:00.000Z');
export const FAKE_API = 'https://rhythm.test.invalid/rhythm';
export const FAKE_DSN = 'postgresql://ro_user:FakePw123@rhythm-db.test.invalid:5432/rhythm_db';

export const CHAIN: IdChain = {
  ids: { account_id: ACCOUNT, customer_id: CUSTOMER },
  hops: [],
  basic_state: [],
};

export const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

export type FetchCall = { url: URL; init: RequestInit };

export type World = {
  readonly ctx: ToolContext;
  readonly config: Config;
  readonly audit: MemoryAuditSink;
  readonly fetches: FetchCall[];
  readonly pg: FakePg;
  readonly staged: { path: string; text: string }[];
  readonly harness: StagingHarness;
  cleanup(): void;
};

export type WorldOptions = {
  /** true: answer from `fixtures`. false: real mode with the fake fetch and pool. */
  readonly mock: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly chain?: IdChain;
  /** Fixture results by kind and facts. */
  readonly fixtures?: { kind: FixtureKind; facts: unknown; result: unknown }[];
  /** Answers each statement request; the default is an empty list. */
  readonly respond?: (url: URL) => Response;
  readonly pgRespond?: Respond;
  readonly rules?: ApiRule[];
  /** Leave the named connectors out of the run's deps. */
  readonly withoutConnectors?: boolean;
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let seq = 0;

export function makeWorld(opts: WorldOptions): World {
  seq += 1;
  const runId = `run_ssfb_${seq}_${Math.random().toString(36).slice(2, 8)}`;
  const home = mkdtempSync(join(tmpdir(), 'triage-ssfb-'));
  cpSync(RESOURCES_DIR, join(home, 'resources'), { recursive: true });
  if (opts.rules !== undefined) {
    writeFileSync(join(home, 'resources', 'ssfb.api.rules.json'), JSON.stringify(opts.rules));
  }

  const env: Record<string, string | undefined> = {
    TRIAGE_MOCK_MODE: opts.mock ? 'true' : 'false',
    TRIAGE_MOCK_STRICT: 'true',
    TRIAGE_RECORD_FIXTURES: 'false',
    SSFB_RHYTHM_API_URL: FAKE_API,
    SSFB_RHYTHM_DB_URL: FAKE_DSN,
    ...opts.env,
  };
  // .env.example plus overrides, like makeTestConfig, but with a real home
  // directory so resources/ssfb.api.rules.json can be read.
  const record: Record<string, string> = { ...parse(readFileSync(EXAMPLE_ENV, 'utf8')) };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete record[key];
    else record[key] = value;
  }
  const config: Config = configFromRecord(record, home);
  const base = makeToolContext({ config, runId, entity: 'ssfb' });

  const fixtures = new Map<string, unknown>();
  for (const f of opts.fixtures ?? []) {
    const key = semanticKey(f.kind, f.facts as SemanticKeyFacts[typeof f.kind]);
    fixtures.set(`${f.kind}:${keyHash(key)}`, f.result);
  }
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get(kind, _entity, key) {
      const hit = fixtures.get(`${kind}:${keyHash(key)}`);
      if (hit === undefined) return null;
      return {
        scope: 'shared',
        path: '/triage-test/fixtures/x.json',
        hash: keyHash(key),
        fixture: { kind, result: hit } as never,
      };
    },
    async list() {
      return [];
    },
  };

  const fetches: FetchCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    fetches.push({ url, init });
    return opts.respond?.(url) ?? json({ data: [] });
  };
  const pg = fakePg(opts.pgRespond !== undefined ? { respond: opts.pgRespond } : {});
  const connectors: ToolConnectors = opts.withoutConnectors
    ? {}
    : {
        http: createHttpConnector({ registry: base.registry, config, fetchImpl }),
        sql: createSqlConnector({ registry: base.registry, config, pgFactory: pg.factory }),
      };

  const audit = createMemoryAuditSink();
  const budget = createRunBudget({
    runId,
    maxToolCalls: 20,
    maxTasks: 5,
    maxRowsPerCall: 200,
    maxBytesPerCall: 1_000_000,
    maxBytesPerRun: 10_000_000,
  });
  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: opts.chain ?? CHAIN,
    connectors,
    runStore: {} as RunStore,
    budget,
    audit,
    fixtures: createMockLayer(config, { store }),
    now: () => FIXED_NOW,
  });

  const staged: { path: string; text: string }[] = [];
  const harness: StagingHarness = {
    sandbox: {
      async writeFile(path: string, text: string | Uint8Array) {
        staged.push({ path, text: String(text) });
      },
    } as StagingHarness['sandbox'],
  };

  return {
    ctx: Object.freeze({ ...base, deps }),
    config,
    audit,
    fetches,
    pg,
    staged,
    harness,
    cleanup() {
      releaseRunBudget(runId);
      releaseEscalation(runId);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function callTool(
  module: ToolModule,
  world: World,
  data: Record<string, unknown>,
  opts: { harness?: boolean } = {},
): Promise<ToolEnvelope> {
  const tool: ToolDefinition = module.create(world.ctx, 'investigator');
  const result = await tool.run({
    data,
    toolCallId: 'toolu_ssfb_1',
    log,
    ...(opts.harness ? { harness: world.harness } : {}),
  } as never);
  return result as ToolEnvelope;
}
