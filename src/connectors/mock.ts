// The mock branch every connector goes through (D19, D27, D42).
//
// withMock(ctx, tool, keyInput, real, { target_env }) is the one switch:
// - mock mode on: the fixture answers and real() is never called. A miss
//   under strict mode throws ConnectorError strict_miss naming the semantic
//   key. A non-strict miss returns a fixture_not_found outcome, still without
//   calling real().
// - mock mode off: real(signal) runs. Its data goes to the recorder only when
//   the port has one, which mockPortFromFixtures() sets up only when T03 says
//   recording is on.
//
// Connectors pass keyInput, the parsed facts for T03's semanticKey(); they
// never build keys or hashes themselves.
import { FixtureMissError } from '../mock/errors.ts';
import { hashKeyString, keyString, semanticKey, type SemanticKeyFacts } from '../mock/key.ts';
import type { RealIoOutcome, RecordContext, Recorder } from '../mock/resolve.ts';
import type { MockSettings } from '../mock/settings.ts';
import type { FixtureStore } from '../mock/store.ts';
import { FIXTURE_ENTITIES, type FixtureEntity, type FixtureKind } from '../mock/types.ts';
import {
  ConnectorError,
  envVarName,
  type ConnectorContext,
  type ConnectorMiss,
  type ConnectorOutcome,
  type ConnectorResult,
} from './types.ts';

export type MockLookup =
  | { readonly hit: true; readonly value: unknown; readonly hash: string }
  | { readonly hit: false; readonly key_string: string; readonly hash: string };

export type RecordMeta = {
  readonly run_id?: string;
  readonly redaction_names?: readonly string[];
};

export interface MockPort {
  /** true: connectors answer from fixtures and never call real(). */
  readonly enabled: boolean;
  /** true: a fixture miss throws strict_miss. */
  readonly strict: boolean;
  lookup<K extends FixtureKind>(tool: K, keyInput: SemanticKeyFacts[K]): Promise<MockLookup>;
  /** Present only on a real run with recording on. Must not throw. */
  record?<K extends FixtureKind>(
    tool: K,
    keyInput: SemanticKeyFacts[K],
    output: unknown,
    meta?: RecordMeta,
  ): Promise<void>;
}

export type RecordErrorContext = {
  readonly kind: FixtureKind;
  readonly entity: FixtureEntity;
  readonly run_id?: string;
};

export type MockPortSource = {
  readonly settings: Pick<MockSettings, 'mockMode' | 'strict' | 'record'>;
  readonly store: Pick<FixtureStore, 'get'>;
  /** From createMockLayer(); null unless mock mode is off and recording is on. */
  readonly recorder?: Recorder | null;
};

export type MockPortOptions = {
  /** Told about a recorder that threw or rejected. The real call still succeeds. */
  readonly onRecordError?: (error: unknown, at: RecordErrorContext) => void;
};

/** The fixture folder for a key: its entity when it has one, else 'global'. */
export function fixtureEntityOf(keyInput: object): FixtureEntity {
  const entity = (keyInput as { entity?: unknown }).entity;
  return typeof entity === 'string' && (FIXTURE_ENTITIES as readonly string[]).includes(entity)
    ? (entity as FixtureEntity)
    : 'global';
}

/**
 * Adapts the T03 fixture store and mock settings (for example a MockLayer
 * from src/mock/index.ts) to a MockPort.
 */
