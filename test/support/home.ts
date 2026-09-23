// Builds a throwaway TRIAGE_HOME for tests.
//
// The generated .env starts from .env.example with every credential and host
// value blanked, so nothing in a test home can point at a real system. Mock
// mode is forced on and strict, fixture recording is forced off (D19, D27,
// D42), and resources/ is copied in so the registry loads. The home lives in
// the OS temp dir and cleanup() removes it. No .env is ever written inside
// the repo.
//
// Node APIs only: contract tests load this under Vitest on Node.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { loadConfig, type Config } from '../../src/config/env.ts';
import { ENTITY_KEY_PATTERN, HOME_KEY, KEY_BY_NAME } from '../../src/config/keys.ts';
import { loadRegistry, type Registry } from '../../src/config/registry.ts';
import type { Entity } from '../../src/types/core.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const EXAMPLE_ENV = join(REPO_ROOT, '.env.example');
export const RESOURCES_DIR = join(REPO_ROOT, 'resources');

/** Key name suffixes whose values are credentials or hosts. */
const BLANK_SUFFIXES = [
  '_DB_URL',
  '_API_URL',
  '_URL',
  '_TOKEN',
  '_KEY',
  '_SECRET',
  '_BASTION',
  '_IDENTITY_FILE',
  '_REMOTE_HOST',
  '_OAUTH_SCOPE',
] as const;

/** Keys blanked by name on top of the suffix list. */
const BLANK_NAMES = new Set(['SLACK_BOT_TOKEN', 'SLACK_REVIEWER_EMAIL']);

/** Values forced in every test home. Overrides may repeat them but not change them. */
export const FORCED: Readonly<Record<string, string>> = Object.freeze({
  TRIAGE_MOCK_MODE: 'true',
  TRIAGE_MOCK_STRICT: 'true',
  TRIAGE_RECORD_FIXTURES: 'false',
});

const KEY_NAME = /^[A-Z][A-Z0-9_]*$/;

// A value that looks like a DSN, an address or a host name. Used as a second
// net for entity and provider keys whose names the suffix list does not cover.
const HOST_LIKE = [/@/, /:\/\//, /\blocalhost\b/i, /\b\d{1,3}(\.\d{1,3}){3}\b/, /[A-Za-z0-9-]+\.[A-Za-z][A-Za-z0-9-]*/];

export type TestHomeOptions = {
  /** Written into the generated .env after blanking. Keys must be env names; values one line. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** Sets TRIAGE_ENTITIES. Do not also pass it in overrides. */
  readonly entities?: readonly Entity[];
};

export type TestHome = {
  readonly home: string;
  readonly config: Config;
  readonly registry: Registry;
  /** The key/value pairs written to <home>/.env. */
  readonly env: Readonly<Record<string, string>>;
  /** Removes the temp dir. Safe to call twice. */
  cleanup(): void;
};

/** True for keys whose value a test home always blanks. */
export function isBlankedKey(name: string): boolean {
  if (BLANK_NAMES.has(name)) return true;
  if (BLANK_SUFFIXES.some((s) => name.endsWith(s))) return true;
  return KEY_BY_NAME.get(name)?.secret === true;
}

/** Entity keys and model provider keys, the ones that must never carry a host. */
export function isEntityOrProviderKey(name: string): boolean {
  if (ENTITY_KEY_PATTERN.test(name)) return true;
  const group = KEY_BY_NAME.get(name)?.group;
  return group === 'providers' || (group === 'sandbox' && isBlankedKey(name));
}

export function looksLikeHost(value: string): boolean {
  return HOST_LIKE.some((re) => re.test(value));
}

/** The .env.example record with credentials and hosts blanked and the mock keys forced. */
export function testEnvRecord(exampleText: string = readFileSync(EXAMPLE_ENV, 'utf8')): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parse(exampleText))) {
    if (name === HOME_KEY) continue;
    const hosty = isEntityOrProviderKey(name) && looksLikeHost(value);
    out[name] = isBlankedKey(name) || hosty ? '' : value;
  }
  return { ...out, ...FORCED };
}

export function makeTestHome(options: TestHomeOptions = {}): TestHome {
  const record = testEnvRecord();
  const overrides = options.overrides ?? {};
  for (const [name, value] of Object.entries(overrides)) {
    checkOverride(name, value);
    record[name] = value;
  }
  if (options.entities !== undefined) {
    if (Object.hasOwn(overrides, 'TRIAGE_ENTITIES')) {
      throw new Error('makeTestHome: pass entities or overrides.TRIAGE_ENTITIES, not both');
    }
    record.TRIAGE_ENTITIES = options.entities.join(',');
  }

  const home = mkdtempSync(join(tmpdir(), 'triage-home-'));
  let removed = false;
  const cleanup = (): void => {
    if (removed) return;
    removed = true;
    rmSync(home, { recursive: true, force: true });
  };
  try {
    cpSync(RESOURCES_DIR, join(home, 'resources'), { recursive: true });
    writeFileSync(join(home, '.env'), renderEnv(record), { mode: 0o600 });
    const config = loadConfig({ home });
    const registry = loadRegistry(config);
    return Object.freeze({ home, config, registry, env: Object.freeze({ ...record }), cleanup });
  } catch (err) {
    cleanup();
    throw err;
  }
}

function checkOverride(name: string, value: string): void {
  if (!KEY_NAME.test(name)) throw new Error(`makeTestHome: override ${JSON.stringify(name)} is not an env name`);
  if (name === HOME_KEY) throw new Error(`makeTestHome: ${HOME_KEY} is chosen by the helper`);
  const forced = FORCED[name];
  if (forced !== undefined && value.trim().toLowerCase() !== forced) {
    throw new Error(`makeTestHome: ${name} is forced to ${forced} in test homes`);
  }
  if (/[\r\n]/.test(value)) throw new Error(`makeTestHome: override ${name} must be one line`);
  if (value.includes("'") && value.includes('"')) {
    throw new Error(`makeTestHome: override ${name} cannot hold both quote kinds`);
  }
}

// One KEY=value line per entry, quoted so '#' and spaces survive dotenv.parse.
function renderEnv(record: Readonly<Record<string, string>>): string {
  const lines = ['# Generated by test/support/home.ts. Credentials and hosts are blank.'];
  for (const [name, value] of Object.entries(record)) {
    const quote = value.includes("'") ? '"' : "'";
    lines.push(`${name}=${quote}${value}${quote}`);
  }
  return `${lines.join('\n')}\n`;
}
