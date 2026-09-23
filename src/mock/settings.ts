// Mock settings for one process, read from the typed config (D19, D27).
//
// Defaults come from src/config/keys.ts: mock mode on, strict on, recording
// off. Recording is only allowed on real runs, so record together with mock
// mode is refused here as well as in the config loader, for callers that
// build the config shape by hand.
import type { Config } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';

export type MockSettings = {
  /** true: I/O answers from fixtures and real() is never called. */
  readonly mockMode: boolean;
  /** true: a fixture miss throws FixtureMissError instead of returning an empty result. */
  readonly strict: boolean;
  /** true: real results are passed to the recorder. Only valid with mockMode false. */
  readonly record: boolean;
  /** Absolute fixtures dir (the loader resolves it against TRIAGE_HOME). */
  readonly fixturesDir: string;
  /** When set, fixtures under cases/<caseId>/ are checked before shared/. */
  readonly caseId?: string;
};

/** The part of Config the mock settings read. */
export type MockConfig = {
  readonly mock: Config['mock'];
  readonly paths: Pick<Config['paths'], 'fixturesDir'>;
};

export type MockSettingsOptions = {
  readonly caseId?: string;
};

export function mockSettingsFrom(config: MockConfig, options: MockSettingsOptions = {}): MockSettings {
  const { enabled, strict, record } = config.mock;
  if (enabled && record) {
    throw new ConfigError([
      { key: 'TRIAGE_RECORD_FIXTURES', reason: 'cannot be true while TRIAGE_MOCK_MODE=true' },
      { key: 'TRIAGE_MOCK_MODE', reason: 'must be false to record fixtures' },
    ]);
  }
  const settings: MockSettings = {
    mockMode: enabled,
    strict,
    record,
    fixturesDir: config.paths.fixturesDir,
    ...(options.caseId !== undefined ? { caseId: options.caseId } : {}),
  };
  return Object.freeze(settings);
}
