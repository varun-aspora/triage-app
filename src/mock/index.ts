// The mock layer tool factories use: settings, fixture store, resolver and,
// only on a real run with recording on, the recorder (D19, D27).
//
// Mock mode never builds a recorder, and neither does a real run with
// recording off, so nothing can be written to _unreviewed/ in those cases.
import { createRecorder, type FixtureRecorder, type RecorderOptions } from './recorder.ts';
import { createResolver, type ResolveIo, type ResolverDeps } from './resolve.ts';
import { mockSettingsFrom, type MockConfig, type MockSettings } from './settings.ts';
import { createFixtureStore, type FixtureStore } from './store.ts';

export type MockLayerDeps = {
  /** Fixtures under cases/<caseId>/ are checked before shared/. */
  readonly caseId?: string;
  /** TRIAGE_HOME, used only when the fixtures dir is relative. */
  readonly home?: string;
  /** Replaces the file store, for tests. */
  readonly store?: FixtureStore;
  /** Clock for meta.recorded_at. */
  readonly now?: () => Date;
  readonly redactPersisted?: RecorderOptions['redactPersisted'];
  readonly checkPersisted?: RecorderOptions['checkPersisted'];
  /** Told about every recorded candidate dropped by the persisted check. */
  readonly onRecordGap?: RecorderOptions['onGap'];
  /** Told about a recorder that threw. The real call still succeeds. */
  readonly onRecorderError?: ResolverDeps['onRecorderError'];
};

export type MockLayer = {
  readonly settings: MockSettings;
  readonly store: FixtureStore;
  /** null unless mock mode is off and recording is on. */
  readonly recorder: FixtureRecorder | null;
  readonly resolveIo: ResolveIo;
};

export function createMockLayer(config: MockConfig, deps: MockLayerDeps = {}): MockLayer {
  const settings = mockSettingsFrom(config, deps.caseId !== undefined ? { caseId: deps.caseId } : {});
  const store =
    deps.store ??
    createFixtureStore({
      fixturesDir: settings.fixturesDir,
      ...(settings.caseId !== undefined ? { caseId: settings.caseId } : {}),
      ...(deps.home !== undefined ? { home: deps.home } : {}),
    });

  const recorder =
    !settings.mockMode && settings.record
      ? createRecorder({
          fixturesDir: settings.fixturesDir,
          ...(deps.home !== undefined ? { home: deps.home } : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
          ...(deps.redactPersisted !== undefined ? { redactPersisted: deps.redactPersisted } : {}),
          ...(deps.checkPersisted !== undefined ? { checkPersisted: deps.checkPersisted } : {}),
          ...(deps.onRecordGap !== undefined ? { onGap: deps.onRecordGap } : {}),
        })
      : null;

  const resolveIo = createResolver({
    settings,
    store,
    ...(recorder !== null ? { recorder } : {}),
    ...(deps.onRecorderError !== undefined ? { onRecorderError: deps.onRecorderError } : {}),
  });

  return Object.freeze({ settings, store, recorder, resolveIo });
}

export type { FixtureRecorder } from './recorder.ts';
export type { IoOutcome, ResolveIo } from './resolve.ts';
export type { MockSettings } from './settings.ts';
