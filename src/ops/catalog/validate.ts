// Input rules for the catalog writes (POST /services, POST /guides).
//
// Every name that ends up in a path is checked against a strict pattern
// before it is joined, and safeJoin checks the joined result again, so a
// bad value is refused twice before it can reach the filesystem.

import { resolve, sep } from 'node:path';
import { checkEgress } from '../../gate/redact.ts';

// The registry allows '_' in service keys and skill names allow '-', but the
// guide for a service is named <entity>-<service> and must satisfy both, so a
// new key gets letters and digits only.
export const SERVICE_KEY = /^[a-z][a-z0-9]*$/;
export const MAX_SERVICE_KEY = 40;
/** The skill name <entity>-overview belongs to the entity overview. */
export const RESERVED_SERVICE_KEY = 'overview';

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;
export const MAX_DESCRIPTION = 1024;

export const QUICKWIT_SERVICE = /^[A-Za-z0-9._-]+$/;
export const MAX_QUICKWIT_SERVICE = 128;

/** Why key is not a usable new service key, or undefined when it is. */
export function serviceKeyProblem(key: string): string | undefined {
  if (!SERVICE_KEY.test(key)) return 'must start with a lowercase letter and hold only lowercase letters and digits';
  if (key.length > MAX_SERVICE_KEY) return `must be at most ${MAX_SERVICE_KEY} characters`;
  if (key === RESERVED_SERVICE_KEY) return `'${RESERVED_SERVICE_KEY}' is reserved for the entity overview`;
  return undefined;
}

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name) && name.length <= MAX_SKILL_NAME;
}

// Control characters, including line and paragraph separators, would break
// the one-line front-matter and registry values.
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** Why text is not one line of min..max characters, or undefined when it is. */
export function oneLineProblem(text: string, max: number, min = 0): string | undefined {
  if (CONTROL.test(text)) return 'must be one line';
  if (text.length < min) return min === 1 ? 'must not be empty' : `must be at least ${min} characters`;
  if (text.length > max) return `must be at most ${max} characters`;
  return undefined;
}

export const EGRESS_REASON = 'looks like customer data or a secret';

/**
 * The fields whose text the persisted redaction profile would mask. That
 * profile is what every run record goes through, so anything it would mask
 * must not be written into the registry or knowledge.
 */
export function egressHits(fields: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (text !== undefined && !checkEgress(text).ok) out.push(field);
  }
  return out;
}

/** Joins parts under root and returns the path, or undefined if it would leave root. */
export function safeJoin(root: string, ...parts: readonly string[]): string | undefined {
  const base = resolve(root);
  for (const part of parts) {
    if (part === '' || part.includes('\0') || part.includes('\\')) return undefined;
  }
  const out = resolve(base, ...parts);
  return out.startsWith(base + sep) ? out : undefined;
}
