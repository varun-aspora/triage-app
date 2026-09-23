// knowledge/classifier/categories.json against the Classification category
// list in src/types/classification.ts and the entity registries.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { CATEGORIES } from '../../src/types/classification.ts';
import { ENTITIES } from '../../src/types/core.ts';
import { CATEGORIES_FILE, REPO_ROOT } from './_util.ts';

const NonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));
const SnakeId = v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/));

// Strict: an entry has exactly these fields, so no tier flag can creep in.
const CategoryEntrySchema = v.strictObject({
  id: v.picklist(CATEGORIES),
  label: NonEmpty,
  description: NonEmpty,
  signals: v.pipe(v.array(NonEmpty), v.minLength(1)),
  typical_entities: v.array(v.picklist(ENTITIES)),
  typical_services: v.array(v.pipe(v.string(), v.regex(/^(?:ssfb|atspl|rtl):[a-z0-9]+(?:-[a-z0-9]+)*$/))),
  subcategories: v.array(SnakeId),
  notes: v.string(),
});
type CategoryEntry = v.InferOutput<typeof CategoryEntrySchema>;

const raw: unknown = JSON.parse(readFileSync(CATEGORIES_FILE, 'utf8'));

function entries(): CategoryEntry[] {
  return v.parse(v.array(CategoryEntrySchema), raw);
}

function registryServices(): Set<string> {
  const out = new Set<string>();
  for (const entity of ENTITIES) {
    const file = join(REPO_ROOT, 'resources', `${entity}.entity.json`);
    const registry = JSON.parse(readFileSync(file, 'utf8')) as { services?: Record<string, unknown> };
    for (const service of Object.keys(registry.services ?? {})) out.add(`${entity}:${service}`);
  }
  return out;
}

describe('categories.json', () => {
  test('is an array of well-formed entries', () => {
    const result = v.safeParse(v.array(CategoryEntrySchema), raw);
    const issues = result.success ? [] : result.issues.map((i) => `${v.getDotPath(i) ?? ''}: ${i.message}`);
    expect(issues).toEqual([]);
  });

  test('ids equal the Classification category list, both ways, in order', () => {
    const ids = entries().map((e) => e.id);
    expect(ids.filter((id) => !(CATEGORIES as readonly string[]).includes(id))).toEqual([]);
    expect(CATEGORIES.filter((c) => !ids.includes(c))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...CATEGORIES]);
    expect(ids).toContain('unknown');
  });

  test('every category has a description and signals', () => {
    for (const e of entries()) {
      expect(e.description.trim().length).toBeGreaterThan(0);
      expect(e.signals.length).toBeGreaterThan(0);
    }
  });

  test('typical_services are entity:service keys in the registry, for a listed entity', () => {
    const known = registryServices();
    for (const e of entries()) {
      for (const key of e.typical_services) {
        expect({ id: e.id, key, known: known.has(key) }).toEqual({ id: e.id, key, known: true });
        const entity = key.split(':')[0] as (typeof ENTITIES)[number];
        expect({ id: e.id, key, listed: e.typical_entities.includes(entity) }).toEqual({ id: e.id, key, listed: true });
      }
    }
  });

  test('lists hold no duplicates', () => {
    for (const e of entries()) {
      for (const list of [e.signals, e.typical_entities, e.typical_services, e.subcategories]) {
        expect(new Set<string>(list).size).toBe(list.length);
      }
    }
  });
});

describe('the entry schema refuses bad shapes', () => {
  const good = {
    id: 'card',
    label: 'Cards',
    description: 'Card issues.',
    signals: ['card not visible'],
    typical_entities: ['ssfb'],
    typical_services: ['ssfb:rhythm'],
    subcategories: ['card_view'],
    notes: '',
  };
  const refuses = (patch: Record<string, unknown>) => !v.safeParse(CategoryEntrySchema, { ...good, ...patch }).success;

  test('the good entry passes', () => {
    expect(v.safeParse(CategoryEntrySchema, good).success).toBe(true);
  });

  test.each([
    ['an unknown id', { id: 'loans' }],
    ['an empty description', { description: '  ' }],
    ['empty signals', { signals: [] }],
    ['an unknown entity', { typical_entities: ['shivalik'] }],
    ['a service without its entity', { typical_services: ['rhythm'] }],
    ['a service with a bad entity', { typical_services: ['bank:rhythm'] }],
    ['a tier flag', { tier: 'cheap' }],
    ['a kebab subcategory', { subcategories: ['card-view'] }],
  ])('refuses %s', (_label, patch) => {
    expect(refuses(patch)).toBe(true);
  });
});
