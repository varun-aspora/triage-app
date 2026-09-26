// resources/known-ids.json: the identifiers a run knows and how ingress finds
// them in a thread (D69). The id decision questions, their options and the
// label fallback are all built from this file; no field is described in code.
//
// Each field is one of two shapes:
// - a value field has `pattern` (JavaScript regex source, run with flags gi)
//   that finds candidate values in the thread, and `normalise`, applied to a
//   candidate before it is offered or stored;
// - a choice field has `options`: option key -> description and aliases. The
//   stored value is the option key; an alias is how the text may say it.
// Both carry `labels`, the template labels the fallback reads as
// `<label>: <value>`.
//
// The keys must be KNOWN_ID_KEYS, in that order, so the file and the KnownIds
// type cannot drift apart.
//
// knownIdFieldsFor(config) is what the ingress identity step and the
// resolve_identity tool read: the home's resources/known-ids.json, or the copy
// shipped with the code when the home has none (homes made before D69 by
// copying resources/). A home file that is there but invalid throws; it is
// never replaced by the shipped copy.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { KNOWN_ID_KEYS, type KnownIdKey } from '../types/core.ts';
import type { Config } from './env.ts';
import { RegistryError } from './registry.ts';

export const KNOWN_IDS_FILE = 'known-ids.json';
const KNOWN_IDS_KEY = `resources/${KNOWN_IDS_FILE}`;

/** How a candidate is cleaned before it is offered and stored. */
export const NORMALISERS = ['none', 'phone'] as const;
export type Normaliser = (typeof NORMALISERS)[number];

const Text = v.pipe(v.string(), v.trim(), v.minLength(1));
const Labels = v.pipe(v.array(Text), v.minLength(1, 'must list at least one label'));

const PatternSchema = v.pipe(
  Text,
  v.check((source) => {
    try {
      new RegExp(source, 'gi');
      return true;
    } catch {
      return false;
    }
  }, 'is not a valid regular expression'),
);

const ValueFieldSchema = v.strictObject({
  key: v.picklist(KNOWN_ID_KEYS),
  description: Text,
  question: Text,
  pattern: PatternSchema,
  normalise: v.picklist(NORMALISERS),
  labels: Labels,
});

const ChoiceOptionSchema = v.strictObject({
  description: Text,
  aliases: v.pipe(v.array(Text), v.minLength(1, 'must list at least one alias')),
});

const ChoiceFieldSchema = v.strictObject({
  key: v.picklist(KNOWN_ID_KEYS),
  description: Text,
  question: Text,
  options: v.pipe(
    v.record(v.pipe(v.string(), v.regex(/^[A-Z0-9_]{1,32}$/, 'option keys are upper case letters, digits and _')), ChoiceOptionSchema),
    v.check((o) => Object.keys(o).length > 0, 'must list at least one option'),
  ),
  labels: Labels,
});

export const KnownIdsFileSchema = v.strictObject({
  $comment: v.optional(v.string()),
  fields: v.array(v.union([ValueFieldSchema, ChoiceFieldSchema])),
});

export type KnownIdValueField = {
  readonly kind: 'value';
  readonly key: KnownIdKey;
  readonly description: string;
  readonly question: string;
  /** Regex source; compile with flags 'gi' per use, since a global regex keeps state. */
  readonly pattern: string;
  readonly normalise: Normaliser;
  readonly labels: readonly string[];
};

export type KnownIdChoiceOption = {
  readonly description: string;
  readonly aliases: readonly string[];
};

export type KnownIdChoiceField = {
  readonly kind: 'choice';
  readonly key: KnownIdKey;
  readonly description: string;
  readonly question: string;
  /** Option key (the stored value) -> description and aliases. */
  readonly options: { readonly [option: string]: KnownIdChoiceOption };
  readonly labels: readonly string[];
};

export type KnownIdField = KnownIdValueField | KnownIdChoiceField;

/** The resources dir shipped with the code. */
export const BUNDLED_RESOURCES_DIR = fileURLToPath(new URL('../../resources/', import.meta.url));

/** The home's known-ids.json, else the shipped one. Throws RegistryError when the file read is bad. */
export function knownIdFieldsFor(config: { readonly paths: Pick<Config['paths'], 'resourcesDir'> }): readonly KnownIdField[] {
  const home = config.paths.resourcesDir;
  return loadKnownIdFields(existsSync(join(home, KNOWN_IDS_FILE)) ? home : BUNDLED_RESOURCES_DIR);
}

/** Reads resources/known-ids.json. Throws RegistryError naming the problem, never a value. */
export function loadKnownIdFields(resourcesDir: string): readonly KnownIdField[] {
  const file = join(resourcesDir, KNOWN_IDS_FILE);
  if (!existsSync(file)) throw RegistryError.of(KNOWN_IDS_KEY, 'is missing');
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw RegistryError.of(KNOWN_IDS_KEY, 'is not valid JSON');
  }
  return parseKnownIdFields(doc);
}

/** Pure part of loadKnownIdFields. */
export function parseKnownIdFields(doc: unknown): readonly KnownIdField[] {
  const parsed = v.safeParse(KnownIdsFileSchema, doc);
  if (!parsed.success) {
    throw new RegistryError(
      parsed.issues.map((issue) => ({ key: KNOWN_IDS_KEY, reason: `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}` })),
    );
  }
  const keys = parsed.output.fields.map((f) => f.key);
  if (keys.length !== KNOWN_ID_KEYS.length || keys.some((k, i) => k !== KNOWN_ID_KEYS[i])) {
    throw RegistryError.of(KNOWN_IDS_KEY, `fields must be ${KNOWN_ID_KEYS.join(', ')}, in that order`);
  }
  return Object.freeze(
    parsed.output.fields.map((f): KnownIdField => {
      const common = { key: f.key, description: f.description, question: f.question };
      const labels = Object.freeze([...f.labels]);
      if ('options' in f) {
        const options = Object.fromEntries(
          Object.entries(f.options).map(([key, o]) => [key, Object.freeze({ description: o.description, aliases: Object.freeze([...o.aliases]) })]),
        );
        return Object.freeze({ kind: 'choice', ...common, options: Object.freeze(options), labels });
      }
      return Object.freeze({ kind: 'value', ...common, pattern: f.pattern, normalise: f.normalise, labels });
    }),
  );
}
