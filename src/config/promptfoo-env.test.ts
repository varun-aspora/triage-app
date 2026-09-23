// The promptfoo off switches: every name is one the installed promptfoo
// actually reads, the values turn the switch on, and applyPromptfooEnv writes
// the env record it is given and no file.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROMPTFOO_CONFIG_DIR_KEY,
  PROMPTFOO_OFF_SWITCHES,
  applyPromptfooEnv,
  promptfooConfigDir,
  promptfooEnv,
} from './promptfoo-env.ts';

const config = { paths: { dataDir: '/eval/home/.data' } };

// promptfoo's built code, read as text. Only the top-level chunks of dist/src.
function promptfooDist(): string {
  // The package entry is dist/src/index.js; promptfoo does not export its package.json.
  const dir = dirname(fileURLToPath(import.meta.resolve('promptfoo')));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

describe('promptfoo off switches', () => {
  test('every name is read by the installed promptfoo', () => {
    const dist = promptfooDist();
    for (const name of [...Object.keys(PROMPTFOO_OFF_SWITCHES), PROMPTFOO_CONFIG_DIR_KEY]) {
      expect({ name, found: dist.includes(`"${name}"`) || dist.includes(`env.${name}`) }).toEqual({ name, found: true });
    }
  });

  test('telemetry, sharing, update check and remote generation are on-switches set to 1; the cache is off', () => {
    expect(PROMPTFOO_OFF_SWITCHES).toEqual({
      PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_DISABLE_SHARING: '1',
      PROMPTFOO_DISABLE_UPDATE: '1',
      PROMPTFOO_DISABLE_REMOTE_GENERATION: '1',
      PROMPTFOO_CACHE_ENABLED: 'false',
    });
  });

  test('the config dir is under TRIAGE_DATA_DIR', () => {
    expect(promptfooConfigDir(config)).toBe('/eval/home/.data/promptfoo');
  });

  test('applyPromptfooEnv overwrites the given env record and returns the names it set', () => {
    const env: Record<string, string | undefined> = { PROMPTFOO_DISABLE_TELEMETRY: '0', PROMPTFOO_CONFIG_DIR: '/elsewhere', OTHER: 'x' };
    const names = applyPromptfooEnv(config, env);
    expect([...names].sort()).toEqual(Object.keys(promptfooEnv(config)).sort());
    expect(env).toEqual({ ...promptfooEnv(config), OTHER: 'x' });
  });
});
