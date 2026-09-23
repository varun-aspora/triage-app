// Reads resources/<entity>.api.rules.json from TRIAGE_HOME and validates it
// with validateRules. Any problem is a startup error that names the entity,
// the file and the rule index. File contents never reach the error text beyond
// the short field values validateRules quotes, and no env value is read here.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RegistryError } from '../config/registry.ts';
import type { Entity } from '../types/core.ts';
import { validateRules, type ApiRule } from './rules.ts';

export type LoadedRules = {
  readonly entity: Entity;
  /** Path relative to TRIAGE_HOME, for messages and the doctor. */
  readonly file: string;
  readonly rules: readonly ApiRule[];
  /** Non-fatal findings (an allow without a reason). The doctor prints them. */
  readonly warnings: readonly string[];
};

export function rulesFileName(entity: Entity): string {
  return `${entity}.api.rules.json`;
}

/**
 * Loads and validates the rules file for one entity. Throws RegistryError
 * (exit 3 in the CLI) when the file is missing, is not JSON or has any error.
 */
export function loadRulesFile(home: string, entity: Entity, serviceNames: readonly string[]): LoadedRules {
  const file = `resources/${rulesFileName(entity)}`;
  const path = join(home, 'resources', rulesFileName(entity));
  if (!existsSync(path)) throw RegistryError.of(file, `(entity ${entity}) is missing`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw RegistryError.of(file, `(entity ${entity}) is not valid JSON`);
  }

  const result = validateRules(raw, serviceNames);
  if (result.errors.length > 0) {
    throw new RegistryError(result.errors.map((reason) => ({ key: file, reason: `(entity ${entity}) ${reason}` })));
  }
  return Object.freeze({ entity, file, rules: result.rules, warnings: result.warnings });
}
