// Known-pattern index (HLD 02 §1.5 and §4.5). loadPatterns reads
// knowledge/patterns/patterns.json and validates every entry; matchPattern
// does the cheap signature match that sets matched_pattern_id before the
// tier policy runs. Prior cases are never an input here (D43).
//
// File shape: a JSON array of entries
//   {id, category, signature: {regex[], services[]}, entities[], query_recipe,
//    tier_hint, stable, source_ref}
// Entries are matched in file order and the first match wins, so curators put
// the more specific entries first.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';

import { CategorySchema, type Category } from '../types/classification.ts';
import { EntitySchema, NonEmptyStringSchema, TierSchema } from '../types/core.ts';

// Regexes are compiled case-insensitively and without the g flag, so a
// compiled RegExp carries no lastIndex state between calls.
const REGEX_FLAGS = 'i';

function compiles(source: string): boolean {
  try {
    new RegExp(source, REGEX_FLAGS);
    return true;
  } catch {
    return false;
  }
}

const RegexSourceSchema = v.pipe(
  v.string(),
  v.minLength(1, 'regex must not be empty'),
  v.check(compiles, (issue) => `regex does not compile: ${String(issue.input)}`),
);

export const PatternSignatureSchema = v.strictObject({
  // At least one regex must match the error text.
  regex: v.pipe(v.array(RegexSourceSchema), v.minLength(1, 'signature.regex needs at least one entry')),
  // Empty means any service. Otherwise one of the request's services must be listed.
  services: v.array(NonEmptyStringSchema),
});
export type PatternSignature = v.InferOutput<typeof PatternSignatureSchema>;

export const PatternSchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be kebab-case')),
  category: CategorySchema,
  signature: PatternSignatureSchema,
  entities: v.array(EntitySchema),
  query_recipe: v.string(),
  tier_hint: TierSchema,
  // Set by whoever curates patterns.json, in a PR. Only a stable pattern may
  // lower the tier (rule 5).
  stable: v.boolean(),
  source_ref: NonEmptyStringSchema,
});
export type Pattern = v.InferOutput<typeof PatternSchema>;

export class PatternsLoadError extends Error {
  override name = 'PatternsLoadError';
}

function issueText(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const path = v.getDotPath(issue);
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * Validates parsed patterns.json content. Throws PatternsLoadError naming the
 * first bad entry by id (or by index when the id itself is missing).
 */
export function parsePatterns(raw: unknown, source = 'patterns.json'): Pattern[] {
  if (!Array.isArray(raw)) {
    throw new PatternsLoadError(`${source}: expected a JSON array of pattern entries`);
  }
  const seen = new Set<string>();
  const out: Pattern[] = [];
  raw.forEach((entry: unknown, index) => {
    const rawId = (entry as { id?: unknown } | null)?.id;
    const label = typeof rawId === 'string' && rawId.length > 0 ? `"${rawId}"` : `#${index}`;
    const parsed = v.safeParse(PatternSchema, entry);
    if (!parsed.success) {
      throw new PatternsLoadError(`${source}: entry ${label}: ${issueText(parsed.issues)}`);
    }
    if (seen.has(parsed.output.id)) {
      throw new PatternsLoadError(`${source}: entry ${label}: duplicate id`);
    }
    seen.add(parsed.output.id);
    out.push(parsed.output);
  });
  return out;
}

/** Reads and validates one patterns file. */
export async function loadPatternsFile(path: string): Promise<Pattern[]> {
  const text = await readFile(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PatternsLoadError(`${path}: not valid JSON: ${(err as Error).message}`);
  }
  return parsePatterns(raw, path);
}

/** Reads and validates <knowledgeDir>/patterns/patterns.json. */
export function loadPatterns(knowledgeDir: string): Promise<Pattern[]> {
  return loadPatternsFile(join(knowledgeDir, 'patterns', 'patterns.json'));
}

export type PatternMatch = {
  matched_pattern_id: string;
  stable: boolean;
};

const compiled = new Map<string, RegExp>();

function compile(source: string): RegExp {
  let re = compiled.get(source);
  if (!re) {
    re = new RegExp(source, REGEX_FLAGS);
    compiled.set(source, re);
  }
  return re;
}

/**
 * Returns the first pattern whose category equals `category`, whose service
 * list is empty or shares a service with `services` (case-insensitive), and
 * one of whose regexes matches `text`. Returns null when nothing matches.
 */
export function matchPattern(
  text: string,
  services: readonly string[],
  category: Category,
  patterns: readonly Pattern[],
): PatternMatch | null {
  const wanted = new Set(services.map((s) => s.trim().toLowerCase()));
  for (const pattern of patterns) {
    if (pattern.category !== category) continue;
    const allowed = pattern.signature.services;
    if (allowed.length > 0 && !allowed.some((s) => wanted.has(s.toLowerCase()))) continue;
    if (!pattern.signature.regex.some((source) => compile(source).test(text))) continue;
    return { matched_pattern_id: pattern.id, stable: pattern.stable };
  }
  return null;
}
