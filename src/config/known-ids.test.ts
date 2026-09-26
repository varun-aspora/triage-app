import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_ID_KEYS } from '../types/core.ts';
import { KNOWN_IDS_FILE, knownIdFieldsFor, loadKnownIdFields, parseKnownIdFields } from './known-ids.ts';
import { RegistryError } from './registry.ts';

const RESOURCES = join(import.meta.dir, '..', '..', 'resources');

describe('resources/known-ids.json', () => {
  test('names KNOWN_ID_KEYS in order', () => {
    expect(loadKnownIdFields(RESOURCES).map((f) => f.key)).toEqual([...KNOWN_ID_KEYS]);
  });

  test('country is a choice of GB and AE', () => {
    const country = loadKnownIdFields(RESOURCES).find((f) => f.key === 'country');
    expect(country?.kind).toBe('choice');
    expect(country?.kind === 'choice' ? Object.keys(country.options) : []).toEqual(['GB', 'AE']);
  });
});

describe('parseKnownIdFields', () => {
  test('refuses a file whose keys differ from KNOWN_ID_KEYS', () => {
    const doc = { fields: [{ key: 'country', description: 'd', question: 'q', options: { GB: { description: 'd', aliases: ['UK'] } }, labels: ['country'] }] };
    expect(() => parseKnownIdFields(doc)).toThrow(RegistryError);
  });

  test('refuses a pattern that does not compile', () => {
    const doc = { fields: [{ key: 'country', description: 'd', question: 'q', pattern: '(', normalise: 'none', labels: ['x'] }] };
    expect(() => parseKnownIdFields(doc)).toThrow(/valid regular expression/);
  });
});

describe('knownIdFieldsFor', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const home = (file?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-known-ids-'));
    dirs.push(dir);
    if (file !== undefined) writeFileSync(join(dir, KNOWN_IDS_FILE), file);
    return dir;
  };

  test('a home without the file reads the shipped copy', () => {
    expect(knownIdFieldsFor({ paths: { resourcesDir: home() } })).toEqual(loadKnownIdFields(RESOURCES));
  });

  test("a home file that is there is the one read, and a bad one throws instead of falling back", () => {
    expect(() => knownIdFieldsFor({ paths: { resourcesDir: home('{ not json') } })).toThrow(RegistryError);
    expect(() => knownIdFieldsFor({ paths: { resourcesDir: home(JSON.stringify({ fields: [] })) } })).toThrow(/in that order/);
  });
});