export function mockPortFromFixtures(source: MockPortSource, options: MockPortOptions = {}): MockPort {
  const { settings, store } = source;
  const recorder = source.recorder ?? null;
  const recording = !settings.mockMode && settings.record && recorder !== null;

  async function lookup<K extends FixtureKind>(tool: K, keyInput: SemanticKeyFacts[K]): Promise<MockLookup> {
    const key = semanticKey(tool, keyInput);
    const key_string = keyString(key);
    const loaded = await store.get(tool, fixtureEntityOf(keyInput), key);
    if (loaded !== null) return Object.freeze({ hit: true as const, value: loaded.fixture.result, hash: loaded.hash });
    return Object.freeze({ hit: false as const, key_string, hash: hashKeyString(key_string) });
  }

  async function record<K extends FixtureKind>(
    tool: K,
    keyInput: SemanticKeyFacts[K],
    output: unknown,
    meta: RecordMeta = {},
  ): Promise<void> {
    const entity = fixtureEntityOf(keyInput);
    try {
      const key = semanticKey(tool, keyInput);
      const key_string = keyString(key);
      const outcome: RealIoOutcome<unknown> = Object.freeze({
        value: output,
        transport: 'real',
        fixture: null,
        fixture_miss: false,
      });
      const ctx = Object.freeze({
        kind: tool,
        entity,
        key,
        key_string,
        hash: hashKeyString(key_string),
        ...(meta.run_id !== undefined ? { run_id: meta.run_id } : {}),
        ...(meta.redaction_names !== undefined ? { redaction_names: meta.redaction_names } : {}),
      }) as RecordContext;
      await (recorder as Recorder).record(outcome, ctx);
    } catch (err) {
      if (options.onRecordError === undefined) return;
      try {
        options.onRecordError(err, { kind: tool, entity, ...(meta.run_id !== undefined ? { run_id: meta.run_id } : {}) });
      } catch {
        // A broken error sink must not fail a real call.
      }
    }
  }

  const port: MockPort = {
    enabled: settings.mockMode,
    strict: settings.strict,
    lookup,
    ...(recording ? { record } : {}),
  };
  return Object.freeze(port);
}

/** What a connector's real call returns. */
export type RealOutput<T> = {
  readonly data: T;
  readonly truncated?: boolean;
};

export type WithMockOptions = {
  /** The env var NAME the target comes from, such as SSFB_DB_HARBOR_DSN. Never its value. */
  readonly target_env: string;
};

export async function withMock<K extends FixtureKind, T>(
  ctx: ConnectorContext,
  tool: K,
  keyInput: SemanticKeyFacts[K],
  real: (signal: AbortSignal) => Promise<RealOutput<T>>,
  options: WithMockOptions,
): Promise<ConnectorOutcome<T>> {
  const target_env = envVarName(options.target_env);
  const { signal, mock } = ctx;
  signal.throwIfAborted();
  const started = ctx.now();
  const taken_at = started.toISOString();
  const elapsed = (): number => Math.max(0, ctx.now().getTime() - started.getTime());

  if (mock.enabled) {
    const found = await mock.lookup(tool, keyInput);
    signal.throwIfAborted();
    if (found.hit) {
      const result: ConnectorResult<T> = {
        data: found.value as T,
        transport: 'mock',
        target_env,
        taken_at,
        duration_ms: elapsed(),
      };
      return Object.freeze(result);
    }
    const missing = new FixtureMissError(tool, found.key_string);
    if (mock.strict) {
      throw new ConnectorError('strict_miss', missing.message, {
        cause: missing,
        fixture: { kind: tool, key_string: found.key_string, hash: found.hash },
      });
    }
    const miss: ConnectorMiss = {
      data: null,
      transport: 'mock',
      target_env,
      taken_at,
      duration_ms: elapsed(),
      fixture_miss: true,
      error: Object.freeze({
        code: 'fixture_not_found' as const,
        kind: tool,
        key_string: found.key_string,
        hash: found.hash,
        message: `no ${tool} fixture for key ${found.key_string} (file ${found.hash}.json)`,
      }),
    };
    return Object.freeze(miss);
  }

  const out = await real(signal);
  if (mock.record !== undefined) {
    try {
      await mock.record(tool, keyInput, out.data, {
        run_id: ctx.runId,
        ...(ctx.redactionNames !== undefined ? { redaction_names: ctx.redactionNames } : {}),
      });
    } catch {
      // Recording never fails a real call. mockPortFromFixtures reports its own errors.
    }
  }
  const result: ConnectorResult<T> = {
    data: out.data,
    transport: 'real',
    target_env,
    taken_at,
    duration_ms: elapsed(),
    ...(out.truncated === true ? { truncated: true } : {}),
  };
  return Object.freeze(result);
}
