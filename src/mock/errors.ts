// A strict mock miss. It is a loud error on purpose: the tool call fails, and
// the message names the fixture kind and the semantic key so the model, the
// transcript and the operator can all see which fixture is missing (D27).
//
// The key_string is the normalised semantic key, not raw model input. Mock
// runs use redacted or pseudonymised fixtures, so the key holds the same
// values the fixture would.
import { hashKeyString } from './key.ts';
import type { FixtureKind } from './types.ts';

export class FixtureMissError extends Error {
  override readonly name = 'FixtureMissError';
  readonly kind: FixtureKind;
  readonly key_string: string;
  /** The file name the missing fixture would have, without .json. */
  readonly hash: string;

  constructor(kind: FixtureKind, key_string: string) {
    const hash = hashKeyString(key_string);
    super(`fixture miss (strict mock): no ${kind} fixture for key ${key_string} (file ${hash}.json)`);
    this.kind = kind;
    this.key_string = key_string;
    this.hash = hash;
  }
}
