// The types list against the code that writes the lines: every
// logRunEvent(runId, '<type>', ...) call under src/, and the types
// trimObservation drops.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLUE_EVENT_TYPES, PIPELINE_EVENT_TYPES } from './event-types.ts';
import { DROPPED_EVENT_TYPES } from './serialize.ts';

const SRC = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f));
}

describe('event types', () => {
  test('pipeline types are exactly the logRunEvent call sites under src/', () => {
    const found = new Set<string>();
    let calls = 0;
    let literal = 0;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      // Calls, not the definition or the comment that names it.
      calls += [...text.matchAll(/(?<!function )logRunEvent\((?!\))/g)].length;
      for (const m of text.matchAll(/logRunEvent\(\s*[^,()]+,\s*'([a-z_]+)'/g)) {
        found.add(m[1] as string);
        literal++;
      }
    }
    // A call with a computed type would not be listed; keep them literal.
    expect(literal).toBe(calls);
    expect([...found].sort()).toEqual([...PIPELINE_EVENT_TYPES].sort());
  });

  test('flue types leave out the dropped streaming deltas and overlap no pipeline type', () => {
    for (const t of FLUE_EVENT_TYPES) expect(DROPPED_EVENT_TYPES.has(t)).toBe(false);
    const pipeline = new Set<string>(PIPELINE_EVENT_TYPES);
    expect(FLUE_EVENT_TYPES.filter((t) => pipeline.has(t))).toEqual([]);
  });
});
