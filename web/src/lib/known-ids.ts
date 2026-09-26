// The known ids a run can be given as hints (D69), read from
// resources/known-ids.json when the console is built, so the keys, what each
// one is and the country options are not copied here. The server checks the
// same file at boot (src/config/known-ids.ts); known-ids.test.ts pins this
// module to what that loader reads. Only the parts the form shows are kept:
// the patterns, questions and labels are ingress's business.

import file from '../../../resources/known-ids.json';
import type { KnownIdKey } from '../api/types.ts';

export type KnownIdOption = {
  /** The stored value, e.g. GB. */
  readonly value: string;
  readonly description: string;
};

export type KnownIdHintField = {
  readonly key: KnownIdKey;
  readonly description: string;
  /** Set for a choice field (country): the value is one of these, not free text. */
  readonly options?: readonly KnownIdOption[];
};

type FileField = { key: string; description: string; options?: Record<string, { description: string }> };

function toField(f: FileField): KnownIdHintField {
  // The key is one of KNOWN_ID_KEYS: the server refuses to boot otherwise, and
  // known-ids.test.ts checks this list against src/types/core.ts.
  const key = f.key as KnownIdKey;
  if (f.options === undefined) return Object.freeze({ key, description: f.description });
  const options = Object.entries(f.options).map(([value, o]) => Object.freeze({ value, description: o.description }));
  return Object.freeze({ key, description: f.description, options: Object.freeze(options) });
}

/** Every known id field, in the file's order. */
export const KNOWN_ID_FIELDS: readonly KnownIdHintField[] = Object.freeze((file.fields as FileField[]).map(toField));

/** The keys alone, in the file's order. */
export const KNOWN_ID_KEYS: readonly KnownIdKey[] = Object.freeze(KNOWN_ID_FIELDS.map((f) => f.key));

const BY_KEY: ReadonlyMap<KnownIdKey, KnownIdHintField> = new Map(KNOWN_ID_FIELDS.map((f) => [f.key, f]));

/** The field for a key. Every KnownIdKey has one. */
export function knownIdField(key: KnownIdKey): KnownIdHintField {
  return BY_KEY.get(key) as KnownIdHintField;
}
