import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadKnownIdFields } from '../../../src/config/known-ids.ts';
import { KNOWN_ID_KEYS as SRC_KNOWN_ID_KEYS } from '../../../src/types/core.ts';
import { KNOWN_ID_FIELDS, KNOWN_ID_KEYS, knownIdField } from './known-ids.ts';

const RESOURCES = join(import.meta.dir, '..', '..', '..', 'resources');

describe('known ids from resources/known-ids.json', () => {
  test('the keys are KNOWN_ID_KEYS, in order', () => {
    expect([...KNOWN_ID_KEYS]).toEqual([...SRC_KNOWN_ID_KEYS]);
  });

  test('descriptions and choice options match what the server loader reads', () => {
    const loaded = loadKnownIdFields(RESOURCES);
    expect(KNOWN_ID_FIELDS.map((f) => [f.key, f.description])).toEqual(loaded.map((f) => [f.key, f.description]));
    for (const f of loaded) {
      const web = knownIdField(f.key);
      if (f.kind === 'choice') {
        expect(web.options?.map((o) => [o.value, o.description])).toEqual(
          Object.entries(f.options).map(([value, o]) => [value, o.description]),
        );
      } else {
        expect(web.options).toBeUndefined();
      }
    }
  });

  test('fields are frozen', () => {
    expect(Object.isFrozen(KNOWN_ID_FIELDS)).toBe(true);
    expect(Object.isFrozen(KNOWN_ID_FIELDS[0])).toBe(true);
  });
});
