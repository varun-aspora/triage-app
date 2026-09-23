// The one switch between real I/O and fixtures (D19, D27).
//
// Every I/O tool, the identity step, Slack read and the doctor probes call
// resolveIo and put outcome.transport and outcome.fixture_miss on their audit
// line; the eval gate reads transport to prove no real I/O happened (D42).
//
// Mock mode: the fixture store answers and real() is never called. A strict
// miss throws FixtureMissError. A non-strict miss returns value null with
// fixture_miss true, and the calling tool renders an empty result.
//
// Real mode: real(signal) is called and the store is not touched. When
// recording is on, the outcome goes to the recorder (T03.3). A recorder
// failure is reported to onRecorderError and never fails the call.
import { hashKeyString, keyString, semanticKey, type SemanticKeyFacts } from './key.ts';
import { FixtureMissError } from './errors.ts';
import type { MockSettings } from './settings.ts';
import type { FixtureStore } from './store.ts';
import type { FixtureEntity, FixtureKind, SemanticKey } from './types.ts';

export type IoTransport = 'real' | 'mock';

export type RealIoOutcome<T> = {
  readonly value: T;
  readonly transport: 'real';
  readonly fixture: null;
  readonly fixture_miss: false;
};

export type MockHitOutcome<T> = {
  readonly value: T;
  readonly transport: 'mock';
  readonly fixture: { readonly hash: string; readonly hit: true };
  readonly fixture_miss: false;
};

export type MockMissOutcome = {
  readonly value: null;
  readonly transport: 'mock';
  readonly fixture: { readonly hash: string; readonly hit: false };
  readonly fixture_miss: true;
};

export type IoOutcome<T> = RealIoOutcome<T> | MockHitOutcome<T> | MockMissOutcome;

/** What the recorder needs to write one candidate fixture. */
export type RecordContext<K extends FixtureKind = FixtureKind> = {
  readonly kind: K;
  readonly entity: FixtureEntity;
  readonly key: SemanticKey<K>;
  readonly key_string: string;
  readonly hash: string;
  readonly run_id?: string;
  /** Ingress-collected names for the persisted redaction profile (D24). */
  readonly redaction_names?: readonly string[];
};

export type RecorderErrorContext = {
  readonly kind: FixtureKind;
  readonly entity: FixtureEntity;
  readonly run_id?: string;
};

export type RecordResult =
  | { readonly status: 'written' | 'kept'; readonly path: string }
  | { readonly status: 'dropped'; readonly gap: string };

/** Implemented by src/mock/recorder.ts (T03.3). */
export interface Recorder {
  record(outcome: RealIoOutcome<unknown>, ctx: RecordContext): Promise<RecordResult | void> | RecordResult | void;
}

export type IoRequest<K extends FixtureKind, T> = {
  readonly kind: K;
  readonly entity: FixtureEntity;
  /** A key from semanticKey(kind, facts). It is normalised again here, which is a no-op for such a key. */
  readonly key: SemanticKey<K>;
  /** The real call. Called only in real mode, with the same signal. */
  readonly real: (signal: AbortSignal) => Promise<T>;
  readonly signal: AbortSignal;
  /** Overrides the resolver's recorder for this call. */
  readonly recorder?: Recorder;
  readonly run_id?: string;
  readonly redaction_names?: readonly string[];
};

export type ResolverDeps = {
  readonly settings: MockSettings;
  /** Read only in mock mode. */
  readonly store: Pick<FixtureStore, 'get'>;
  readonly recorder?: Recorder;
  /** Told about a recorder that threw. If this throws too, that is ignored. */
  readonly onRecorderError?: (error: unknown, at: RecorderErrorContext) => void;
};

export type ResolveIo = <K extends FixtureKind, T>(request: IoRequest<K, T>) => Promise<IoOutcome<T>>;

export function createResolver(deps: ResolverDeps): ResolveIo {
  const { settings } = deps;
  return async function resolveIo<K extends FixtureKind, T>(request: IoRequest<K, T>): Promise<IoOutcome<T>> {
    const { signal } = request;
    signal.throwIfAborted();
    if (settings.mockMode) return fromFixture<K, T>(deps, request);

    const value = await request.real(signal);
    const outcome: RealIoOutcome<T> = Object.freeze({
      value,
      transport: 'real',
      fixture: null,
      fixture_miss: false,
    });
    if (settings.record) await recordSafely(deps, request, outcome);
    return outcome;
  };
}

/** One-off form of createResolver(deps)(request). */
export function resolveIo<K extends FixtureKind, T>(deps: ResolverDeps, request: IoRequest<K, T>): Promise<IoOutcome<T>> {
  return createResolver(deps)(request);
}

async function fromFixture<K extends FixtureKind, T>(deps: ResolverDeps, request: IoRequest<K, T>): Promise<IoOutcome<T>> {
  const { kind, entity, key, signal } = request;
  const loaded = await deps.store.get(kind, entity, key);
  signal.throwIfAborted();
  if (loaded !== null) {
    return Object.freeze({
      value: loaded.fixture.result as T,
      transport: 'mock',
      fixture: Object.freeze({ hash: loaded.hash, hit: true as const }),
      fixture_miss: false,
    });
  }
  const key_string = canonicalKeyString(kind, key);
  if (deps.settings.strict) throw new FixtureMissError(kind, key_string);
  return Object.freeze({
    value: null,
    transport: 'mock',
    fixture: Object.freeze({ hash: hashKeyString(key_string), hit: false as const }),
    fixture_miss: true,
  });
}

async function recordSafely<K extends FixtureKind, T>(
  deps: ResolverDeps,
  request: IoRequest<K, T>,
  outcome: RealIoOutcome<T>,
): Promise<void> {
  const recorder = request.recorder ?? deps.recorder;
  if (recorder === undefined) return;
  try {
    const normalised = semanticKey(request.kind, request.key as SemanticKeyFacts[K]);
    const key_string = keyString(normalised);
    const ctx = Object.freeze({
      kind: request.kind,
      entity: request.entity,
      key: normalised,
      key_string,
      hash: hashKeyString(key_string),
      ...(request.run_id !== undefined ? { run_id: request.run_id } : {}),
      ...(request.redaction_names !== undefined ? { redaction_names: request.redaction_names } : {}),
    }) as RecordContext;
    await recorder.record(outcome, ctx);
  } catch (err) {
    if (deps.onRecorderError === undefined) return;
    const at: RecorderErrorContext = {
      kind: request.kind,
      entity: request.entity,
      ...(request.run_id !== undefined ? { run_id: request.run_id } : {}),
    };
    try {
      deps.onRecorderError(err, at);
    } catch {
      // A broken error sink must not fail a real call either.
    }
  }
}

function canonicalKeyString<K extends FixtureKind>(kind: K, key: SemanticKey<K>): string {
  return keyString(semanticKey(kind, key as SemanticKeyFacts[K]));
}
