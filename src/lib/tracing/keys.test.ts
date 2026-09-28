// The run id key on the app's spans must match the key each vendor's Flue
// instrumentation writes the instance id under (D91), or the filter that
// joins a run stops matching. This reads the installed dist code, so a rename
// on upgrade fails here.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAINTRUST_RUN_ID_KEY, OTLP_RUN_ID_KEY } from './keys.ts';

/** The package's resolved entry plus the local chunks it imports; the code sits in a hashed chunk. */
function installedCode(pkg: string): string {
  const entry = Bun.resolveSync(pkg, import.meta.dir);
  const text = readFileSync(entry, 'utf8');
  const chunks = [...text.matchAll(/from ["'](\.\/[^"']+)["']/g)].map((m) => readFileSync(join(dirname(entry), m[1] as string), 'utf8'));
  return [text, ...chunks].join('\n');
}

describe('run id keys', () => {
  test('braintrust writes the Flue instance id under the key the adapter uses', () => {
    expect(installedCode('braintrust')).toContain(`"${BRAINTRUST_RUN_ID_KEY}": event.instanceId`);
  });

  test('@flue/opentelemetry writes the Flue instance id under the key the adapter uses', () => {
    expect(installedCode('@flue/opentelemetry')).toContain(`"${OTLP_RUN_ID_KEY}": event.instanceId`);
  });
});
