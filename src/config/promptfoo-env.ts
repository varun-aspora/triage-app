// promptfoo's off switches (D42; P1 critic on PROMPTFOO_* keys).
//
// `triage evals` sets these in its own process env before promptfoo is first
// imported, because promptfoo reads PROMPTFOO_CONFIG_DIR once at module load.
// They are never written to a .env file and are not config keys: nothing in
// the app reads them back. The names were checked against the installed
// promptfoo 0.123 dist, and src/config/promptfoo-env.test.ts checks them again
// on every run, so a renamed switch fails a test instead of silently turning
// telemetry or sharing back on.
//
// This file lives under src/config/ because that is the only place that may
// touch process.env.

import { join } from 'node:path';

/** The one part of Config this file needs. */
export type DataDirConfig = { readonly paths: { readonly dataDir: string } };

/** Switch name -> value. promptfoo reads '1' and 'true' as on. */
export const PROMPTFOO_OFF_SWITCHES: Readonly<Record<string, string>> = Object.freeze({
  PROMPTFOO_DISABLE_TELEMETRY: '1',
  PROMPTFOO_DISABLE_SHARING: '1',
  PROMPTFOO_DISABLE_UPDATE: '1',
  PROMPTFOO_DISABLE_REMOTE_GENERATION: '1',
  PROMPTFOO_CACHE_ENABLED: 'false',
});

/** Where promptfoo keeps its sqlite results store and cache. */
export const PROMPTFOO_CONFIG_DIR_KEY = 'PROMPTFOO_CONFIG_DIR';

/** <TRIAGE_DATA_DIR>/promptfoo, so eval results stay inside the eval home. */
export function promptfooConfigDir(config: DataDirConfig): string {
  return join(config.paths.dataDir, 'promptfoo');
}

/** Every value applyPromptfooEnv writes, by name. */
export function promptfooEnv(config: DataDirConfig): Readonly<Record<string, string>> {
  return Object.freeze({ ...PROMPTFOO_OFF_SWITCHES, [PROMPTFOO_CONFIG_DIR_KEY]: promptfooConfigDir(config) });
}

/**
 * Writes the off switches and the config dir into env (the process env by
 * default), overwriting whatever was there. Returns the names it set.
 */
export function applyPromptfooEnv(
  config: DataDirConfig,
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const values = promptfooEnv(config);
  Object.assign(env, values);
  return Object.freeze(Object.keys(values));
}
