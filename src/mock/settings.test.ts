import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromRecord } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';
import { mockSettingsFrom, type MockConfig } from './settings.ts';

const HOME = '/triage/home';

function fromRecord(record: Record<string, string>) {
  return configFromRecord(record, HOME);
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('mockSettingsFrom', () => {
  test('with no TRIAGE_MOCK_* keys set: mock on, strict on, record off', () => {
    const s = mockSettingsFrom(fromRecord({}));
    expect(s).toEqual({ mockMode: true, strict: true, record: false, fixturesDir: join(HOME, 'fixtures') });
    expect(Object.isFrozen(s)).toBe(true);
  });

  test('blank values fall back to the defaults', () => {
    const s = mockSettingsFrom(fromRecord({ TRIAGE_MOCK_MODE: '', TRIAGE_MOCK_STRICT: '', TRIAGE_RECORD_FIXTURES: '' }));
    expect(s).toMatchObject({ mockMode: true, strict: true, record: false });
  });

  test('TRIAGE_MOCK_STRICT=false parses to strict false', () => {
    expect(mockSettingsFrom(fromRecord({ TRIAGE_MOCK_STRICT: 'false' })).strict).toBe(false);
  });

  test('real mode with recording is allowed', () => {
    const s = mockSettingsFrom(fromRecord({ TRIAGE_MOCK_MODE: 'false', TRIAGE_RECORD_FIXTURES: 'true' }));
    expect(s).toMatchObject({ mockMode: false, record: true });
  });

  test('TRIAGE_FIXTURES_DIR resolves against the home', () => {
    expect(mockSettingsFrom(fromRecord({ TRIAGE_FIXTURES_DIR: './fx' })).fixturesDir).toBe(join(HOME, 'fx'));
  });

  test('caseId is passed through only when given', () => {
    expect(mockSettingsFrom(fromRecord({}), { caseId: 'case-7' }).caseId).toBe('case-7');
    expect('caseId' in mockSettingsFrom(fromRecord({}))).toBe(false);
  });

  test('the loader rejects record with mock mode, naming both keys', () => {
    const err = thrown(() => fromRecord({ TRIAGE_MOCK_MODE: 'true', TRIAGE_RECORD_FIXTURES: 'true' }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain('TRIAGE_RECORD_FIXTURES');
    expect((err as Error).message).toContain('TRIAGE_MOCK_MODE');
  });

  test('mockSettingsFrom rejects record with mock mode on a hand-built config, naming both keys', () => {
    const config: MockConfig = {
      mock: { enabled: true, strict: true, record: true },
      paths: { fixturesDir: '/fx' },
    };
    const err = thrown(() => mockSettingsFrom(config));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).keys).toEqual(['TRIAGE_RECORD_FIXTURES', 'TRIAGE_MOCK_MODE']);
    expect((err as Error).message).toContain('TRIAGE_RECORD_FIXTURES');
    expect((err as Error).message).toContain('TRIAGE_MOCK_MODE');
  });
});

describe('src/mock source guard', () => {
  // Built from parts so this file does not match its own search.
  const FORBIDDEN = [
    ['TRIAGE', 'ENV', 'LABEL'].join('_'),
    ['TRIAGE', 'DEPLOY', 'MODE'].join('_'),
    ['env', 'Label'].join(''),
    ['deployMode', 'ForPreflight'].join(''),
  ];
  const dir = fileURLToPath(new URL('.', import.meta.url));

  test('no file in src/mock names the env label or the deploy mode', () => {
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const word of FORBIDDEN) if (text.includes(word)) hits.push(`${file}: ${word}`);
    }
    expect(hits).toEqual([]);
  });
});
